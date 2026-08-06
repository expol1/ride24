import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  requireSecret,
  serviceClient,
} from "../_shared/ride24-security.ts";
import {
  PDFDocument,
  type PDFFont,
  rgb,
} from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";
import QRCode from "https://esm.sh/qrcode@1.5.4";

type AdminClient = ReturnType<typeof serviceClient>;

type RequestBody = {
  booking_id?: unknown;
};

type ClientRelation = {
  name: string;
  email: string;
  phone: string;
};

type PartnerRelation = {
  company_name: string;
  phone: string;
  emergency_phone: string;
  currency: string | null;
};

type CarClassRelation = {
  class_code: string;
};

type PickupLocationRelation = {
  location_name: string;
};

type BookingRow = {
  id: string;
  client_id: string;
  status: string;
  reservation_code: string;
  start_date: string;
  end_date: string;
  pickup_time: string | null;
  return_time: string | null;
  pickup_location: string | null;
  return_location: string | null;
  deposit_snapshot: number;
  mileage_limit_snapshot: number | null;
  driver_included_snapshot: boolean;
  driver_hours_snapshot: string | null;
  pickup_payment_partner_currency: number;
  partner_currency: string;
  client: ClientRelation;
  partner: PartnerRelation;
  carClass: CarClassRelation;
  pickupLocation: PickupLocationRelation | null;
};

type VoucherRow = {
  id: string;
  status: string;
  reservation_code: string | null;
  pdf_path: string | null;
};

type VoucherClaim =
  | { state: "claimed"; row: VoucherRow }
  | { state: "ready"; row: VoucherRow }
  | { state: "generating"; row: VoucherRow };

const MAX_REQUEST_BYTES = 4_096;
const MAX_ASSET_BYTES = 3_000_000;
const MAX_QR_BYTES = 1_000_000;
const MAX_PDF_BYTES = 5_000_000;
const MAX_TEXT_LENGTH = 250;
const VOUCHERS_BUCKET = "vouchers";
const ASSETS_BUCKET = "assets";
const REGULAR_FONT_PATH = "fonts/Roboto-Regular.ttf";
const BOLD_FONT_PATH = "fonts/Roboto-Medium.ttf";
const LOGO_PATH = "bez.png";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

function cleanText(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH,
  fallback = "",
): string {
  if (value == null) return fallback;
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }

  const text = String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\u0020-\u007E\u00A0-\u024F\u1E00-\u1EFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text ? text.slice(0, maxLength) : fallback;
}

function finiteNonNegative(
  value: unknown,
  maximum = 10_000_000,
): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) {
    return null;
  }
  return number;
}

function normalizeCurrency(value: unknown): string | null {
  const currency = cleanText(value, 10).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function safeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^([01]\d|2[0-3]):[0-5]\d/);
  return match ? match[0] : null;
}

function safeReservationCode(value: unknown): string | null {
  const code = cleanText(value, 100);
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(code)) return null;
  return code;
}

function safeVoucherPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();

  if (
    !path
    || path.length > 500
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\u0000")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !/^vouchers\/[A-Za-z0-9_-]+\.pdf$/i.test(path)
  ) {
    return null;
  }

  return path;
}

function normalizeClient(value: unknown): ClientRelation {
  const row = firstRecord(value);
  return {
    name: cleanText(row?.name, 250, "-"),
    email: cleanText(row?.email, 254, "-"),
    phone: cleanText(row?.phone, 50, "-"),
  };
}

function normalizePartner(value: unknown): PartnerRelation {
  const row = firstRecord(value);
  const phone = cleanText(row?.phone, 50, "-");

  return {
    company_name: cleanText(row?.company_name, 250, "-"),
    phone,
    emergency_phone: cleanText(row?.emergency_phone, 50, phone),
    currency: normalizeCurrency(row?.currency),
  };
}

function normalizeCarClass(value: unknown): CarClassRelation {
  const row = firstRecord(value);
  return {
    class_code: cleanText(row?.class_code, 50, "-"),
  };
}

