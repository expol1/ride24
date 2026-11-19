/**
 * Caravel pre-Stripe customer consent: what the customer is SHOWN (built by
 * the server from the released, re-hashed terms + the server-issued quote) and
 * how the echoed acceptance is VERIFIED before the atomic booking RPC
 * (public.caravel_commit_pending_booking re-checks every field in SQL).
 *
 * Wording rules (Ride24 policy, 18 Nov 2026):
 *  - Premium is included in the rental price; deposit 0 and excess 0 only as
 *    confirmed by the quote; no "full insurance" claim while anything is excluded;
 *  - every excluded code is listed; the admin fee is stated exactly;
 *  - Stripe takes only the separate Ride24 booking fee; the rental is paid to
 *    Caravel at pickup; a vehicle CATEGORY is booked, not a model.
 */
import {renderCaravelTermsHtml} from "./caravel-terms-canonical.ts";
import type {CaravelRelease} from "./caravel-release.ts";
import {CARAVEL_PARTNER_ID} from "./caravel-release.ts";
import {caravelSnapshotChoices} from "./caravel-extra-selection.ts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Labels for Caravel protection_coverage_codes; unknown codes are shown verbatim, never hidden. */
export const CARAVEL_COVERAGE_LABELS: Readonly<Record<string, {pl: string; en: string}>> = Object.freeze({
  glass: {pl: "szyby", en: "glass"},
  tyres_and_wheels: {pl: "opony i koła", en: "tyres and wheels"},
  undercarriage: {pl: "podwozie", en: "undercarriage"},
  mirrors: {pl: "lusterka", en: "mirrors"},
  interior: {pl: "wnętrze pojazdu", en: "interior"},
  roof: {pl: "dach", en: "roof"},
  keys: {pl: "kluczyki", en: "keys"},
  immobilisation: {pl: "unieruchomienie pojazdu", en: "immobilisation"},
  wrong_fuel: {pl: "zatankowanie niewłaściwego paliwa", en: "wrong fuel"},
  administration_fee: {pl: "opłata administracyjna", en: "administration fee"},
  unauthorised_driver: {pl: "kierowca nieupoważniony", en: "unauthorised driver"},
  off_road_use: {pl: "jazda poza drogami utwardzonymi", en: "off-road use"},
  driving_under_influence: {pl: "jazda pod wpływem alkoholu lub środków odurzających", en: "driving under the influence"},
  ferry_or_sea_transport: {pl: "transport promem lub drogą morską", en: "ferry or sea transport"},
  cross_border_use: {pl: "wyjazd za granicę", en: "cross-border use"},
  bodywork: {pl: "karoseria", en: "bodywork"},
  theft: {pl: "kradzież", en: "theft"},
  fire: {pl: "pożar", en: "fire"},
  third_party_liability: {pl: "OC wobec osób trzecich", en: "third-party liability"},
  roadside_assistance: {pl: "pomoc drogowa", en: "roadside assistance"},
  towing_and_recovery: {pl: "holowanie", en: "towing and recovery"},
});
const label = (code: string, lang: "pl" | "en") => CARAVEL_COVERAGE_LABELS[code]?.[lang] ?? code;
// Only provider-returned, already reconciled amounts are shown to the customer.
const CARAVEL_FEE_NAMES: Record<string, {pl:string;en:string}> = {
  young_driver: {pl:"Młody kierowca",en:"Young driver"},
  senior_driver: {pl:"Starszy kierowca",en:"Senior driver"},
  one_way: {pl:"Zwrot w innym punkcie",en:"One-way return"},
  out_of_hours: {pl:"Obsługa poza godzinami pracy",en:"Out-of-hours service"},
  premium_location: {pl:"Dopłata za lokalizację",en:"Premium location fee"},
  delivery: {pl:"Dostawa lub odbiór",en:"Delivery or collection"},
};

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

export type CaravelQuoteRow = {
  id: string; partner_id: string; car_class_id: string; external_quote_reference: string;
  partner_net_total: number | string; commission_total: number | string; final_total: number | string;
  currency: string; expires_at: string; start_date: string; end_date: string;
  booking_id?: string | null; used_at?: string | null; raw_response: unknown;
};

