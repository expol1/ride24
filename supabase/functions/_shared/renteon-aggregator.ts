// Renteon AGGREGATOR API, not the older direct Renteon ExBooking API.
// Based on "Aggregator API Ride24" Postman collection from Renteon support.
// Each rental brand uses a case-sensitive provider code on a shared API host.
import {
  partnerApiRequest,
  sanitizePartnerPayload,
  type PartnerApiCredentials,
  type ApiLocation,
  type ApiVehicleGroup,
} from "./partner-api.ts";
import type {
  ProviderBookingInput,
  ProviderSearchInput,
} from "./provider-adapters.ts";

const HOST = "https://aggregator.renteon.com";
const setupPath = (code: string) => "/api/setup/provider/" + encodeURIComponent(code);
const availabilityPath = "/api/bookings/availability";
const createPath = "/api/bookings/create";
const calculatePath = "/api/bookings/calculate";
const savePath = "/api/bookings/save";
const searchPath = "/api/bookings/search";

type Obj = Record<string, unknown>;
function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function txt(v: unknown, max = 250): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).trim().slice(0, max);
}
function nonNegative(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function positive(v: unknown): number | null {
  const n = nonNegative(v);
  return n !== null && n > 0 ? n : null;
}
function finiteInt(v: unknown): number | null {
  const n = nonNegative(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}
function locationName(v: unknown): string {
  return txt(v, 240);
}
function countryName(v: unknown): string {
  const code = txt(v, 2).toUpperCase();
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}
function dateTime(date: string, time?: string | null): string {
  const t = txt(time || "10:00", 10);
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(t)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_INVALID_TIME");
  }
  return date + "T" + (t.length === 5 ? t + ":00" : t);
}
function periodDays(start: string, end: string): number {
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_INVALID_DATES");
  }
  return Math.max(1, Math.round((b - a) / 86_400_000));
}
function equalDateTime(a: unknown, b: string): boolean {
  return txt(a, 40).slice(0, 19) === b.slice(0, 19);
}
function amountIsEqual(a: unknown, b: unknown): boolean {
  const actual = positive(a);
  const expected = positive(b);
  return actual !== null && expected !== null
    && Math.abs(actual - expected) <= Math.max(0.02, expected * 0.0002);
}
function groupCode(v: unknown): string {
  const raw = txt(v, 20).toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(raw) ? raw : "";
}
function agencyCode(credentials: PartnerApiCredentials): string {
  const url = new URL(credentials.api_url);
  if (url.origin !== HOST || url.pathname !== "/" && url.pathname !== "") {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_URL_NOT_ALLOWED");
  }
  if (credentials.auth_type !== "basic") {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_BASIC_REQUIRED");
  }
  if (!credentials.username || !credentials.password) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_VAULT_UNAVAILABLE");
  }
  const code = txt(credentials.renteon_provider_code, 40);
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_CODE_REQUIRED");
  }
  return code;
}

async function call<T>(
  credentials: PartnerApiCredentials,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  agencyCode(credentials);
  return await partnerApiRequest<T>(
    { ...credentials, extra_headers: {}, endpoints: {} },
    path,
    options,
  );
}
async function setup(credentials: PartnerApiCredentials): Promise<Obj> {
  const code = agencyCode(credentials);
  const response = obj(await call<unknown>(credentials, setupPath(code)));
  if (!response || txt(response.Code) !== code) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_PROVIDER_SETUP_INVALID");
  }
  return response;
}

export async function aggregatorTest(credentials: PartnerApiCredentials): Promise<void> {
  const response = await setup(credentials);
  if (!Array.isArray(response.Locations) || !Array.isArray(response.CarCategories)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_SETUP_INCOMPLETE");
  }
}

export async function aggregatorLocations(credentials: PartnerApiCredentials): Promise<ApiLocation[]> {
  const response = await setup(credentials);
  const offices = arr(response.Offices).map(obj).filter((o): o is Obj => !!o);
  const enabledCodes = new Set(
    offices.filter(o => o.IsPickupOffice === true || o.IsDropOffOffice === true)
      .map(o => txt(o.LocationCode, 150)),
  );
  const locations: ApiLocation[] = [];
  const seen = new Set<string>();
  for (const row of arr(response.Locations).slice(0, 2000)) {
    const location = obj(row);
    if (!location) continue;
    const code = txt(location.Code, 150);
    const name = locationName(location.Name);
    if (!code || !name || seen.has(code) || !enabledCodes.has(code)) continue;
    seen.add(code);
    const country = countryName(location.CountryCode);
    const path = txt(location.Path, 300);
    const city = path.includes(">") ? path.split(">")[0].trim() : name;
    const locationType = txt(location.Type, 30).toLowerCase();
    locations.push({
      external_id: code,
      country,
      region: city || country,
      city: city || null,
      location_name: name,
      type: locationType.includes("airport") ? "airport" : "city",
      extra_fee: false,
      extra_fee_amount: null,
      return_fee_amount: null,
      contact_required: false,
      active: true,
    });
  }
  return locations;
}

