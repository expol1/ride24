// Arvent "VEHICLE DELIVERY CERTIFICATE" (kolayCAR voucher PDF) parser and
// verifier. Pure module: text in, facts out. Format verified against the real
// document for 17BFD74AC95B (wkhtmltopdf 0.12.4, 2 pages, 27.11.2026).
//
// The document is only ONE piece of evidence. Approval additionally requires
// an authenticated sender (DKIM), the paid Ride24 booking it names, the live
// Arvent API record (status 0 or 1, never 3/6) and a successful Stripe payment.

const MAX_TEXT = 40000;
export const ARVENT_DOCUMENT_TITLE = "VEHICLE DELIVERY CERTIFICATE";
export const ARVENT_SENDER_DOMAIN = "arventcarrental.com";
// Arvent's operating time zone (Türkiye, no DST since 2016).
const TR_OFFSET = "+03:00";

const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
const squash = (s) => clean(s).replace(/[ \t\u00a0]+/g, " ").trim();
const norm = (s) => squash(s).toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\u0131/g, "i")
  .replace(/[^a-z0-9]+/g, " ").trim();

// "84,75" / "1.234,56" / "84.75" -> integer cents. Null when not a money value.
export function moneyCents(raw) {
  const s = squash(raw).replace(/\s/g, "");
  if (!/^\d{1,3}([.,]?\d{3})*([.,]\d{1,2})?$/.test(s) && !/^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const m = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(s);
  const whole = m[1].replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac || 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

function line(text, label) {
  // Label and value are on one line in both pdf.js and pdftotext output.
  const re = new RegExp("^\\s*" + label + "[ \\t:]+(.+?)\\s*$", "im");
  const m = re.exec(text);
  return m ? squash(m[1]) : null;
}
function moneyLine(text, label) {
  const v = line(text, label);
  if (!v) return null;
  const m = /^([\d.,]+)\s*([A-Z]{3})$/.exec(v);
  return m ? { cents: moneyCents(m[1]), currency: m[2] } : null;
}
// Arvent prints pick-up/return as US "M/D/YYYY h:mm:ss AM|PM" (verified:
// 3/6/2027 6:00:00 PM = 6 March 2027 18:00, matching the API returnDate).
export function arventUsDateTime(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)$/i.exec(squash(raw));
  if (!m) return null;
  let [, mo, d, y, h, mi] = m;
  let hour = Number(h);
  if (hour < 1 || hour > 12) return null;
  if (/pm/i.test(m[7]) && hour !== 12) hour += 12;
  if (/am/i.test(m[7]) && hour === 12) hour = 0;
  return isoLocal(Number(y), Number(mo), Number(d), hour, Number(mi));
}
// Reservation date: "27.11.2026 18:19:51" (Arvent local time).
export function arventDotDateTime(raw) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(squash(raw));
  if (!m) return null;
  return isoLocal(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}
function isoLocal(y, mo, d, h, mi, s = 0) {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}
export const arventLocalToUtcMs = (iso) => iso ? Date.parse(iso + TR_OFFSET) : NaN;

export function parseArventCertificate(input, meta = {}) {
  const text = clean(input).slice(0, MAX_TEXT).replace(/\r\n?/g, "\n");
  const errors = [];
  if (!new RegExp("^\\s*" + ARVENT_DOCUMENT_TITLE + "\\s*$", "m").test(text)) errors.push("DOCUMENT_TITLE");
  // The number is printed on its own line right after the label.
  const num = /Reservation Number\s*\n\s*([0-9A-F]{12})\s*\n/.exec(text)?.[1] ?? null;
  if (!num) errors.push("RESERVATION_NUMBER");
  if (meta.title !== undefined && meta.title !== null && num && !String(meta.title).startsWith(num)) errors.push("PDF_TITLE_MISMATCH");

  const pickupLine = line(text, "Pick-up Date"), returnLine = line(text, "Return Date");
  const rental = /^\s*Rental Amount[ \t]+([\d.,]+) ([A-Z]{3}) x (\d+) = ([\d.,]+) ([A-Z]{3})\s*$/im.exec(text);
  const duration = /Rental Duration\s*:\s*(\d+)\s*Day/i.exec(text);
  const mileage = /^\s*Mileage Limit[ \t]+(\d+)\s*km\s*$/im.exec(text);
  const extrasBlock = /Selected Extras\s*\n([\s\S]*?)\n\s*Payment Information/.exec(text)?.[1] ?? "";
  const vehicleBlock = /^\s*Vehicle Class[ \t]+(.+)\n\s*\(([^)]*)\)/im.exec(text);

  const doc = {
    title: ARVENT_DOCUMENT_TITLE,
    reservation_number: num,
    reservation_local: arventDotDateTime(line(text, "Reservation Date") ?? ""),
    pickup_local: arventUsDateTime(pickupLine ?? ""),
    return_local: arventUsDateTime(returnLine ?? ""),
    pickup_location: line(text, "Pick-up Location"),
    return_location: line(text, "Return Location"),
    rental_days: duration ? Number(duration[1]) : null,
    vehicle_model: vehicleBlock ? squash(vehicleBlock[1]) : line(text, "Vehicle Class"),
    vehicle_category: vehicleBlock ? squash(vehicleBlock[2]).split("/").map(squash) : [],
    mileage_limit_km: mileage ? Number(mileage[1]) : null,
    extras: extrasBlock.split("\n").map(squash).filter(Boolean),
    daily_rate_cents: rental ? moneyCents(rental[1]) : null,
    billed_days: rental ? Number(rental[3]) : null,
    rental_amount_cents: rental ? moneyCents(rental[4]) : null,
    currency: rental && rental[2] === rental[5] ? rental[2] : null,
    extras_amount: moneyLine(text, "Extra / Insurance Amount"),
    one_way_fee: moneyLine(text, "One-Way Fee"),
    total: moneyLine(text, "Total Amount"),
    paid: moneyLine(text, "Paid Amount"),
    on_delivery: moneyLine(text, "Payment On Delivery"),
    customer_name: line(text, "Name/Surname"),
    customer_email_masked: line(text, "E-Mail"),
    customer_phone: line(text, "Telephone"),
  };
  for (const [k, v] of Object.entries(doc)) {
    if (["extras", "vehicle_category"].includes(k)) continue;
    if (v === null || v === undefined || (typeof v === "object" && v.cents == null)) errors.push("FIELD_" + k.toUpperCase());
  }
  // A blank extras section is the only accepted extras state until
  // Arvent paid extras are certified (code 2 is verified separately).
  return { ok: errors.length === 0, doc, errors };
}

