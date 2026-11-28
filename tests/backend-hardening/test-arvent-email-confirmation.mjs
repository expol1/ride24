// Automatic Arvent approval from the supplier's emailed confirmation PDF.
// Fixtures are text extracted from the real certificate for 17BFD74AC95B
// (customer phone redacted). DKIM messages are signed by nodemailer, an
// independent implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import nodemailer from 'nodemailer';
import {PGlite} from '@electric-sql/pglite';
import {parseArventCertificate,verifyArventCertificate,moneyCents,arventUsDateTime} from '../../supabase/functions/_shared/arvent-confirmation-document.mjs';
import {parseMime,verifyDkim,senderVerdict,trustedAuthResults,deliveredAtMs} from '../../supabase/functions/_shared/mail-authentication.mjs';
import {processArventMail,ZOHO_AUTHSERV} from '../../supabase/functions/_shared/arvent-mail-ingest.mjs';
import {advanceApiPayment} from '../../supabase/functions/_shared/api-payment-flow.mjs';

const fixture=name=>readFile(new URL('./fixtures/arvent-certificate-17BFD74AC95B.'+name+'.txt',import.meta.url),'utf8');
const TITLE='17BFD74AC95BVoucherTitle';

// Real booking R24-8DE01B as stored by Ride24 (phone redacted like the fixture).
const booking=()=>({id:'163b5fdc-0f33-446d-b71e-52bf8b0db2aa',reservation_code:'R24-8DE01B',status:'pending',
 partner_id:'bf29a373-c464-4cec-87a7-c3218ea1ea51',api_booking_reference:'17BFD74AC95B',start_date:'2027-03-03',end_date:'2027-03-06',
 pickup_time:'18:00:00',return_time:'18:00:00',partner_currency:'EUR',partner_net_price_snapshot:84.75,pickup_payment_partner_currency:84.75,
 main_driver_name:'Test Test',client_email:'ride24@t.pl',client_phone:'+48500000000',cancelled_at:null,refund_status:null,
 stripe_amount_cents:1514,payment_intent_id:'pi_x'});
const workflow=()=>({booking_id:'163b5fdc-0f33-446d-b71e-52bf8b0db2aa',state:'provider_pending',provider_reference:'17BFD74AC95B',
 paid_at:'2026-11-27T15:19:40.787Z',payment_intent:'pi_x',amount_cents:1514,supplier_received_at:'2026-11-27T15:20:02.856Z',
 supplier_deadline_at:'2026-11-28T15:20:02.856Z',prepared_quote:{provider:'arvent_kolaycar'}});
const quote={external_group_id:'ECMD',pickup_location_external_id:'12',dropoff_location_external_id:'12',raw_response:{}};
// Live GET /reservations fields as returned for 17BFD74AC95B (status set per test).
const livePayload=(status=0)=>({reservationNumber:'17BFD74AC95B',agencyReservationReference:'R24-8DE01B',reservationStatusType:status,
 pickupDate:'2027-03-03T18:00:00',returnDate:'2027-03-06T18:00:00',pickupLocationId:12,returnLocationId:12,
 pickupLocationName:'Antalya Airport',returnLocationName:'Antalya Airport',rentalDuration:3,vehicleName:'Renault Clio',
 vehicleCategoryTypeName:'Economic',transmissionTypeName:'Manual',fuelTypeName:'Diesel',dailyPrice:28.25,extraPrice:0,oneWayFee:0,
 paidAmount:0,totalPrice:84.75,currencyCode:'EUR',depositPrice:0,depositCreditCardRequired:false,totalKMLimit:0,reservationExtras:[]});
const delivered=Date.parse('2026-11-27T15:28:30Z');

