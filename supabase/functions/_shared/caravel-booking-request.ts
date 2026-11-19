/**
 * Caravel-only entry into Ride24's existing booking pipeline (same bookings
 * table, same create_checkout_session, same signed stripe-webhook, same shared
 * API fulfilment and voucher). It exists only because Caravel needs a
 * server-rendered terms/coverage consent BEFORE Stripe, which the generic
 * create-booking-request (that keeps refusing Caravel) does not have.
 *
 * actions:
 *  consent-view {api_quote_id, lang}  -> terms (verified clauses/v1), exclusions,
 *                                        admin fee, money split, echo object
 *  book {api_quote_id, driver_id?, consent, lang}
 *                                     -> verifies consent + driver + FX, then
 *                                        public.caravel_commit_pending_booking
 * Fails closed with 409 while the release gate is closed.
 */
import {loadCaravelRelease, CARAVEL_PARTNER_ID, type CaravelRelease} from "./caravel-release.ts";
import {buildCaravelConsentView, buildCaravelCommitPayload, caravelQuoteFacts, type CaravelConsentView} from "./caravel-consent.ts";
import {caravelSnapshotChoices,type CaravelExtra,type CaravelExtraChoice} from "./caravel-extra-selection.ts";

type Rec = Record<string, unknown>;
type Db = {from(table: string): any; rpc(name: string, args: Rec): any};
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export type CaravelRequestDeps = {
  admin: Db;
  userId: string; userEmail: string | null;
  /** PLN per 1 unit of currency from NBP; must throw instead of guessing. */
  exchangeRate: (currency: string) => Promise<number>;
  release?: CaravelRelease; nowMs?: number;
  /** Re-issue the same selection for another main-driver age (production client). */
  requote?: (quoteRow: Rec, driverAge: number, release: CaravelRelease, selections?:CaravelExtraChoice[]) => Promise<{ok: true; apiQuoteId: string} | {ok: false; reason: string}>;
  /** Authenticated read-only supplier catalog; caller verifies supplier identity. */
  extrasCatalog?: (release:CaravelRelease) => Promise<{catalog:CaravelExtra[];unavailable:Array<{name:string;reason:string}>}>;
};
export type CaravelRequestResult = {status: number; body: Rec};
const out = (status: number, body: Rec): CaravelRequestResult => ({status, body});

/** NBP mid rate, tables A then B; NO hard-coded fallback for Caravel. */
export async function nbpRateStrict(currency: string, fetcher: typeof fetch = fetch): Promise<number> {
  if (currency === "PLN") return 1;
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("CARAVEL_FX_CURRENCY_INVALID");
  for (const table of ["A", "B"]) {
    const r = await fetcher(`https://api.nbp.pl/api/exchangerates/rates/${table}/${currency}/?format=json`,
      {headers: {Accept: "application/json"}, redirect: "error", signal: AbortSignal.timeout(6000)});
    if (r.status === 404) continue;
    if (!r.ok) throw new Error("CARAVEL_FX_UNAVAILABLE");
    const mid = Number((await r.json())?.rates?.[0]?.mid);
    if (Number.isFinite(mid) && mid > 0) return mid;
    throw new Error("CARAVEL_FX_UNAVAILABLE");
  }
  throw new Error("CARAVEL_FX_UNAVAILABLE");
}

/** Display the same NBP-converted Ride24 booking fee as the other partners.
 * Preview only: the actual PLN amount is independently captured by the
 * atomic Caravel booking after customer confirmation.
 */
async function withPlnPreview(view: CaravelConsentView | null, deps: CaravelRequestDeps): Promise<CaravelConsentView | null> {
  if (!view) return null;
  try {
    const rate = await deps.exchangeRate(view.money.ride24_fee_currency);
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 1000) return null;
    const minor = Math.round(view.money.ride24_fee_minor * rate);
    if (!Number.isSafeInteger(minor) || minor <= 0) return null;
    return {...view, money: {...view.money,
      ride24_fee_pln_minor: minor, ride24_fee_pln: `${(minor / 100).toFixed(2)} PLN`}};
  } catch { return null; }
}
const unavailablePln = () => out(503, {code:"CARAVEL_FX_UNAVAILABLE",
  error:"Nie udało się pobrać kursu PLN. Spróbuj ponownie przed rezerwacją.",
  error_en:"PLN exchange rate is unavailable. Please retry before booking."});

async function loadQuote(admin: Db, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const {data, error} = await admin.from("api_quotes")
    .select("id,partner_id,car_class_id,external_group_id,external_quote_reference,partner_net_total,commission_total,final_total,currency,expires_at,start_date,end_date,booking_id,used_at,pickup_location_external_id,dropoff_location_external_id,raw_response")
    .eq("id", id).eq("partner_id", CARAVEL_PARTNER_ID).maybeSingle();
  return error ? null : data;
}

