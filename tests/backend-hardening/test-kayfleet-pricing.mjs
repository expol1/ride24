import test from "node:test";
import assert from "node:assert/strict";
import {
  kayfleetCounts,kayfleetAssertQuote,kayfleetSnapshot,kayfleetCatalog,
  KAYFLEET_EXTRA_CATALOG,
} from "../../supabase/functions/_shared/kayfleet-pricing.mjs";
const q=(extras={car_seat_qty:0,booster_seat_qty:0,additional_drivers:0},alter={})=>({
  requested_full_insurance:true,insurance_excess:0,deposit_amount:0,currency:"EUR",
  quote_reference:"offline-test-quote",
  quote_expires_at:new Date(Date.now()+20*60_000).toISOString(),
  group_id:"economy",pickup_location:"Larnaca Airport",dropoff_location:"Larnaca Airport",
  days:5,rental_total:166.25,insurance_fee:75,delivery_fee:0,
  equipment_fee:extras.car_seat_qty*15+extras.booster_seat_qty*10,
  additional_driver_fee:extras.additional_drivers*3,
  extras,...alter,
  get grand_total(){return this.rental_total+this.insurance_fee+this.delivery_fee+this.equipment_fee+this.additional_driver_fee;},
});
test("KayFleet supplier quote price is single source for Ride24 PL/EN v2 snapshot",()=>{
  const raw=q({car_seat_qty:1,booster_seat_qty:0,additional_drivers:1});
  const s=kayfleetSnapshot(raw,{marginPercent:25,loyaltyPercent:0,exchangeRate:4.2});
  assert.equal(s.version,2);
  assert.equal(s.currency,"EUR");
  assert.equal(s.partner_cents,25925);
  assert.equal(s.gross_cents,32406);
  assert.equal(s.commission_cents,6481);
  assert.equal(s.online_pln_cents,Math.round(6481*4.2));
  assert.equal(s.items.reduce((n,i)=>n+i.partner_cents,0),s.partner_cents);
  assert.equal(s.items.reduce((n,i)=>n+i.customer_cents,0),s.gross_cents);
  assert.equal(s.items.filter(i=>i.kind==="extra").length,2);
  assert.ok(s.items.some(i=>i.name_pl==="Pełne ubezpieczenie"&&i.name_en==="Full insurance"));
  assert.ok(s.items.some(i=>i.name_pl==="Dodatkowy kierowca"&&i.name_en==="Additional driver"));
});
test("KayFleet loyalty discount only reduces Ride24 fee, never supplier rent",()=>{
  const raw=q();
  const s=kayfleetSnapshot(raw,{marginPercent:25,loyaltyPercent:10,exchangeRate:4.3});
  assert.equal(s.partner_cents,24125);
  assert.equal(s.total_cents,s.gross_cents-s.loyalty_discount_cents);
  assert.equal(s.online_pln_cents,Math.round((s.commission_cents-s.loyalty_discount_cents)*4.3));
});
test("KayFleet rejects missing deposit, insurance, excess, change in extras or incorrect breakdown",()=>{
  for(const bad of [
    {...q(),deposit_amount:undefined},{...q(),deposit_amount:300},
    {...q(),insurance_excess:150},{...q(),requested_full_insurance:false},
    {...q(),insurance_fee:undefined},{...q(),rental_total:-1},
    {...q(),grand_total:240},{...q(),extras:{car_seat_qty:5,booster_seat_qty:0,additional_drivers:0}},
  ])assert.throws(()=>kayfleetAssertQuote(bad),/KAYFLEET_/);
  assert.throws(()=>kayfleetSnapshot(q(),{marginPercent:-1,loyaltyPercent:0,exchangeRate:4.2}),/KAYFLEET_/);
});
test("KayFleet selectors use Ride24 existing id/quantity and bound additional driver",()=>{
  assert.deepEqual(kayfleetCounts([
    {id:"kayfleet:car_seat_qty",quantity:2},
    {id:"kayfleet:booster_seat_qty",quantity:1},
    {id:"kayfleet:additional_drivers",quantity:1},
  ],"driver-uuid"),{car_seat_qty:2,booster_seat_qty:1,additional_drivers:1});
  assert.deepEqual(kayfleetCounts([],"driver-uuid"),
    {car_seat_qty:0,booster_seat_qty:0,additional_drivers:1});
  for(const bad of [
    [[{id:"other",quantity:1}],null],
    [[{id:"kayfleet:car_seat_qty",quantity:3}],null],
    [[{id:"kayfleet:additional_drivers",quantity:1}],null],
    [[{id:"kayfleet:car_seat_qty",quantity:1},{id:"kayfleet:car_seat_qty",quantity:1}],null],
  ])assert.throws(()=>kayfleetCounts(...bad),/KAYFLEET_/);
});
test("KayFleet catalog supplier-unit quote prices never use local extras tariffs",()=>{
  const base=q();
  const quoted={
    car_seat_qty:q({car_seat_qty:1,booster_seat_qty:0,additional_drivers:0}),
    booster_seat_qty:q({car_seat_qty:0,booster_seat_qty:1,additional_drivers:0}),
    additional_drivers:q({car_seat_qty:0,booster_seat_qty:0,additional_drivers:1}),
  };
  const catalog=kayfleetCatalog(base,quoted,25);
  assert.equal(catalog.length,KAYFLEET_EXTRA_CATALOG.length);
  assert.deepEqual(catalog.map(x=>x.unit_customer_cents),[1875,1250,375]);
  assert.deepEqual(catalog.map(x=>x.code),["child_seat","booster_seat","additional_driver"]);
  assert.throws(()=>kayfleetCatalog(base,{...quoted,car_seat_qty:{...quoted.car_seat_qty,insurance_fee:150}},25),/KAYFLEET_/);
});