export async function aggregatorGroups(credentials: PartnerApiCredentials): Promise<ApiVehicleGroup[]> {
  const response = await setup(credentials);
  const groups: ApiVehicleGroup[] = [];
  const seen = new Set<string>();
  for (const item of arr(response.CarCategories).slice(0, 2000)) {
    const row = obj(item);
    if (!row) continue;
    const code = groupCode(row.Code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    groups.push({
      external_id: code,
      class_code: code[0],
      public_price: 0, // Live availability supplies prices per requested rental dates.
      currency: "EUR",
      example_model: code,
      model: code,
      description: "Renteon " + code,
      features: {
        provider: "renteon_aggregator",
        sipp: code,
        noCreditCard: true,
        noCardHold: false,
      },
      deposit_amount: 0,
      active: true,
      seasonal_prices: null,
    });
  }
  return groups;
}

export async function aggregatorAvailability(
  credentials: PartnerApiCredentials,
  input: ProviderSearchInput,
): Promise<ApiVehicleGroup[]> {
  const code = agencyCode(credentials);
  const pickup = txt(input.pickup_location_id, 150);
  const dropoff = txt(input.dropoff_location_id || pickup, 150);
  if (!pickup || !dropoff) throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_LOCATION_REQUIRED");
  const start = dateTime(input.pickup_date, input.pickup_time);
  const end = dateTime(input.return_date, input.return_time);
  const days = periodDays(input.pickup_date, input.return_date);
  const payload = await call<unknown>(credentials, availabilityPath, {
    method: "POST",
    body: {
      currency: txt(input.currency || "EUR", 3).toUpperCase(),
      prepaid: false,
      IncludeOnRequest: true,
      providers: [{ Code: code, PricelistCodes: [] }],
      PickupLocation: pickup,
      DropOffLocation: dropoff,
      PickupDate: start,
      DropOffDate: end,
    },
  });
  if (!Array.isArray(payload)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_INVALID_AVAILABILITY");
  }
  const output: ApiVehicleGroup[] = [];
  for (const value of payload.slice(0, 1000)) {
    const item = obj(value);
    if (!item || txt(item.Provider) !== code || item.Prepaid !== false) continue;
    const group = groupCode(item.CarCategory);
    const total = positive(item.Amount);
    const currency = txt(item.Currency || input.currency || "EUR", 3).toUpperCase();
    if (!group || total === null || currency !== "EUR") continue;
    const officeOut = obj(item.PickupOffice);
    const officeIn = obj(item.DropOffOffice);
    if (txt(officeOut?.LocationCode) !== pickup || txt(officeIn?.LocationCode) !== dropoff) continue;
    if (!equalDateTime(item.PickupDate, start) || !equalDateTime(item.DropOffDate, end)) continue;
    const rentalAmount = positive(item.CarRentalAmount);
    // Unexpected provider price components must be investigated before publication.
    if (rentalAmount !== null && !amountIsEqual(total, rentalAmount)) continue;
    const deposit = nonNegative(item.DepositAmount);
    const excess = nonNegative(item.ExcessAmount);
    if (code !== "demo" && (deposit !== null && deposit > 200 || excess !== null && excess > 0)) {
      // Do not display offers contradicting Ride24's mandatory deposit/insurance rules.
      continue;
    }
    const model = txt(item.ModelName, 200) || group;
    const bags = Number(item.BigBagsCapacity || 0) + Number(item.SmallBagsCapacity || 0);
    const priceDate = txt(item.PriceDate, 80);
    const quoteExpiry = priceDate && Number.isFinite(Date.parse(priceDate))
      ? new Date(Date.parse(priceDate) + 15 * 60_000).toISOString()
      : new Date(Date.now() + 10 * 60_000).toISOString();
    const offer = sanitizePartnerPayload(item, 70_000);
    output.push({
      external_id: group,
      class_code: group[0],
      public_price: Number((total / days).toFixed(6)),
      public_price_total: total,
      price_is_total: true,
      currency,
      example_model: model,
      model,
      description: model + " (" + group + ")",
      transmission: null,
      fuel_type: null,
      seats: finiteInt(item.PassengerCapacity),
      bags: Number.isFinite(bags) && bags >= 0 ? bags : null,
      image: null, // Images are on provider domains, not the aggregator origin.
      features: {
        provider: "renteon_aggregator",
        sipp: group,
        minimum_driver_age: nonNegative(item.MinimumDriverAge),
        maximum_driver_age: nonNegative(item.MaximumDriverAge),
        excess_amount: excess,
        is_on_request: item.IsOnRequest === true,
        noCreditCard: true,
        noCardHold: false, // AVIA uses a small debit-card preauthorization.
      },
      mileage_limit: null,
      deposit_amount: deposit,
      active: true,
      driver_included: false,
      location_external_ids: [pickup, dropoff],
      quote_reference: [
        code, group, txt(item.ConnectorId, 30), txt(item.PricelistId, 30), priceDate,
      ].join(":").slice(0, 500),
      quote_expires_at: quoteExpiry,
      provider_quote_data: {
        aggregator: true,
        provider_code: code,
        total_amount: total,
        price_date: priceDate,
        offer,
      },
    });
  }
  return output;
}

export async function aggregatorBook(
  credentials: PartnerApiCredentials,
  input: ProviderBookingInput,
): Promise<Obj> {
  const code = agencyCode(credentials);
  // The provider supplies already-discounted partner rates. No second discount.
  if (Number(input.partner_discount_percent || 0) !== 0) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_DOUBLE_DISCOUNT_BLOCKED");
  }
  const quote = obj(input.provider_quote_data);
  const offered = obj(quote?.offer);
  if (quote?.provider_code !== code || !offered || txt(offered.Provider) !== code) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_QUOTE_MISSING");
  }
  if (offered.Prepaid !== false || txt(offered.CarCategory) !== input.vehicle_group_id) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_QUOTE_CHANGED");
  }
  const amount = positive(offered.Amount);
  if (amount === null || !amountIsEqual(amount, input.partner_amount)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_PRICE_MISMATCH");
  }
  if (
    txt(obj(offered.PickupOffice)?.LocationCode) !== input.pickup_location_id
    || txt(obj(offered.DropOffOffice)?.LocationCode) !== input.dropoff_location_id
    || !equalDateTime(offered.PickupDate, dateTime(input.pickup_date, input.pickup_time))
    || !equalDateTime(offered.DropOffDate, dateTime(input.return_date, input.return_time))
  ) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_QUOTE_LOCATION_MISMATCH");
  }
  const name = txt(input.main_driver?.name, 200);
  const email = txt(input.client_email, 250);
  if (!name || !email) throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_CUSTOMER_REQUIRED");

  const created = obj(await call<unknown>(credentials, createPath, {
    method: "POST",
    body: offered,
  }));
  if (!created || txt(created.Provider) !== code || !amountIsEqual(created.Total, amount)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_CREATE_PRICE_CHANGED");
  }
  const calculation = obj(await call<unknown>(credentials, calculatePath, {
    method: "POST",
    body: {
      ...created,
      ClientName: name,
      ClientEmail: email,
      ClientPhone: txt(input.client_phone, 60) || null,
    },
  }));
  if (!calculation || txt(calculation.Provider) !== code || !amountIsEqual(calculation.Total, amount)) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_CALCULATE_PRICE_CHANGED");
  }
  // Save is the first durable booking. Renteon Postman does not define idempotency,
  // so transport failures are flagged for manual investigation, never auto-retried here.
  const saved = obj(await call<unknown>(credentials, savePath, {
    method: "POST",
    body: {
      ...calculation,
      ClientName: name,
      ClientEmail: email,
      ClientPhone: txt(input.client_phone, 60) || null,
      VoucherNumber: txt(input.reservation_code, 100) || input.ride24_booking_id,
      OrderReference: txt(input.reservation_code, 100) || input.ride24_booking_id,
      IntegrationRemark: "Ride24 " + (txt(input.reservation_code, 100) || input.ride24_booking_id),
    },
  }));
  const bookingNumber = txt(saved?.Number, 120);
  if (!saved || !bookingNumber || txt(saved.Provider) !== code) {
    throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_SAVE_UNVERIFIED");
  }
  const matched = amountIsEqual(saved.Total, amount);
  const status = matched && saved.IsCancelled !== true
    ? saved.IsOnRequest === true ? "pending" : "confirmed"
    : "pending";
  return {
    booking_reference: bookingNumber,
    reference: bookingNumber,
    id: bookingNumber,
    status,
    needs_manual_review: !matched,
    provider_payload: sanitizePartnerPayload(saved, 12_000),
  };
}

