/**
 * Caravel sandbox diagnostics — read-only (isolated, not part of dispatch).
 *
 * Every call is a GET against https://sandbox-api.caravelway.com (the client
 * refuses any other host and any non-sandbox environment). No quote, booking,
 * modify, cancel, credential or webhook endpoint is called. The API key is
 * passed in by the caller and never placed in the result: only HTTP outcomes,
 * Caravel error codes / request ids, counts and Ride24 normalization results.
 */
import {CaravelError, CaravelSandboxClient} from "./caravel-sandbox-adapter.ts";
import {
  caravelExtraFromApi, caravelExtrasCatalog, caravelLocationFromApi, caravelVehicleFromApi,
  normalizeCaravelLocation, normalizeCaravelVehicleClass,
} from "./caravel-normalize.ts";

type Json = Record<string, unknown>;
export type DiagnosticStep = {
  endpoint: string;
  outcome: "OK" | "HTTP_ERROR" | "NETWORK_ERROR" | "ERROR" | "NOT_RUN";
  http_status?: number;
  error_code?: string;
  request_id?: string | null;
  summary?: unknown;
};
export type DiagnosticResult = {
  secret_present: boolean;
  sandbox_only: true;
  blocker: null | "MISSING_SECRET" | "INVALID_KEY" | "FORBIDDEN_SCOPE_OR_IP" | "SUPPLIER" | "NETWORK_OR_DNS" | "API_ERROR" | "NOT_SANDBOX";
  steps: DiagnosticStep[];
};

const SUPPLIER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const histogram = (items: unknown[]) =>
  items.reduce<Record<string, number>>((h, e) => { const k = String(e ?? "not stated"); h[k] = (h[k] || 0) + 1; return h; }, {});
