import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authenticatedUser,
  corsHeaders,
  escapeHtml,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  requireSecret,
  serviceClient,
} from "../_shared/ride24-security.ts";

type AdminClient = ReturnType<typeof serviceClient>;

type EmailLogRow = {
  id: string;
  booking_id: string;
  type: string;
};

type BookingRow = {
  id: string;
  reservation_code: string;
  client_email: string | null;
  partner_email: string | null;
  client_phone: string | null;
  partner_phone: string | null;
  partner_type: string | null;
  class_code: string | null;
};

type EmailContent = {
  recipient: string;
  subject: string;
  html: string;
  whatsappPhone: string | null;
  whatsappTemplate: string | null;
};

const MAX_EMAILS_PER_RUN = 100;
const QUEUE_BATCH_SIZE = 10;
const MAX_EMAIL_LENGTH = 254;
const MAX_CODE_LENGTH = 100;
const MAX_CLASS_CODE_LENGTH = 50;
const RESEND_TIMEOUT_MS = 10_000;
const WHATSAPP_TIMEOUT_MS = 8_000;
const SUPPORTED_TYPES = new Set([
  "client_payment_required",
  "booking_confirmation",
  "client_booking_rejected",
  "partner_new_request",
  "partner_booking_confirmed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanEmail(value: unknown): string | null {
  const email = cleanText(value, MAX_EMAIL_LENGTH)?.toLowerCase() || null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cleanPhone(value: unknown): string | null {
  const source = cleanText(value, 50);
  if (!source) return null;

  const digits = source.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function normalizeLog(value: unknown): EmailLogRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.booking_id)
    || typeof value.type !== "string"
  ) {
    return null;
  }

  const type = value.type.trim();
  if (!SUPPORTED_TYPES.has(type)) return null;

  return {
    id: value.id,
    booking_id: value.booking_id,
    type,
  };
}

function normalizeBooking(value: unknown): BookingRow | null {
  if (!isRecord(value) || !isUuid(value.id)) return null;

  const profile = firstRecord(value.profiles);
  const partner = firstRecord(value.partners);
  const carClass = firstRecord(value.car_classes);
  const reservationCode = cleanText(value.reservation_code, MAX_CODE_LENGTH);

  if (!reservationCode) return null;

  return {
    id: value.id,
    reservation_code: reservationCode,
    client_email: cleanEmail(profile?.email),
    partner_email: cleanEmail(partner?.email),
    client_phone: cleanPhone(profile?.phone),
    partner_phone: cleanPhone(partner?.phone),
    partner_type: cleanText(partner?.provider_type, 20),
    class_code: cleanText(carClass?.class_code, MAX_CLASS_CODE_LENGTH),
  };
}

function baseTemplate(
  title: string,
  content: string,
  buttonText?: string,
  buttonUrl?: string,
): string {
  const button = buttonText && buttonUrl
    ? `<div style="text-align:center;margin-top:35px"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:16px 32px;background:#73D700;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:16px">${escapeHtml(buttonText)}</a></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="font-family:Arial,sans-serif;background:#F8FAFC;color:#0F172A;margin:0;padding:0">
  <div style="width:100%;padding:40px 0;background:#F8FAFC">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #E2E8F0;border-top:8px solid #73D700">
      <div style="padding:32px;text-align:center;background:#1E3A8A">
        <img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" width="160" alt="Ride24">
      </div>
      <div style="padding:40px 35px;line-height:1.6">
        <h1 style="font-size:24px;font-weight:800;color:#1E3A8A;margin-top:0;text-align:center">${escapeHtml(title)}</h1>
        ${content}
        ${button}
      </div>
      <div style="padding:25px;text-align:center;font-size:13px;color:#94A3B8;background:#0F172A">
        &copy; 2026 Ride24.pl — Samochody z różnych zakątków świata.
      </div>
    </div>
  </div>
</body>
</html>`;
}

function highlight(label: string, value: string): string {
  return `<div style="background:#F1FCE3;border:1px solid rgba(115,215,0,.2);padding:22px;border-radius:16px;margin-bottom:26px;text-align:center">
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#64748B;margin-bottom:4px">${escapeHtml(label)}</div>
    <div style="font-size:20px;font-weight:800;color:#1E3A8A">${escapeHtml(value)}</div>
  </div>`;
}