/** Server-side reading of a Caravel api_quotes row; null if it is not a releasable Caravel quote. */
export function caravelQuoteFacts(row: unknown, release: CaravelRelease, nowMs = Date.now()) {
  if (!release.open) return null;
  const q = rec(row) as CaravelQuoteRow | null;
  const data = rec(rec(q?.raw_response)?.provider_quote_data);
  const prot = rec(data?.protection);
  const minor = rec(data?.amounts_minor);
  const excludes = prot?.excludes, covers = prot?.covers, drivers = data?.drivers;
  if (!q || q.partner_id !== CARAVEL_PARTNER_ID || q.booking_id || q.used_at || !data || data.provider !== "caravel" ||
      data.quote_id !== q.external_quote_reference || data.payment_model !== "pay_on_arrival" || data.plan !== "premium" ||
      data.terms_document_id !== release.terms.documentId || data.terms_content_hash !== release.terms.contentHash ||
      data.terms_language !== release.terms.language || data.supplier_id !== release.terms.supplierId ||
      !Array.isArray(excludes) || !Array.isArray(covers) || !Number.isSafeInteger(minor?.total) ||
      minor?.pay_now !== 0 || minor?.pay_at_pickup !== minor?.total ||
      !Array.isArray(drivers) || drivers.length !== 1 || !Number.isSafeInteger(rec(drivers[0])?.age) ||
      !Number.isFinite(Date.parse(q.expires_at)) || Date.parse(q.expires_at) <= nowMs + 10 * 60_000)
    return null;
  const fee = Number(q.commission_total);
  if (!Number.isFinite(fee) || fee <= 0) return null;
  const adminFee = Number.isSafeInteger(data.damage_administration_fee_minor) ? data.damage_administration_fee_minor as number : null;
  if (excludes.length > 0 && adminFee === null) return null;
  // Legacy quotes may have no detailed lines; new quotes must have a complete
  // reconciliation before any financial breakdown is shown.
  const rawBreakdown = data.price_breakdown;
  const bd = rec(rawBreakdown);
  const choices = caravelSnapshotChoices(data.selected_extras ?? []);
  if(!choices)return null;
  const feeItems = Array.isArray(bd?.fees) ? bd.fees.map(rec) : null;
  const extraItems = Array.isArray(bd?.extras) ? bd.extras.map(rec) : [];
  const extrasOk = extraItems.length === choices.length && extraItems.length <= 12 &&
    extraItems.every(e=>e &&
      typeof e.extra_id==="string" && typeof e.code==="string" && e.code.length<=128 &&
      typeof e.name_pl==="string" && e.name_pl.length<=140 &&
      typeof e.name_en==="string" && e.name_en.length<=140 &&
      Number.isSafeInteger(e.quantity) && Number.isSafeInteger(e.amount_minor) && Number(e.amount_minor)>=0 &&
      choices.some(c=>c.extra_id===e.extra_id && c.quantity===e.quantity)) &&
    extraItems.reduce((sum,e)=>sum+Number(e!.amount_minor),0)===bd?.extras_minor;
  const validBreakdown = bd?.version === 1 && bd.currency === q.currency &&
    Number.isSafeInteger(bd.rental_minor) && (bd.rental_minor as number) >= 0 &&
    Number.isSafeInteger(bd.mandatory_fees_minor) && (bd.mandatory_fees_minor as number) >= 0 &&
    Number.isSafeInteger(bd.extras_minor) && (bd.extras_minor as number)>=0 &&
    extrasOk && bd.total_minor === minor!.total &&
    (bd.rental_minor as number) + (bd.mandatory_fees_minor as number) +
      (bd.extras_minor as number) === minor!.total &&
    feeItems !== null && feeItems.length <= 30 &&
    feeItems.every(x => x &&
      typeof x.type === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(x.type) &&
      typeof x.label === "string" && x.label.length <= 180 &&
      typeof x.code === "string" && x.code.length <= 128 &&
      Number.isSafeInteger(x.amount_minor) && (x.amount_minor as number) >= 0) &&
    feeItems.reduce((s,x) => s + Number(x!.amount_minor), 0) === bd.mandatory_fees_minor;
  if (rawBreakdown !== undefined && !validBreakdown) return null;
  if (choices.length>0 && !validBreakdown) return null;
  if (Number(q.partner_net_total) !== Number(minor!.total) / 100) return null;
  return {quote: q, data, excludes: excludes as string[], covers: covers as string[], rentalMinor: minor!.total as number,
    breakdown: validBreakdown ? bd : null,
    currency: String(q.currency), feeMajor: fee, driverAge: rec(drivers[0])!.age as number, adminFeeMinor: adminFee};
}