const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function runCaravelDiagnostics(
  apiKey: string | undefined | null,
  options: {supplierId?: string | null; nowEpochMs: number; budgetMs?: number},
): Promise<DiagnosticResult> {
  const steps: DiagnosticStep[] = [];
  if (!apiKey) return {secret_present: false, sandbox_only: true, blocker: "MISSING_SECRET", steps};
  const scope = options.supplierId ?? undefined;
  if (scope !== undefined && !SUPPLIER_ID.test(scope)) {
    steps.push({endpoint: "input", outcome: "ERROR", error_code: "INVALID_SUPPLIER_ID"});
    return {secret_present: true, sandbox_only: true, blocker: "SUPPLIER", steps};
  }
  const started = Date.now();
  const budget = options.budgetMs ?? 90000;
  // Never let any error text carry the key, even by accident.
  const scrub = (s: string) => s.split(apiKey).join("***").slice(0, 160);
  const client = new CaravelSandboxClient(apiKey);

  async function step<T>(endpoint: string, fn: () => Promise<T>): Promise<T | null> {
    if (Date.now() - started > budget) { steps.push({endpoint, outcome: "NOT_RUN", error_code: "TIME_BUDGET"}); return null; }
    try {
      const summary = await fn();
      steps.push({endpoint, outcome: "OK", summary});
      return summary;
    } catch (error) {
      if (error instanceof CaravelError) {
        steps.push({endpoint, outcome: "HTTP_ERROR", http_status: error.status, error_code: error.code, request_id: error.requestId});
      } else if (error instanceof TypeError || (error as {name?: string})?.name === "TimeoutError") {
        steps.push({endpoint, outcome: "NETWORK_ERROR", error_code: (error as {name?: string}).name || "TypeError"});
      } else {
        steps.push({endpoint, outcome: "ERROR", error_code: scrub(String((error as {message?: string})?.message ?? error))});
      }
      return null;
    }
  }
  const classify = (): DiagnosticResult["blocker"] => {
    const bad = steps.find(s => s.outcome !== "OK" && s.outcome !== "NOT_RUN");
    if (!bad) return null;
    if (bad.outcome === "NETWORK_ERROR") return "NETWORK_OR_DNS";
    if (bad.error_code === "SANDBOX_ENVIRONMENT_REQUIRED") return "NOT_SANDBOX";
    if (bad.http_status === 401) return "INVALID_KEY";
    if (bad.http_status === 403) return "FORBIDDEN_SCOPE_OR_IP";
    if (bad.error_code === "CONFIGURED_SUPPLIER_NOT_VISIBLE" || bad.error_code === "NO_SUPPLIERS") return "SUPPLIER";
    return "API_ERROR";
  };
  const done = (): DiagnosticResult => ({secret_present: true, sandbox_only: true, blocker: classify(), steps});

  // 1. Environment + authentication.
  const caps = await step("GET /v1/capabilities", async () => {
    const c = await client.capabilities();
    return {environment: c.data.environment, api_version: c.data.api_version};
  });
  if (!caps) return done();
  const who = await step("GET /v1/whoami", async () => {
    const w = (await client.whoami()).data as Json;
    const key = (w.key && typeof w.key === "object" ? w.key : {}) as Json;
    return {scopes: w.scopes ?? key.scopes ?? null, currency: w.currency ?? null,
      opt_ins: w.opt_ins && typeof w.opt_ins === "object" ? Object.keys(w.opt_ins as Json) : null};
  });
  if (!who) return done();

  // 2. Supplier scope.
  let supplier: Json | null = null;
  await step("GET /v1/suppliers", async () => {
    const list = (await client.suppliers()).data as unknown as Json[];
    supplier = (scope ? list.find(s => s.supplier_id === scope) : list[0]) ?? null;
    if (!supplier) throw new Error(scope ? "CONFIGURED_SUPPLIER_NOT_VISIBLE" : "NO_SUPPLIERS");
    return {count: list.length, suppliers: list.map(s => ({supplier_id: s.supplier_id, currency: s.currency, tax_inclusive: s.tax_inclusive, payment_models: s.payment_models ?? "not stated"}))};
  });
  if (!supplier) return done();
  const sid = String((supplier as Json).supplier_id);
  const currency = String((supplier as Json).currency);

  // 3. Reference catalogues, normalized with the Ride24 mappers.
  let desks: Json[] = [];
  await step("GET /v1/reference/locations", async () => {
    const raw = (await client.locations(200, sid)).data as unknown as Json[];
    const mapped = raw.map(r => ({raw: r, n: normalizeCaravelLocation(caravelLocationFromApi(r), sid)}));
    desks = mapped.filter(m => m.n.ok).map(m => m.raw);
    return {count: raw.length, ride24_normalized: desks.length,
      rejected: histogram(mapped.flatMap(m => ("errors" in m.n ? m.n.errors : []))),
      types: histogram(raw.map(r => r.type)), with_hours: raw.filter(r => Array.isArray(r.hours)).length,
      weekday_values: [...new Set(raw.flatMap(r => (Array.isArray(r.hours) ? r.hours : []).map((h: Json) => h.day)))].slice(0, 10),
      out_of_hours_available: raw.filter(r => (r.out_of_hours as Json | null)?.available === true).length};
  });
  let policies: Json | null = null;
  await step("GET /v1/reference/policies", async () => {
    const list = (await client.reference("policies", sid)).data as Json[];
    policies = list[0] ?? null;
    const p = (policies ?? {}) as Json;
    return {count: list.length, mileage: p.mileage ?? null, deposit_payment_methods: p.deposit_payment_methods ?? null,
      min_rental_days: p.min_rental_days ?? null, max_rental_days: p.max_rental_days ?? null};
  });
  await step("GET /v1/reference/vehicles", async () => {
    const raw = (await client.vehicleClasses(200, sid)).data as Json[];
    const mapped = raw.map(r => normalizeCaravelVehicleClass(caravelVehicleFromApi(r, policies), sid));
    return {count: raw.length, ride24_normalized: mapped.filter(m => m.ok).length,
      rejected: histogram(mapped.flatMap(m => ("errors" in m ? m.errors : []))),
      fuels: histogram(raw.map(r => r.fuel)), transmissions: histogram(raw.map(r => r.transmission))};
  });
  await step("GET /v1/reference/protections", async () => {
    const raw = (await client.reference("protections", sid)).data as Json[];
    const premium = raw.filter(p => p.tier === "premium");
    const zero = (m: unknown) => !!m && typeof m === "object" && (m as Json).amount === 0;
    return {count: raw.length, tiers: histogram(raw.map(p => p.tier)), premium: premium.length,
      premium_zero_excess_and_deposit: premium.filter(p => zero(p.excess) && zero(p.deposit)).length,
      premium_theft_excess_stated: premium.filter(p => p.theft_excess).length};
  });
  await step("GET /v1/reference/extras", async () => {
    const raw = (await client.reference("extras", sid)).data as Json[];
    const {rows, rejected} = caravelExtrasCatalog(raw.map(caravelExtraFromApi), currency);
    return {count: raw.length, ride24_mapped: rows.map(r => `${r.code}:${r.billing}:${r.amount}`),
      rejected: histogram(rejected.map(r => r.error)), categories: histogram(raw.map(e => e.category)),
      pricing_types: histogram(raw.map(e => e.pricing_type))};
  });
  await step("GET /v1/reference/fees", async () => {
    const raw = (await client.reference("fees", sid)).data as Json[];
    return {count: raw.length, types: histogram(raw.map(f => f.type))};
  });

  // 4. Availability (read-only): one 3-day daytime window and one night window.
  const desk = desks.find(d => d.type === "airport") ?? desks[0];
  if (!desk) {
    steps.push({endpoint: "GET /v1/availability", outcome: "NOT_RUN", error_code: "NO_NORMALIZED_DESK"});
    return done();
  }
  const day0 = new Date(options.nowEpochMs + 30 * 86400000); day0.setUTCHours(0, 0, 0, 0);
  const at = (d: number, h: number, m = 0) => isoZ(day0.getTime() + d * 86400000 + (h * 60 + m) * 60000);
  const id = String(desk.location_id);
  for (const [label, h, m] of [["day 10:00Z", 10, 0], ["night 23:30Z", 23, 30]] as const) {
    await step(`GET /v1/availability (${label}, ${desk.type})`, async () => {
      const r = await client.availability({pickup_location_id: id, dropoff_location_id: id, pickup: at(0, h, m), dropoff: at(3, h, m), driver_age: 30, currency}, sid);
      const rows = r.data as Json[];
      const premium = rows.filter(x => x.plan === "premium");
      const fees = rows.flatMap(x => (Array.isArray(x.line_items) ? x.line_items : []) as Json[]).filter(l => l.kind === "fee");
      const meta = (r.meta ?? {}) as Json;
      return {rows: rows.length, plans: histogram(rows.map(x => x.plan)), premium_rows: premium.length,
        premium_zero_risk: premium.filter(x => CaravelSandboxClient.isPremiumZeroRisk(x)).length,
        deposits_minor: [...new Set(rows.map(x => ((x.protection as Json | undefined)?.deposit as Json | undefined)?.amount))].slice(0, 8),
        fee_types: histogram(fees.map(l => l.type)), rental_days: meta.rental_days ?? null,
        withheld: meta.withheld ?? null, unsellable_window: meta.unsellable_window ?? null};
    });
  }
  return done();
}
