import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const client = '00000000-0000-4000-8000-000000000001';
const partner = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA vault;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,role text);
INSERT INTO public.profiles VALUES('${client}','client'),('${partner}','partner'),('${admin}','admin');
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin') $$;
CREATE TABLE public.travel_guides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,slug text UNIQUE NOT NULL,folder_name text UNIQUE NOT NULL,active boolean DEFAULT true);
ALTER TABLE public.travel_guides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read travel guides" ON public.travel_guides FOR SELECT TO authenticated USING(true);
CREATE POLICY "Authenticated users can insert travel guides" ON public.travel_guides FOR INSERT TO authenticated WITH CHECK(auth.uid() IS NOT NULL);
INSERT INTO public.travel_guides(title,slug,folder_name) VALUES('Madera','madeira','madeira');
CREATE TABLE public.bookings(id integer, status text); INSERT INTO public.bookings VALUES(1,'confirmed');
CREATE TABLE public.partner_locations(id integer,guide_id uuid REFERENCES public.travel_guides(id));
INSERT INTO public.partner_locations SELECT 1,id FROM public.travel_guides;
CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text UNIQUE,secret text,description text);
CREATE VIEW vault.decrypted_secrets AS SELECT id,name,secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(secret text,name text,description text) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE sid uuid; BEGIN INSERT INTO vault.secrets(secret,name,description) VALUES($1,$2,$3) RETURNING id INTO sid; RETURN sid; END $$;
CREATE FUNCTION vault.update_secret(sid uuid,secret text,name text,description text) RETURNS void LANGUAGE sql AS $$ UPDATE vault.secrets SET secret=$2,name=$3,description=$4 WHERE id=$1 $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
GRANT SELECT,INSERT ON public.travel_guides TO authenticated,service_role;
`);
const before = (await db.query('SELECT (SELECT jsonb_agg(to_jsonb(b)) FROM public.bookings b) AS bookings,(SELECT jsonb_agg(to_jsonb(l)) FROM public.partner_locations l) AS locations')).rows[0];
await db.exec(readFileSync(new URL('../../supabase/migrations/20261009190900_admin_travel_guide_upload.sql', import.meta.url), 'utf8'));
const checks = [];
async function test(name, fn) { await fn(); checks.push(name); }
async function context(role, id = '') { await db.exec(`RESET ROLE; SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub','${id}',false);`); }
async function denied(query) {
  try { await db.exec(query); return false; } catch (error) { return error.code === '42501'; }
}
for (const [role, id] of [['authenticated',client],['authenticated',partner],['authenticated',admin],['anon','']]) {
  await test(`${role}/${id.slice(-1)} cannot read or set the server GitHub token`, async () => {
    await context(role,id);
    assert.equal(await denied('SELECT public.admin_travel_guide_github_token()'),true);
    assert.equal(await denied("SELECT public.admin_travel_guide_github_token('github_pat_fixture12345678901234567890')"),true);
  });
}
for (const id of [client,partner]) {
  await test(`${id.slice(-1)} can read existing guides but cannot insert`, async () => {
    await context('authenticated',id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.travel_guides')).rows[0].n,1);
    assert.equal(await denied("INSERT INTO public.travel_guides(title,slug,folder_name) VALUES('Injected','injected','injected')"),true);
  });
}
await test('administrator may still add a guide', async () => {
  await context('authenticated',admin);
  await db.exec("INSERT INTO public.travel_guides(title,slug,folder_name) VALUES('Varna','varna','varna')");
});
await test('server token access works with the PostgREST service role', async () => {
  await context('service_role');
  assert.equal((await db.query('SELECT public.admin_travel_guide_github_token() AS token')).rows[0].token,null);
  await db.exec("SELECT public.admin_travel_guide_github_token('github_pat_fixture12345678901234567890')");
  assert.equal((await db.query('SELECT public.admin_travel_guide_github_token() AS token')).rows[0].token,'github_pat_fixture12345678901234567890');
});
await test('token rotation updates only the dedicated Vault entry', async () => {
  await db.exec("SELECT public.admin_travel_guide_github_token('github_pat_fixture09876543210987654321')");
  await context('postgres');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM vault.secrets')).rows[0].n,1);
  assert.equal((await db.query('SELECT secret FROM vault.secrets')).rows[0].secret,'github_pat_fixture09876543210987654321');
});
await test('unexpected database role fails closed even as function owner', async () => {
  assert.equal(await denied('SELECT public.admin_travel_guide_github_token()'),true);
});
await test('migration preserves reservations and guide location assignments', async () => {
  const after = (await db.query('SELECT (SELECT jsonb_agg(to_jsonb(b)) FROM public.bookings b) AS bookings,(SELECT jsonb_agg(to_jsonb(l)) FROM public.partner_locations l) AS locations')).rows[0];
  assert.deepEqual(after,before);
});
console.log(JSON.stringify({passed:checks.length,checks,scope:'isolated PostgreSQL permissions and migration; Vault encryption is provided by hosted Supabase'}));
await db.close();