const sameMoney = (m, cents, cur = "EUR") => !!m && m.currency === cur && m.cents === cents;
const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const timeHHMM = (t) => String(t ?? "").slice(0, 5);
function maskedEmailMatches(masked, email) {
  // Arvent masks as "rid****@t.pl": visible prefix + full domain.
  const m = /^([^*@\s]{1,10})\*+@([^@\s]+)$/.exec(squash(masked ?? ""));
  const e = String(email ?? "").trim().toLowerCase();
  if (!m || !e.includes("@")) return false;
  const [local, domain] = e.split("@");
  return local.startsWith(m[1].toLowerCase()) && domain === m[2].toLowerCase();
}
const digits = (s) => String(s ?? "").replace(/\D/g, "");

// Category text "(Economic/Manual/Diesel)" vs live API names.
function categoryMatches(doc, live) {
  if (!doc.vehicle_category.length) return false;
  const want = [live.vehicleCategoryTypeName, live.transmissionTypeName, live.fuelTypeName].map(norm);
  const got = doc.vehicle_category.map(norm);
  return want.every((w, i) => w && got[i] === w);
}

/**
 * Compare a parsed certificate with the paid Ride24 booking and the live
 * Arvent readback. Returns {ok, reasons[]}; any reason blocks approval.
 * `live` is the sanitized supplier reservation (GET /reservations data).
 */
