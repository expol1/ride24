// Staged pricing engine. No production caller until the full v2 rollout passes QA.
export const EXTRA_NAMES = Object.freeze({
  child_seat: { pl: 'Fotelik dziecięcy', en: 'Child seat' },
  booster_seat: { pl: 'Podstawka dla dziecka', en: 'Booster seat' },
  gps: { pl: 'Nawigacja GPS', en: 'GPS navigation' },
  additional_driver: { pl: 'Dodatkowy kierowca', en: 'Additional driver' },
});

export function cents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('INVALID_PRICE');
  if (typeof value === 'string' && !/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('INVALID_PRICE');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error('INVALID_PRICE');
  const result = Math.round((n + Number.EPSILON) * 100);
  if (Math.abs(n * 100 - result) > 0.00001) throw new Error('INVALID_PRICE');
  return result;
}

function integer(value, max) {
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('INVALID_QUANTITY');
  return value;
}

function label(value) {
  if (typeof value !== 'string') throw new Error('INVALID_LABEL');
  const s = value.trim();
  if (!s || s.length > 120 || /[\u0000-\u001f<>]/.test(s)) throw new Error('INVALID_LABEL');
  return s;
}

function timeInWindow(actual, from, until) {
  const seconds = (value) => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) throw new Error('INVALID_TIME');
    const [h,m,s=0] = value.split(':').map(Number);
    return h*3600 + m*60 + s;
  };
  const t=seconds(actual), start=seconds(from), end=seconds(until);
  if(start===end) throw new Error('INVALID_TIME_WINDOW');
  return start<end ? t>=start && t<end : t>=start || t<end;
}