test('parses the real Arvent certificate identically from pdf.js and pdftotext output',async()=>{
 for(const f of ['unpdf','layout']){
  const r=parseArventCertificate(await fixture(f),{title:TITLE});
  assert.equal(r.ok,true,f+': '+r.errors);
  assert.deepEqual({...r.doc,customer_phone:undefined},{title:'VEHICLE DELIVERY CERTIFICATE',reservation_number:'17BFD74AC95B',
   reservation_local:'2026-11-27T18:19:51',pickup_local:'2027-03-03T18:00:00',return_local:'2027-03-06T18:00:00',
   pickup_location:'Antalya Airport',return_location:'Antalya Airport',rental_days:3,vehicle_model:'Renault Clio',
   vehicle_category:['Economic','Manual','Diesel'],mileage_limit_km:0,extras:[],daily_rate_cents:2825,billed_days:3,
   rental_amount_cents:8475,currency:'EUR',extras_amount:{cents:0,currency:'EUR'},one_way_fee:{cents:0,currency:'EUR'},
   total:{cents:8475,currency:'EUR'},paid:{cents:0,currency:'EUR'},on_delivery:{cents:8475,currency:'EUR'},
   customer_name:'Test Test',customer_email_masked:'rid****@t.pl',customer_phone:undefined});
 }
 assert.equal(moneyCents('1.234,56'),123456);assert.equal(moneyCents('84.75'),8475);assert.equal(moneyCents('abc'),null);
 assert.equal(arventUsDateTime('3/6/2027 6:00:00 PM'),'2027-03-06T18:00:00');
 assert.equal(arventUsDateTime('12/1/2027 12:30:00 AM'),'2027-12-01T00:30:00');
 assert.equal(arventUsDateTime('2/30/2027 6:00:00 PM'),null);
});

test('rejects sample, foreign or mismatched documents',async()=>{
 const text=await fixture('unpdf');
 assert.deepEqual(parseArventCertificate(text,{title:'OTHERVoucherTitle'}).errors,['PDF_TITLE_MISMATCH']);
 assert.ok(parseArventCertificate(text.replace('VEHICLE DELIVERY CERTIFICATE','SAMPLE VOUCHER')).errors.includes('DOCUMENT_TITLE'));
 assert.ok(parseArventCertificate('Lorem ipsum').errors.includes('RESERVATION_NUMBER'));
});

test('verifies the certificate against the paid booking, live API and the never-reset deadline',async()=>{
 const {doc}=parseArventCertificate(await fixture('unpdf'),{title:TITLE});
 const base={doc,booking:booking(),workflow:workflow(),live:livePayload(0),quote,evidence:{one_way_fee:0},receivedAtMs:delivered};
 assert.deepEqual(verifyArventCertificate(base),{ok:true,reasons:[]});
 assert.deepEqual(verifyArventCertificate({...base,live:livePayload(1)}),{ok:true,reasons:[]});
 const reasons=over=>verifyArventCertificate({...base,...over}).reasons;
 // The real outcome for 17BFD74AC95B: Arvent cancelled it 3 minutes after the PDF.
 assert.deepEqual(reasons({live:livePayload(3)}),['LIVE_STATUS']);
 assert.deepEqual(reasons({live:livePayload(6)}),['LIVE_STATUS']);
 assert.ok(reasons({booking:{...booking(),partner_net_price_snapshot:80}}).includes('TOTAL'));
 assert.ok(reasons({live:{...livePayload(0),totalKMLimit:300}}).includes('MILEAGE_UNLIMITED'));
 assert.ok(reasons({live:{...livePayload(0),pickupLocationName:'Istanbul Airport'}}).includes('PICKUP_LOCATION'));
 assert.ok(reasons({live:{...livePayload(0),vehicleName:'Fiat Egea'}}).includes('VEHICLE_MODEL'));
 assert.ok(reasons({live:{...livePayload(0),agencyReservationReference:'R24-OTHER'}}).includes('AGENCY_REFERENCE'));
 assert.ok(reasons({booking:{...booking(),main_driver_name:'Jan Kowalski'}}).includes('CUSTOMER_NAME'));
 assert.ok(reasons({booking:{...booking(),start_date:'2027-03-04'}}).includes('PICKUP_DATETIME'));
 // Delivered after the persisted 24h deadline: never approved, deadline not reset.
 assert.deepEqual(reasons({receivedAtMs:Date.parse('2026-11-28T15:20:03Z')}),['DELIVERED_BEFORE_DEADLINE']);
 // A certificate for an older supplier record (replayed number) is refused.
 assert.ok(reasons({workflow:{...workflow(),supplier_received_at:'2026-11-27T12:00:00Z'}}).includes('RESERVATION_TIME'));
});