export type CaravelConsentView = {
  api_quote_id: string; supplier_quote_id: string; expires_at: string;
  terms: {document_id: string; content_hash: string; language: string; version: number; title: string; html: string};
  coverage: {covers: Array<{code: string; label: string}>; excluded: Array<{code: string; label: string}>;
    full_insurance_claim_allowed: boolean; deposit_minor: 0; excess_minor: 0;
    damage_admin_fee_minor: number | null; damage_admin_fee_currency: "EUR" | null;
    exclusion_clause_refs: string[]; admin_fee_clause_ref: string | null};
  money: {rental_at_pickup: string; rental_at_pickup_minor: number; rental_currency: string;
    customer_total: string; customer_total_minor: number; ride24_fee_minor: number;
    ride24_fee: string; ride24_fee_currency: string; ride24_fee_pln?: string;
    ride24_fee_pln_minor?: number; charged_by_stripe: "ride24_fee_only";
    breakdown?: {rental_base:string; fee_total:string; extras_total:string; partner_total:string;
      fees:Array<{label:string; original_label:string; type:string; amount:string}>;
      extras:Array<{extra_id:string;name:string;quantity:number;amount:string}>}};
  driver_age: number;
  statements: string[];
  /** Exactly what the client must echo back with accepted:true. */
  echo: {terms_document_id: string; terms_content_hash: string; terms_language: string;
    excluded_codes: string[]; damage_admin_fee_minor: number | null};
};