export function calculateBookingItems({ rental, pickup, dropoff, timeRules = [], timeBlocks = [], conditionalFees = [], pickupTime = null, returnTime = null, catalog = [], selections = [], days, marginPercent, loyaltyPercent = 0, currency, exchangeRate }) {
  integer(days, 366);
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_CURRENCY');
  if (!Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent > 100) throw new Error('INVALID_MARGIN');
  if (!Number.isFinite(loyaltyPercent) || loyaltyPercent < 0 || loyaltyPercent > 20) throw new Error('INVALID_LOYALTY');
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || exchangeRate > 100000) throw new Error('INVALID_EXCHANGE_RATE');
  if (!Array.isArray(selections) || selections.length > 20 || !Array.isArray(catalog)) throw new Error('INVALID_SELECTIONS');
  const rentalNet = cents(rental.base_total), rentalFinal = cents(rental.final_total);
  if (rentalNet <= 0 || rentalFinal < rentalNet) throw new Error('INVALID_RENTAL_PRICE');
  const items = [{ kind: 'rental', id: null, name_pl: 'Wynajem samochodu', name_en: 'Car rental', quantity: 1, days, billing: 'rental', partner_cents: rentalNet, customer_cents: rentalFinal }];
  function add(kind, id, names, amount, quantity = 1, billing = 'rental') {
    const units = integer(quantity, 10) * (billing === 'day' ? days : 1);
    const net = cents(amount) * units;
    if (!Number.isSafeInteger(net) || net > 100000000) throw new Error('PRICE_LIMIT');
    const commission = Math.round(net * marginPercent / 100);
    items.push({ kind, id, name_pl: label(names.pl), name_en: label(names.en), quantity, days: billing === 'day' ? days : 1, billing, partner_cents: net, customer_cents: net + commission });
  }
  for (const [kind, location, names] of [
    ['pickup', pickup, { pl: 'Odbiór', en: 'Pickup' }],
    ['return', dropoff, { pl: 'Zwrot', en: 'Return' }],
  ]) {
    if (!location?.id || !location.name) throw new Error('LOCATION_REQUIRED');
    if (cents(location.amount ?? 0) > 0) {
      add(kind, location.id, names, location.amount);
      items.at(-1).location_name = String(location.name).slice(0,250);
    }
  }
  if (!Array.isArray(timeRules) || timeRules.length > 30) throw new Error('INVALID_TIME_RULES');
  // A closed airport/location time can never be booked by paying an extra fee.
  if (!Array.isArray(timeBlocks) || timeBlocks.length > 30) throw new Error('INVALID_TIME_BLOCKS');
  for (const block of timeBlocks) {
    if (block?.active !== true) continue;
    if (!['pickup','return','either'].includes(block.applies_to)) throw new Error('INVALID_TIME_BLOCKS');
    const pickupBlocked = (block.applies_to === 'pickup' || block.applies_to === 'either')
      && (!block.location_id || block.location_id === pickup.id)
      && timeInWindow(pickupTime,block.starts_at,block.ends_at);
    const returnBlocked = (block.applies_to === 'return' || block.applies_to === 'either')
      && (!block.location_id || block.location_id === dropoff.id)
      && timeInWindow(returnTime,block.starts_at,block.ends_at);
    if (pickupBlocked || returnBlocked) throw new Error(pickupBlocked ? 'PICKUP_UNAVAILABLE_TIME' : 'RETURN_UNAVAILABLE_TIME');
  }
  if (!Array.isArray(conditionalFees) || conditionalFees.length > 30) throw new Error('INVALID_CONDITIONAL_FEES');
  const city = (v) => typeof v === 'string' ? v.trim().toLocaleLowerCase('en-US') : '';
  for (const fee of conditionalFees) {
    if(fee?.active !== true) continue;
    if (!['location_either','cross_city'].includes(fee.kind)) throw new Error('INVALID_CONDITIONAL_FEES');
    const matches=fee.kind==='location_either'
      ? fee.location_id && (fee.location_id===pickup.id || fee.location_id===dropoff.id)
      : Array.isArray(fee.city_scope) && city(pickup.city) && city(dropoff.city)
        && city(pickup.city)!==city(dropoff.city)
        && fee.city_scope.some(v=>city(v)===city(pickup.city))
        && fee.city_scope.some(v=>city(v)===city(dropoff.city));
    if(matches) add('conditional_fee',fee.id,{pl:fee.name_pl,en:fee.name_en},fee.amount);
  }
  // Time-dependent fees are mandatory and server-calculated, never customer-selected extras.
  for (const rule of timeRules) {
    if (rule?.active !== true) continue;
    if (!['pickup','return','either'].includes(rule.applies_to) || typeof rule.id !== 'string') throw new Error('INVALID_TIME_RULES');
    const forPickup = (rule.applies_to === 'pickup' || rule.applies_to === 'either')
      && (!rule.location_id || rule.location_id === pickup.id)
      && timeInWindow(pickupTime, rule.starts_at, rule.ends_at);
    const forReturn = (rule.applies_to === 'return' || rule.applies_to === 'either')
      && (!rule.location_id || rule.location_id === dropoff.id)
      && timeInWindow(returnTime, rule.starts_at, rule.ends_at);
    if (!forPickup && !forReturn) continue;
    const count = rule.applies_to === 'either' && rule.once_per_booking === false ? Number(forPickup)+Number(forReturn) : 1;
    const window = String(rule.starts_at).slice(0,5) + '–' + String(rule.ends_at).slice(0,5);
    const name = rule.applies_to === 'pickup' ? ['Odbiór poza godzinami','Out-of-hours pickup']
      : rule.applies_to === 'return' ? ['Zwrot poza godzinami','Out-of-hours return']
      : ['Obsługa poza godzinami','Out-of-hours service'];
    const approval = rule.requires_approval === true ? [' — wymaga uzgodnienia',' — prior approval required'] : ['',''];
    add('time_fee', rule.id, {pl: name[0]+' ('+window+')'+approval[0], en: name[1]+' ('+window+')'+approval[1]}, rule.amount, count);
  }
  const seen = new Set();
  // Canonical order keeps equivalent client selections stable for quote fingerprints.
  for (const selection of [...selections].sort((a,b)=>String(a?.id).localeCompare(String(b?.id)))) {
    if (!selection || typeof selection.id !== 'string' || seen.has(selection.id)) throw new Error('INVALID_SELECTIONS');
    seen.add(selection.id);
    const matches = catalog.filter(e => e.id === selection.id && e.active === true);
    if (matches.length !== 1) throw new Error('EXTRA_UNAVAILABLE');
    const extra = matches[0];
    integer(selection.quantity, Math.min(extra.max_quantity ?? 1, 10));
    if (!['rental', 'day'].includes(extra.billing)) throw new Error('INVALID_BILLING');
    const names = Object.hasOwn(EXTRA_NAMES, extra.code) ? EXTRA_NAMES[extra.code] : { en: extra.name_en, pl: extra.name_pl || extra.name_en };
    add('extra', extra.id, names, extra.amount, selection.quantity, extra.billing);
  }
  const partner = items.reduce((s, x) => s + x.partner_cents, 0);
  const gross = items.reduce((s, x) => s + x.customer_cents, 0);
  const commission = gross - partner;
  const discount = Math.round(commission * loyaltyPercent / 100);
  const onlinePln = Math.round((commission - discount) * exchangeRate);
  if (![partner, gross, onlinePln].every(n => Number.isSafeInteger(n) && n <= 100000000)) throw new Error('PRICE_LIMIT');
  return { version: 2, currency, items, partner_cents: partner, gross_cents: gross,
    commission_cents: commission, loyalty_discount_cents: discount,
    total_cents: gross - discount, online_pln_cents: onlinePln, exchange_rate: exchangeRate };
}

export function partnerItems(snapshot) {
  return snapshot.items.map(({ kind, id, name_pl, name_en, quantity, days, billing, partner_cents, location_name }) => ({ kind, id, name_pl, name_en, quantity, days, billing, amount_cents: partner_cents, ...(location_name ? { location_name } : {}) }));
}

export function customerPricing(snapshot) {
  const { partner_cents, commission_cents, ...publicValue } = snapshot;
  return { ...publicValue, pickup_payment_cents: partner_cents,
    items: snapshot.items.map(({ partner_cents, ...item }) => item) };
}
