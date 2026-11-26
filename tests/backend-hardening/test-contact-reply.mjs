import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a failed reply retains its draft, concurrent clicks invoke once, retry confirms the recipient', async () => {
  const html = read('../../admin/index.html');
  const {window} = new JSDOM(html, {runScripts: 'outside-only'});
  const ui = window.document;
  const source = html.slice(html.indexOf('let currentMessageId ='), html.indexOf('async function loadMarketingSettings'));
  window.eval(source);
  window.loadMessages = async () => {};
  let calls = 0;
  let finish;
  window.db = {functions: {invoke(name, {body}) {
    calls++;
    assert.equal(name, 'send-reply');
    assert.equal(body.message_id, 'fixture');
    assert.equal(body.message, 'Zażółć gęślą jaźń');
    assert.equal(body.to, 'kontakt@ride24.pl');
    return new Promise(resolve => {finish = resolve;});
  }}};
  window.openReplyModal('fixture', 'kontakt@ride24.pl');
  ui.querySelector('#reply-text').value = 'Zażółć gęślą jaźń';
  const pending = window.sendReply();
  await window.sendReply();
  assert.equal(calls, 1);
  window.closeReplyModal();
  assert.equal(ui.querySelector('#reply-modal').style.display, 'flex');
  finish({error: {context: {json: async () => ({error: 'Błąd SMTP'})}}});
  await pending;
  assert.equal(ui.querySelector('#reply-error').textContent, 'Błąd SMTP');
  assert.equal(ui.querySelector('#reply-text').value, 'Zażółć gęślą jaźń');
  assert.equal(ui.querySelector('#reply-send').disabled, false);
  const retry = window.sendReply();
  finish({data: {success: true}});
  await retry;
  assert.match(ui.querySelector('#reply-confirmation').textContent, /Wysłano odpowiedź do kontakt@ride24.pl/);
  window.close();
});

test('PostgreSQL permits only one claim for a contact and reply and denies ordinary clients access', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role; create table contact_messages(id uuid primary key);');
    await db.exec(read('../../supabase/migrations/20261126175549_contact_reply_deliveries.sql'));
    const id = '442df61a-4a82-41df-b60d-592aeb043928';
    await db.query('insert into contact_messages values ($1)', [id]);
    const claim = () => db.query('insert into contact_reply_deliveries(contact_id,fingerprint) values ($1,$2)', [id, 'same']);
    const results = await Promise.allSettled([claim(), claim()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, '23505');
    await db.exec('set role authenticated');
    await assert.rejects(claim(), {code: '42501'});
  } finally {
    await db.close();
  }
});