function normalizePickupLocation(
  value: unknown,
): PickupLocationRelation | null {
  const row = firstRecord(value);
  const locationName = cleanText(row?.location_name, 250);
  return locationName ? { location_name: locationName } : null;
}

function normalizeBooking(value: unknown): BookingRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.client_id)
    || typeof value.status !== "string"
  ) {
    return null;
  }

  const reservationCode = safeReservationCode(value.reservation_code);
  const startDate = validIsoDate(value.start_date);
  const endDate = validIsoDate(value.end_date);
  const deposit = finiteNonNegative(value.deposit_snapshot) ?? 0;
  const mileage = value.mileage_limit_snapshot == null
    ? null
    : finiteNonNegative(value.mileage_limit_snapshot, 1_000_000);
  const pickupPayment = finiteNonNegative(
    value.pickup_payment_partner_currency,
  ) ?? 0;
  const partner = normalizePartner(value.partners);
  const partnerCurrency = normalizeCurrency(value.partner_currency)
    || partner.currency
    || "EUR";

  if (!reservationCode || !startDate || !endDate) return null;

  return {
    id: value.id,
    client_id: value.client_id,
    status: value.status,
    reservation_code: reservationCode,
    start_date: startDate,
    end_date: endDate,
    pickup_time: safeTime(value.pickup_time),
    return_time: safeTime(value.return_time),
    pickup_location: cleanText(value.pickup_location, 250) || null,
    return_location: cleanText(value.return_location, 250) || null,
    deposit_snapshot: deposit,
    mileage_limit_snapshot: mileage,
    driver_included_snapshot: value.driver_included_snapshot === true,
    driver_hours_snapshot:
      cleanText(value.driver_hours_snapshot, 100) || null,
    pickup_payment_partner_currency: pickupPayment,
    partner_currency: partnerCurrency,
    client: normalizeClient(value.profiles),
    partner,
    carClass: normalizeCarClass(value.car_classes),
    pickupLocation: normalizePickupLocation(value.pickup_location_join),
  };
}

function normalizeVoucher(value: unknown): VoucherRow | null {
  if (!isRecord(value) || !isUuid(value.id)) return null;

  return {
    id: value.id,
    status: cleanText(value.status, 50, "error"),
    reservation_code:
      safeReservationCode(value.reservation_code),
    pdf_path: safeVoucherPath(value.pdf_path),
  };
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new Error("Wymagane dane w formacie JSON");
  }

  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new Error("Nieprawidłowy rozmiar danych wejściowych");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new Error("Wymagane dane vouchera");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      totalBytes += value.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Nieprawidłowy rozmiar danych wejściowych");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Nieprawidłowy format JSON");
  }

  if (!isRecord(parsed)) throw new Error("Nieprawidłowe dane wejściowe");
  return parsed;
}

async function downloadAsset(
  admin: AdminClient,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await admin.storage
    .from(ASSETS_BUCKET)
    .download(path);

  if (error || !data || data.size <= 0 || data.size > MAX_ASSET_BYTES) {
    throw new Error("VOUCHER_ASSET_UNAVAILABLE");
  }

  return new Uint8Array(await data.arrayBuffer());
}

function fitText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;

  const ellipsis = "...";
  let output = text;
  while (
    output.length > 1
    && font.widthOfTextAtSize(`${output}${ellipsis}`, size) > maxWidth
  ) {
    output = output.slice(0, -1);
  }

  return `${output}${ellipsis}`;
}