export function buildCaravelConsentView(row: unknown, release: CaravelRelease, lang: "pl" | "en", nowMs = Date.now()): CaravelConsentView | null {
  const f = caravelQuoteFacts(row, release, nowMs);
  if (!f || !release.open) return null;
  const t = release.terms;
  const pl = lang === "pl";
  const at = money(f.rentalMinor, f.currency);
  const ride24FeeMinor = Math.round(f.feeMajor * 100);
  const customerMinor = f.rentalMinor + ride24FeeMinor;
  // Keep the summary consistent with the exact gross stored in api_quotes.
  if (!Number.isSafeInteger(customerMinor) ||
      Math.round(Number(f.quote.final_total) * 100) !== customerMinor) return null;
  const bd = f.breakdown;
  const breakdown = bd ? {
    rental_base:money(Number(bd.rental_minor), f.currency),
    fee_total:money(Number(bd.mandatory_fees_minor), f.currency),
    extras_total:money(Number(bd.extras_minor), f.currency),
    partner_total:at,
    extras:(Array.isArray(bd.extras)?bd.extras:[]).map((x:unknown)=>{
      const e=rec(x)!;return {
        extra_id:String(e.extra_id),name:String(pl?e.name_pl:e.name_en),
        quantity:Number(e.quantity),amount:money(Number(e.amount_minor),f.currency),
      };
    }),
    fees:(bd.fees as Array<{type:string;label:string;amount_minor:number}>).map(x => ({
      label:CARAVEL_FEE_NAMES[x.type]?.[lang] || x.label || (pl ? "Opłata Caravel" : "Caravel fee"),
      original_label:x.label,
      type:x.type,
      amount:money(x.amount_minor, f.currency),
    })),
  } : undefined;
  const ref = (k: string, fallback = "") => t.keyClauseRefs?.[k] ? (pl ? ` (pkt ${t.keyClauseRefs[k]})` : ` (clause ${t.keyClauseRefs[k]})`) : fallback;
  const statements = [
    pl ? `Rezerwujesz kategorię pojazdu, nie konkretny model.` : `You are booking a vehicle category, not a specific model.`,
    pl ? `Cenę wynajmu ${at} płacisz Caravel przy odbiorze${t.noCardRequired ? ", gotówką lub kartą Visa/Mastercard (kredytową albo debetową) wystawioną na głównego kierowcę" : ""}. Stripe pobiera wyłącznie osobną opłatę rezerwacyjną Ride24 — nie płacisz dwa razy.`
       : `You pay the rental price of ${at} to Caravel at pickup${t.noCardRequired ? ", in cash or by Visa/Mastercard (credit or debit) in the main driver's name" : ""}. Stripe charges only the separate Ride24 booking fee — you never pay twice.`,
    pl ? `Pakiet Premium jest wliczony w cenę wynajmu: depozyt 0, udział własny 0 i udział własny przy kradzieży 0 według tej wyceny.`
       : `Premium protection is included in the rental price: deposit 0, excess 0 and theft excess 0 according to this quote.`,
  ];
  if (t.noCardRequired)
    statements.push(pl ? `Karta kredytowa ani depozyt nie są wymagane przy pakiecie Premium${ref("no_card")}.`
      : `No credit card and no deposit are needed on the Premium package${ref("no_card")}.`);
  if (f.excludes.length) {
    statements.push(pl
      ? `Ochrona NIE obejmuje: ${f.excludes.map((c) => label(c, "pl")).join(", ")}. Nie jest to pełne ubezpieczenie bez wyłączeń.`
      : `Protection does NOT cover: ${f.excludes.map((c) => label(c, "en")).join(", ")}. This is not full cover without exclusions.`);
    if (f.adminFeeMinor && f.adminFeeMinor > 0)
      statements.push(pl
        ? `W razie szkody lub kradzieży Caravel pobiera opłatę administracyjną ${money(f.adminFeeMinor, "EUR")} za wynajem (nie za każde zdarzenie), także przy pakiecie Premium${t.adminFeeClauseRef ? ` (pkt ${t.adminFeeClauseRef} regulaminu)` : ""}.`
        : `If the vehicle is damaged or stolen, Caravel charges an administration fee of ${money(f.adminFeeMinor, "EUR")} per rental (not per incident), also on Premium${t.adminFeeClauseRef ? ` (clause ${t.adminFeeClauseRef})` : ""}.`);
  }
  if (t.keyClauseRefs?.post_return)
    statements.push(pl
      ? `Kwoty należne po zwrocie (szkody poza ochroną, opłata administracyjna, mandaty itp.) płacisz przy zwrocie gotówką lub kartą; kwoty ustalone później Caravel fakturuje na głównego kierowcę, płatne od razu po otrzymaniu faktury${ref("post_return")}.`
      : `Amounts owed after return (damage outside the cover, the administration fee, fines, etc.) are paid at return in cash or by card; amounts identified later are invoiced to the main driver and due on receipt${ref("post_return")}.`);
  if (t.keyClauseRefs?.fines)
    statements.push(pl
      ? `Mandaty, parkingi, opłaty drogowe i podobne należności obciążają najemcę i są przekazywane wraz z opłatą administracyjną za obsługę${ref("fines")}.`
      : `Traffic fines, parking, tolls and similar charges remain the renter's and are passed on with an administrative handling fee${ref("fines")}.`);
  if (t.freeCancellationUntilPickup)
    statements.push(pl
      ? `Rezerwację u Caravel można bezpłatnie anulować do momentu odbioru${ref("cancellation")}. Zwrot opłaty rezerwacyjnej Ride24 odbywa się zgodnie z regulaminem Ride24.`
      : `The Caravel booking can be cancelled free of charge until pickup${ref("cancellation")}. Refund of the Ride24 booking fee follows the Ride24 terms.`);
  return {
    api_quote_id: f.quote.id, supplier_quote_id: f.quote.external_quote_reference, expires_at: f.quote.expires_at,
    terms: {document_id: t.documentId, content_hash: t.contentHash, language: t.language, version: t.version,
      title: t.title, html: renderCaravelTermsHtml(t.body)},
    coverage: {covers: f.covers.map((c) => ({code: c, label: label(c, lang)})),
      excluded: f.excludes.map((c) => ({code: c, label: label(c, lang)})),
      full_insurance_claim_allowed: f.excludes.length === 0, deposit_minor: 0, excess_minor: 0,
      damage_admin_fee_minor: f.excludes.length ? f.adminFeeMinor : null,
      damage_admin_fee_currency: f.excludes.length ? "EUR" : null,
      exclusion_clause_refs: t.exclusionClauseRefs, admin_fee_clause_ref: t.adminFeeClauseRef},
    money: {rental_at_pickup: at, rental_at_pickup_minor: f.rentalMinor, rental_currency: f.currency,
      customer_total: money(customerMinor, f.currency), customer_total_minor: customerMinor, ride24_fee_minor: ride24FeeMinor,
      ride24_fee: `${f.feeMajor.toFixed(2)} ${f.currency}`, ride24_fee_currency: f.currency, charged_by_stripe: "ride24_fee_only",
      ...(breakdown ? {breakdown} : {})},
    driver_age: f.driverAge, statements,
    echo: {terms_document_id: t.documentId, terms_content_hash: t.contentHash, terms_language: t.language,
      excluded_codes: [...f.excludes], damage_admin_fee_minor: f.excludes.length ? f.adminFeeMinor : null},
  };
}

