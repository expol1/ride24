// Arvent-only supplier extras pricing. Never infer numeric extraRentalType enums.
// A billing map must be explicitly certified for this Arvent account; the
// catalogue alone cannot establish price, quantity or confirmed availability.
const safeCents = v => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000 ||
      Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw Error("ARVENT_EXTRA_PRICE_INVALID");
  return Math.round(v * 100);
};
export function arventBillingMode(rawType, certifiedMap = {}) {
  const key=typeof rawType==="string" ? rawType.trim().toLowerCase() :
    Number.isInteger(rawType) ? String(rawType) : "";
  const knownDay=new Set(["day","daily","per_day","per-day","perday"]);
  const knownRental=new Set(["booking","rental","one_time","one-time","once","fixed","per_rental","per-rental"]);
  if (knownDay.has(key)) return "day";
  if (knownRental.has(key)) return "rental";
  // Never assume the meanings of the supplier's numeric enums.
  const mapped=Object.hasOwn(certifiedMap,key) ? certifiedMap[key] : null;
  return mapped==="day" || mapped==="rental" ? mapped : null;
}
export function arventPricedExtrasCatalog(items, certifiedMap = {}, certified = false) {
  if (!Array.isArray(items) || items.length > 250) throw Error("ARVENT_EXTRAS_INVALID");
  return items.map(x => {
    const mode=arventBillingMode(x.billing_type, certifiedMap);
    const valid=typeof x.code==="string" && /^[a-z0-9_-]{1,60}$/i.test(x.code) &&
      typeof x.price_eur==="number" && Number.isFinite(x.price_eur) &&
      x.price_eur>=0 && x.price_eur<=100000 &&
      Math.abs(x.price_eur*100-Math.round(x.price_eur*100))<1e-6;
    const maxQuantity=x.code==="2" ? 1 :
      x.quantity_increasable===true && Number.isInteger(x.max_quantity) && x.max_quantity>=1
        ? Math.min(x.max_quantity,10) : 1;
    return {...x, billing:mode, max_quantity:maxQuantity,
      bookable:certified===true && valid && (mode!==null || x.price_eur===0)};
  });
}
export function arventSelectedExtrasQuote({
  items, selections, billedDays, certifiedMap={}, certified=false, additionalDriverId=null
}) {
  if(!Number.isInteger(billedDays)||billedDays<1||billedDays>366 ||
     !Array.isArray(selections)||selections.length>20)
    throw Error("ARVENT_EXTRAS_SELECTION_INVALID");
  const catalog=arventPricedExtrasCatalog(items,certifiedMap,certified);
  const byCode=new Map(catalog.map(x=>[x.code,x]));
  if(byCode.size!==catalog.length)throw Error("ARVENT_EXTRAS_DUPLICATE");
  const chosen=new Map();
  for(const entry of selections){
    if(!entry || typeof entry.id!=="string" || !Number.isInteger(entry.quantity) ||
      chosen.has(entry.id))throw Error("ARVENT_EXTRAS_SELECTION_INVALID");
    const item=byCode.get(entry.id);
    if(!item?.bookable || entry.quantity<1 || entry.quantity>item.max_quantity)
      throw Error("ARVENT_EXTRAS_NOT_PRICED");
    chosen.set(entry.id,entry.quantity);
  }
  if(Boolean(additionalDriverId)!==chosen.has("2"))
    throw Error("ARVENT_EXTRA_DRIVER_SELECTION_MISMATCH");
  // A mandatory item is included even when the customer did not select it.
  for(const item of catalog){
    if(item.required){
      if(!item.bookable)throw Error("ARVENT_REQUIRED_EXTRA_UNPRICED");
      if(!chosen.has(item.code))chosen.set(item.code,1);
    }
  }
  const result=[];
  let total=0;
  for(const [code,quantity] of [...chosen].sort(([a],[b])=>a.localeCompare(b))){
    const item=byCode.get(code);
    const mode=item.billing || "rental"; // zero-price extras only
    const unitCents=safeCents(item.price_eur);
    const amountCents=unitCents*quantity*(mode==="day"?billedDays:1);
    if(!Number.isSafeInteger(amountCents)||amountCents>10000000)
      throw Error("ARVENT_EXTRA_PRICE_LIMIT");
    total+=amountCents;
    if(total>10000000)throw Error("ARVENT_EXTRA_PRICE_LIMIT");
    result.push({code,quantity,billing:mode,days:mode==="day"?billedDays:1,
      unit_cents:unitCents,total_cents:amountCents,
      name:typeof item.name==="string"?item.name.slice(0,120):code,
      required:item.required===true,kind:code==="2"?"additional_driver":"extra"});
  }
  return {items:result,total_cents:total,selected:result.map(x=>({code:x.code,piece:x.quantity}))};
}
// Quote all amounts as integer cents; the separate Ride24 booking fee
// stays unchanged, and every Arvent extra is payable to Arvent at pickup.
export function arventBookingTotals({rentalCents,ride24FeeCents,extrasCents,loyaltyPercent,nbpRate}) {
  if(![rentalCents,ride24FeeCents,extrasCents].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=100000000) ||
     !Number.isFinite(nbpRate)||nbpRate<=0||
     !Number.isFinite(loyaltyPercent)||loyaltyPercent<0||loyaltyPercent>20)
    throw Error("ARVENT_BOOKING_TOTAL_INVALID");
  const pickupCents=rentalCents+extrasCents;
  const grossCents=pickupCents+ride24FeeCents;
  if(!Number.isSafeInteger(grossCents)||grossCents>100000000)throw Error("ARVENT_BOOKING_TOTAL_INVALID");
  const discountCents=Math.round(ride24FeeCents*loyaltyPercent/100);
  const onlinePlnCents=Math.round(Number(((ride24FeeCents/100)*nbpRate*(1-loyaltyPercent/100)).toFixed(2))*100);
  return {partner_cents:pickupCents,gross_cents:grossCents,commission_cents:ride24FeeCents,
    loyalty_discount_cents:discountCents,total_cents:grossCents-discountCents,
    online_pln_cents:onlinePlnCents,exchange_rate:nbpRate};
}
