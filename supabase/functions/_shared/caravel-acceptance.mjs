// Caravel Channel API v1.67.0 — sandbox acceptance flow (shared by the CI script
// tests/caravel-live-sandbox.mjs and the temporary Edge Function caravel-sandbox-acceptance).
// Sandbox ONLY: the client is fixed to environment "sandbox" and cannot reach production.
// Walks every supplier the key holds: capabilities -> reference sync -> availability ->
// quote -> [book (pay_on_arrival, invented data) -> replay -> 409s -> cancel].
// Every booking it creates is cancelled; a cleanup pass runs even past the time budget.
// The key is never placed in the result (scrubbed from the serialized output).
import {CaravelClient, CaravelError} from "./caravel-sandbox-adapter.ts";
import {
  buildCaravelOfferFromApi, caravelExtraFromApi, caravelExtrasCatalog, caravelLocationFromApi, caravelProviderExtras,
  caravelQuoteFromApi, caravelVehicleFromApi, minorToMajor, normalizeCaravelLocation, normalizeCaravelVehicleClass,
  caravelProtectionCandidates, describeCaravelProtection, selectCaravelPremiumProtection,
} from "./caravel-normalize.ts";
import {evaluateCaravelPremium, caravelConditionsOfHire, reconcileCaravelTerms} from "./caravel-premium.ts";
import {caravelOutsideHours} from "./caravel-hours.ts";
import {mergeCaravelReference, REFERENCE_ID_KEYS} from "./caravel-reference-sync.ts";
import {
  buildCaravelBookingDraft, caravelBookingStatus, caravelCancellationFromApi, caravelErrorAction, caravelQuotedBookingRequest,
  expectedPartnerAmount, verifyCaravelBookingAgainstQuote,
} from "./caravel-booking.ts";

/** @returns {Promise<{failed: boolean, booking: boolean, results: Array<{endpoint: string, outcome: string, summary?: unknown}>}>} */
/**
 * @param options.supplierId  run only this supplier (must be visible to the key); omitted = every supplier
 * @param options.premiumOnly book only an offer that passes the Ride24 Premium policy (default true)
 */