async function signedMail({domain='arventcarrental.com',from='Arvent Car Rental <info@arventcarrental.com>',pdf,key,headers={}}){
 const t=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows'});
 const info=await t.sendMail({from,to:'kontakt@ride24.pl',subject:'Rezervasyon Bilgileri 17BFD74AC95B',text:'Reservation details attached.',
  date:new Date('2026-11-27T15:28:20Z'),headers,
  attachments:pdf?[{filename:'17BFD74AC95B.pdf',content:pdf,contentType:'application/pdf'}]:[],
  dkim:{domainName:domain,keySelector:'mail',privateKey:key.privateKey.export({type:'pkcs1',format:'pem'})}});
 return info.message.toString();
}
const keys=()=>crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const resolver=key=>async name=>name==='mail._domainkey.arventcarrental.com'
 ?['v=DKIM1; k=rsa; t=s; p='+key.publicKey.export({type:'spki',format:'der'}).toString('base64')]:[];

test('authenticates the real sender by aligned DKIM, never by From or SPF alone',async()=>{
 const key=keys();
 const raw=await signedMail({key,pdf:Buffer.from('%PDF-1.4')});
 const ok=parseMime(raw);const dkim=await verifyDkim(ok,resolver(key));
 assert.equal(senderVerdict({msg:ok,dkim,authResults:null,domain:'arventcarrental.com'}).ok,true);
 // Spoofed From signed by another domain.
 const other=parseMime(await signedMail({key,domain:'evil.example',pdf:Buffer.from('%PDF')}));
 assert.deepEqual(senderVerdict({msg:other,dkim:await verifyDkim(other,resolver(key)),authResults:null,domain:'arventcarrental.com'}).reasons,['DKIM_NOT_ALIGNED_PASS']);
 // Modified attachment after signing.
 const tampered=parseMime(raw.replace(Buffer.from('%PDF-1.4').toString('base64'),Buffer.from('%PDF-1.5').toString('base64')));
 assert.equal((await verifyDkim(tampered,resolver(key)))[0].reason,'BODY_HASH');
 // Unsigned message with only SPF pass in Zoho's header: refused.
 const unsigned='Authentication-Results: mx.zohomail.eu; spf=pass (zohomail.eu: domain of arventcarrental.com) smtp.mailfrom=info@arventcarrental.com; dmarc=none\r\nFrom: info@arventcarrental.com\r\nSubject: x\r\n\r\nbody\r\n';
 const u=parseMime(unsigned);const ar=trustedAuthResults(u,ZOHO_AUTHSERV);
 assert.equal(ar.spf,'pass');
 assert.equal(senderVerdict({msg:u,dkim:await verifyDkim(u,resolver(key)),authResults:ar,domain:'arventcarrental.com'}).ok,false);
 // Zoho's own topmost DKIM pass counts; a forged header below it does not.
 const zoho='Authentication-Results: mx.zohomail.eu; dkim=pass header.i=arventcarrental.com; spf=pass smtp.mailfrom=info@arventcarrental.com; dmarc=none\r\nFrom: info@arventcarrental.com\r\n\r\nx\r\n';
 assert.equal(senderVerdict({msg:parseMime(zoho),dkim:[],authResults:trustedAuthResults(parseMime(zoho),ZOHO_AUTHSERV),domain:'arventcarrental.com'}).ok,true);
 const forged='Authentication-Results: mx.zohomail.eu; dkim=none; spf=softfail\r\nAuthentication-Results: mx.zohomail.eu; dkim=pass header.i=arventcarrental.com\r\nFrom: info@arventcarrental.com\r\n\r\nx\r\n';
 assert.equal(senderVerdict({msg:parseMime(forged),dkim:[],authResults:trustedAuthResults(parseMime(forged),ZOHO_AUTHSERV),domain:'arventcarrental.com'}).ok,false);
 const foreign='Authentication-Results: attacker.example; dkim=pass header.i=arventcarrental.com\r\nFrom: info@arventcarrental.com\r\n\r\nx\r\n';
 assert.equal(trustedAuthResults(parseMime(foreign),ZOHO_AUTHSERV),null);
 // Delivery stamp: topmost Received, never before the Date header.
 const rcv=parseMime('Received: from mx by mx.zohomail.eu; Fri, 27 Nov 2026 15:28:30 +0000\r\nDate: Fri, 27 Nov 2026 15:28:20 +0000\r\nFrom: a@b\r\n\r\nx');
 assert.equal(deliveredAtMs(rcv),delivered);
 const back=parseMime('Received: from mx by mx.zohomail.eu; Fri, 27 Nov 2026 10:00:00 +0000\r\nDate: Fri, 27 Nov 2026 15:28:20 +0000\r\nFrom: a@b\r\n\r\nx');
 assert.ok(Number.isNaN(deliveredAtMs(back)));
});

