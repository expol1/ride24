import { EXTRA_NAMES, calculateBookingItems, cents, customerPricing } from './booking-items.mjs';

export class BookingOptionsError extends Error {
  constructor(code, pl, en, status = 409) { super(pl); this.code = code; this.en = en; this.status = status; }
}
export function quoteChanged() {
  return new BookingOptionsError('QUOTE_CHANGED', 'Cena lub dodatki uległy zmianie. Sprawdź podsumowanie i zaakceptuj je ponownie.', 'The price or extras changed. Review the summary and accept it again.');
}
export async function pricedExtrasEnabled(admin) {
  const {data,error} = await admin.from('booking_feature_flags').select('priced_extras_enabled').eq('id',true).single();
  // Missing configuration is a server failure, never permission to bypass fees.
  if (error || !data) throw new Error('PRICING_CONFIGURATION_UNAVAILABLE');
  return data.priced_extras_enabled === true;
}
export async function loadBookingOptions(admin, partnerId, pickupName, returnName) {
  const [locations,extras] = await Promise.all([
    admin.from('partner_locations').select('id,location_name,extra_fee,extra_fee_amount,return_fee_amount').eq('partner_id',partnerId).eq('active',true).eq('is_api_managed',false),
    admin.from('partner_extras').select('id,code,name_en,name_pl,amount,billing,max_quantity,active').eq('partner_id',partnerId).eq('active',true).order('id'),
  ]);
  if (locations.error || extras.error) throw new Error('BOOKING_OPTIONS_UNAVAILABLE');
  const resolve = (name,kind) => {
    const matches=(locations.data || []).filter(x => x.location_name === name);
    if(matches.length !== 1) throw new BookingOptionsError('LOCATION_UNAVAILABLE','Wybrana lokalizacja nie jest dostępna. Wróć do wyszukiwarki.','This location is unavailable. Return to search.');
    const row=matches[0];
    return {id:row.id,name:row.location_name,amount:kind==='pickup' ? (row.extra_fee===true ? row.extra_fee_amount ?? 0 : 0) : row.return_fee_amount};
  };
  return {pickup:resolve(pickupName,'pickup'),dropoff:resolve(returnName,'return'),catalog:extras.data || []};
}

export function validateDriverExtra(catalog, selections, hasAdditionalDriver) {
  if (!Array.isArray(selections)) throw quoteChanged();
  const driverExtras=catalog.filter(x=>x.active && x.code==='additional_driver');
  if(driverExtras.length > 1) throw new Error('AMBIGUOUS_DRIVER_EXTRA');
  const driverExtra=driverExtras[0];
  const selected=driverExtra && selections.filter(x=>x?.id===driverExtra.id);
  // Existing free-driver flow stays available if the partner has no driver product.
  if(driverExtra && (hasAdditionalDriver ? selected.length!==1 || selected[0].quantity!==1 : selected.length!==0)) {
    throw new BookingOptionsError('DRIVER_EXTRA_MISMATCH','Wybór dodatkowego kierowcy musi odpowiadać dodatkowi w podsumowaniu.','The additional driver must match the extra in your summary.',400);
  }
}

export async function priceFingerprint(snapshot, context) {
  const bytes=new TextEncoder().encode(JSON.stringify({snapshot,context}));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
}
export function pricingContext({userId,carId,startDate,endDate,pickupTime,returnTime,additionalDriverId},options) {
  return {userId,carId,startDate,endDate,pickupTime,returnTime,additionalDriverId:additionalDriverId || null,pickupId:options.pickup.id,returnId:options.dropoff.id};
}
export function publicCatalog(catalog, marginPercent) {
  return catalog.map(x=>{
    const names=Object.hasOwn(EXTRA_NAMES,x.code) ? EXTRA_NAMES[x.code] : {en:x.name_en,pl:x.name_pl || x.name_en};
    const net=cents(x.amount);
    return {id:x.id,code:x.code,name_pl:names.pl,name_en:names.en,billing:x.billing,max_quantity:x.max_quantity,unit_customer_cents:net+Math.round(net*marginPercent/100)};
  });
}
export async function makeBookingQuote({options,selections,hasAdditionalDriver,context,...pricing}) {
  validateDriverExtra(options.catalog,selections,hasAdditionalDriver);
  let snapshot;
  try { snapshot=calculateBookingItems({...pricing,...options,selections}); }
  catch(error) {
    if(error instanceof BookingOptionsError) throw error;
    throw new BookingOptionsError('INVALID_BOOKING_OPTIONS','Wybrane dodatki lub cena nie są już dostępne. Odśwież podsumowanie.','Selected extras or prices are no longer available. Refresh the summary.',400);
  }
  return {snapshot,publicQuote:{enabled:true,pricing:customerPricing(snapshot),fingerprint:await priceFingerprint(snapshot,context),catalog:publicCatalog(options.catalog,pricing.marginPercent)}};
}
export function assertAcceptedQuote(body, quote, options) {
  if(body.pricing_version!==2) {
    if(cents(options.pickup.amount)>0 || cents(options.dropoff.amount)>0 || (body.extras?.length || 0)>0) {
      throw new BookingOptionsError('PRICING_UPDATE_REQUIRED','Zaktualizuj aplikację lub dokończ rezerwację na ride24.pl, aby zobaczyć pełną cenę.','Update the app or book at ride24.pl to review the full price.');
    }
    return false;
  }
  if(typeof body.pricing_fingerprint!=='string' || body.pricing_fingerprint!==quote.fingerprint) throw quoteChanged();
  return true;
}