export async function handleCaravelBookingRequest(deps: CaravelRequestDeps, input: unknown): Promise<CaravelRequestResult> {
  const body = rec(input);
  const action = body?.action;
  const lang = body?.lang === "en" ? "en" : "pl";
  if (!body || !["consent-view","book","extras-catalog","extras-requote"].includes(String(action))) return out(400, {code: "BAD_REQUEST"});
  const release = deps.release ?? await loadCaravelRelease(deps.admin);
  if ("reason" in release) return out(409, {code: "CARAVEL_CERTIFICATION_PENDING", reason: release.reason,
    error: "Oferty Caravel są chwilowo niedostępne. Wybierz inną ofertę.", error_en: "Caravel reservations are not yet available."});
  const now = deps.nowMs ?? Date.now();
  const quote = await loadQuote(deps.admin, body.api_quote_id);
  if (!quote || !caravelQuoteFacts(quote, release, now))
    return out(409, {code: "CARAVEL_QUOTE_EXPIRED", error: "Oferta wygasła. Wyszukaj ponownie.", error_en: "The offer expired. Please search again."});
  if (action === "consent-view") {
    const view = buildCaravelConsentView(quote, release, lang, now);
    if (!view) return out(409, {code: "CARAVEL_QUOTE_EXPIRED"});
    const priced = await withPlnPreview(view, deps);
    return priced ? out(200, {success:true, consent:priced}) : unavailablePln();
  }
  if (action === "extras-catalog") {
    if (!deps.extrasCatalog) return out(503,{code:"CARAVEL_EXTRAS_NOT_AVAILABLE"});
    try {
      const extra = await deps.extrasCatalog(release);
      return out(200,{success:true,catalog:extra.catalog,unavailable:extra.unavailable});
    } catch {
      return out(503,{code:"CARAVEL_EXTRAS_REFERENCE_UNAVAILABLE",
        error:"Nie można pobrać katalogu dodatków Caravel. Wybór nie jest dostępny.",
        error_en:"Caravel extras catalog is temporarily unavailable."});
    }
  }
  if (action === "extras-requote") {
    const choices=caravelSnapshotChoices(body.extras);
    if(!choices || !deps.requote) return out(400,{code:"CARAVEL_EXTRA_SELECTION_INVALID"});
    const facts=caravelQuoteFacts(quote,release,now);
    if(!facts)return out(409,{code:"CARAVEL_QUOTE_EXPIRED"});
    const response=await deps.requote(quote as Rec,facts.driverAge,release,choices);
    const next=response.ok ? await loadQuote(deps.admin,response.apiQuoteId):null;
    const view=next?buildCaravelConsentView(next,release,lang,now):null;
    const priced=view?await withPlnPreview(view,deps):null;
    return priced?out(200,{success:true,consent:priced,api_quote_id:priced.api_quote_id}):
      out(view?503:409,view?{code:"CARAVEL_FX_UNAVAILABLE",
        error:"Nie udało się przeliczyć opłaty Ride24 na PLN. Spróbuj ponownie.",
        error_en:"The Ride24 fee could not be converted to PLN. Please retry."}:{code:"CARAVEL_EXTRA_QUOTE_UNAVAILABLE",
        error:"Nie udało się potwierdzić dodatków i ceny u Caravel. Nic nie zostało dodane.",
        error_en:"Caravel could not confirm your extras and price. No extras were added."});
  }

  // --- book ---
  const {data: profile} = await deps.admin.from("profiles").select("name,phone,age").eq("id", deps.userId).maybeSingle();
  let name = clean(rec(profile)?.name, 120), age = Number(rec(profile)?.age);
  const phone = clean(rec(profile)?.phone, 80), email = clean(deps.userEmail, 254);
  if (body.additional_driver_id) return out(400, {code: "CARAVEL_ADDITIONAL_DRIVER_UNSUPPORTED",
    error: "Dodatkowy kierowca nie jest jeszcze obsługiwany dla Caravel.", error_en: "Additional drivers are not yet supported for Caravel."});
  if (body.driver_id != null && body.driver_id !== "") {
    if (typeof body.driver_id !== "string" || !UUID.test(body.driver_id)) return out(400, {code: "INVALID_DRIVER"});
    const {data: d} = await deps.admin.from("drivers").select("id,user_id,name,age").eq("id", body.driver_id).maybeSingle();
    if (!rec(d) || rec(d)!.user_id !== deps.userId) return out(403, {code: "INVALID_DRIVER"});
    name = clean(rec(d)!.name, 120); age = Number(rec(d)!.age);
  }
  if (!name || !phone || !email || !Number.isInteger(age)) return out(400, {code: "PROFILE_INCOMPLETE",
    error: "Uzupełnij profil przed rezerwacją", error_en: "Complete your profile before booking"});
  const facts = caravelQuoteFacts(quote, release, now)!;
  if (age !== facts.driverAge) {
    // Caravel prices the driver's age band: never book on another age's price.
    const again = deps.requote && Number.isInteger(age) && age >= 18 && age <= 90
      ? await deps.requote(quote as Rec, age, release) : null;
    const fresh = again && again.ok ? await loadQuote(deps.admin, again.apiQuoteId) : null;
    const view = fresh ? buildCaravelConsentView(fresh, release, lang, now) : null;
    const priced = view ? await withPlnPreview(view, deps) : null;
    return out(409, priced ? {code: "CARAVEL_REQUOTED_FOR_DRIVER_AGE", api_quote_id: priced.api_quote_id, consent: priced,
        error: "Cena została przeliczona dla wieku kierowcy. Sprawdź nową cenę i warunki, a następnie potwierdź ponownie.",
        error_en: "The price was recalculated for the driver's age. Review the new price and terms, then confirm again."}
      : {code: "CARAVEL_DRIVER_AGE_NOT_OFFERED", error: "Ta oferta nie jest dostępna dla wieku tego kierowcy.",
        error_en: "This offer is not available for this driver's age."});
  }
  const ctxRaw = rec(rec(quote.raw_response)?.ride24_context);
  const pickupTime = clean(ctxRaw?.pickup_time, 8), returnTime = clean(ctxRaw?.return_time, 8);
  const locs = await deps.admin.from("partner_locations").select("id,external_id,location_name,active,is_api_managed")
    .eq("partner_id", CARAVEL_PARTNER_ID).in("external_id",
      [...new Set([quote.pickup_location_external_id, quote.dropoff_location_external_id])]);
  const rows = (locs?.data ?? []) as Rec[];
  const pick = rows.find((l) => l.external_id === quote.pickup_location_external_id && l.active === true && l.is_api_managed === true);
  const drop = rows.find((l) => l.external_id === quote.dropoff_location_external_id && l.active === true && l.is_api_managed === true);
  if (locs?.error || !pick || !drop || !pickupTime || !returnTime) return out(409, {code: "CARAVEL_QUOTE_EXPIRED"});
  let rate: number;
  try { rate = await deps.exchangeRate(String(quote.currency)); }
  catch { return out(503, {code: "CARAVEL_FX_UNAVAILABLE", error: "Kurs waluty jest chwilowo niedostępny. Spróbuj za chwilę.",
    error_en: "The exchange rate is temporarily unavailable. Please retry shortly."}); }
  const built = buildCaravelCommitPayload(quote, release, body.consent, {
    clientId: deps.userId, clientEmail: email, clientPhone: phone, mainDriverName: name, mainDriverAge: age,
    pickupLocationId: String(pick.id), dropoffLocationId: String(drop.id),
    pickupLocationName: String(pick.location_name), returnLocationName: String(drop.location_name),
    pickupTime, returnTime, exchangeRate: rate}, now);
  if ("code" in built) {
    const msg: Record<string, [string, string]> = {
      CARAVEL_TERMS_CONSENT_STALE_OR_MISSING: ["Regulamin lub warunki ochrony zmieniły się albo nie zostały zaakceptowane. Przeczytaj je ponownie.",
        "The terms or protection conditions changed or were not accepted. Please review them again."],
      CARAVEL_DRIVER_AGE_REQUOTE_REQUIRED: ["Cena dotyczyła innego wieku kierowcy. Wyszukaj ponownie z właściwym wiekiem.",
        "The price was quoted for a different driver age. Please search again with the correct age."],
    };
    const [pl, en] = msg[built.code] ?? ["Nie udało się utworzyć rezerwacji.", "Could not create the booking."];
    return out(409, {code: built.code, error: pl, error_en: en});
  }
  const {data: bookingId, error} = await deps.admin.rpc("caravel_commit_pending_booking",
    {p_quote_id: quote.id, p_client_id: deps.userId, p_payload: built.payload});
  if (error || typeof bookingId !== "string")
    return out(409, {code: "CARAVEL_BOOKING_NOT_CREATED", detail: String(error?.message ?? "").slice(0, 80),
      error: "Nie udało się utworzyć rezerwacji. Wyszukaj ponownie.", error_en: "Could not create the booking. Please search again."});
  return out(200, {success: true, booking: {id: bookingId}, payment_required: true});
}
