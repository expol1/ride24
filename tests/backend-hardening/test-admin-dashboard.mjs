import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../../admin/index.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://ride24.pl/admin/',runScripts:'outside-only'});
const doc=dom.window.document;
const cardIds=['stat-clients','stat-partners','stat-total','stat-pending','stat-paid','stat-revenue','stat-refunds','stat-messages','stat-pending-refunds','stat-deletions'];
const actions=["switchTab('clients')","switchTab('partners')","openRadarBookings('active')","openRadarBookings('pending')","openRadarBookings('paid')","switchTab('finances')","switchTab('finances')","switchTab('messages')","switchTab('refunds')","switchTab('deletions')"];
const source=html.match(/<script>([\s\S]*?)<\/script>/i)?.[1]||'';
assert.ok(source.includes('async function loadRadarData()'));

const sample={
 profiles:[{id:'c1',role:'client',name:'Anna',email:'anna@example.com',created_at:'2026-10-01T10:00:00Z'},{id:'c2',role:'client',name:'Marta',email:'marta@example.com'},{id:'a1',role:'admin',name:'Admin',email:'admin@example.com'}],
 partners:[{id:'p1',company_name:'Partner ABC',account_status:'active'},{id:'p2',company_name:'Partner XYZ',account_status:'pending'}],
 bookings:[
  {id:'b1',status:'pending',partner_id:'p1',main_driver_name:'Jan',client_email:'jan@example.com',reservation_code:'TEST-1',start_date:'2026-11-01',end_date:'2026-11-04'},
  {id:'b2',status:'accepted',partner_id:'p1',reservation_code:'TEST-2'},
  {id:'b3',status:'awaiting_payment',partner_id:'p1',reservation_code:'TEST-3'},
  {id:'b4',status:'paid',partner_id:'p2',reservation_code:'TEST-4'},
  {id:'b5',status:'cancelled',partner_id:'p2',reservation_code:'TEST-5'},
  {id:'b6',status:'rejected',partner_id:'p2',reservation_code:'TEST-6'},
  {id:'b7',status:'expired',partner_id:'p2',reservation_code:'TEST-7'}
 ],
 contact_messages:[{id:'m1'}]
};
class Query {
 constructor(table){this.table=table;this.filters=[];this.rangeFrom=0;this.rangeTo=99999;this.countRequested=false;}
 select(_columns,options={}){this.countRequested=options.count==='exact';this.head=options.head===true;return this;}
 eq(key,value){this.filters.push(r=>r[key]===value);return this;}
 in(key,values){this.filters.push(r=>values.includes(r[key]));return this;}
 order(){return this;}
 range(a,b){this.rangeFrom=a;this.rangeTo=b;return this;}
 then(resolve,reject){
  const rows=(sample[this.table]||[]).filter(row=>this.filters.every(filter=>filter(row)));
  const value={data:this.head?null:rows.slice(this.rangeFrom,this.rangeTo+1),count:this.countRequested?rows.length:null,error:null};
  return Promise.resolve(value).then(resolve,reject);
 }
}
const db={
 from:table=>new Query(table),
 rpc:async function(name){
  if(name==='admin_get_deletion_requests')return {data:[{id:'c1'}],error:null};
  if(name==='admin_get_refunds')return {data:[{id:'b5'}],error:null};
  throw Error('Unexpected RPC: '+name);
 }
};
const extraction=(begin,end)=>{
 const a=source.indexOf(begin),b=source.indexOf(end,a);
 assert.ok(a>=0&&b>a,'Missing function boundaries '+begin);
 return source.slice(a,b);
};
const counterSource=extraction('const RADAR_ACTIVE_BOOKING_STATUSES=', '        // --- DANE (REZERWACJE) ---');
const loadRadar=new Function('db','document','loadStripeRevenue',counterSource+';return loadRadarData;')(db,doc,()=>{});
const detailSource=extraction('// Read-only drilldowns for dashboard tiles.','       // --- ZARZĄDZANIE PARTNERAMI');
let navigation='';
const handlers=new Function('db','document','escapeHtml','switchTab','RADAR_ACTIVE_BOOKING_STATUSES',
 detailSource+';return {openRadarBookings,setBookingFilter,loadBookingsData,loadClientsData};')(
 db,doc,txt=>String(txt??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 tab=>{navigation=tab;},['pending','accepted','awaiting_payment','paid']);

test('radar has exactly 10 correctly ordered, keyboard-accessible clickable tiles',()=>{
 const cards=[...doc.querySelectorAll('#radar-metrics > button')];
 assert.equal(cards.length,10);
 assert.deepEqual(cards.map(x=>x.querySelector('.stat-value').id),cardIds);
 assert.deepEqual(cards.map(x=>x.getAttribute('onclick')),actions);
 for(const tile of cards){
  assert.equal(tile.type,'button');
  assert.ok(tile.getAttribute('aria-label'));
  assert.ok(tile.classList.contains('stat-card-action'));
 }
});
test('new drilldowns exist with filters, pagination and Stripe breakdown',()=>{
 for(const id of ['view-clients','view-bookings','view-finances','admin-clients-tbody','admin-bookings-tbody','finance-net','finance-gross','finance-refunds','finance-fees']){
  assert.ok(doc.getElementById(id),'Missing '+id);
 }
 assert.deepEqual([...doc.querySelectorAll('#admin-bookings-filter option')].map(x=>x.value),['active','pending','paid','all']);
});
test('exact radar counts exclude historical cancelled/rejected/expired bookings and admins from customers',async()=>{
 await loadRadar();
 const value=id=>doc.getElementById(id).textContent;
 assert.equal(value('stat-clients'),'2');
 assert.equal(value('stat-partners'),'2');
 assert.equal(value('stat-total'),'4');
 assert.equal(value('stat-pending'),'1');
 assert.equal(value('stat-paid'),'1');
 assert.equal(value('stat-messages'),'1');
 assert.equal(value('stat-pending-refunds'),'1');
 assert.equal(value('stat-deletions'),'1');
});
test('client tile presents only client profiles',async()=>{
 await handlers.loadClientsData();
 const table=doc.getElementById('admin-clients-tbody').textContent;
 assert.match(table,/Anna/);assert.match(table,/Marta/);assert.doesNotMatch(table,/admin@example.com/);
 assert.match(doc.getElementById('admin-clients-count').textContent,/2/);
});
test('booking tile navigates to filtered, paginated read-only lists',async()=>{
 handlers.openRadarBookings('pending');assert.equal(navigation,'bookings');
 await handlers.loadBookingsData();
 assert.equal(doc.querySelectorAll('#admin-bookings-tbody tr').length,1);
 assert.match(doc.getElementById('admin-bookings-tbody').textContent,/TEST-1/);
 handlers.setBookingFilter('paid');
 await handlers.loadBookingsData();
 assert.match(doc.getElementById('admin-bookings-tbody').textContent,/TEST-4/);
 handlers.setBookingFilter('active');
 await handlers.loadBookingsData();
 const active=doc.getElementById('admin-bookings-tbody').textContent;
 assert.match(active,/TEST-1/);assert.match(active,/TEST-2/);assert.match(active,/TEST-3/);assert.match(active,/TEST-4/);
 assert.doesNotMatch(active,/TEST-5|TEST-6|TEST-7/);
 handlers.setBookingFilter('all');
 await handlers.loadBookingsData();
 assert.equal(doc.querySelectorAll('#admin-bookings-tbody tr').length,7);
});
test('inline admin JS parses and dashboard is read-only',()=>{
 assert.doesNotThrow(()=>new Function(source));
 assert.ok(!detailSource.includes('.delete('));
 assert.ok(!detailSource.includes('.update('));
});