function harness({status=0,stripe={ok:true},confirmOk=true,existing=null,wf=workflow(),bk=booking(),text}){
 const calls={confirm:0,finalize:0,alerts:[],updates:[],logged:[]};
 const deps={
  resolveTxt:null,pdfText:async()=>({text,title:TITLE}),
  logMessage:async row=>{calls.logged.push(row);return existing??{id:'m-1',verdict:'received',attempts:0};},
  updateMessage:async(id,patch)=>{calls.updates.push(patch);return true;},
  loadBooking:async ref=>ref==='17BFD74AC95B'?{booking:bk,workflow:wf,quote,evidence:{one_way_fee:0}}:null,
  liveStatus:async()=>{if(status==='down')throw Error('PARTNER_API_ERROR:HTTP:503');
   return {booking_reference:'17BFD74AC95B',supplier_status_type:status,status:status===1?'confirmed':status===3?'cancelled':'pending',
    terms_verified:true,extras_verified:true,needs_manual_review:false,provider_payload:livePayload(status)};},
  stripePaid:async()=>stripe,
  confirm:async(id,b,w,s,resp)=>{calls.confirm++;calls.response=resp;return confirmOk;},
  finalize:async()=>{calls.finalize++;return {voucher:true};},
  alert:async(kind,d)=>calls.alerts.push([kind,d]),
 };
 return {deps,calls};
}

test('end to end: authentic timely PDF with Received status approves once and issues the voucher',async()=>{
 const key=keys();const text=await fixture('unpdf');
 const raw=await signedMail({key,pdf:Buffer.from('%PDF-1.4 real')});
 const {deps,calls}=harness({text});deps.resolveTxt=resolver(key);
 const r=await processArventMail(deps,{source:'admin_upload',mailboxMessageId:'1',receivedAtMs:delivered,raw});
 assert.equal(r.verdict,'approved');assert.equal(r.voucher,true);
 assert.equal(calls.confirm,1);assert.equal(calls.finalize,1);assert.equal(calls.alerts.length,0);
 assert.equal(calls.logged[0].reservation_number,'17BFD74AC95B');assert.match(calls.logged[0].pdf_sha256,/^[a-f0-9]{64}$/);
 assert.equal(calls.response.email_confirmation.source,'supplier_email_pdf');
 assert.equal(calls.response.email_confirmation.delivered_at,new Date(delivered).toISOString());
 // Second delivery of the same message is a no-op (already processed).
 const again=harness({text,existing:{id:'m-1',verdict:'approved'}});again.deps.resolveTxt=resolver(key);
 assert.equal((await processArventMail(again.deps,{source:'admin_upload',mailboxMessageId:'1',receivedAtMs:delivered,raw})).verdict,'approved');
 assert.equal(again.calls.confirm,0);
});

test('end to end: R24-8DE01B (cancelled by Arvent after the PDF) is rejected and the admin is alerted',async()=>{
 const key=keys();const raw=await signedMail({key,pdf:Buffer.from('%PDF')});
 const {deps,calls}=harness({status:3,text:await fixture('unpdf')});deps.resolveTxt=resolver(key);
 const r=await processArventMail(deps,{source:'zoho',mailboxMessageId:'2',receivedAtMs:delivered,raw});
 assert.deepEqual(r.reasons,['SUPPLIER_STATUS_3']);assert.equal(calls.confirm,0);assert.equal(calls.finalize,0);
 assert.equal(calls.alerts[0][0],'ARVENT_EMAIL_REJECTED');
});