export function verifyArventCertificate({ doc, booking, workflow, live, quote, evidence, receivedAtMs }) {
  const r = [];
  const fail = (code, cond) => { if (!cond) r.push(code); };
  const ref = workflow?.provider_reference;
  fail("BOOKING_REFERENCE", !!ref && doc.reservation_number === ref && booking?.api_booking_reference === ref);
  fail("LIVE_REFERENCE", live?.reservationNumber === ref);
  fail("AGENCY_REFERENCE", live?.agencyReservationReference == null || live.agencyReservationReference === booking?.reservation_code);
  // Live supplier state: 0 received or 1 approved only. 3 cancelled, 6
  // unapproved and anything else are never approvable from an email.
  fail("LIVE_STATUS", live?.reservationStatusType === 0 || live?.reservationStatusType === 1);

  const pickup = `${booking?.start_date}T${timeHHMM(booking?.pickup_time)}:00`;
  const ret = `${booking?.end_date}T${timeHHMM(booking?.return_time)}:00`;
  fail("PICKUP_DATETIME", doc.pickup_local === pickup && String(live?.pickupDate ?? "").slice(0, 19) === pickup);
  fail("RETURN_DATETIME", doc.return_local === ret && String(live?.returnDate ?? "").slice(0, 19) === ret);
  fail("PICKUP_LOCATION", !!doc.pickup_location && norm(doc.pickup_location) === norm(live?.pickupLocationName));
  fail("RETURN_LOCATION", !!doc.return_location && norm(doc.return_location) === norm(live?.returnLocationName));
  fail("LOCATION_IDS", !!quote && String(live?.pickupLocationId) === String(quote.pickup_location_external_id)
    && String(live?.returnLocationId) === String(quote.dropoff_location_external_id));
  fail("RENTAL_DAYS", doc.rental_days === doc.billed_days && doc.rental_days === live?.rentalDuration);
  fail("VEHICLE_MODEL", !!doc.vehicle_model && norm(doc.vehicle_model) === norm(live?.vehicleName));
  fail("VEHICLE_CATEGORY", categoryMatches(doc, live || {}));
  // totalKMLimit=0 is Arvent's "no limit" (verified on all live offers with
  // the written unlimited-mileage terms); the PDF prints the same field as 0km.
  fail("MILEAGE_UNLIMITED", doc.mileage_limit_km === 0 && live?.totalKMLimit === 0);

  const total = toCents(booking?.partner_net_price_snapshot);
  const extrasCents = Number(quote?.raw_response?.ride24_options?.arvent_extra?.extras_cents ?? 0);
  const oneWay = toCents(evidence?.one_way_fee ?? 0);
  fail("CURRENCY", doc.currency === "EUR" && live?.currencyCode === "EUR" && booking?.partner_currency === "EUR");
  fail("RENTAL_AMOUNT", doc.daily_rate_cents * doc.billed_days === doc.rental_amount_cents
    && doc.daily_rate_cents === toCents(live?.dailyPrice));
  fail("EXTRAS", sameMoney(doc.extras_amount, extrasCents) && toCents(live?.extraPrice ?? 0) === extrasCents
    && (extrasCents === 0 ? doc.extras.length === 0 && (!Array.isArray(live?.reservationExtras) || live.reservationExtras.length === 0) : true));
  fail("ONE_WAY_FEE", sameMoney(doc.one_way_fee, oneWay) && toCents(live?.oneWayFee ?? 0) === oneWay);
  fail("TOTAL", sameMoney(doc.total, total) && toCents(live?.totalPrice) === total
    && doc.rental_amount_cents + doc.extras_amount.cents + doc.one_way_fee.cents === total);
  fail("PAID_AMOUNT", sameMoney(doc.paid, 0) && toCents(live?.paidAmount ?? 0) === 0);
  fail("PAY_ON_DELIVERY", sameMoney(doc.on_delivery, toCents(booking?.pickup_payment_partner_currency)) && doc.on_delivery.cents === total);
  fail("DEPOSIT", live?.depositPrice === 0 && live?.depositCreditCardRequired === false);

  fail("CUSTOMER_NAME", norm(doc.customer_name) === norm(booking?.main_driver_name));
  fail("CUSTOMER_EMAIL", maskedEmailMatches(doc.customer_email_masked, booking?.client_email));
  fail("CUSTOMER_PHONE", digits(doc.customer_phone).length >= 7 && digits(doc.customer_phone) === digits(booking?.client_phone));

  // The certificate belongs to THIS supplier record: its reservation time is
  // the moment Arvent accepted our SaveReservation (within minutes).
  const reservedMs = arventLocalToUtcMs(doc.reservation_local);
  const receivedSupplierMs = Date.parse(workflow?.supplier_received_at);
  fail("RESERVATION_TIME", Number.isFinite(reservedMs) && Number.isFinite(receivedSupplierMs)
    && Math.abs(reservedMs - receivedSupplierMs) <= 15 * 60000);
  // Timely: delivered before the persisted 24h deadline, which is never reset.
  const deadline = Date.parse(workflow?.supplier_deadline_at);
  fail("DELIVERED_BEFORE_DEADLINE", Number.isFinite(receivedAtMs) && Number.isFinite(deadline) && receivedAtMs <= deadline
    && Number.isFinite(reservedMs) && receivedAtMs >= reservedMs - 60000);
  return { ok: r.length === 0, reasons: r };
}

