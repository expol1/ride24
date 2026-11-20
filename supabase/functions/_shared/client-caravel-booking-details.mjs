// Read-only customer projection. Never recalculates a provider price or modifies a booking.
export const CARAVEL_ID = '78721481-7619-44df-a9b7-5faa344b69bb';
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const cents = n => {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 1e6) return null;
  const c = Math.round(v * 100);
  return Math.abs(v * 100 - c) <= .0001 ? c : null;
};
const money = n => Number.isSafeInteger(n) && n >= 0 && n <= 100000000;
const str = (v, max = 180) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0,max) : '';
const FEE_NAMES = {
  young_driver:['Młody kierowca','Young driver'],
  senior_driver:['Starszy kierowca','Senior driver'],
  additional_driver:['Dodatkowy kierowca','Additional driver'],
  one_way:['Zwrot w innym punkcie','One-way return'],
  out_of_hours:['Obsługa poza godzinami pracy','Out-of-hours service'],
  premium_location:['Dopłata za lokalizację','Premium location fee'],
  delivery:['Dostawa / odbiór','Delivery / collection']
};
function feeName(fee) {
  const kind = str(fee.type,40);
  const original = str(fee.label,180);
  let pl = FEE_NAMES[kind]?.[0] || original || 'Dopłata Caravel';
  let en = FEE_NAMES[kind]?.[1] || original || 'Caravel surcharge';
  if (kind === 'young_driver' || kind === 'senior_driver') {
    const age = original.match(/additional driver,\s*age\s*(\d{2})/i);
    if (age) pl += ' — dodatkowy kierowca, ' + age[1] + ' lat';
  }
  if (kind === 'out_of_hours') {
    if (/pickup/i.test(original)) pl = 'Odbiór poza godzinami pracy';
    if (/dropoff/i.test(original)) pl = 'Zwrot poza godzinami pracy';
  }
  return {pl,en};
}
function readTerms(booking, terms) {
  if (!terms || terms.document_id !== booking.caravel_terms_document_id ||
      terms.content_hash !== booking.caravel_terms_content_hash ||
      terms.language !== booking.caravel_terms_language) return null;
  const body=obj(terms.body);
  if (!body || !Array.isArray(body.clauses) || body.clauses.length < 1 ||
      body.clauses.length > 100) return null;
  const clauses=[];
  for (const clause of body.clauses) {
    const c=obj(clause);
    if (!c || !Array.isArray(c.paragraphs)) return null;
    const paragraphs=[];
    for (const paragraph of c.paragraphs) {
      if (!Array.isArray(paragraph)) return null;
      const text=paragraph.map(run => str(obj(run)?.text,3000)).filter(Boolean).join('');
      if (text) paragraphs.push(text.slice(0,5000));
    }
    clauses.push({number:str(c.number,15),heading:str(c.heading,200),paragraphs:paragraphs.slice(0,70)});
  }
  return {title:str(terms.title,180),version:terms.version,language:str(terms.language,8),clauses};
}
export function projectCaravelBookingDetails(booking, quote, terms = null) {
  const b=obj(booking), q=obj(quote);
  if (!b || b.partner_id !== CARAVEL_ID || !q || q.id !== b.api_quote_id ||
      q.partner_id !== CARAVEL_ID || q.booking_id !== b.id) throw new Error('CARAVEL_BOOKING_QUOTE_MISMATCH');
  const cur=str(b.partner_currency,3) || str(q.currency,3);
  if (!/^[A-Z]{3}$/.test(cur) || q.currency !== cur) throw new Error('CARAVEL_CURRENCY_MISMATCH');
  const provider=obj(obj(q.raw_response)?.provider_quote_data);
  const bd=obj(provider?.price_breakdown);
  const pickup=cents(b.pickup_payment_partner_currency);
  const gross=cents(b.final_price_snapshot);
  const quotedGross=cents(q.final_total);
  const quotedPickup=cents(q.partner_net_total);
  const onlinePln=cents(b.online_payment_pln);
  if ([pickup,gross,quotedGross,quotedPickup,onlinePln].some(v => !money(v)) ||
      pickup !== quotedPickup || gross !== quotedGross || gross < pickup)
    throw new Error('CARAVEL_BOOKED_AMOUNTS_MISMATCH');
  let items=null;
  // Only show individual prices when the original quote remains fully reconciled.
  if (bd && bd.version === 1 && bd.currency === cur &&
      money(bd.rental_minor) && money(bd.mandatory_fees_minor) &&
      money(bd.extras_minor) && money(bd.total_minor) &&
      bd.total_minor === pickup && Array.isArray(bd.fees) &&
      Array.isArray(bd.extras) && Array.isArray(provider.selected_extras) &&
      bd.fees.length <= 30 && bd.extras.length <= 12 &&
      bd.extras.length === provider.selected_extras.length) {
    const candidate = [{kind:'rental',name_pl:'Wynajem samochodu',name_en:'Car rental',
      amount_minor:bd.rental_minor,quantity:1}];
    let sum=bd.rental_minor, ok=true, feeSum=0,extraSum=0;
    for (const fee of bd.fees) {
      const f=obj(fee);
      if (!f || !money(f.amount_minor) || !str(f.type,40)) {ok=false;break;}
      const n=feeName(f);
      candidate.push({kind:'fee',name_pl:n.pl,name_en:n.en,
        amount_minor:f.amount_minor,quantity:1});
      sum+=f.amount_minor;feeSum+=f.amount_minor;
    }
    if (ok) for (const extra of bd.extras) {
      const e=obj(extra);
      if (!e || !money(e.amount_minor) || !Number.isSafeInteger(e.quantity) ||
          e.quantity < 1 || e.quantity > 10 ||
          !provider.selected_extras.some(x=>x.extra_id===e.extra_id && x.quantity===e.quantity)) {
        ok=false;break;
      }
      candidate.push({kind:'extra',name_pl:str(e.name_pl,140) || str(e.name_en,140),
        name_en:str(e.name_en,140) || str(e.name_pl,140),
        amount_minor:e.amount_minor,quantity:e.quantity});
      sum+=e.amount_minor;extraSum+=e.amount_minor;
    }
    if(ok && sum===pickup && feeSum===bd.mandatory_fees_minor &&
       extraSum===bd.extras_minor) items=candidate;
  }
  const protection=obj(provider?.protection);
  const exclusions=Array.isArray(b.caravel_coverage_excluded_codes)
    ? b.caravel_coverage_excluded_codes.map(x=>str(x,50)).filter(Boolean).slice(0,40)
    : [];
  return {
    booking_id:b.id,kind:'caravel',currency:cur,items,
    total_minor:gross,partner_minor:pickup,online_pln_minor:onlinePln,
    deposit_minor:cents(b.deposit_snapshot),
    mileage_unlimited:b.mileage_limit_snapshot == null || b.mileage_limit_snapshot === 0,
    main_driver:str(b.main_driver_name,180),additional_driver:str(b.add_driver_name,180),
    coverage:{
      premium:provider?.plan === 'premium' && protection?.tier === 'premium',
      deposit_minor:cents(protection?.deposit?.amount),
      excess_minor:cents(protection?.excess?.amount),
      damage_admin_fee_minor:b.caravel_coverage_damage_admin_fee_minor,
      excluded_codes:exclusions
    },
    terms:readTerms(b,terms)
  };
}