function drawValue(
  page: ReturnType<PDFDocument["addPage"]>,
  font: PDFFont,
  bold: PDFFont,
  label: string,
  value: string,
  y: number,
  valueColor = rgb(0.2, 0.2, 0.2),
): void {
  page.drawText(label, {
    x: 50,
    y,
    size: 12,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
  page.drawText(fitText(bold, value, 12, 300), {
    x: 250,
    y,
    size: 12,
    font: bold,
    color: valueColor,
  });
}

async function createQrPng(verifyUrl: string): Promise<Uint8Array> {
  const dataUrl = await QRCode.toDataURL(verifyUrl, {
    width: 200,
    margin: 1,
    color: { dark: "#10386B", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
  });

  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("VOUCHER_QR_FAILED");

  const bytes = Uint8Array.from(
    atob(encoded),
    (character) => character.charCodeAt(0),
  );

  if (bytes.length <= 0 || bytes.length > MAX_QR_BYTES) {
    throw new Error("VOUCHER_QR_FAILED");
  }

  return bytes;
}

async function createVoucherPdf(
  admin: AdminClient,
  booking: BookingRow,
): Promise<Uint8Array> {
  const verifyUrl =
    `https://ride24.pl/verify.html?code=${encodeURIComponent(booking.reservation_code)}`;

  const [regularBytes, boldBytes, logoBytes, qrBytes] = await Promise.all([
    downloadAsset(admin, REGULAR_FONT_PATH),
    downloadAsset(admin, BOLD_FONT_PATH),
    downloadAsset(admin, LOGO_PATH),
    createQrPng(verifyUrl),
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const font = await pdfDoc.embedFont(regularBytes, { subset: true });
  const bold = await pdfDoc.embedFont(boldBytes, { subset: true });
  const logoImage = await pdfDoc.embedPng(logoBytes);
  const qrImage = await pdfDoc.embedPng(qrBytes);
  const page = pdfDoc.addPage([600, 800]);

  const brandBlue = rgb(0.06, 0.22, 0.42);
  const brandGreen = rgb(0.45, 0.85, 0.25);
  const textDark = rgb(0.2, 0.2, 0.2);
  const textGray = rgb(0.4, 0.4, 0.4);
  const lightGray = rgb(0.9, 0.9, 0.9);

  page.drawRectangle({
    x: 0,
    y: 700,
    width: 600,
    height: 100,
    color: brandBlue,
  });
  page.drawRectangle({
    x: 0,
    y: 695,
    width: 600,
    height: 5,
    color: brandGreen,
  });
  page.drawImage(logoImage, {
    x: 50,
    y: 725,
    width: 130,
    height: 45,
  });
  page.drawText("RENTAL VOUCHER / VOUCHER", {
    x: 300,
    y: 755,
    size: 14,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(
    fitText(font, `Res / Nr: ${booking.reservation_code}`, 12, 250),
    {
      x: 300,
      y: 735,
      size: 12,
      font,
      color: rgb(0.8, 0.8, 0.9),
    },
  );

  let y = 640;

  page.drawText("CLIENT DETAILS / DANE KLIENTA", {
    x: 50,
    y,
    size: 12,
    font: bold,
    color: textGray,
  });
  y -= 25;
  drawValue(page, font, bold, "Name / Imię i nazwisko:", booking.client.name, y);
  y -= 18;
  drawValue(page, font, bold, "Phone / Telefon:", booking.client.phone, y);
  y -= 18;
  drawValue(page, font, bold, "Email / E-mail:", booking.client.email, y);

  y -= 25;
  page.drawLine({
    start: { x: 50, y },
    end: { x: 550, y },
    thickness: 1,
    color: lightGray,
  });
  y -= 30;

  page.drawText("VEHICLE & RENTAL INFO / POJAZD I WYNAJEM", {
    x: 50,
    y,
    size: 12,
    font: bold,
    color: textGray,
  });
  y -= 25;
  drawValue(page, font, bold, "Class / Klasa:", booking.carClass.class_code, y);
  y -= 18;

  const pickup =
    booking.pickupLocation?.location_name
    || booking.pickup_location
    || "-";
  drawValue(page, font, bold, "Pickup / Miejsce odbioru:", pickup, y);
  y -= 18;

  const returnLocation = booking.return_location || "-";
  drawValue(page, font, bold, "Return / Miejsce zwrotu:", returnLocation, y);
  y -= 18;

  const pickupDateTime = booking.pickup_time
    ? `${booking.start_date} ${booking.pickup_time}`
    : booking.start_date;
  drawValue(page, font, bold, "Start / Odbiór:", pickupDateTime, y);
  y -= 18;

  const returnDateTime = booking.return_time
    ? `${booking.end_date} ${booking.return_time}`
    : booking.end_date;
  drawValue(page, font, bold, "End / Zwrot:", returnDateTime, y);
  y -= 25;

  page.drawText("RENTAL DETAILS / SZCZEGÓŁY WYNAJMU", {
    x: 50,
    y,
    size: 12,
    font: bold,
    color: textGray,
  });
  y -= 20;
  drawValue(
    page,
    font,
    bold,
    "Deposit / Kaucja:",
    `${booking.deposit_snapshot} ${booking.partner_currency}`,
    y,
  );
  y -= 18;
  drawValue(
    page,
    font,
    bold,
    "Mileage / Limit km:",
    booking.mileage_limit_snapshot !== null
      ? `${booking.mileage_limit_snapshot} km/day`
      : "Unlimited / Bez limitu",
    y,
  );

  if (booking.driver_included_snapshot) {
    y -= 18;
    const hours = booking.driver_hours_snapshot
      ? ` (${booking.driver_hours_snapshot}h)`
      : "";
    drawValue(
      page,
      font,
      bold,
      "Driver / Kierowca:",
      `Included${hours} / W cenie${hours}`,
      y,
      brandBlue,
    );
  }

  y -= 30;

  if (booking.pickup_payment_partner_currency > 0) {
    page.drawRectangle({
      x: 40,
      y: y - 55,
      width: 520,
      height: 80,
      color: rgb(0.96, 0.97, 0.98),
    });
    page.drawText("PAYMENT SUMMARY / PODSUMOWANIE PŁATNOŚCI", {
      x: 60,
      y,
      size: 12,
      font: bold,
      color: textGray,
    });
    y -= 25;
    page.drawText("To pay at pickup / Do zapłaty na miejscu:", {
      x: 60,
      y,
      size: 12,
      font,
      color: textGray,
    });
    page.drawText(
      `${booking.pickup_payment_partner_currency} ${booking.partner_currency}`,
      {
        x: 300,
        y,
        size: 14,
        font: bold,
        color: rgb(0.1, 0.6, 0.1),
      },
    );
    y -= 45;
  }

  page.drawText("RENTAL PARTNER / WYPOŻYCZALNIA", {
    x: 50,
    y,
    size: 12,
    font: bold,
    color: textGray,
  });
  y -= 25;
  drawValue(
    page,
    font,
    bold,
    "Company / Firma:",
    booking.partner.company_name,
    y,
  );
  y -= 18;
  drawValue(
    page,
    font,
    bold,
    "Phone / Telefon:",
    booking.partner.phone,
    y,
  );
  y -= 18;
  drawValue(
    page,
    font,
    bold,
    "Emergency / Tel. alarmowy:",
    booking.partner.emergency_phone,
    y,
  );

  page.drawLine({
    start: { x: 50, y: 150 },
    end: { x: 550, y: 150 },
    thickness: 1,
    color: lightGray,
  });
  page.drawText(
    "Verify this reservation online / Zweryfikuj rezerwację online:",
    {
      x: 50,
      y: 130,
      size: 10,
      font,
      color: textGray,
    },
  );
  page.drawText(fitText(bold, verifyUrl, 10, 390), {
    x: 50,
    y: 115,
    size: 10,
    font: bold,
    color: brandBlue,
  });
  page.drawImage(qrImage, {
    x: 460,
    y: 75,
    width: 85,
    height: 85,
  });

  page.drawText(
    "Please present this voucher when picking up the vehicle.",
    {
      x: 50,
      y: 50,
      size: 10,
      font,
      color: textGray,
    },
  );
  page.drawText(
    "Prosimy o okazanie tego vouchera przy odbiorze pojazdu.",
    {
      x: 50,
      y: 38,
      size: 10,
      font,
      color: textGray,
    },
  );

  const pdfBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  if (pdfBytes.length <= 0 || pdfBytes.length > MAX_PDF_BYTES) {
    throw new Error("VOUCHER_PDF_INVALID");
  }

  return pdfBytes;
}

async function loadBooking(
  admin: AdminClient,
  bookingId: string,
): Promise<BookingRow | null> {
  const { data, error } = await admin
    .from("bookings")
    .select(`
      id,
      client_id,
      status,
      reservation_code,
      start_date,
      end_date,
      pickup_time,
      return_time,
      pickup_location,
      return_location,
      deposit_snapshot,
      mileage_limit_snapshot,
      driver_included_snapshot,
      driver_hours_snapshot,
      pickup_payment_partner_currency,
      partner_currency,
      profiles!fk_client(name, email, phone),
      partners!bookings_partner_id_fkey(
        company_name,
        phone,
        emergency_phone,
        currency
      ),
      pickup_location_join:partner_locations!pickup_location_id(
        location_name
      ),
      car_classes!bookings_car_class_id_fkey(class_code)
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) throw new Error("VOUCHER_BOOKING_LOOKUP_FAILED");
  return normalizeBooking(data);
}

async function hasPaidPayment(
  admin: AdminClient,
  bookingId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("payments")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("status", "paid")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("VOUCHER_PAYMENT_LOOKUP_FAILED");
  return Boolean(data);
}

async function loadVoucher(
  admin: AdminClient,
  bookingId: string,
): Promise<VoucherRow | null> {
  const { data, error } = await admin
    .from("vouchers")
    .select("id, status, reservation_code, pdf_path")
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (error) throw new Error("VOUCHER_ROW_LOOKUP_FAILED");
  return normalizeVoucher(data);
}

async function claimVoucherGeneration(
  admin: AdminClient,
  bookingId: string,
): Promise<VoucherClaim> {
  let existing = await loadVoucher(admin, bookingId);

  if (existing?.status === "ready" && existing.pdf_path) {
    return { state: "ready", row: existing };
  }
  if (existing?.status === "generating") {
    return { state: "generating", row: existing };
  }

  if (!existing) {
    const { data, error } = await admin
      .from("vouchers")
      .insert({
        booking_id: bookingId,
        status: "generating",
      })
      .select("id, status, reservation_code, pdf_path")
      .maybeSingle();

    if (!error) {
      const inserted = normalizeVoucher(data);
      if (!inserted) throw new Error("VOUCHER_CLAIM_FAILED");
      return { state: "claimed", row: inserted };
    }

    // Równoległe wywołanie mogło utworzyć rekord z unikalnym booking_id.
    existing = await loadVoucher(admin, bookingId);
    if (!existing) throw new Error("VOUCHER_CLAIM_FAILED");
    if (existing.status === "ready" && existing.pdf_path) {
      return { state: "ready", row: existing };
    }
    if (existing.status === "generating") {
      return { state: "generating", row: existing };
    }
  }

  const { data, error } = await admin
    .from("vouchers")
    .update({ status: "generating" })
    .eq("id", existing!.id)
    .eq("booking_id", bookingId)
    .eq("status", existing!.status)
    .select("id, status, reservation_code, pdf_path")
    .maybeSingle();

  if (error) throw new Error("VOUCHER_CLAIM_FAILED");

  const claimed = normalizeVoucher(data);
  if (!claimed) {
    const current = await loadVoucher(admin, bookingId);
    if (current?.status === "ready" && current.pdf_path) {
      return { state: "ready", row: current };
    }
    if (current?.status === "generating") {
      return { state: "generating", row: current };
    }
    throw new Error("VOUCHER_CLAIM_FAILED");
  }

  return { state: "claimed", row: claimed };
}

async function markVoucherError(
  admin: AdminClient,
  bookingId: string,
  voucherId: string | null,
): Promise<void> {
  let query = admin
    .from("vouchers")
    .update({ status: "error" })
    .eq("booking_id", bookingId)
    .eq("status", "generating");

  if (voucherId) query = query.eq("id", voucherId);
  const { error } = await query;

  if (error) console.error("generate-voucher error status write failed");
}

async function queueConfirmationEmail(
  admin: AdminClient,
  bookingId: string,
): Promise<void> {
  const { error } = await admin
    .from("email_logs")
    .upsert(
      {
        booking_id: bookingId,
        type: "booking_confirmation",
        status: "queued",
      },
      {
        onConflict: "booking_id,type",
        ignoreDuplicates: true,
      },
    );

  if (error) {
    console.error("generate-voucher confirmation email queue failed");
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      req,
      { error: "METHOD_NOT_ALLOWED" },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  let authorized = false;
  let bookingId: string | null = null;
  let claimedVoucherId: string | null = null;
  let uploadedPath: string | null = null;

  try {
    requireSecret(req, "x-internal-secret", "RIDE24_INTERNAL_SECRET");
    authorized = true;

    const body = await readJsonObject(req) as RequestBody;
    if (!isUuid(body.booking_id)) {
      return jsonResponse(req, { error: "Nieprawidłowy booking_id" }, 400);
    }
    bookingId = body.booking_id;

    const admin = serviceClient();
    const booking = await loadBooking(admin, bookingId);

    if (!booking) {
      return jsonResponse(req, { error: "Rezerwacja nie istnieje" }, 404);
    }
    if (booking.status !== "paid") {
      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "BOOKING_NOT_PAID",
      });
    }
    if (!(await hasPaidPayment(admin, booking.id))) {
      return jsonResponse(
        req,
        { error: "Brak potwierdzonej płatności rezerwacji" },
        409,
      );
    }

    const claim = await claimVoucherGeneration(admin, booking.id);
    claimedVoucherId = claim.row.id;

    if (claim.state === "ready") {
      await queueConfirmationEmail(admin, booking.id);
      return jsonResponse(req, {
        success: true,
        existing: true,
        reservation_code:
          claim.row.reservation_code || booking.reservation_code,
      });
    }
    if (claim.state === "generating") {
      return jsonResponse(req, {
        success: true,
        existing: false,
        generating: true,
      }, 202);
    }

    const pdfBytes = await createVoucherPdf(admin, booking);
    uploadedPath = `vouchers/${booking.reservation_code}.pdf`;

    const { error: uploadError } = await admin.storage
      .from(VOUCHERS_BUCKET)
      .upload(uploadedPath, pdfBytes, {
        contentType: "application/pdf",
        cacheControl: "private, max-age=0, no-store",
        upsert: false,
      });

    if (uploadError) throw new Error("VOUCHER_UPLOAD_FAILED");

    const { data: saved, error: saveError } = await admin
      .from("vouchers")
      .update({
        reservation_code: booking.reservation_code,
        pdf_path: uploadedPath,
        status: "ready",
      })
      .eq("id", claim.row.id)
      .eq("booking_id", booking.id)
      .eq("status", "generating")
      .select("id")
      .maybeSingle();

    if (saveError || !saved) throw new Error("VOUCHER_SAVE_FAILED");

    claimedVoucherId = null;
    uploadedPath = null;

    await queueConfirmationEmail(admin, booking.id);

    return jsonResponse(req, {
      success: true,
      existing: false,
      reservation_code: booking.reservation_code,
    });
  } catch (error) {
    const admin = serviceClient();

    if (authorized && uploadedPath) {
      await admin.storage
        .from(VOUCHERS_BUCKET)
        .remove([uploadedPath])
        .catch(() => undefined);
    }
    if (authorized && bookingId) {
      await markVoucherError(
        admin,
        bookingId,
        claimedVoucherId,
      ).catch(() => undefined);
    }

    console.error(
      "generate-voucher",
      error instanceof Error && error.message === "INTERNAL_AUTH_FAILED"
        ? "INTERNAL_AUTH_FAILED"
        : "REQUEST_FAILED",
    );

    const publicError = publicErrorMessage(error);
    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