export type CaravelBookingContext = {
  clientId: string; clientEmail: string; clientPhone: string; mainDriverName: string; mainDriverAge: number;
  pickupLocationId: string; dropoffLocationId: string; pickupLocationName: string; returnLocationName: string;
  pickupTime: string; returnTime: string; exchangeRate: number;
};

/**
 * Verify the echoed consent against what the server would show NOW, then build
 * the exact payload caravel_commit_pending_booking re-checks in SQL.
 * Any version change of the terms (different id/hash) invalidates the old consent.
 */
export function buildCaravelCommitPayload(row: unknown, release: CaravelRelease, consent: unknown,
  ctx: CaravelBookingContext, nowMs = Date.now()): {ok: true; payload: Rec} | {ok: false; code: string} {
  const f = caravelQuoteFacts(row, release, nowMs);
  if (!f || !release.open) return {ok: false, code: "CARAVEL_QUOTE_NOT_BOOKABLE"};
  const c = rec(consent);
  const shown = [...f.excludes].sort();
  const echoed = Array.isArray(c?.excluded_codes) ? [...(c!.excluded_codes as unknown[])].map(String).sort() : null;
  if (!c || c.accepted !== true || c.coverage_acknowledged !== true ||
      c.terms_document_id !== release.terms.documentId || c.terms_content_hash !== release.terms.contentHash ||
      c.terms_language !== release.terms.language || !echoed || JSON.stringify(echoed) !== JSON.stringify(shown) ||
      (c.damage_admin_fee_minor ?? null) !== (f.excludes.length ? f.adminFeeMinor : null))
    return {ok: false, code: "CARAVEL_TERMS_CONSENT_STALE_OR_MISSING"};
  // The supplier priced this exact age; another age is a different price (requote).
  if (ctx.mainDriverAge !== f.driverAge) return {ok: false, code: "CARAVEL_DRIVER_AGE_REQUOTE_REQUIRED"};
  if (!UUID.test(ctx.clientId) || !UUID.test(ctx.pickupLocationId) || !UUID.test(ctx.dropoffLocationId) ||
      !ctx.clientEmail.includes("@") || !ctx.clientPhone.trim() || ctx.mainDriverName.trim().split(/\s+/).length < 2 ||
      !(Number.isFinite(ctx.exchangeRate) && ctx.exchangeRate > 0))
    return {ok: false, code: "CARAVEL_CUSTOMER_INVALID"};
  const online = Math.round(f.feeMajor * ctx.exchangeRate * 100) / 100;
  const payload: Rec = {
    client_id: ctx.clientId, car_class_id: f.quote.car_class_id, partner_id: CARAVEL_PARTNER_ID, api_quote_id: f.quote.id,
    caravel_supplier_quote_id: f.quote.external_quote_reference, caravel_supplier_id: release.terms.supplierId,
    caravel_terms_document_id: release.terms.documentId, caravel_terms_content_hash: release.terms.contentHash,
    caravel_terms_language: release.terms.language, terms_accepted: true,
    start_date: f.quote.start_date, end_date: f.quote.end_date, pickup_time: ctx.pickupTime, return_time: ctx.returnTime,
    pickup_location_id: ctx.pickupLocationId, dropoff_location_id: ctx.dropoffLocationId,
    pickup_location: ctx.pickupLocationName, return_location: ctx.returnLocationName,
    exchange_rate_snapshot: ctx.exchangeRate, online_payment_pln: online,
    main_driver_name: ctx.mainDriverName.trim(), main_driver_age: ctx.mainDriverAge,
    client_email: ctx.clientEmail.trim(), client_phone: ctx.clientPhone.trim(),
  };
  if (f.excludes.length) Object.assign(payload, {
    // Must equal the stored protection.excludes array exactly (SQL compares jsonb).
    caravel_coverage_excluded_codes: f.excludes, caravel_coverage_terms_document_id: release.terms.documentId,
    caravel_coverage_terms_content_hash: release.terms.contentHash, caravel_coverage_supplier_id: release.terms.supplierId,
    caravel_coverage_quote_id: f.quote.external_quote_reference, caravel_coverage_damage_admin_fee_minor: f.adminFeeMinor,
  });
  return {ok: true, payload};
}