test('end to end: refunds, unpaid Stripe, spoofed sender, late delivery and outages never approve',async()=>{
 const key=keys();const text=await fixture('unpdf');const raw=await signedMail({key,pdf:Buffer.from('%PDF')});
 const run=async(opts,extra={})=>{const h=harness({text,...opts});h.deps.resolveTxt=resolver(key);
  return [await processArventMail(h.deps,{source:'zoho',mailboxMessageId:'3',receivedAtMs:delivered,raw,...extra}),h.calls];};
 assert.deepEqual((await run({bk:{...booking(),refund_status:'pending'}}))[0].reasons,['BOOKING_CANCELLED_OR_REFUNDED']);
 assert.deepEqual((await run({wf:{...workflow(),state:'refund_pending'}}))[0].reasons,['WORKFLOW_STATE_REFUND_PENDING']);
 assert.deepEqual((await run({stripe:{ok:false,reason:'REFUNDED_OR_DISPUTED'}}))[0].reasons,['STRIPE_REFUNDED_OR_DISPUTED']);
 assert.deepEqual((await run({},{receivedAtMs:Date.parse('2026-11-29T00:00:00Z')}))[0].reasons,['MISMATCH_DELIVERED_BEFORE_DEADLINE']);
 assert.deepEqual((await run({confirmOk:false}))[0].reasons,['CONFIRM_STATE_CHANGED']);
 const [down,calls]=await run({status:'down'});
 assert.equal(down.verdict,'received');assert.equal(calls.confirm,0);assert.equal(calls.updates.find(u=>'attempts' in u).attempts,1);
 const spoof=harness({text});spoof.deps.resolveTxt=async()=>['v=DKIM1; k=rsa; p='+keys().publicKey.export({type:'spki',format:'der'}).toString('base64')];
 assert.deepEqual((await processArventMail(spoof.deps,{source:'zoho',mailboxMessageId:'4',receivedAtMs:delivered,raw})).reasons,['SENDER_DKIM_NOT_ALIGNED_PASS']);
});

test('timeout cancellation yields to a pending emailed confirmation',async()=>{
 const w={...workflow(),supplier_deadline_at:new Date(Date.now()-60000).toISOString()};
 let cancelled=0,statusRead=0;
 const deps={get:async()=>w,move:async()=>w,status:async()=>{statusRead++;return {status:'pending'};},cancel:async()=>{cancelled++;return null;},
  emailConfirmationPending:async()=>true};
 assert.deepEqual(await advanceApiPayment(deps,w.booking_id),{state:'provider_pending',email_pending:true});
 assert.equal(cancelled+statusRead,0);
 deps.emailConfirmationPending=async()=>{throw Error('db down');};
 assert.equal((await advanceApiPayment(deps,w.booking_id)).email_pending,true);
});

