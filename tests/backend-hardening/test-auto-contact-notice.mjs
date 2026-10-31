import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const search = read('results.html');
const partner = read('partner-dashboard.html');
const helper = read('assets/js/location-contact-notice.js');
const browser = { window: {} };
runInNewContext(helper, browser);
const contact = browser.window.Ride24LocationContact;
const car = rows => ({ partners: { partner_locations: rows } });
const point = (type, location_name = 'Pickup') =>
    ({ type, location_name, country: 'Italy', city: 'Bari', contact_required: false });

test('automatic rule follows location type and ignores legacy contact checkbox/fees', () => {
    for (const type of ['city', 'hotel', 'office', 'railway_station', 'seaport', 'custom']) {
        assert.equal(contact.requiresContact({ type, contact_required: false, extra_fee_amount: 0 }), true, type);
    }
    assert.equal(contact.requiresContact({ type: 'airport', contact_required: true, extra_fee_amount: 100 }), false);
    assert.equal(contact.requiresContact({ type: 'unknown', contact_required: true }), false);
    assert.equal(contact.requiresContact({ type: null }), false);
});

test('selected named non-airport pickup gets contact notice even without a fee', () => {
    assert.equal(contact.showForPickup(car([point('hotel')]), point('hotel')), true);
    assert.equal(contact.showForPickup(car([point('office')]), point('office')), true);
    assert.equal(contact.showForPickup(car([point('airport')]), point('airport')), false);
    assert.equal(contact.showForPickup(car([{ ...point('airport'), contact_required: true }]), point('airport')), false);
    assert.equal(contact.showForPickup(car([{ ...point('hotel'), extra_fee: true, extra_fee_amount: 35 }]), point('hotel')), true);
});

test('exact selected pickup and geography prevent warning from an unrelated location', () => {
    const rows = [point('hotel', 'Bari Hotel'), point('airport', 'Bari Airport')];
    assert.equal(contact.showForPickup(car(rows), point('hotel', 'Bari Hotel')), true);
    assert.equal(contact.showForPickup(car(rows), point('airport', 'Bari Airport')), false);
    assert.equal(contact.showForPickup(car(rows), point('hotel', 'Another Hotel')), false);
    assert.equal(contact.showForPickup(car(rows), { ...point('hotel', 'Bari Hotel'), city: 'Rome' }), false);
});

test('broad city search only shows when all matched pickup points are non-airport', () => {
    const selected = { type: 'city', country: 'Italy', city: 'Bari' };
    assert.equal(contact.showForPickup(car([point('hotel'), point('office')]), selected), true);
    assert.equal(contact.showForPickup(car([point('airport'), point('office')]), selected), false);
    assert.equal(contact.showForPickup(car([point('airport')]), selected), false);
    assert.equal(contact.showForPickup(car([]), selected), false);
    assert.equal(contact.showForPickup(car([point('hotel')]), { type: 'airport', city: 'Bari' }), false);
    assert.equal(contact.showForPickup(car([point('hotel')]), { type: 'region', city: 'Bari' }), false);
});

test('search restores compact contact-only notice without pickup fee duplication', () => {
    assert.match(search, /location-contact-notice\.js\?v=/);
    assert.match(search, /partner_locations!inner\([\s\S]*?type,[\s\S]*?contact_required,/);
    assert.match(search, /const contactBadgeHtml = window\.Ride24LocationContact\.showForPickup\(car, loc\)/);
    assert.match(search, /\$\{contactBadgeHtml\}/);
    assert.match(search, /Odbiór poza lotniskiem/);
    assert.match(search, /Non-airport pickup/);
    assert.doesNotMatch(search, /Opłata za odbiór od/);
});

test('partner can no longer toggle contact; location type automatically sets legacy field', () => {
    assert.match(partner, /location-contact-notice\.js\?v=/);
    assert.doesNotMatch(partner, /id="locContact"/);
    assert.doesNotMatch(partner, /getElementById\('locContact'\)/);
    assert.match(partner, /locationData\.contact_required = window\.Ride24LocationContact\.requiresContact\(locationData\)/);
    assert.match(partner, /Ride24 automatycznie informuje klienta/);
});

test('new helper and current inline result scripts parse successfully', () => {
    new Script(helper, { filename: 'location-contact-notice.js' });
    const inline = [...search.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(inline.length > 0);
    for (const script of inline) if (script[1].trim()) {
        new Script(script[1], { filename: 'results-inline.js' });
    }
});