function buildEmail(log: EmailLogRow, booking: BookingRow): EmailContent | null {
  const code = booking.reservation_code;
  const encodedBookingId = encodeURIComponent(booking.id);
  const encodedCode = encodeURIComponent(code);

  if (log.type.startsWith("partner_") && booking.partner_type === "api") {
    return null;
  }

  if (log.type === "client_payment_required") {
    if (!booking.client_email) return null;
    return {
      recipient: booking.client_email,
      subject: `Potwierdź rezerwację ${code}`,
      html: baseTemplate(
        "Twoja rezerwacja czeka!",
        `<p style="font-size:16px;color:#334155">Dobra wiadomość! Wypożyczalnia zaakceptowała Twoje zapytanie.</p>
        ${highlight("Numer rezerwacji", code)}
        <p style="font-size:16px;color:#334155">Aby potwierdzić rezerwację i zablokować auto, dokonaj płatności online w ciągu 24 godzin.</p>`,
        "Opłać rezerwację",
        `https://ride24.pl/panel?id=${encodedBookingId}`,
      ),
      whatsappPhone: booking.client_phone,
      whatsappTemplate: "ride24_booking_approved",
    };
  }

  if (log.type === "booking_confirmation") {
    if (!booking.client_email) return null;
    return {
      recipient: booking.client_email,
      subject: "Ride24 – Twoja rezerwacja została potwierdzona",
      html: baseTemplate(
        "Twoja rezerwacja została opłacona",
        `<p style="font-size:16px;color:#334155">Płatność została zaksięgowana, a rezerwacja jest potwierdzona.</p>
        ${highlight("Kod rezerwacji", code)}
        <p style="font-size:16px;color:#334155">Voucher PDF i szczegóły odbioru pojazdu są dostępne w panelu klienta.</p>`,
        "Przejdź do panelu",
        `https://ride24.pl/panel?reservation=${encodedCode}`,
      ),
      whatsappPhone: null,
      whatsappTemplate: null,
    };
  }

  if (log.type === "client_booking_rejected") {
    if (!booking.client_email) return null;
    return {
      recipient: booking.client_email,
      subject: `Rezerwacja ${code} nie została zaakceptowana`,
      html: baseTemplate(
        "Rezerwacja nie została zaakceptowana",
        `<p style="font-size:16px;color:#334155">Niestety wypożyczalnia nie mogła potwierdzić Twojego zapytania.</p>
        ${highlight("Numer rezerwacji", code)}
        <p style="font-size:16px;color:#334155">Nie została pobrana żadna opłata. Wróć do Ride24 i wybierz inną grupę pojazdów lub termin.</p>`,
        "Wyszukaj inną ofertę",
        "https://ride24.pl/",
      ),
      whatsappPhone: null,
      whatsappTemplate: null,
    };
  }

  if (log.type === "partner_new_request") {
    if (!booking.partner_email) return null;
    return {
      recipient: booking.partner_email,
      subject: `New booking request: ${code}`,
      html: baseTemplate(
        "New Booking Request",
        `<p style="font-size:16px;color:#334155">You have received a new booking request for car class: <strong>${escapeHtml(booking.class_code || "-")}</strong>.</p>
        ${highlight("Reservation Code", code)}
        <p style="font-size:16px;color:#334155">Please log in to your Ride24 partner account to accept or decline this request.</p>`,
        "Log in to Ride24",
        "https://ride24.pl/",
      ),
      whatsappPhone: booking.partner_phone,
      whatsappTemplate: null,
    };
  }

  if (log.type === "partner_booking_confirmed") {
    if (!booking.partner_email) return null;
    return {
      recipient: booking.partner_email,
      subject: `Booking confirmed – ${code}`,
      html: baseTemplate(
        "Booking Confirmed",
        `<p style="font-size:16px;color:#334155">The client has confirmed reservation <strong>${escapeHtml(code)}</strong>.</p>
        ${highlight("Car Class", booking.class_code || "-")}
        <p style="font-size:16px;color:#334155">Please prepare the vehicle for the scheduled pickup.</p>`,
        "Log in to Ride24",
        "https://ride24.pl/",
      ),
      whatsappPhone: booking.partner_phone,
      whatsappTemplate: null,
    };
  }

  return null;
}