test('database: one atomic approval per booking, by real delivery time, never on held refunds',async()=>{
 const p=new PGlite();
 try {
  const b='163b5fdc-0f33-446d-b71e-52bf8b0db2aa';
  await p.exec(`create role anon; create role authenticated; create role service_role;
   create function is_admin() returns boolean language sql as 'select false';
   create table bookings(id uuid primary key,partner_id uuid,status text,api_booking_reference text,cancelled_at timestamptz,refund_status text);
   create table api_booking_workflows(booking_id uuid primary key,state text,last_error text,updated_at timestamptz,provider_response jsonb,
    provider_reference text,paid_at timestamptz,payment_intent text,prepared_quote jsonb,supplier_received_at timestamptz,supplier_deadline_at timestamptz);
   insert into bookings values('${b}','bf29a373-c464-4cec-87a7-c3218ea1ea51','pending','17BFD74AC95B',null,null);
   insert into api_booking_workflows values('${b}','provider_pending',null,now(),null,'17BFD74AC95B','2026-11-27T15:19:40Z','pi_x',
    '{"provider":"arvent_kolaycar"}','2026-11-27T15:20:02Z','2026-11-28T15:20:02Z');`);
  for(const f of ['20261127190000_api_refund_holds.sql','20261127200000_arvent_email_confirmations.sql'])
   await p.exec(await readFile(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8'));
  const sha='a'.repeat(64);
  const msg=async(id,received)=>(await p.query(`insert into arvent_email_messages(source,mailbox_message_id,received_at,pdf_sha256,reservation_number)
   values('zoho',$1,$2,$3,'17BFD74AC95B') returning id`,[id,received,sha])).rows[0].id;
  const resp=(m,status=0)=>JSON.stringify({status:'confirmed',terms_verified:true,extras_verified:true,needs_manual_review:false,
   booking_reference:'17BFD74AC95B',provider_payload:{reservationStatusType:status},
   email_confirmation:{source:'supplier_email_pdf',message_id:m,pdf_sha256:sha}});
  const confirm=async(m,status=0,r=resp(m,status))=>(await p.query("select arvent_email_confirm($1,$2,'17BFD74AC95B',$3,$4) as ok",[m,b,status,r])).rows[0].ok;
  const late=await msg('late','2026-11-28T15:20:03Z');
  assert.equal(await confirm(late),false,'delivered after the deadline');
  const early=await msg('early','2026-11-27T15:28:30Z');
  assert.equal(await confirm(early,3),false,'cancelled supplier status');
  assert.equal(await confirm(early,0,JSON.stringify({status:'confirmed'})),false,'unverified response');
  await p.query("insert into api_refund_holds(booking_id,reason,created_by) values($1,'held for owner decision','test')",[b]);
  assert.equal(await confirm(early),false,'refund hold');
  await p.exec("update api_refund_holds set released_at=now()");
  // Timeout claim already taken (state left provider_pending): email loses.
  await p.exec("update api_booking_workflows set state='unknown',last_error='ARVENT_TIMEOUT_CANCEL_UNCONFIRMED'");
  assert.equal(await confirm(early),false,'timeout claim won');
  await p.exec("update api_booking_workflows set state='provider_pending',last_error=null");
  assert.equal(await confirm(early),true);
  assert.equal(await confirm(early),false,'idempotent');
  const second=await msg('second','2026-11-27T15:30:00Z');
  await p.exec("update api_booking_workflows set state='provider_pending'");
  await assert.rejects(confirm(second),/duplicate key|unique/,'one approval per booking');
  assert.deepEqual((await p.query("select verdict,booking_id from arvent_email_messages where mailbox_message_id='early'")).rows[0],{verdict:'approved',booking_id:b});
  await p.exec('set role authenticated');
  await assert.rejects(p.query("select arvent_email_confirm($1,$2,'x',0,'{}')",[early,b]),/permission denied/);
 } finally {await p.close();}
});

test('refund hold blocks only the held booking\'s refund transition',async()=>{
 const p=new PGlite();
 try {
  await p.exec(`create role anon; create role authenticated; create role service_role;
   create function is_admin() returns boolean language sql as 'select false';
   create table bookings(id uuid primary key);
   create table api_booking_workflows(booking_id uuid primary key references bookings(id),state text);
   insert into bookings values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
   insert into api_booking_workflows values('00000000-0000-4000-8000-000000000001','refund_pending'),('00000000-0000-4000-8000-000000000002','refund_pending');`);
  await p.exec(await readFile(new URL('../../supabase/migrations/20261127190000_api_refund_holds.sql',import.meta.url),'utf8'));
  await p.exec("insert into api_refund_holds(booking_id,reason,created_by) values('00000000-0000-4000-8000-000000000001','supplier contradicted email','test')");
  await assert.rejects(p.exec("update api_booking_workflows set state='refunding' where booking_id='00000000-0000-4000-8000-000000000001'"),/API_REFUND_ON_HOLD/);
  await p.exec("update api_booking_workflows set state='refunding' where booking_id='00000000-0000-4000-8000-000000000002'");
  await p.exec("update api_refund_holds set released_at=now()");
  await p.exec("update api_booking_workflows set state='refunding' where booking_id='00000000-0000-4000-8000-000000000001'");
 } finally {await p.close();}
});

test('database: the timeout cancellation claim waits for a timely email, never moves the deadline',async()=>{
 const p=new PGlite();
 try {
  const b='163b5fdc-0f33-446d-b71e-52bf8b0db2aa';
  await p.exec(`create role anon; create role authenticated; create role service_role;
   create function is_admin() returns boolean language sql as 'select false';
   create table bookings(id uuid primary key,partner_id uuid,status text,api_booking_reference text,cancelled_at timestamptz,refund_status text);
   create table api_booking_workflows(booking_id uuid primary key,state text,last_error text,updated_at timestamptz,provider_response jsonb,
    provider_reference text,paid_at timestamptz,payment_intent text,prepared_quote jsonb,supplier_received_at timestamptz,supplier_deadline_at timestamptz);
   insert into bookings values('${b}','bf29a373-c464-4cec-87a7-c3218ea1ea51','pending','17BFD74AC95B',null,null);
   insert into api_booking_workflows values('${b}','provider_pending',null,now(),null,'17BFD74AC95B',now()-interval '1 day','pi_x',
    '{"provider":"arvent_kolaycar"}',now()-interval '1 day',now()-interval '2 minutes');`);
  for(const f of ['20261127190000_api_refund_holds.sql','20261127200000_arvent_email_confirmations.sql'])
   await p.exec(await readFile(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8'));
  const claim=()=>p.exec("update api_booking_workflows set state='unknown',last_error='ARVENT_TIMEOUT_CANCELLING'");
  await assert.rejects(claim(),/ARVENT_EMAIL_CONFIRMATION_PENDING/,'polling grace');
  await p.exec("update api_booking_workflows set supplier_deadline_at=now()-interval '10 minutes'");
  await p.exec("insert into arvent_email_messages(source,mailbox_message_id,received_at,reservation_number) values('zoho','late',now()-interval '1 minute','17BFD74AC95B')");
  const timely=(await p.query("insert into arvent_email_messages(source,mailbox_message_id,received_at,reservation_number) values('zoho','t',now()-interval '11 minutes','17BFD74AC95B') returning id")).rows[0].id;
  await assert.rejects(claim(),/ARVENT_EMAIL_CONFIRMATION_PENDING/,'timely email pending');
  await p.query("update arvent_email_messages set verdict='rejected' where id=$1",[timely]);
  await claim();
  assert.equal((await p.query('select state from api_booking_workflows')).rows[0].state,'unknown');
  // Other transitions are unaffected.
  await p.exec("update api_booking_workflows set state='refund_pending'");
 } finally {await p.close();}
});

test('live readback summary from the real 17BFD74AC95B record',async()=>{
 const {arventLiveSummary}=await import('../../supabase/functions/_shared/arvent-confirmation-document.mjs');
 const ctx={booking:booking(),quote,evidence:{one_way_fee:0}};
 const cancelled=arventLiveSummary({...livePayload(3),statusName:'Reservation received(...),Cancelled(...)'},ctx);
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.supplier_status_type,3);
 const ok=arventLiveSummary(livePayload(0),ctx);
 assert.deepEqual([ok.status,ok.terms_verified,ok.extras_verified,ok.needs_manual_review],['pending',true,true,false]);
 assert.equal(arventLiveSummary({...livePayload(0),depositPrice:100},ctx).terms_verified,false);
 assert.equal(arventLiveSummary({...livePayload(0),reservationExtras:[{code:2}]},ctx).extras_verified,false);
 assert.throws(()=>arventLiveSummary(null,ctx),/ARVENT_BOOKING_SHAPE/);
});

test('gmail relay: private mail is dropped unparsed and unstored; Google\'s topmost DKIM verdict counts',async()=>{
 const text=await fixture('unpdf');
 const priv=harness({text});priv.deps.resolveTxt=async()=>{throw Error('must not resolve');};
 const raw='Received: by 2002:a05::1 with SMTP id x; Fri, 27 Nov 2026 15:28:30 +0000\r\nFrom: Bank <alerts@bank.example>\r\nDate: Fri, 27 Nov 2026 15:28:20 +0000\r\nSubject: statement\r\n\r\nprivate\r\n';
 const r=await processArventMail(priv.deps,{source:'gmail',mailboxMessageId:'g1',receivedAtMs:delivered,raw});
 assert.deepEqual(r,{verdict:'ignored',reasons:['NOT_PARTNER_SENDER'],stored:false});
 assert.equal(priv.calls.logged.length,0);
 // A From header listed twice is treated as not the partner, too.
 const twice=raw.replace('From: Bank <alerts@bank.example>','From: info@arventcarrental.com\r\nFrom: x@evil.example');
 assert.equal((await processArventMail(priv.deps,{source:'gmail',mailboxMessageId:'g2',receivedAtMs:delivered,raw:twice})).stored,false);
 const key=keys();
 const signed=await signedMail({key,pdf:Buffer.from('%PDF')});
 const g=harness({text});g.deps.resolveTxt=resolver(key);
 const ok=await processArventMail(g.deps,{source:'gmail',mailboxMessageId:'g3',receivedAtMs:delivered,raw:signed});
 assert.equal(ok.verdict,'approved');
 assert.equal(g.calls.logged[0].source,'gmail');
 const google='Authentication-Results: mx.google.com; dkim=pass header.i=@arventcarrental.com header.s=mail header.b=x; spf=pass smtp.mailfrom=info@arventcarrental.com\r\nFrom: info@arventcarrental.com\r\n\r\nx\r\n';
 const {GOOGLE_AUTHSERV}=await import('../../supabase/functions/_shared/arvent-mail-ingest.mjs');
 const ar=trustedAuthResults(parseMime(google),GOOGLE_AUTHSERV);
 assert.equal(senderVerdict({msg:parseMime(google),dkim:[],authResults:ar,domain:'arventcarrental.com'}).ok,true);
 assert.equal(trustedAuthResults(parseMime(google),ZOHO_AUTHSERV),null,'sources do not trust each other');
});
