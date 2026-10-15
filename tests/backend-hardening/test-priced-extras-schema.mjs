// Run with PGLITE_MODULE pointing to an installed @electric-sql/pglite module.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
create table public.partners(id uuid primary key,user_id uuid,provider_type text);
create table public.partner_locations(id uuid primary key);
create table public.bookings(id uuid primary key);
grant select on public.partners to authenticated;
grant select,insert,update on public.bookings to authenticated,service_role;
insert into public.partners values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','local'),
('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','local'),
('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','api');`);
await db.exec(await readFile(new URL('../../maintenance/proposed/priced-extras-v2.sql',import.meta.url),'utf8'));
let checks=0;
async function ok(sql){await db.exec(sql);checks++;}
async function rejected(sql){await assert.rejects(db.exec(sql));checks++;}
const p1='10000000-0000-4000-8000-000000000001',p2='10000000-0000-4000-8000-000000000002';
await ok(`set role authenticated; select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false)`);
await ok(`insert into partner_extras(partner_id,code,name_en,amount) values('${p1}','gps','GPS',5)`);
await rejected(`insert into partner_extras(partner_id,code,name_en) values('${p2}','gps','GPS')`);
await rejected(`update partner_extras set partner_id='${p2}'`);
await rejected(`update partner_extras set amount=-1`);
await rejected(`delete from partner_extras`);
await rejected(`select * from booking_feature_flags`);
await rejected(`insert into bookings(id,pricing_items_snapshot) values(gen_random_uuid(),'{}')`);
await ok(`insert into bookings(id) values('30000000-0000-4000-8000-000000000001')`);
await rejected(`update bookings set pricing_items_snapshot='{}'`);
await ok(`reset role; set role service_role; update bookings set pricing_items_snapshot='{"version":2}'`);
await ok(`reset role; set role authenticated; update bookings set id=id`);
await rejected(`update bookings set pricing_items_snapshot=null`);
await ok(`select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false)`);
assert.equal((await db.query('select * from partner_extras')).rows.length,0);checks++;
await ok(`select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000003',false)`);
await rejected(`insert into partner_extras(partner_id,code,name_en) values('10000000-0000-4000-8000-000000000003','gps','GPS')`);
await ok(`reset role; set role anon`);
await rejected(`select * from partner_extras`);
await ok(`reset role`);
assert.equal((await db.query('select priced_extras_enabled from booking_feature_flags')).rows[0].priced_extras_enabled,false);checks++;
await rejected(`insert into partner_extras(partner_id,code,name_en) values('${p1}','gps','Duplicate GPS')`);
await rejected(`insert into partner_extras(partner_id,code,name_en,max_quantity) values('${p1}','additional_driver','Driver',2)`);
console.log(`${checks} isolated schema and ownership checks passed; no production writes.`);
await db.close();
