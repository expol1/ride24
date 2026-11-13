// Common Ride24 item contract for provider-calculated services. No local tariffs.
const names = {
 'CAR-RENT':['Wynajem samochodu','Car rental'],
 'EQ-BABYSEAT':['Fotelik niemowlęcy (0–9 kg)','Baby seat (0–9 kg)'],
 'EQ-CHILDSEAT':['Fotelik dziecięcy (9–18 kg)','Child seat (9–18 kg)'],
 'EQ-BOOSTER':['Podkładka dla dziecka','Booster seat'],
 'EQ-GPS':['Nawigacja GPS','GPS'], 'EQ-CHAINS':['Łańcuchy śniegowe','Snow chains'],
 'FEE-CB':['Wyjazd za granicę','Cross-border travel'], 'FEE-FERRY':['Przewóz promem','Ferry travel'],
 'FEE-WINTERTIRE':['Opony zimowe','Winter tyres'], 'FEE-GREENCARD':['Zielona karta','Green card'],
 'ADD-DRIVER':['Dodatkowy kierowca','Additional driver'],
 'FEE-DRIVERAGE':['Dopłata za wiek kierowcy','Driver age fee'],
 'FEE-ONEWAY':['Zwrot w innej lokalizacji','One-way fee'],
 'LOC-DELIVERY':['Dostawa samochodu','Vehicle delivery'], 'LOC-COLLECTION':['Odbiór samochodu','Vehicle collection'],
};
export function serviceNames(s) {
 if(s.Code==='FEE-OOH') return /drop|return/i.test(s.AdditionalName||'')
  ? {pl:'Zwrot poza godzinami pracy',en:'Out-of-hours return'}
  : {pl:'Odbiór poza godzinami pracy',en:'Out-of-hours pickup'};
 const n=names[s.Code]; const fallback=String(s.AdditionalName||s.Name||'').trim().slice(0,120);
 if(!fallback&&!n)throw Error('PROVIDER_SERVICE_NAME_MISSING');
 return {pl:n?.[0]||fallback,en:n?.[1]||fallback};
}
export function serviceCents(value) {
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000000)throw Error('PROVIDER_SERVICE_PRICE_MISSING');
 return Math.round((value+Number.EPSILON)*100);
}
export function reconcileAvailabilityServices(offer) {
 const total=serviceCents(offer.Amount), rent=serviceCents(offer.CarRentalAmount);
 const services=offer.IncludedServices??[];
 if(!Array.isArray(services)||services.length>100)throw Error('PROVIDER_SERVICES_INVALID');
 const seen=new Set();
 const items=services.map(s=>{
  if(!Number.isSafeInteger(s.ServiceId)||s.ServiceId<=0||seen.has(s.ServiceId)||s.Prepaid!==false)throw Error('PROVIDER_SERVICES_INVALID');
  seen.add(s.ServiceId); serviceNames(s);
  return serviceCents(s.AmountTotal);
 });
 if(rent+items.reduce((a,b)=>a+b,0)!==total)throw Error('PROVIDER_SERVICES_UNRECONCILED');
 return true;
}
export function selectedServices(model) {
 if(!Array.isArray(model.Services)||model.Services.length>100)throw Error('PROVIDER_SERVICES_INVALID');
 const seen=new Set();
 for(const s of model.Services){if(!Number.isSafeInteger(s.ServiceId)||seen.has(s.ServiceId))throw Error('PROVIDER_SERVICES_INVALID');seen.add(s.ServiceId);}
 const selected=model.Services.filter(s=>s.IsSelected===true);
 const sum=selected.reduce((n,s)=>{
  if(s.Prepaid!==false||s.ServicePrice?.Currency!==model.Currency||!Number.isSafeInteger(s.Quantity)||s.Quantity<1)throw Error('PROVIDER_SERVICES_INVALID');
  return n+serviceCents(s.ServicePrice.AmountTotal);
 },0);
 if(sum!==serviceCents(model.Total))throw Error('PROVIDER_SERVICES_UNRECONCILED');
 return selected;
}
export function unconfirmedServicePrice(s) {
 const p=s.ServicePrice;
 // A zero amount alone is not an explicit promise of a free optional service.
 return !p || typeof p.Amount!=='number' || !Number.isFinite(p.Amount) || p.Amount<0
  || (p.Amount===0 && p.FreeOfCharge!==true && p.IncludedInPriceUnlimited!==true && p.IncludedInPriceLimited!==true);
}
export function providerServiceCatalog(model,margin=0) {
 return model.Services.filter(s=>!s.IsRent&&!s.IsMandatory&&!s.IsSelected&&s.Code!=='UNSPECIFIED'&&!String(s.Code).startsWith('INS-')).flatMap(s=>{
  const p=s.ServicePrice;
  if(s.Prepaid!==false||p?.Currency!==model.Currency||unconfirmedServicePrice(s))return [];
  const n=serviceNames(s); const max=s.IsQuantityEditable===true&&Number.isSafeInteger(s.MaximumQuantity)&&s.MaximumQuantity>0?Math.min(s.MaximumQuantity,20):1;
  // Amount is for one unit for the entire quoted period, not a daily tariff.
  return [{id:String(s.ServiceId),code:s.Code==='ADD-DRIVER'?'additional_driver':s.Code,
   name_pl:n.pl,name_en:n.en,billing:'rental',max_quantity:max,
   unit_customer_cents:Math.round(serviceCents(p.Amount)*(1+margin/100)),provider_id:String(s.ServiceId),
   max_billed_days:p.MaxDurationMeasuringUnitForPayment,provider_billing:p.IsOneTimePayment?'once':'duration'}];
 });
}
export function applyProviderSelections(model,selections) {
 if(!Array.isArray(selections)||selections.length>20)throw Error('INVALID_PROVIDER_SELECTION');
 const next=structuredClone(model), catalog=providerServiceCatalog(model),seen=new Set();
 for(const x of selections){const allowed=catalog.find(s=>s.id===x?.id);
  if(!allowed||seen.has(x.id)||!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>allowed.max_quantity)throw Error('INVALID_PROVIDER_SELECTION');
  seen.add(x.id);const s=next.Services.find(s=>String(s.ServiceId)===x.id);s.IsSelected=true;s.Quantity=x.quantity;
 }
 return next;
}
export function verifySelectedServices(requested,calculated) {
 selectedServices(calculated);
 for(const s of requested.Services.filter(s=>s.IsSelected)){
  const actual=calculated.Services.find(x=>x.ServiceId===s.ServiceId&&x.IsSelected);
  if(!actual||actual.Quantity!==s.Quantity)throw Error('PROVIDER_SELECTION_NOT_CONFIRMED');
  if(s.IsMandatory===false && !s.IsRent && unconfirmedServicePrice(actual))throw Error('PROVIDER_SERVICE_PRICE_UNCONFIRMED');
 }
}
export function providerPricingSnapshot(model,{marginPercent,loyaltyPercent,exchangeRate,days}) {
 if(!Number.isFinite(marginPercent)||marginPercent<0||marginPercent>100||!Number.isFinite(loyaltyPercent)||loyaltyPercent<0||loyaltyPercent>20||!Number.isFinite(exchangeRate)||exchangeRate<=0)throw Error('PROVIDER_PRICING_INVALID');
 const services=selectedServices(model);
 if(services.length>23)throw Error('PROVIDER_TOO_MANY_ITEMS');
 const partner=serviceCents(model.Total),gross=Math.round(partner*(1+marginPercent/100));
 const items=services.map(s=>{const n=serviceNames(s),net=serviceCents(s.ServicePrice.AmountTotal);return {
  kind:s.IsRent?'rental':s.IsMandatory?'time_fee':'extra',id:String(s.ServiceId),provider_service_id:String(s.ServiceId),
  name_pl:n.pl,name_en:n.en,quantity:s.Quantity,days:s.IsRent?days:1,billing:'rental',partner_cents:net,customer_cents:Math.round(net*(1+marginPercent/100))};});
 const rounding=gross-items.reduce((n,s)=>n+s.customer_cents,0); if(items.length)items[0].customer_cents+=rounding;
 const commission=gross-partner,discount=Math.round(commission*loyaltyPercent/100);
 return {version:2,currency:model.Currency,items,partner_cents:partner,gross_cents:gross,commission_cents:commission,loyalty_discount_cents:discount,total_cents:gross-discount,online_pln_cents:Math.round((commission-discount)*exchangeRate),exchange_rate:exchangeRate};
}