// Summary of a raw Arvent GET /reservations record in the shape the shared
// payment workflow stores (status/terms/extras flags + evidence payload).
const LIVE_FIELDS = ["reservationNumber","agencyReservationReference","reservationStatusType","currencyCode","totalPrice",
  "depositPrice","depositCreditCardRequired","totalKMLimit","pickupLocationId","returnLocationId","pickupDate","returnDate",
  "pickupLocationName","returnLocationName","vehicleName","rentalDuration","vehicleCategoryTypeName","transmissionTypeName",
  "fuelTypeName","dailyPrice","extraPrice","oneWayFee","paidAmount","reservationDate","reservationExtras","statusName"];
export function arventLiveSummary(data, { booking, quote, evidence }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("ARVENT_BOOKING_SHAPE");
  const raw = typeof data.reservationStatusType === "number" ? data.reservationStatusType : null;
  const extrasCents = Number(quote?.raw_response?.ride24_options?.arvent_extra?.extras_cents ?? 0);
  const extras = Array.isArray(data.reservationExtras) ? data.reservationExtras : [];
  const terms = booking?.partner_currency === "EUR" && data.currencyCode === "EUR"
    && toCents(data.totalPrice) === toCents(booking?.partner_net_price_snapshot)
    && data.depositPrice === 0 && data.depositCreditCardRequired === false && data.totalKMLimit === 0
    && (data.paidAmount === undefined || data.paidAmount === 0)
    && String(data.pickupLocationId) === String(quote?.pickup_location_external_id)
    && String(data.returnLocationId) === String(quote?.dropoff_location_external_id)
    && toCents(data.oneWayFee ?? 0) === toCents(evidence?.one_way_fee ?? 0)
    && (data.agencyReservationReference == null || data.agencyReservationReference === booking?.reservation_code);
  const provider_payload = Object.fromEntries(LIVE_FIELDS.filter((k) => data[k] !== undefined)
    .map((k) => [k, k === "reservationExtras" ? extras.slice(0, 20) : typeof data[k] === "string" ? data[k].slice(0, 500) : data[k]]));
  return {
    booking_reference: typeof data.reservationNumber === "string" ? data.reservationNumber : null,
    supplier_status_type: raw,
    status: raw === 1 ? "confirmed" : raw === 3 ? "cancelled" : "pending",
    terms_verified: terms === true,
    // Paid extras remain uncertified: only an extras-free reservation passes.
    extras_verified: extrasCents === 0 && extras.length === 0 && toCents(data.extraPrice ?? 0) === 0,
    needs_manual_review: !(terms === true),
    provider_payload,
  };
}
