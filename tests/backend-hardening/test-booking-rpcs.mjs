import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// Real RPC bodies; synthetic rows; no production connection or HTTP/push triggers.
const db=new PGlite(), checks=[];
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function check(name,actual,expected) { assert.deepEqual(actual,expected,name); checks.push(name); }
async function one(sql) { return (await db.query(sql)).rows[0]; }
async function context(n) { await db.exec(`RESET ROLE; SET request.jwt.claim.sub='${n?uid(n):''}'; SET ROLE authenticated;`); }
async function denied(name,sql,expected) { let message=''; try { await db.exec(sql); } catch(e) { message=e.message; } check(name,message.includes(expected),true); }
await db.exec(`
CREATE ROLE authenticated; CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated;
CREATE TYPE booking_status AS ENUM('pending','awaiting_payment','paid','rejected','expired','cancelled','payment_expired');
CREATE TABLE partners(id uuid PRIMARY KEY,user_id uuid,provider_type text);
CREATE TABLE car_classes(id uuid PRIMARY KEY,class_code text,description text);
CREATE TABLE bookings(id uuid PRIMARY KEY,partner_id uuid,car_class_id uuid,status booking_status,
 partner_response_deadline timestamptz,payment_deadline timestamptz,expires_at timestamptz,
 reservation_code text,start_date date,end_date date,pickup_time time,return_time time,
 pickup_location text,return_location text,partner_currency text,pickup_payment_partner_currency numeric,
 partner_net_price_snapshot numeric,main_driver_name text,main_driver_age bigint,add_driver_name text,
 add_driver_age bigint,client_phone text,client_email text,created_at timestamptz DEFAULT now());
INSERT INTO partners VALUES('${uid(201)}','${uid(101)}','local'),('${uid(202)}','${uid(102)}','local'),('${uid(203)}','${uid(103)}','api');
INSERT INTO car_classes VALUES('${uid(401)}','A','Fixture car');
`);
await db.exec(readFileSync(new URL('booking-rpc-fixture.sql',import.meta.url),'utf8'));
await db.exec('GRANT EXECUTE ON FUNCTION partner_accept_booking(uuid),partner_reject_booking(uuid),partner_app_get_bookings() TO authenticated;');
async function booking(n,partner=201,status='pending',expired=false) {
 await db.exec(`RESET ROLE; INSERT INTO bookings(id,partner_id,car_class_id,status,partner_response_deadline,client_phone,client_email)
 VALUES('${uid(n)}','${uid(partner)}','${uid(401)}','${status}',now()+interval '${expired?'-1':'1'} hour','000000000','fixture@example.invalid');`);
}
await booking(301); await context(0);
await denied('anonymous acceptance requires authentication',`SELECT * FROM partner_accept_booking('${uid(301)}')`,'AUTH_REQUIRED');
await context(101);
check('own pending booking accepted with 24-hour payment deadline',await one(`SELECT status,(payment_deadline BETWEEN now()+interval '23 hours 59 minutes' AND now()+interval '24 hours 1 minute') AS deadline_ok FROM partner_accept_booking('${uid(301)}')`),{status:'awaiting_payment',deadline_ok:true});
await db.exec('RESET ROLE');
check('payment expiry matches deadline',(await one(`SELECT expires_at=payment_deadline AS ok FROM bookings WHERE id='${uid(301)}'`)).ok,true);
await context(101);
await denied('duplicate acceptance rejected',`SELECT * FROM partner_accept_booking('${uid(301)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await booking(302,202); await context(101);
await denied('another partner cannot accept booking',`SELECT * FROM partner_accept_booking('${uid(302)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await denied('another partner cannot reject booking',`SELECT partner_reject_booking('${uid(302)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await booking(303,203); await context(103);
await denied('API partner cannot use local acceptance RPC',`SELECT * FROM partner_accept_booking('${uid(303)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await booking(304,201,'pending',true); await context(101);
await denied('expired response deadline blocks acceptance',`SELECT * FROM partner_accept_booking('${uid(304)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await denied('expired response deadline blocks rejection',`SELECT partner_reject_booking('${uid(304)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await booking(305); await context(101);
check('own pending booking rejected',(await one(`SELECT partner_reject_booking('${uid(305)}') AS id`)).id,uid(305));
await db.exec('RESET ROLE');
check('rejected status persisted in isolated fixture',(await one(`SELECT status FROM bookings WHERE id='${uid(305)}'`)).status,'rejected');
await context(101);
await denied('duplicate rejection rejected',`SELECT partner_reject_booking('${uid(305)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
await booking(306,201,'paid'); await context(101);
await denied('paid booking cannot be rejected through pending RPC',`SELECT partner_reject_booking('${uid(306)}')`,'BOOKING_NOT_AVAILABLE_OR_ACCESS_DENIED');
const rows=(await db.query('SELECT id,status,client_phone,client_email FROM partner_app_get_bookings()')).rows;
check('booking list excludes other partners',rows.some(r=>[uid(302),uid(303)].includes(r.id)),false);
check('unpaid booking contact data hidden',rows.filter(r=>r.status!=='paid').every(r=>r.client_phone===null&&r.client_email===null),true);
check('paid booking contact data remains available',rows.find(r=>r.id===uid(306)),{id:uid(306),status:'paid',client_phone:'000000000',client_email:'fixture@example.invalid'});
await context(0);
await denied('anonymous booking read requires authentication','SELECT * FROM partner_app_get_bookings()','AUTH_REQUIRED');
await context(104);
await denied('client cannot use partner booking list','SELECT * FROM partner_app_get_bookings()','PARTNER_NOT_FOUND_OR_NOT_LOCAL');
await context(103);
await denied('API partner cannot use local booking list','SELECT * FROM partner_app_get_bookings()','PARTNER_NOT_FOUND_OR_NOT_LOCAL');
await booking(307); await context(101);
await db.exec('BEGIN'); await db.query(`SELECT * FROM partner_accept_booking('${uid(307)}')`); await db.exec('ROLLBACK; RESET ROLE');
check('transaction rollback restores pending state',(await one(`SELECT status FROM bookings WHERE id='${uid(307)}'`)).status,'pending');
console.log(JSON.stringify({passed:checks.length,checks,scope:'isolated PostgreSQL fixtures using deployed RPC definitions; notifications/payment/native APK excluded'}));
await db.close();
