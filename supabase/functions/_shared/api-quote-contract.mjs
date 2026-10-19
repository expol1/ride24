import { BookingOptionsError } from './booking-options.mjs';

// API quotes are provider-priced. Never silently combine them with locally
// configured extras/fees: an adapter must first support and reconcile those items.
export async function assertApiPricingCompatible(admin, partnerId) {
  const [locations, ...supplements] = await Promise.all([
    admin.from('partner_locations').select('extra_fee,extra_fee_amount,return_fee_amount')
      .eq('partner_id', partnerId).eq('active', true).limit(10000),
    ...['partner_extras', 'partner_time_fees', 'partner_time_blocks', 'partner_conditional_fees']
      .map(table => admin.from(table).select('id').eq('partner_id', partnerId).eq('active', true).limit(1)),
  ]);
  if ([locations, ...supplements].some(result => result.error || !Array.isArray(result.data))) {
    throw new BookingOptionsError('API_PRICING_UNAVAILABLE',
      'Nie udało się sprawdzić pełnej ceny oferty. Spróbuj ponownie.',
      'Could not verify the full price of this offer. Please try again.', 503);
  }
  const nonZero = value => value != null && Number(value) !== 0;
  if (locations.data.length >= 10000 || locations.data.some(location =>
    (location.extra_fee === true && nonZero(location.extra_fee_amount)) || nonZero(location.return_fee_amount)
  ) || supplements.some(result => result.data.length)) {
    throw new BookingOptionsError('API_PRICING_NOT_READY',
      'Nie możemy teraz potwierdzić pełnej ceny tej oferty. Wybierz inną ofertę.',
      'We cannot currently confirm the full price of this offer. Please choose another offer.');
  }
}

export function assertApiRequestedOptions(body) {
  if (!Array.isArray(body.extras ?? []) || (body.extras?.length || 0)
    || body.pricing_version === 2 || body.additional_driver_id) {
    throw new BookingOptionsError('API_OPTIONS_UNAVAILABLE',
      'Wybrane dodatki nie są dostępne w tej ofercie. Wróć do wyników i wybierz inną ofertę.',
      'The selected extras are unavailable for this offer. Return to results and choose another offer.');
  }
}

function time(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return null;
  return value.length === 5 ? value + ':00' : value;
}
function location(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

export function apiQuoteContext({ pickupTime, returnTime, pickupName, returnName }) {
  const context = { version: 1, pickup_time: time(pickupTime), return_time: time(returnTime),
    pickup_location: location(pickupName), return_location: location(returnName) };
  if (!context.pickup_time || !context.return_time || !context.pickup_location || !context.return_location) {
    throw new Error('INVALID_API_QUOTE_CONTEXT');
  }
  return context;
}

export function assertApiQuoteContext(rawResponse, body) {
  const context = rawResponse?.ride24_context;
  if (!context || context.version !== 1 || !time(body.pickup_time) || !time(body.return_time)
    || context.pickup_time !== time(body.pickup_time) || context.return_time !== time(body.return_time)
    || !context.pickup_location || context.pickup_location !== location(body.pickup_location)
    || !context.return_location || context.return_location !== location(body.return_location ?? body.pickup_location)) {
    throw new BookingOptionsError('API_QUOTE_CHANGED',
      'Termin, godziny lub miejsca tej oferty wymagają ponownej wyceny. Wróć do wyników wyszukiwania.',
      'This offer needs a new quote for its dates, times or locations. Return to the search results.');
  }
}

export function apiPriceTotals(group, days, discountPercent, marginPercent) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 366
    || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 50
    || !Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent > 100) {
    throw new Error('INVALID_API_PRICE');
  }
  const daily = Number(group.public_price);
  if (!Number.isFinite(daily) || daily <= 0) throw new Error('INVALID_API_PRICE');
  const total = group.price_is_total === true ? Number(group.public_price_total) : daily * days;
  if (!Number.isFinite(total) || total <= 0 || total > 1000000) throw new Error('INVALID_API_PRICE');
  // The provider's period total takes precedence over its rounded daily display.
  // Apply the existing discount/margin order before rounding monetary totals.
  const partnerExact = total * (1 - discountPercent / 100);
  const customerExact = partnerExact * (1 + marginPercent / 100);
  const partnerNetTotal = Math.round((partnerExact + Number.EPSILON) * 100) / 100;
  const finalTotal = Math.round((customerExact + Number.EPSILON) * 100) / 100;
  return { partnerNetTotal, finalTotal,
    commissionTotal: Math.round((finalTotal - partnerNetTotal + Number.EPSILON) * 100) / 100,
    partnerNetPerDay: Number((partnerExact / days).toFixed(2)),
    finalPerDay: Number((customerExact / days).toFixed(2)) };
}
