// KayFleet prices and extras expressed in Ride24's existing v2 item contract.
// Every amount comes from a validated supplier /quote, NEVER from a local tariff.
export const KAYFLEET_EXTRA_CATALOG = Object.freeze([
  {id:"kayfleet:car_seat_qty",code:"child_seat",field:"car_seat_qty",
    name_pl:"Fotelik dziecięcy",name_en:"Child seat",billing:"rental",max_quantity:2},
  {id:"kayfleet:booster_seat_qty",code:"booster_seat",field:"booster_seat_qty",
    name_pl:"Podstawka dla dziecka",name_en:"Booster seat",billing:"rental",max_quantity:2},
  {id:"kayfleet:additional_drivers",code:"additional_driver",field:"additional_drivers",
    name_pl:"Dodatkowy kierowca",name_en:"Additional driver",billing:"rental",max_quantity:1},
]);
const fail=(code)=>{throw new Error("PARTNER_API_ERROR:KAYFLEET_"+code)};
const cents=(v,label)=>{
  if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>1000000)fail(label);
  const result=Math.round(v*100);
  if(Math.abs(result-v*100)>0.001)fail(label);
  return result;
};
const count=(v,max,label)=>{
  if(!Number.isSafeInteger(v)||v<0||v>max)fail(label);
  return v;
};
export function kayfleetCounts(selections,additionalDriverId) {
  if(!Array.isArray(selections)||selections.length>3)fail("EXTRAS_SELECTION_INVALID");
  const out={car_seat_qty:0,booster_seat_qty:0,additional_drivers:0},seen=new Set();
  for(const selected of selections) {
    const item=KAYFLEET_EXTRA_CATALOG.find(c=>c.id===selected?.id);
    if(!item||seen.has(item.id))fail("EXTRAS_SELECTION_INVALID");
    seen.add(item.id);
    out[item.field]=count(selected.quantity,item.max_quantity,"EXTRAS_QUANTITY_INVALID");
    if(out[item.field]===0)fail("EXTRAS_QUANTITY_INVALID");
  }
  // The web may select a driver before the initial options catalogue arrives.
  // Bind that driver automatically, but never allow the charge without identity.
  if(additionalDriverId && out.additional_drivers===0)out.additional_drivers=1;
  if(!additionalDriverId && out.additional_drivers===1)fail("ADDITIONAL_DRIVER_BINDING");
  return out;
}
export function kayfleetAssertQuote(q,expected={}) {
  if(!q||typeof q!=="object"||Array.isArray(q)||q.requested_full_insurance!==true
    ||q.insurance_excess!==0||q.deposit_amount!==0||q.currency!=="EUR"
    ||typeof q.quote_reference!=="string"||!q.quote_reference
    ||!(Date.parse(q.quote_expires_at)>Date.now()+1000))fail("QUOTE_INVALID");
  if(expected.group_id && q.group_id!==expected.group_id)fail("GROUP_CHANGED");
  if(expected.pickup_location && q.pickup_location!==expected.pickup_location)fail("LOCATION_CHANGED");
  if(expected.dropoff_location && q.dropoff_location!==expected.dropoff_location)fail("LOCATION_CHANGED");
  const x=q.extras;
  if(!x||typeof x!=="object")fail("EXTRAS_UNCONFIRMED");
  for(const c of KAYFLEET_EXTRA_CATALOG) {
    const n=count(x[c.field],c.max_quantity,c.field.toUpperCase());
    if(expected.extras && n!==expected.extras[c.field])fail("EXTRAS_UNCONFIRMED");
  }
  if(!Number.isSafeInteger(q.days)||q.days<1||q.days>366)fail("DAYS_INVALID");
  const parts=["rental_total","insurance_fee","delivery_fee","equipment_fee","additional_driver_fee"]
    .map(key=>cents(q[key],key.toUpperCase()));
  if(parts[1]<=0)fail("INSURANCE_MISSING");
  const total=cents(q.grand_total,"PRICE_INVALID");
  if(total<=0||parts.reduce((a,b)=>a+b,0)!==total)fail("PRICE_MISMATCH");
  return total;
}
// The supplier's test/live quote uses one equipment_fee for seats/boosters.
// Display it as one supplier-priced line rather than inventing a split.
export function kayfleetSnapshot(q,{marginPercent,loyaltyPercent,exchangeRate}) {
  const partner=kayfleetAssertQuote(q);
  if(!Number.isFinite(marginPercent)||marginPercent<0||marginPercent>100
    ||!Number.isFinite(loyaltyPercent)||loyaltyPercent<0||loyaltyPercent>20
    ||!Number.isFinite(exchangeRate)||exchangeRate<=0||exchangeRate>100000)fail("PRICING_CONTEXT");
  const source=[
    ["rental","kayfleet:rental","Wynajem samochodu","Car rental",q.rental_total],
    ["time_fee","kayfleet:insurance","Pełne ubezpieczenie","Full insurance",q.insurance_fee],
    ["pickup","kayfleet:delivery","Dostawa i odbiór","Delivery and collection",q.delivery_fee],
    ["extra","kayfleet:equipment","Foteliki i podkładki","Child seats and boosters",q.equipment_fee],
    ["extra","kayfleet:additional_drivers","Dodatkowy kierowca","Additional driver",q.additional_driver_fee],
  ];
  const items=source.filter(([, , , ,amount],i)=>i<2||amount>0).map(([kind,id,name_pl,name_en,amount])=>({
    kind,id,name_pl,name_en,quantity:1,days:1,billing:"rental",
    partner_cents:cents(amount,String(id)),customer_cents:Math.round(cents(amount,String(id))*(1+marginPercent/100)),
  }));
  const gross=Math.round(partner*(1+marginPercent/100));
  // Exact cent-level reconciliation after supplier/platform rounding.
  items[0].customer_cents+=gross-items.reduce((n,item)=>n+item.customer_cents,0);
  if(items[0].customer_cents<0)fail("ROUNDING_INVALID");
  const commission=gross-partner,discount=Math.round(commission*loyaltyPercent/100);
  const online=Math.round((commission-discount)*exchangeRate);
  if(!Number.isSafeInteger(online)||online<=0)fail("INVALID_ONLINE_FEE");
  return {
    version:2,currency:"EUR",items,
    partner_cents:partner,gross_cents:gross,commission_cents:commission,
    loyalty_discount_cents:discount,total_cents:gross-discount,
    online_pln_cents:online,exchange_rate:exchangeRate,
  };
}
// Price labels are computed from supplier's exact single-item quote for the
// selected period; the final customer price always comes from a fresh /quote.
export function kayfleetCatalog(base,pricedQuotes,marginPercent) {
  const catalog=[];
  kayfleetAssertQuote(base);
  for(const item of KAYFLEET_EXTRA_CATALOG) {
    const q=pricedQuotes?.[item.field];
    if(!q)fail("CATALOG_UNVERIFIED");
    kayfleetAssertQuote(q);
    for(const k of ["rental_total","insurance_fee","delivery_fee"]) {
      if(cents(q[k],k)!==cents(base[k],k))fail("CATALOG_BASE_CHANGED");
    }
    for(const other of KAYFLEET_EXTRA_CATALOG) {
      if(q.extras[other.field] !== (other.field===item.field?1:0))fail("CATALOG_SELECTION_CHANGED");
    }
    const feeKey=item.field==="additional_drivers"?"additional_driver_fee":"equipment_fee";
    const extraCents=cents(q[feeKey],feeKey);
    if(extraCents<=0)fail("CATALOG_PRICE_MISSING");
    if(cents(q.grand_total,"GRAND_TOTAL")-cents(base.grand_total,"BASE_TOTAL")!==extraCents)fail("CATALOG_PRICE_MISMATCH");
    catalog.push({...item,unit_customer_cents:Math.round(extraCents*(1+marginPercent/100)),
      provider_id:item.field,provider_billing:"duration"});
  }
  return catalog;
}
