import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {projectCaravelBookingDetails,CARAVEL_ID}
  from '../../supabase/functions/_shared/client-caravel-booking-details.mjs';

const bookingId='6ce216bd-93d6-4700-a180-bb2feaa5e3d8';
const quoteId='19fe3a63-8c6d-4026-92f9-6de6a4d7bfd5';
function fixture(){
 const booking={
  id:bookingId,partner_id:CARAVEL_ID,api_quote_id:quoteId,
  partner_currency:'EUR',pickup_payment_partner_currency:58.41,
  final_price_snapshot:60.75,online_payment_pln:10.43,
  deposit_snapshot:0,mileage_limit_snapshot:null,
  main_driver_name:'Jan Testowy',add_driver_name:'Anna Testowa',
  caravel_terms_document_id:'terms-v5',caravel_terms_content_hash:'sha-v5',
  caravel_terms_language:'en',caravel_coverage_damage_admin_fee_minor:10000,
  caravel_coverage_excluded_codes:['glass','tyres_and_wheels']
 };
 const quote={
  id:quoteId,booking_id:bookingId,partner_id:CARAVEL_ID,currency:'EUR',
  partner_net_total:58.41,final_total:60.75,
  raw_response:{provider_quote_data:{
   plan:'premium',protection:{tier:'premium',deposit:{amount:0},
    excess:{amount:0}},
   selected_extras:[{extra_id:'extra_8',quantity:1}],
   price_breakdown:{version:1,currency:'EUR',rental_minor:4741,
    mandatory_fees_minor:1100,extras_minor:0,total_minor:5841,
    fees:[{type:'young_driver',code:'YOUNG_DRIVER',
      label:'Young driver surcharge (additional driver, age 23)',amount_minor:1100}],
    extras:[{extra_id:'extra_8',code:'extra_8',quantity:1,
      name_en:'Additional Driver',name_pl:'Dodatkowy kierowca',amount_minor:0}]}
  }}
 };
 const terms={
  document_id:'terms-v5',content_hash:'sha-v5',language:'en',
  version:5,title:'Terms & Conditions',
  body:{title:'Caravel',clauses:[{number:'1',heading:'Included',
    paragraphs:[[{text:'Premium includes unlimited mileage.'}]]}]}
 };
 return {booking,quote,terms};
}
test('archives every booked supplier price line, including zero-price additional driver',()=>{
 const f=fixture(),d=projectCaravelBookingDetails(f.booking,f.quote,f.terms);
 assert.deepEqual(d.items.map(i=>i.amount_minor),[4741,1100,0]);
 assert.match(d.items[1].name_pl,/Młody kierowca — dodatkowy kierowca, 23 lat/);
 assert.equal(d.items[2].name_pl,'Dodatkowy kierowca');
 assert.equal(d.total_minor,6075);
 assert.equal(d.partner_minor,5841);
 assert.equal(d.online_pln_minor,1043);
 assert.equal(d.terms.version,5);
 assert.equal(d.terms.clauses[0].paragraphs[0],'Premium includes unlimited mileage.');
 assert.equal(d.coverage.premium,true);
 assert.equal(d.coverage.damage_admin_fee_minor,10000);
});
test('cannot use a quote from another owner, another partner or another booking',()=>{
 const f=fixture();
 assert.throws(()=>projectCaravelBookingDetails({...f.booking,id:'another-id'},f.quote,f.terms),/MISMATCH/);
 assert.throws(()=>projectCaravelBookingDetails({...f.booking,partner_id:'elsewhere'},f.quote,f.terms),/MISMATCH/);
 assert.throws(()=>projectCaravelBookingDetails(f.booking,{...f.quote,partner_id:'elsewhere'},f.terms),/MISMATCH/);
 assert.throws(()=>projectCaravelBookingDetails(f.booking,{...f.quote,booking_id:'elsewhere'},f.terms),/MISMATCH/);
});
test('prices cannot be invented from an inconsistent historical provider snapshot',()=>{
 const f=fixture();
 assert.throws(()=>projectCaravelBookingDetails({...f.booking,
  pickup_payment_partner_currency:51.41},f.quote,f.terms),/MISMATCH/);
 assert.throws(()=>projectCaravelBookingDetails({...f.booking,
  final_price_snapshot:120},f.quote,f.terms),/MISMATCH/);
 const changed=fixture();
 changed.quote.raw_response.provider_quote_data.price_breakdown.fees[0].amount_minor=1500;
 const d=projectCaravelBookingDetails(changed.booking,changed.quote,changed.terms);
 assert.equal(d.items,null,'do not show a fabricated incomplete breakdown');
});
test('archived document must match the exact booked version and content hash',()=>{
 const f=fixture();
 assert.equal(projectCaravelBookingDetails(f.booking,f.quote,
  {...f.terms,content_hash:'newer'}).terms,null);
 assert.equal(projectCaravelBookingDetails(f.booking,f.quote,
  {...f.terms,language:'pl'}).terms,null);
});
test('customer details modal safely renders full archived terms and booked extras',()=>{
 const f=fixture(),data=projectCaravelBookingDetails(f.booking,f.quote,f.terms);
 const dom=new JSDOM('<section id="details"></section>',{runScripts:'outside-only',url:'https://ride24.pl/klient'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'))};
 const script=readFileSync(new URL('../../assets/helper/caravelBookingDetails.js',import.meta.url),'utf8');
 dom.window.eval(script);
 const box=dom.window.document.getElementById('details');
 assert.equal(dom.window.Ride24CaravelBookingDetails.render(data,box,false),true);
 const txt=box.textContent;
 for(const v of ['Regulamin Caravel','Pakiet Premium','Jan Testowy','Anna Testowa',
  'Wynajem samochodu','47.41 EUR','11.00 EUR','Dodatkowy kierowca × 1',
  '0.00 EUR','60.75 EUR','10.43 PLN','58.41 EUR'])
  assert.ok(txt.includes(v),'missing booked detail '+v);
 const btn=box.querySelector('.r24-caravel-document-btn');
 btn.click();
 assert.match(dom.window.document.querySelector('.r24-caravel-document-modal').textContent,/Premium includes unlimited mileage/);
});
test('the edge function must authenticate and select only the calling user booking',()=>{
 const src=readFileSync(new URL('../../supabase/functions/client-caravel-booking-details/index.ts',import.meta.url),'utf8');
 assert.match(src,/await authenticatedUser\(req\)/);
 assert.match(src,/\.eq\("client_id",user.id\)/);
 assert.match(src,/\.eq\("booking_id",booking.id\)/);
 assert.match(src,/\.eq\("partner_id",CARAVEL_ID\)/);
 assert.match(src,/Cache-Control/);
});
