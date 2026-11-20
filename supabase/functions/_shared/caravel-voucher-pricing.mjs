// Caravel-only read-only voucher lines from the exact paid supplier quote.
// No client-calculated prices, no added fees, and no amendment to a confirmed booking.
const isObj=x=>!!x&&typeof x==="object"&&!Array.isArray(x);
const cents=n=>(typeof n==="number"||typeof n==="string")&&n!==""&&Number.isFinite(Number(n))?
 Math.round(Number(n)*100):null;
const amt=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000;
const names={young_driver:["Młody kierowca","Young driver"],senior_driver:["Starszy kierowca","Senior driver"],
 one_way:["Zwrot w innym punkcie","One-way return"],out_of_hours:["Obsługa poza godzinami","Out-of-hours service"],
 delivery:["Dostawa lub odbiór","Delivery or collection"],premium_location:["Dopłata za lokalizację","Premium location fee"]};
export function caravelVoucherPricing(booking,quote){
 if(!isObj(booking)||!isObj(quote)||!isObj(quote.raw_response))throw Error("CARAVEL_VOUCHER_SOURCE_UNVERIFIED");
 if(quote.partner_id!==booking.partner_id || quote.booking_id!==booking.id ||
   quote.id!==booking.api_quote_id || quote.currency!==booking.partner_currency ||
   booking.partner_id!=="78721481-7619-44df-a9b7-5faa344b69bb" ||
   quote.external_quote_reference!==booking.caravel_supplier_quote_id)
   throw Error("CARAVEL_VOUCHER_QUOTE_SCOPE_INVALID");
 const data=quote.raw_response.provider_quote_data, bd=data?.price_breakdown;
 if(!isObj(data)||data.provider!=="caravel"||data.payment_model!=="pay_on_arrival"||
   !isObj(bd)||bd.version!==1||bd.currency!=="EUR"||
   !Array.isArray(bd.fees)||!Array.isArray(bd.extras))
   throw Error("CARAVEL_VOUCHER_PRICE_BREAKDOWN_MISSING");
 const base=bd.rental_minor,fees=bd.mandatory_fees_minor,extras=bd.extras_minor,total=bd.total_minor;
 const ride24=cents(quote.commission_total),customer=cents(quote.final_total);
 const partner=cents(quote.partner_net_total),paid=cents(booking.online_payment_pln);
 if(![base,fees,extras,total,ride24,customer,partner,paid].every(amt)||
   base+fees+extras!==total||total!==partner||customer!==total+ride24||
   cents(booking.pickup_payment_partner_currency)!==total||paid===0||
   bd.fees.length+bd.extras.length+2>23)
   throw Error("CARAVEL_VOUCHER_TOTALS_MISMATCH");
 // Same presentation as every other Ride24 partner: the Ride24 fee is part of
 // the customer's rental price (as in the checkout summary), never its own line.
 const items=[{kind:"rental",name_pl:"Wynajem z pakietem Premium",name_en:"Rental with Premium protection",
   customer_cents:base+ride24,partner_cents:base}];
 let mandatorySum=0,extrasSum=0;
 for(const f of bd.fees){
  if(!isObj(f)||!amt(f.amount_minor)||typeof f.label!=="string"||f.label.length>120||
     typeof f.type!=="string"||f.type.length>40)
    throw Error("CARAVEL_VOUCHER_FEE_INVALID");
  mandatorySum+=f.amount_minor;
  const label=names[f.type]||[f.label,f.label];
  items.push({kind:"fee",name_pl:label[0],name_en:label[1],
    customer_cents:f.amount_minor,partner_cents:f.amount_minor});
 }
 for(const e of bd.extras){
  if(!isObj(e)||!amt(e.amount_minor)||typeof e.name_pl!=="string"||e.name_pl.length>120||
    typeof e.name_en!=="string"||e.name_en.length>120||
    !Number.isSafeInteger(e.quantity)||e.quantity<1||e.quantity>9)
    throw Error("CARAVEL_VOUCHER_EXTRA_INVALID");
  extrasSum+=e.amount_minor;
  items.push({kind:"extra",name_pl:e.name_pl,name_en:e.name_en,quantity:e.quantity,billing:"rental",
    customer_cents:e.amount_minor,partner_cents:e.amount_minor});
 }
 if(mandatorySum!==fees||extrasSum!==extras)
   throw Error("CARAVEL_VOUCHER_LINES_MISMATCH");
 return {version:2,currency:"EUR",items,partner_cents:total,gross_cents:customer,commission_cents:ride24,
   loyalty_discount_cents:0,total_cents:customer,online_pln_cents:paid};
}