async function loadBooking(
  admin: AdminClient,
  bookingId: string,
): Promise<BookingRow | null> {
  const { data, error } = await admin
    .from("bookings")
    .select(`
      id,
      reservation_code,
      profiles!fk_client(email, phone),
      partners!bookings_partner_id_fkey(email, phone, provider_type),
      car_classes!bookings_car_class_id_fkey(class_code)
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) throw new Error("EMAIL_BOOKING_LOOKUP_FAILED");
  return normalizeBooking(data);
}

async function setLogStatus(
  admin: AdminClient,
  logId: string,
  fromStatus: string,
  toStatus: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("email_logs")
    .update({ status: toStatus })
    .eq("id", logId)
    .eq("status", fromStatus)
    .select("id")
    .maybeSingle();

  if (error) throw new Error("EMAIL_LOG_UPDATE_FAILED");
  return Boolean(data);
}

async function sendResendEmail(
  apiKey: string,
  logId: string,
  content: EmailContent,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `ride24-email/${logId}`,
      },
      body: JSON.stringify({
        from: "Ride24 <noreply@ride24.pl>",
        to: [content.recipient],
        subject: content.subject,
        html: content.html,
      }),
      signal: controller.signal,
      redirect: "error",
    });

    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function whatsappUrl(): string {
  const rawUrl = Deno.env.get("SUPABASE_URL");
  if (!rawUrl) throw new Error("WHATSAPP_CONFIGURATION_MISSING");

  const url = new URL(rawUrl);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("WHATSAPP_CONFIGURATION_MISSING");
  }

  url.pathname = "/functions/v1/whatsapp-alert";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function sendWhatsappBestEffort(
  phone: string | null,
  template: string | null,
): Promise<void> {
  if (!phone) return;

  const internalSecret = Deno.env.get("RIDE24_INTERNAL_SECRET");
  if (!internalSecret) {
    console.error("email-worker whatsapp configuration missing");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHATSAPP_TIMEOUT_MS);

  try {
    const response = await fetch(whatsappUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({
        phone,
        ...(template ? { template } : {}),
      }),
      signal: controller.signal,
      redirect: "error",
    });

    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      console.error("email-worker whatsapp failed", response.status);
    }
  } catch {
    console.error("email-worker whatsapp failed", "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function processLog(
  admin: AdminClient,
  resendKey: string,
  log: EmailLogRow,
): Promise<"sent" | "failed" | "skipped"> {
  const locked = await setLogStatus(admin, log.id, "queued", "processing");
  if (!locked) return "skipped";

  try {
    const booking = await loadBooking(admin, log.booking_id);
    if (!booking) {
      await setLogStatus(admin, log.id, "processing", "failed");
      return "failed";
    }

    const content = buildEmail(log, booking);
    if (!content) {
      console.error("email-worker blocked or invalid recipient", log.id);
      await setLogStatus(admin, log.id, "processing", "failed");
      return "failed";
    }

    const result = await sendResendEmail(resendKey, log.id, content);
    if (!result.ok) {
      console.error("email-worker resend failed", log.id, result.status);
      await setLogStatus(admin, log.id, "processing", "failed");
      return "failed";
    }

    const saved = await setLogStatus(admin, log.id, "processing", "sent");
    if (!saved) {
      console.error("email-worker sent status conflict", log.id);
      return "failed";
    }

    await sendWhatsappBestEffort(
      content.whatsappPhone,
      content.whatsappTemplate,
    );

    return "sent";
  } catch (error) {
    console.error(
      "email-worker item failed",
      log.id,
      error instanceof Error && error.name === "AbortError"
        ? "TIMEOUT"
        : "PROCESSING_ERROR",
    );

    await setLogStatus(admin, log.id, "processing", "failed")
      .catch(() => undefined);
    return "failed";
  }
}

async function processQueue(
  admin: AdminClient,
  resendKey: string,
  bookingIds: string[] | null,
): Promise<Record<string, number>> {
  let examined = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  while (examined < MAX_EMAILS_PER_RUN) {
    const limit = Math.min(
      QUEUE_BATCH_SIZE,
      MAX_EMAILS_PER_RUN - examined,
    );

    let queueQuery = admin
      .from("email_logs")
      .select("id, booking_id, type")
      .eq("status", "queued");

    if (bookingIds) {
      queueQuery = queueQuery.in("booking_id", bookingIds);
    }

    const { data, error } = await queueQuery
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw new Error("EMAIL_QUEUE_READ_FAILED");

    const rawRows = (data || []) as unknown[];
    if (!rawRows.length) break;

    let claimedInBatch = 0;
    for (const raw of rawRows) {
      examined += 1;
      const log = normalizeLog(raw);

      if (!log) {
        if (isRecord(raw) && isUuid(raw.id)) {
          await setLogStatus(admin, raw.id, "queued", "failed")
            .catch(() => undefined);
        }
        failed += 1;
        continue;
      }

      const result = await processLog(admin, resendKey, log);
      if (result !== "skipped") claimedInBatch += 1;
      if (result === "sent") sent += 1;
      else if (result === "failed") failed += 1;
      else skipped += 1;
    }

    if (rawRows.length < limit) break;
    if (claimedInBatch === 0) break;
  }

  return { examined, sent, failed, skipped };
}

function readBearerToken(req: Request): string | null {
  const value = req.headers.get("authorization")
    || req.headers.get("Authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function parseRequestedBookingIds(value: unknown): string[] | null {
  if (!isRecord(value)) return null;

  const rawIds = value.booking_ids != null
    ? value.booking_ids
    : value.booking_id != null
    ? [value.booking_id]
    : null;

  if (rawIds == null) return null;
  if (
    !Array.isArray(rawIds)
    || rawIds.length < 1
    || rawIds.length > 50
    || rawIds.some((item) => !isUuid(item))
  ) {
    throw new Error("INVALID_BOOKING_ID");
  }

  return [...new Set(rawIds as string[])];
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("INVALID_BOOKING_ID");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_BOOKING_ID") {
      throw error;
    }
    throw new Error("INVALID_BOOKING_ID");
  }
}

function validCronSecret(req: Request): boolean {
  try {
    requireSecret(req, "x-cron-secret", "RIDE24_CRON_SECRET");
    return true;
  } catch {
    return false;
  }
}

async function authorizeWorkerRequest(
  req: Request,
  admin: AdminClient,
  bookingIds: string[] | null,
): Promise<void> {
  const token = readBearerToken(req);
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // Existing Edge Functions and webhooks call the worker with the service-role JWT.
  if (token && serviceRoleKey && token === serviceRoleKey) return;
  if (validCronSecret(req)) return;

  // Browser callers may only trigger queued messages for their own partner bookings.
  if (!bookingIds) throw new Error("INTERNAL_AUTH_FAILED");

  const user = await authenticatedUser(req);
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error("INTERNAL_AUTH_FAILED");
  if (profile?.role === "admin") return;

  const { data: partners, error: partnerError } = await admin
    .from("partners")
    .select("id")
    .eq("user_id", user.id);

  if (partnerError) throw new Error("INTERNAL_AUTH_FAILED");
  const partnerIds = (partners || [])
    .map((row) => row.id)
    .filter(isUuid);
  if (!partnerIds.length) throw new Error("INTERNAL_AUTH_FAILED");

  const { data: ownedBookings, error: bookingError } = await admin
    .from("bookings")
    .select("id")
    .in("id", bookingIds)
    .in("partner_id", partnerIds);

  if (bookingError) throw new Error("INTERNAL_AUTH_FAILED");
  const ownedIds = new Set((ownedBookings || []).map((row) => row.id));
  if (bookingIds.some((id) => !ownedIds.has(id))) {
    throw new Error("INTERNAL_AUTH_FAILED");
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

  try {
    const body = await requestBody(req);
    const bookingIds = parseRequestedBookingIds(body);
    const admin = serviceClient();
    await authorizeWorkerRequest(req, admin, bookingIds);

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) throw new Error("EMAIL_CONFIGURATION_MISSING");

    const result = await processQueue(admin, resendKey, bookingIds);
    return jsonResponse(req, {
      success: result.failed === 0,
      booking_ids: bookingIds,
      ...result,
    });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : "REQUEST_FAILED";
    console.error(
      "email-worker",
      ["INTERNAL_AUTH_FAILED", "AUTH_REQUIRED", "INVALID_BOOKING_ID"].includes(errorCode)
        ? errorCode
        : "REQUEST_FAILED",
    );

    if (errorCode === "INVALID_BOOKING_ID") {
      return jsonResponse(req, { error: "Nieprawidłowa rezerwacja" }, 400);
    }

    const publicError = publicErrorMessage(error);
    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
