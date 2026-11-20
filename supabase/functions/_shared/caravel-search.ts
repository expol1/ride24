/**
 * Caravel real-time offers for Ride24 search (production only, release gate open).
 * GET /v1/availability (Premium rows only) -> pre-select a protection that passes
 * the Ride24 policy with the operator-reviewed exclusions -> issueVerifiedCaravelQuote
 * (POST /v1/quote, strict Premium/zero-risk/pay_on_arrival checks, Ride24 fee from
 * the global platform margin, terms bound to the quote, api_quotes row written).
 * Returns ONLY quotes that passed issuance; the card is built by search-api.
 */
import {issueVerifiedCaravelQuote} from "./caravel-quote-issuance.ts";
import {selectCaravelPremiumProtection} from "./caravel-normalize.ts";
import type {CaravelClient} from "./caravel-sandbox-adapter.ts";
import {caravelSafeExtraCatalog,caravelSnapshotChoices,type CaravelExtraChoice} from "./caravel-extra-selection.ts";
import type {CaravelRelease} from "./caravel-release.ts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => !!v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;

/** "YYYY-MM-DDTHH:MM:00±hh:mm" for a local wall-clock time in an IANA zone. */
export function caravelLocalInstant(date: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  try {
    const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
    const fmt = new Intl.DateTimeFormat("en-US", {timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit"});
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let guess = wall;
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
      const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      guess += wall - shown;
    }
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` !== date || `${p.hour}:${p.minute}` !== time) return null; // DST gap
    const off = Math.round((wall - guess) / 60000), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
    return `${date}T${time}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  } catch { return null; }
}

export type CaravelSearchOffer = {
  carClassId: string; apiQuoteId: string; vehicleId: string; supplierQuoteId: string; expiresAt: string;
  rentalMinor: number; feeMinor: number; customerMinor: number; currency: string;
  excludes: string[]; covers: string[]; adminFeeMinor: number | null;
};

export async function searchCaravelOffers(args: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  client: Pick<CaravelClient, "environment" | "locations" | "availability" | "quote" | "suppliers" | "referenceTerms">;
  release: CaravelRelease;
  pickup: {id: string; external_id: string}; dropoff: {id: string; external_id: string};
  pickupDate: string; returnDate: string; pickupTime: string; returnTime: string; days: number;
  driverAge: number; currency: string; maxOffers: number; nowMs?: number;
  loadCarClasses: (externalIds: string[]) => Promise<Map<string, {id: string; active?: unknown}>>;
  idempotencyKey?: () => string;
}): Promise<{offers: CaravelSearchOffer[]; rejected: Record<string, number>}> {
  const rejected: Record<string, number> = {};
  const bump = (k: string) => { rejected[k] = (rejected[k] ?? 0) + 1; };
  const release = args.release;
  if (!release.open) return {offers: [], rejected: {CARAVEL_RELEASE_CLOSED: 1}};
  const readyRelease: Extract<CaravelRelease, {open: true}> = release;
  if (args.client.environment !== "production") return {offers: [], rejected: {CARAVEL_PRODUCTION_ONLY: 1}};
  const supplierId = release.terms.supplierId;
  const locations = (await args.client.locations(200, supplierId)).data as Rec[];
  const tz = (id: string) => {
    const l = locations.find((x) => x.location_id === id);
    return typeof l?.timezone === "string" ? l.timezone : null;
  };
  const ptz = tz(args.pickup.external_id), dtz = tz(args.dropoff.external_id);
  const pickupAt = ptz ? caravelLocalInstant(args.pickupDate, args.pickupTime, ptz) : null;
  const dropoffAt = dtz ? caravelLocalInstant(args.returnDate, args.returnTime, dtz) : null;
  if (!pickupAt || !dropoffAt) return {offers: [], rejected: {CARAVEL_LOCATION_TIMEZONE_UNKNOWN: 1}};
  // The stable aliases retain the validated string types in async quote tasks.
  const verifiedPickupAt: string = pickupAt, verifiedDropoffAt: string = dropoffAt;
  const rows = (await args.client.availability({pickup_location_id: args.pickup.external_id,
    dropoff_location_id: args.dropoff.external_id, pickup: pickupAt, dropoff: dropoffAt,
    driver_age: args.driverAge, currency: args.currency}, supplierId)).data as Rec[];
  if (!rows.length) return {offers: [], rejected: {CARAVEL_SUPPLIER_NO_AVAILABILITY: 1}};
  const offers: CaravelSearchOffer[] = [];
  const classes = await args.loadCarClasses([...new Set(rows.map((r) => r.vehicle_id).filter((v): v is string => typeof v === "string"))]);

  // Scope the supplier metadata to this SINGLE search: each offer still checks
  // the terms hash, but we don't make 2 redundant GETs per vehicle.
  // Rejected/missing reference data remains fail-closed for the whole request.
  let suppliersOnce: ReturnType<CaravelClient["suppliers"]> | undefined;
  let termsOnce: ReturnType<CaravelClient["referenceTerms"]> | undefined;
  const quoteClient: Pick<CaravelClient, "environment" | "quote" | "suppliers" | "referenceTerms"> = {
    environment: args.client.environment,
    quote: (...a) => args.client.quote(...a),
    suppliers: () => (suppliersOnce ??= args.client.suppliers()),
    referenceTerms: (id) => {
      if (id !== supplierId) throw new Error("CARAVEL_TERMS_SUPPLIER_MISMATCH");
      return (termsOnce ??= args.client.referenceTerms(id));
    },
  };

  // Preserve each vehicle's Premium alternatives. A quote rejection may allow
  // retrying another provider-supported Premium protection for the same group.
  type Candidate = {vehicleId: string; classId: string; protections: Rec[]};
  const groups = new Map<string, Candidate>();
  for (const row of rows) {
    const vehicleId = typeof row.vehicle_id === "string" ? row.vehicle_id : "";
    if (row.plan !== "premium" || !vehicleId) { bump("NOT_PREMIUM_ROW"); continue; }
    const klass = classes.get(vehicleId);
    if (!klass || klass.active === false) { bump("CATEGORY_NOT_SYNCED"); continue; }
    const pick = selectCaravelPremiumProtection(row, release.review);
    if (!pick) { bump("PREMIUM_POLICY_NOT_MET"); continue; }
    if (!groups.has(vehicleId)) groups.set(vehicleId, {vehicleId, classId: klass.id, protections: []});
    groups.get(vehicleId)!.protections.push(pick.protection as Rec);
  }

  async function quoteVehicle(group: Candidate): Promise<CaravelSearchOffer | null> {
    for (const protection of group.protections) {
      const result = await issueVerifiedCaravelQuote({
        admin: args.admin, client: quoteClient,
        idempotencyKey: (args.idempotencyKey ?? (() => crypto.randomUUID()))(), supplierId,
        carClassId: group.classId, pickupLocationId: args.pickup.id, dropoffLocationId: args.dropoff.id,
        quoteRequest: {pickup: {location_id: args.pickup.external_id, at: verifiedPickupAt},
          dropoff: {location_id: args.dropoff.external_id, at: verifiedDropoffAt}, vehicle_id: group.vehicleId,
          protection_id: String(protection.protection_id), plan: "premium", currency: args.currency,
          drivers: [{age: args.driverAge, role: "main"}], extras: []},
        startDate: args.pickupDate, endDate: args.returnDate, pickupLocalTime: args.pickupTime,
        dropoffLocalTime: args.returnTime, rentalDays: args.days, nowEpochMs: args.nowMs ?? Date.now(),
        reviewedTerms: readyRelease.snapshot, canonicalHashIndependentlyVerified: true, protection,
        approvedExclusions: readyRelease.review, allowProductionQuoteIssuance: true,
      });
      if (!result.ok) { bump(String((result as Rec).reason ?? "QUOTE_REJECTED")); continue; }
      const ex = Array.isArray(protection.excludes) ? protection.excludes as string[] : [];
      return {carClassId: group.classId, apiQuoteId: result.apiQuoteId, vehicleId: group.vehicleId,
        supplierQuoteId: result.providerQuoteId, expiresAt: result.expiresAt,
        rentalMinor: result.partnerPayableMinor, feeMinor: result.ride24ReservationFeeMinor,
        customerMinor: result.customerTotalMinor, currency: args.currency, excludes: [...ex],
        covers: Array.isArray(protection.covers) ? [...protection.covers as string[]] : [],
        adminFeeMinor: ex.length ? readyRelease.review.damageAdministrationFeeMinor : null};
    }
    return null;
  }

  // At most 2 supplier quote writes in flight. This reduces serial latency
  // without a request burst or changing another API partner's concurrency.
  const candidates = [...groups.values()];
  for (let i = 0; i < candidates.length && offers.length < args.maxOffers; i += 2) {
    const batch = await Promise.all(candidates.slice(i, i + 2).map(quoteVehicle));
    for (const offer of batch) if (offer && offers.length < args.maxOffers) offers.push(offer);
  }
  return {offers, rejected};
}