export async function runCaravelAcceptance(key, {booking: withBooking = false, runId = "local", budgetMs = 120000, supplierId = null, premiumOnly = true} = {}) {
  if (!key) return {failed: false, booking: withBooking, results: [{endpoint: "-", outcome: "SKIPPED", summary: "CARAVEL_SANDBOX_API_KEY is not configured"}]};
  const started = Date.now();
  const results = [];
  let failed = false;
  const created = []; // bookings to clean up
  const finish = () => {
    const text = JSON.stringify({failed, booking: withBooking, results}).split(key).join("***");
    return JSON.parse(text);
  };
  const hist = (items) => items.reduce((h, e) => { const k = String(e ?? "not stated"); h[k] = (h[k] || 0) + 1; return h; }, {});
  const errOut = (error) => error instanceof CaravelError
    ? `HTTP ${error.status} ${error.code}${error.details?.length ? ` [${error.details.map(d => `${d.field ?? ""}:${d.issue ?? ""}`).join(",")}]` : ""}${error.requestId ? ` (request_id ${error.requestId})` : ""}`
    : `ERROR ${String(error?.message || error).split(key || "\u0000").join("***").slice(0, 200)}`;

  async function step(endpoint, fn, {expectError, soft, force} = {}) {
    if (!force && Date.now() - started > budgetMs) { results.push({endpoint, outcome: "NOT RUN (time budget)"}); return null; }
    try {
      const summary = await fn();
      if (expectError) { failed = true; results.push({endpoint, outcome: `UNEXPECTED OK (expected ${expectError})`, summary}); return null; }
      results.push({endpoint, outcome: "OK", summary});
      return summary;
    } catch (error) {
      if (expectError && error instanceof CaravelError && (expectError === "*" || error.code === expectError)) {
        results.push({endpoint, outcome: `OK (expected ${errOut(error)})`, summary: {action: caravelErrorAction(error).action}});
        return {expected: true};
      }
      if (soft) { results.push({endpoint, outcome: `DEGRADED ${errOut(error)}`}); return null; }
      failed = true;
      results.push({endpoint, outcome: errOut(error)});
      return null;
    }
  }
  const client = new CaravelClient({apiKey: key, environment: "sandbox"});
  const caps = await step("GET /v1/capabilities (with key)", async () => {
    const c = await client.capabilities();
    return {environment: c.data.environment, api_version: c.data.api_version, unknown_features_ignored: true};
  });
  if (!caps) return finish();
  await step("GET /v1/whoami", async () => {
    const w = (await client.whoami()).data;
    return {scopes: w.scopes ?? null, opt_ins: w.opt_ins ? Object.keys(w.opt_ins) : null};
  });
  let suppliers = [];
  await step("GET /v1/suppliers", async () => {
    suppliers = (await client.suppliers()).data;
    return suppliers.map(s => ({supplier_id: s.supplier_id, currency: s.currency, tax_inclusive: s.tax_inclusive, payment_models: s.payment_models ?? "not stated"}));
  });
  await step("GET /v1/reference/constants", async () => {
    const c = (await client.constants()).data;
    return {booking_statuses: c.booking_statuses ?? null, fee_types: c.fee_types ?? null, extra_categories: c.extra_categories ?? null,
      protection_coverage_codes: c.protection_coverage_codes ?? null, location_types: c.location_types ?? null};
  });

  const day0 = new Date(Date.now() + 30 * 86400000); day0.setUTCHours(0, 0, 0, 0);
  const at = (d, h, m = 0) => new Date(day0.getTime() + d * 86400000 + (h * 60 + m) * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");

  if (supplierId !== null) {
    if (typeof supplierId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(supplierId) || !suppliers.some(s => s.supplier_id === supplierId)) {
      failed = true;
      results.push({endpoint: "supplier scope", outcome: "ERROR SUPPLIER_NOT_VISIBLE", summary: {requested: String(supplierId).slice(0, 64)}});
      return finish();
    }
    suppliers = suppliers.filter(s => s.supplier_id === supplierId);
  }
  for (const supplier of suppliers) {
    const sid = supplier.supplier_id, cur = supplier.currency, tag = `[${cur} ${sid.slice(0, 12)}…]`;
    const stores = {locations: new Map(), vehicles: new Map(), protections: new Map(), extras: new Map()};
    let locations = [], policies = null, extrasRaw = [];

    // Reference sync (merge, never replace).
    const syncLocations = async () => {
      locations = (await client.locations(200, sid)).data;
      const merged = mergeCaravelReference(stores.locations, locations, REFERENCE_ID_KEYS.locations, new Date().toISOString());
      const n = locations.map(l => normalizeCaravelLocation(caravelLocationFromApi(l), sid));
      return {count: locations.length, merge: merged, ride24_ok: n.filter(x => x.ok).length, rejected: hist(n.flatMap(x => x.errors ?? [])),
        timezones: [...new Set(locations.map(l => l.timezone))], types: hist(locations.map(l => l.type))};
    };
    const firstSync = await step(`${tag} GET /v1/reference/locations`, syncLocations, {soft: true});
    await step(`${tag} GET /v1/reference/policies`, async () => {
      const list = (await client.reference("policies", sid)).data;
      policies = list[0] ?? null;
      const c = caravelConditionsOfHire(policies);
      return {conditions: c, ride24_terms: reconcileCaravelTerms(c)};
    });
    await step(`${tag} GET /v1/reference/vehicles`, async () => {
      const raw = (await client.vehicleClasses(200, sid)).data;
      mergeCaravelReference(stores.vehicles, raw, REFERENCE_ID_KEYS.vehicles, new Date().toISOString());
      const m = raw.map(r => normalizeCaravelVehicleClass(caravelVehicleFromApi(r, policies), sid));
      return {count: raw.length, ride24_ok: m.filter(x => x.ok).length, rejected: hist(m.flatMap(x => x.errors ?? [])),
        ages: raw.map(r => `${r.min_driver_age}-${r.max_driver_age}`)};
    });
    await step(`${tag} GET /v1/reference/protections`, async () => {
      const raw = (await client.reference("protections", sid)).data;
      mergeCaravelReference(stores.protections, raw, REFERENCE_ID_KEYS.protections, new Date().toISOString());
      return raw.map(p => ({tier: p.tier, excess: p.excess, deposit: p.deposit, theft_excess: p.theft_excess ?? "not stated",
        product_type: p.product_type ?? "not stated", covers: p.covers ?? "not stated", excludes: p.excludes ?? "not stated"}));
    });
    await step(`${tag} GET /v1/reference/extras`, async () => {
      extrasRaw = (await client.reference("extras", sid)).data;
      mergeCaravelReference(stores.extras, extrasRaw, REFERENCE_ID_KEYS.extras, new Date().toISOString());
      const {rows, rejected} = caravelExtrasCatalog(extrasRaw.map((x) => caravelExtraFromApi(x)), cur);
      return {count: extrasRaw.length, provider_extras: caravelProviderExtras(extrasRaw).map(e => `${e.name}:${e.category}:${e.pricing_type}:${e.unit_price}${e.price_cap !== null ? `/cap ${e.price_cap}` : ""}:${e.payable}`),
        ride24_codes: rows.map(r => r.code), unmapped: hist(rejected.map(r => r.error))};
    });
    await step(`${tag} GET /v1/reference/fees`, async () => {
      const raw = (await client.reference("fees", sid)).data;
      return raw.map(f => ({type: f.type, applies_when: f.applies_when ?? null}));
    });
    // An unknown error on the first list read degrades generically: the next scheduled
    // sync reads it again (certification phase unknown-error-code; a 422 is not retried in place).
    if (!firstSync) { await step(`${tag} GET /v1/reference/locations (next sync)`, syncLocations); }

    // Served plan, quoted from the freshly synced reference catalogue (certification phase
    // opaque-id-tolerance): no plan named, a protection_id that GET /v1/reference/protections lists.
    const vehicleIds = new Set([...stores.vehicles.values()].map(v => v.data.vehicle_id));
    const refProtection = [...stores.protections.values()].map(r => r.data).find(p => typeof p.vehicle_id === "string" && vehicleIds.has(p.vehicle_id));
    const refDesk = locations.find(l => normalizeCaravelLocation(caravelLocationFromApi(l), sid).ok);
    if (refProtection && refDesk) {
      await step(`${tag} POST /v1/quote (served plan, ids from reference sync)`, async () => {
        const q = (await client.quote({pickup: {location_id: refDesk.location_id, at: at(1, 10)}, dropoff: {location_id: refDesk.location_id, at: at(4, 10)},
          vehicle_id: refProtection.vehicle_id, protection_id: refProtection.protection_id, drivers: [{age: 30, role: "main"}]}, crypto.randomUUID(), sid)).data;
        return {status: q.status, plan: q.plan ?? "served (not named)", grand_total: q.totals?.grand_total,
          premium: evaluateCaravelPremium(q.plan ?? refProtection.tier, refProtection, q.deposit).ok ? "PUBLISHABLE" : "not Premium-publishable"};
      });
    }

    const desk = locations.find(l => normalizeCaravelLocation(caravelLocationFromApi(l), sid).ok && l.type === "airport")
      ?? locations.find(l => normalizeCaravelLocation(caravelLocationFromApi(l), sid).ok);
    if (!desk) { results.push({endpoint: `${tag} availability`, outcome: "NOT RUN", summary: "no desk passed normalization"}); continue; }
    const id = desk.location_id;
    const window = {pickup: at(0, 10), dropoff: at(3, 10)};
    let rows = [], meta = null;
    await step(`${tag} GET /v1/availability (3 days, 10:00Z)`, async () => {
      const r = await client.availability({pickup_location_id: id, dropoff_location_id: id, ...window, driver_age: 30, currency: cur}, sid);
      rows = r.data; meta = r.meta;
      const premiumRows = rows.filter(x => x.plan === "premium");
      return {rows: rows.length, plans: hist(rows.map(x => x.plan)), outside_hours: {pickup: caravelOutsideHours(desk, window.pickup), dropoff: caravelOutsideHours(desk, window.dropoff)},
        // Every protection a Premium row can be booked with: included package and protection_options, with exact amounts.
        premium_rows: premiumRows.map(x => ({vehicle_id: x.vehicle_id,
          protections: caravelProtectionCandidates(x).map(c => describeCaravelProtection(x.plan, c.protection, c.source))})),
        fee_types: hist(rows.flatMap(x => (x.line_items || []).filter(l => l.kind === "fee").map(l => l.type))),
        // Rental restrictions Caravel states for this search (duration bounds, movement, end terms).
        unsellable: {window: r.meta?.unsellable_window ?? null, movement: r.meta?.unsellable_movement ?? null, ends: r.meta?.unsellable_ends ?? null},
        rental_days: r.meta?.rental_days ?? null};
    });
    await step(`${tag} GET /v1/availability (night 23:30Z)`, async () => {
      const r = await client.availability({pickup_location_id: id, dropoff_location_id: id, pickup: at(0, 23, 30), dropoff: at(3, 23, 30), driver_age: 30, currency: cur}, sid);
      return {rows: r.data.length, outside_hours: {pickup: caravelOutsideHours(desk, at(0, 23, 30))},
        out_of_hours_minor: [...new Set(r.data.flatMap(x => (x.line_items || []).filter(l => l.type === "out_of_hours").map(l => l.total?.amount)))],
        unsellable_ends: r.meta?.unsellable_ends ?? null};
    });

    // Unavailable / unknown vehicle must be refused safely.
    await step(`${tag} POST /v1/quote unknown vehicle (expect 4xx)`, async () => {
      await client.quote({pickup: {location_id: id, at: window.pickup}, dropoff: {location_id: id, at: window.dropoff},
        vehicle_id: "ride24-nonexistent-vehicle", protection_id: "ride24-nonexistent-protection", drivers: [{age: 30, role: "main"}]}, crypto.randomUUID(), sid);
      return {};
    }, {expectError: "*"});

    // Quote: a publishable Premium row if any; otherwise a mechanics-only row (never publishable).
    // Premium rows only; pick the first protection (included or option) passing the policy on its own data.
    let publishable = null, chosenProtection = null;
    for (const x of rows.filter(r => r.plan === "premium")) {
      const sel = selectCaravelPremiumProtection(x);
      if (sel) { publishable = x; chosenProtection = sel; break; }
    }
    const row = publishable ?? rows.find(x => x.plan === "premium") ?? (premiumOnly ? undefined : rows[0]);
    const quotedProtection = chosenProtection?.protection ?? row?.protection;
    if (!row) { results.push({endpoint: `${tag} POST /v1/quote`, outcome: "NOT RUN", summary: "no availability rows"}); continue; }
    const quoteBody = {pickup: {location_id: id, at: window.pickup}, dropoff: {location_id: id, at: window.dropoff},
      vehicle_id: row.vehicle_id, protection_id: quotedProtection.protection_id, plan: row.plan, currency: cur, drivers: [{age: 30, role: "main"}]};
    const quoteKey = crypto.randomUUID();
    let quoteData = null, read = null, offerOk = false;
    await step(`${tag} POST /v1/quote (${row.plan}${publishable ? `, publishable ${chosenProtection.source} protection` : ", evidence only"})`, async () => {
      quoteData = (await client.quote(quoteBody, quoteKey, sid)).data;
      read = caravelQuoteFromApi(quoteData, quotedProtection, supplier);
      const offer = buildCaravelOfferFromApi({availabilityRow: row, protectionId: quotedProtection.protection_id, policies: meta?.policies ?? policies, quoteData, supplier, pickupLocation: desk, dropoffLocation: desk,
        context: {scopeSupplierId: sid, partnerCurrency: cur, pickupLocationId: id, dropoffLocationId: id,
          pickupEpochMs: Date.parse(window.pickup), dropoffEpochMs: Date.parse(window.dropoff), rentalDays: 3, driverAge: 30, nowEpochMs: Date.now()}});
      offerOk = offer.ok;
      return {status: quoteData.status, rental_days: quoteData.rental_days, expires_at: quoteData.expires_at,
        lines: (quoteData.line_items || []).map(l => `${l.kind}:${l.type ?? l.code}:${l.total?.amount}`),
        totals: quoteData.totals, deposit: quoteData.deposit?.amount ?? null,
        reconciliation: read.ok ? "OK" : read.errors,
        quoted_protection: describeCaravelProtection(row.plan, quotedProtection, chosenProtection?.source ?? "included", quoteData.deposit),
        ride24_offer: offer.ok ? {class: offer.value.class_code, model: offer.value.model, total: offer.value.public_price_total, noCreditCard: offer.value.features.noCreditCard} : offer.errors};
    });
    if (!quoteData) continue;
    await step(`${tag} POST /v1/quote replay (same key + body)`, async () => {
      const again = (await client.quote(quoteBody, quoteKey, sid)).data;
      return {same_quote_id: again.quote_id === quoteData.quote_id};
    });
    await step(`${tag} POST /v1/quote same key, different body (expect idempotency_key_reused)`, async () => {
      await client.quote({...quoteBody, drivers: [{age: 31, role: "main"}]}, quoteKey, sid);
      return {};
    }, {expectError: "idempotency_key_reused"});

    if (!withBooking || !read?.ok || (premiumOnly && !offerOk)) {
      if (withBooking) results.push({endpoint: `${tag} POST /v1/bookings`, outcome: "NOT RUN",
        summary: !read?.ok ? "quote did not reconcile" : "no Premium-publishable offer (premiumOnly): nothing booked"});
      continue;
    }
    // Booking (invented data, pay_on_arrival). Mechanics-only rows are booked only to exercise the flow and cancelled at once.
    const total = minorToMajor(read.value.quote.totalAmountMinor, cur);
    const ref = `ci-${String(runId).replace(/[^A-Za-z0-9]/g, "").slice(-10)}-${cur}-${Date.now().toString(36)}`;
    const draft = buildCaravelBookingDraft({
      idempotency_key: crypto.randomUUID(), ride24_booking_id: ref, vehicle_group_id: row.vehicle_id,
      main_driver: {name: "Sandbox Tester", age: 30}, client_email: "sandbox-ci@example.test", client_phone: null,
      currency: cur, partner_discount_percent: 0, partner_amount: expectedPartnerAmount(total, 0), quote_reference: read.value.quote.quoteId,
      provider_quote_data: {provider: "caravel", quote_id: read.value.quote.quoteId, supplier_id: sid, vehicle_id: row.vehicle_id,
        protection_id: quotedProtection.protection_id, plan: "premium", currency: cur, amounts: {total},
        drivers: [{age: 30, role: "main"}], expires_at: new Date(read.value.quote.expiresAtEpochMs).toISOString()},
    }, Date.now());
    if (!draft.ok) { failed = true; results.push({endpoint: `${tag} POST /v1/bookings`, outcome: "NOT SENT", summary: draft.errors}); continue; }
    const body = caravelQuotedBookingRequest(draft.draft);
    let booking = null;
    await step(`${tag} POST /v1/bookings (pay_on_arrival)`, async () => {
      booking = (await client.bookSandbox(body, draft.draft.idempotencyKey, sid)).data;
      created.push({id: booking.booking_id, sid});
      const check = verifyCaravelBookingAgainstQuote(booking, read.value.quote);
      return {status: caravelBookingStatus(booking.status), revision: booking.revision, payment: booking.payment ?? null,
        matches_quote: check.ok ? true : check.errors};
    });
    if (!booking) continue;
    await step(`${tag} POST /v1/bookings replay (same key + body)`, async () => {
      const again = (await client.bookSandbox(body, draft.draft.idempotencyKey, sid)).data;
      return {same_booking_id: again.booking_id === booking.booking_id, revision: again.revision};
    });
    await step(`${tag} POST /v1/bookings same quote, new key + ref (expect 409)`, async () => {
      await client.bookSandbox({...body, external_ref: `${body.external_ref}-b`}, crypto.randomUUID(), sid);
      return {};
    }, {expectError: "*"});
    let current = booking;
    await step(`${tag} GET /v1/bookings/{ref}`, async () => {
      current = (await client.bookingStatusSandbox(booking.booking_id, sid)).data;
      return {status: current.status, revision: current.revision};
    });
    let cancelled = null;
    await step(`${tag} POST /v1/bookings/{ref}/cancel`, async () => {
      cancelled = (await client.cancelSandbox(booking.booking_id, current.revision, crypto.randomUUID(), sid)).data;
      const c = caravelCancellationFromApi(cancelled);
      return {status: caravelBookingStatus(cancelled.status), revision: cancelled.revision, cancellation: c.ok ? c : c.errors};
    });
    if (cancelled) {
      created.splice(created.findIndex(x => x.id === booking.booking_id), 1);
      await step(`${tag} POST cancel again (idempotent)`, async () => {
        const c2 = (await client.cancelSandbox(booking.booking_id, cancelled.revision, crypto.randomUUID(), sid)).data;
        return {status: c2.status, revision: c2.revision};
      });
      await step(`${tag} POST cancel with stale revision (expect 409)`, async () => {
        await client.cancelSandbox(booking.booking_id, 1, crypto.randomUUID(), sid);
        return {};
      }, {expectError: "*"});
    }
  }

  // Safety net: cancel anything the run created and did not cancel.
  for (const b of created) {
    await step(`cleanup cancel ${b.id.slice(0, 8)}…`, async () => {
      const cur = (await client.bookingStatusSandbox(b.id, b.sid)).data;
      const c = (await client.cancelSandbox(b.id, cur.revision, crypto.randomUUID(), b.sid)).data;
      return {status: c.status};
    }, {force: true});
  }
  return finish();
}