export async function aggregatorStatus(
  credentials: PartnerApiCredentials,
  number: string,
): Promise<Obj> {
  const code = agencyCode(credentials);
  const safeNumber = txt(number, 120);
  if (!safeNumber) throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_BOOKING_NUMBER_REQUIRED");
  const payload = await call<unknown>(credentials, searchPath, {
    method: "POST",
    body: { Provider: code, Number: safeNumber },
  });
  const rows = Array.isArray(payload) ? payload.map(obj).filter((x): x is Obj => !!x) : [obj(payload)].filter((x): x is Obj => !!x);
  const row = rows.find(x => txt(x.Number) === safeNumber && txt(x.Provider) === code);
  if (!row) throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_BOOKING_NOT_FOUND");
  return {
    booking_reference: safeNumber,
    reference: safeNumber,
    status: row.IsCancelled === true ? "cancelled" : row.IsOnRequest === true ? "pending" : "confirmed",
    confirmed_at: txt(row.ModificationTime || row.InitialBookingDate, 80) || null,
    provider_payload: sanitizePartnerPayload(row, 12_000),
  };
}

export async function aggregatorCancel(): Promise<Obj> {
  // The supplied Renteon Postman collection does not specify a cancellation endpoint.
  // Do not make up an API request or tell Ride24 the booking was cancelled.
  throw new Error("PARTNER_API_ERROR:RENTEON_AGGREGATOR_CANCEL_MANUAL_REQUIRED");
}