/**
 * Re-issue the SAME selection for the actual main-driver age (Caravel prices age
 * bands). The customer must then confirm the new price and terms again.
 */
export async function requoteCaravelForDriverAge(args: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  client: Pick<CaravelClient, "environment" | "quote" | "suppliers" | "referenceTerms" | "reference">;
  release: CaravelRelease; quoteRow: Rec; driverAge: number; selectedExtras?:CaravelExtraChoice[];
  additionalDriverAge?:number|null; nowMs?: number;
}): Promise<{ok: true; apiQuoteId: string} | {ok: false; reason: string}> {
  if (!args.release.open) return {ok: false, reason: "CARAVEL_RELEASE_CLOSED"};
  const q = args.quoteRow, data = rec(rec(q.raw_response)?.provider_quote_data), ctx = rec(rec(q.raw_response)?.ride24_context);
  const protection = rec(data?.protection);
  let requested = caravelSnapshotChoices(args.selectedExtras ?? data?.selected_extras ?? []);
  if(!requested) return {ok:false,reason:"CARAVEL_EXTRA_SELECTION_INVALID"};
  if(args.additionalDriverAge!=null &&
    (!Number.isSafeInteger(args.additionalDriverAge)||args.additionalDriverAge<18||args.additionalDriverAge>90))
    return {ok:false,reason:"CARAVEL_ADDITIONAL_DRIVER_AGE_INVALID"};
  let extrasCatalog;
  if(requested.length || args.additionalDriverAge!=null || data?.driver_service_id){
    try{
      const raw=(await args.client.reference("extras",args.release.terms.supplierId)).data;
      const {catalog,driverServices}=caravelSafeExtraCatalog(raw,args.release.terms.supplierId,String(data?.currency));
      const service=driverServices[0];
      if(args.additionalDriverAge!=null && driverServices.length!==1)
        return {ok:false,reason:"CARAVEL_DRIVER_SERVICE_UNAVAILABLE"};
      requested=requested.filter(x=>x.extra_id!==data?.driver_service_id && !driverServices.some(d=>d.extra_id===x.extra_id));
      if(args.additionalDriverAge!=null && service)requested.push({extra_id:service.extra_id,quantity:1});
      extrasCatalog=[...catalog,...driverServices];
    }catch{return {ok:false,reason:"CARAVEL_EXTRAS_CATALOG_UNAVAILABLE"};}
  }
  if (!data || !protection || typeof data.pickup_at !== "string" || typeof data.dropoff_at !== "string" || !ctx)
    return {ok: false, reason: "CARAVEL_REQUOTE_CONTEXT_MISSING"};
  const {data: locs} = await args.admin.from("partner_locations").select("id,external_id")
    .eq("partner_id", q.partner_id).in("external_id", [q.pickup_location_external_id, q.dropoff_location_external_id]);
  const id = (ext: unknown) => ((locs ?? []) as Rec[]).find((l) => l.external_id === ext)?.id as string | undefined;
  const pickupId = id(q.pickup_location_external_id), dropoffId = id(q.dropoff_location_external_id);
  if (!pickupId || !dropoffId) return {ok: false, reason: "CARAVEL_REQUOTE_LOCATION_MISSING"};
  const start = String(q.start_date), end = String(q.end_date);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  const result = await issueVerifiedCaravelQuote({
    admin: args.admin, client: args.client as never, idempotencyKey: crypto.randomUUID(),
    supplierId: args.release.terms.supplierId, carClassId: String(q.car_class_id),
    pickupLocationId: pickupId, dropoffLocationId: dropoffId,
    quoteRequest: {pickup: {location_id: String(q.pickup_location_external_id), at: data.pickup_at},
      dropoff: {location_id: String(q.dropoff_location_external_id), at: data.dropoff_at},
      vehicle_id: String(data.vehicle_id), protection_id: String(data.protection_id), plan: "premium",
      currency: String(data.currency),
      drivers: [{age:args.driverAge,role:"main"}, ...(args.additionalDriverAge == null ? []
        : [{age:args.additionalDriverAge,role:"additional" as const}])],
      extras: requested},
    ...(requested.length?{verifiedExtrasCatalog:extrasCatalog}:{}),
    startDate: start, endDate: end, pickupLocalTime: String(ctx.pickup_time).slice(0, 5),
    dropoffLocalTime: String(ctx.return_time).slice(0, 5), rentalDays: Number.isSafeInteger(data.rental_days) ? data.rental_days as number : days,
    nowEpochMs: args.nowMs ?? Date.now(), reviewedTerms: args.release.snapshot, canonicalHashIndependentlyVerified: true,
    protection, approvedExclusions: args.release.review, allowProductionQuoteIssuance: true,
  });
  return result.ok ? {ok: true, apiQuoteId: result.apiQuoteId} : {ok: false, reason: String((result as Rec).reason)};
}
