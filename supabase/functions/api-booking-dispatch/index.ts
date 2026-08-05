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
  endpointFor,
  loadPartnerCredentials,
  partnerApiRequest,
  sanitizePartnerPayload,
} from "../_shared/partner-api.ts";

type AdminClient = ReturnType<typeof serviceClient>;

type RequestBody = {
  booking_id?: unknown;
};

type PartnerRelation = {
  api_provider: string | null;
  provider_type: string | null;
};

type CarClassRelation = {
  external_id: string | null;
  class_code: string | null;
};

type BookingRow = {
  id: string;
  reservation_code: string | null;
  status: string;
  created_at: string | null;
  partner_id: string;
  car_class_id: string;
  start_date: string;
  end_date: string;
  pickup_time: string | null;
  return_time: string | null;
  pickup_location: string | null;
  return_location: string | null;
  main_driver_name: string | null;
  main_driver_age: number | string | null;
  add_driver_name: string | null;
  add_driver_age: number | string | null;
  partner_currency: string | null;
  partner_net_price_snapshot: number | string | null;
  final_price_snapshot: number | string | null;
  api_booking_reference: string | null;
  api_quote_id: string | null;
  partner_response_deadline: string | null;
  carClass: CarClassRelation;
  partner: PartnerRelation;
};

type QuoteRow = {
  id: string;
  partner_id: string;
  car_class_id: string;
  booking_id: string | null;
  used_at: string | null;
  external_quote_reference: string | null;
  pickup_location_external_id: string | null;
  dropoff_location_external_id: string | null;
  external_group_id: string | null;
};

type ParsedPartnerResponse = {
  payload: Record<string, unknown>;
  externalReference: string | null;
  status: "pending" | "confirmed" | "rejected";
};

const MAX_REQUEST_BYTES = 4_096;
const MAX_REFERENCE_LENGTH = 500;
const MAX_REVIEW_TEXT_LENGTH = 4_000;
const PARTNER_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1_000;

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
  if (!["string", "number", "bigint"].includes(typeof value)) return null;

  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  return text || null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("Nieprawidłowy rozmiar danych wejściowych");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new Error("Wymagane dane wejściowe");

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

function relationPartner(value: unknown): PartnerRelation | null {
  const row = firstRecord(value);
  if (!row) return null;

  return {
    api_provider: cleanText(row.api_provider, 100),
    provider_type: cleanText(row.provider_type, 20),
  };
}

function relationCarClass(value: unknown): CarClassRelation | null {
  const row = firstRecord(value);
  if (!row) return null;

  return {
    external_id: cleanText(row.external_id, 200),
    class_code: cleanText(row.class_code, 20),
  };
}

function normalizeBooking(value: unknown): BookingRow | null {
  if (!isRecord(value)) return null;

  const partner = relationPartner(value.partners);
  const carClass = relationCarClass(value.car_classes);

  if (
    !partner
    || !carClass
    || !isUuid(value.id)
    || !isUuid(value.partner_id)
    || !isUuid(value.car_class_id)
    || typeof value.status !== "string"
    || typeof value.start_date !== "string"
    || typeof value.end_date !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    reservation_code: cleanText(value.reservation_code, 100),
    status: value.status,
    created_at: cleanText(value.created_at, 80),
    partner_id: value.partner_id,
    car_class_id: value.car_class_id,
    start_date: value.start_date,
    end_date: value.end_date,
    pickup_time: cleanText(value.pickup_time, 20),
    return_time: cleanText(value.return_time, 20),
    pickup_location: cleanText(value.pickup_location, 250),
    return_location: cleanText(value.return_location, 250),
    main_driver_name: cleanText(value.main_driver_name, 250),
    main_driver_age: typeof value.main_driver_age === "number"
        || typeof value.main_driver_age === "string"
      ? value.main_driver_age
      : null,
    add_driver_name: cleanText(value.add_driver_name, 250),
    add_driver_age: typeof value.add_driver_age === "number"
        || typeof value.add_driver_age === "string"
      ? value.add_driver_age
      : null,
    partner_currency: cleanText(value.partner_currency, 10),
    partner_net_price_snapshot:
      typeof value.partner_net_price_snapshot === "number"
        || typeof value.partner_net_price_snapshot === "string"
      ? value.partner_net_price_snapshot
      : null,
    final_price_snapshot:
      typeof value.final_price_snapshot === "number"
        || typeof value.final_price_snapshot === "string"
      ? value.final_price_snapshot
      : null,
    api_booking_reference: cleanText(
      value.api_booking_reference,
      MAX_REFERENCE_LENGTH,
    ),
    api_quote_id: isUuid(value.api_quote_id) ? value.api_quote_id : null,
    partner_response_deadline: cleanText(
      value.partner_response_deadline,
      80,
    ),
    carClass,
    partner,
  };
}

function normalizeStatus(value: unknown): "pending" | "confirmed" | "rejected" {
  const status = String(value || "pending").trim().toLowerCase();

  if (["confirmed", "accepted", "approved", "ok"].includes(status)) {
    return "confirmed";
  }
  if (
    [
      "rejected",
      "declined",
      "unavailable",
      "cancelled",
      "canceled",
    ].includes(status)
  ) {
    return "rejected";
  }
  return "pending";
}

function partnerPayloadRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const nested = firstRecord(value.data);
  return nested || value;
}

function parsePartnerResponse(value: unknown): ParsedPartnerResponse {
  const payload = partnerPayloadRecord(value);
  const externalReference = cleanText(
    payload.booking_reference ?? payload.reference ?? payload.id,
    MAX_REFERENCE_LENGTH,
  );

  return {
    payload,
    externalReference,
    status: normalizeStatus(payload.status),
  };
}

function validTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function responseDeadlineFor(booking: BookingRow): Date {
  const explicit = validTimestamp(booking.partner_response_deadline);
  if (explicit !== null) return new Date(explicit);

  const createdAt = validTimestamp(booking.created_at);
  if (createdAt === null) {
    throw new Error("Nieprawidłowy termin odpowiedzi partnera");
  }

  return new Date(createdAt + PARTNER_RESPONSE_WINDOW_MS);
}

function reportedConfirmationTime(
  payload: Record<string, unknown>,
  createdAt: string | null,
): number | null {
  const lowerBound = validTimestamp(createdAt);
  const now = Date.now();

  for (
    const candidate of [
      payload.confirmed_at,
      payload.accepted_at,
      payload.status_updated_at,
    ]
  ) {
    const parsed = validTimestamp(candidate);
    if (
      parsed !== null
      && parsed <= now + 60_000
      && (lowerBound === null || parsed >= lowerBound - 60_000)
    ) {
      return parsed;
    }
  }

  return null;
}

function safePartnerErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "PARTNER_API_ERROR:UNKNOWN";

  const message = error.message;
  if (message.startsWith("PARTNER_API_ERROR:")) {
    return message.slice(0, 120);
  }
  if (message === "API_NOT_CONFIGURED") return "API_NOT_CONFIGURED";
  if (message.startsWith("API URL")) return "INVALID_API_URL";
  if (message.startsWith("Nieprawidłowy endpoint API")) {
    return "INVALID_ENDPOINT";
  }

  return "PARTNER_API_ERROR:REQUEST_FAILED";
}

function reviewText(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_REVIEW_TEXT_LENGTH);
  } catch {
    return '{"error":"REVIEW_PAYLOAD_UNAVAILABLE"}';
  }
}

async function writeApiLog(
  admin: AdminClient,
  payload: {
    booking_id: string;
    provider: string;
    action: string;
    request_payload?: unknown;
    response_payload?: unknown;
    status: string;
  },
): Promise<void> {
  const { error } = await admin.from("api_booking_logs").insert({
    booking_id: payload.booking_id,
    provider: payload.provider,
    action: payload.action,
    request_payload: sanitizePartnerPayload(payload.request_payload ?? {}, 4_000),
    response_payload: sanitizePartnerPayload(payload.response_payload ?? {}, 12_000),
    status: payload.status.slice(0, 100),
  });

  if (error) console.error("api-booking-dispatch log write failed");
}

async function queueManualReview(
  admin: AdminClient,
  bookingId: string,
  provider: string,
  providerStatus: string,
  apiResponse: unknown,
): Promise<void> {
  const safeStatus = providerStatus.slice(0, 100);

  const { data: existing, error: lookupError } = await admin
    .from("booking_review_queue")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("provider_status", safeStatus)
    .limit(1)
    .maybeSingle();

  if (!lookupError && existing?.id) return;

  const { error } = await admin.from("booking_review_queue").insert({
    booking_id: bookingId,
    provider_key: provider,
    provider_status: safeStatus,
    api_response: reviewText(sanitizePartnerPayload(apiResponse, 4_000)),
  });

  if (error) console.error("api-booking-dispatch review queue write failed");
}

async function loadQuote(
  admin: AdminClient,
  booking: BookingRow,
): Promise<QuoteRow> {
  if (!booking.api_quote_id) {
    throw new Error("Brak poprawnej wyceny API dla rezerwacji");
  }

  const { data, error } = await admin
    .from("api_quotes")
    .select(
      "id, partner_id, car_class_id, booking_id, used_at, external_quote_reference, pickup_location_external_id, dropoff_location_external_id, external_group_id",
    )
    .eq("id", booking.api_quote_id)
    .eq("partner_id", booking.partner_id)
    .eq("car_class_id", booking.car_class_id)
    .maybeSingle();

  if (error || !isRecord(data) || !isUuid(data.id)) {
    throw new Error("Brak poprawnej wyceny API dla rezerwacji");
  }

  if (data.booking_id != null && data.booking_id !== booking.id) {
    throw new Error("Wycena API jest przypisana do innej rezerwacji");
  }

  const quote: QuoteRow = {
    id: data.id,
    partner_id: booking.partner_id,
    car_class_id: booking.car_class_id,
    booking_id: isUuid(data.booking_id) ? data.booking_id : null,
    used_at: cleanText(data.used_at, 80),
    external_quote_reference: cleanText(
      data.external_quote_reference,
      MAX_REFERENCE_LENGTH,
    ),
    pickup_location_external_id: cleanText(
      data.pickup_location_external_id,
      200,
    ),
    dropoff_location_external_id: cleanText(
      data.dropoff_location_external_id,
      200,
    ),
    external_group_id: cleanText(data.external_group_id, 200),
  };

  if (!quote.booking_id || !quote.used_at) {
    const now = new Date().toISOString();
    const { error: bindError } = await admin
      .from("api_quotes")
      .update({
        booking_id: booking.id,
        used_at: quote.used_at || now,
      })
      .eq("id", quote.id)
      .is("booking_id", null);

    if (bindError) throw new Error("Nie udało się przypisać wyceny API");

    quote.booking_id = booking.id;
    quote.used_at = quote.used_at || now;
  }

  return quote;
}

async function tryCancelExternalBooking(
  admin: AdminClient,
  booking: BookingRow,
  credentials: Awaited<ReturnType<typeof loadPartnerCredentials>>,
  externalReference: string | null,
  reason: string,
): Promise<{ cancelled: boolean; response: unknown }> {
  if (!externalReference) return { cancelled: false, response: null };

  try {
    const response = await partnerApiRequest<unknown>(
      credentials,
      endpointFor(credentials, "booking_cancel", { id: externalReference }),
      {
        method: "POST",
        body: {
          idempotency_key: `ride24:cancel:${booking.id}`,
          reason: cleanText(reason, 100) || "local_state_changed",
        },
      },
    );

    return { cancelled: true, response };
  } catch (error) {
    console.error(
      "api-booking-dispatch orphan cancellation failed",
      booking.id,
      safePartnerErrorCode(error),
    );
    return {
      cancelled: false,
      response: { error: safePartnerErrorCode(error) },
    };
  }
}

async function markDispatchFailure(
  admin: AdminClient,
  booking: BookingRow,
  code: string,
): Promise<void> {
  const safeResponse = { error: code };

  await admin.from("bookings").update({
    api_status: "error",
    api_response: safeResponse,
    manual_review: true,
  }).eq("id", booking.id).is("api_booking_reference", null);

  await writeApiLog(admin, {
    booking_id: booking.id,
    provider: booking.partner.api_provider || "custom",
    action: "create",
    request_payload: {
      ride24_booking_id: booking.id,
      vehicle_group_id: booking.carClass.external_id,
    },
    response_payload: safeResponse,
    status: "error",
  });

  await queueManualReview(
    admin,
    booking.id,
    booking.partner.api_provider || "custom",
    "error",
    safeResponse,
  );
}

async function triggerEmailWorker(bookingIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(bookingIds)].filter(isUuid).slice(0, 50);
  if (uniqueIds.length === 0) return;

  const rawUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!rawUrl || !serviceRoleKey) {
    console.error("booking email worker configuration missing");
    return;
  }

  const url = new URL(rawUrl);
  url.pathname = "/functions/v1/email-worker";
  url.search = "";
  url.hash = "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ booking_ids: uniqueIds }),
      signal: controller.signal,
      redirect: "error",
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      console.error("booking email worker failed", response.status);
    }
  } catch {
    console.error("booking email worker failed", "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
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
    requireSecret(req, "x-internal-secret", "RIDE24_INTERNAL_SECRET");

    const body = await readJsonObject(req) as RequestBody;
    if (!isUuid(body.booking_id)) {
      return jsonResponse(req, { error: "Nieprawidłowy booking_id" }, 400);
    }

    const admin = serviceClient();
    const { data: rawBooking, error: bookingError } = await admin
      .from("bookings")
      .select(`
        id,
        reservation_code,
        status,
        created_at,
        partner_id,
        car_class_id,
        start_date,
        end_date,
        pickup_time,
        return_time,
        pickup_location,
        return_location,
        main_driver_name,
        main_driver_age,
        add_driver_name,
        add_driver_age,
        partner_currency,
        partner_net_price_snapshot,
        final_price_snapshot,
        api_booking_reference,
        api_quote_id,
        partner_response_deadline,
        car_classes!inner(external_id, class_code),
        partners!bookings_partner_id_fkey(api_provider, provider_type)
      `)
      .eq("id", body.booking_id)
      .maybeSingle();

    const booking = normalizeBooking(rawBooking);
    if (bookingError || !booking) {
      return jsonResponse(req, { error: "Rezerwacja nie istnieje" }, 404);
    }

    if (booking.status !== "pending") {
      return jsonResponse(req, {
        success: true,
        skipped: true,
        status: booking.status,
      });
    }

    if (booking.api_booking_reference) {
      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "ALREADY_DISPATCHED",
        external_reference: booking.api_booking_reference,
      });
    }

    if (booking.partner.provider_type !== "api") {
      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "LOCAL_BOOKING",
      });
    }

    const responseDeadline = responseDeadlineFor(booking);
    if (responseDeadline.getTime() < Date.now()) {
      const { error: expireError } = await admin.from("bookings").update({
        status: "expired",
        api_status: "expired_before_dispatch",
      })
        .eq("id", booking.id)
        .eq("status", "pending")
        .is("api_booking_reference", null);

      if (expireError) throw new Error("Nie udało się wygasić rezerwacji");

      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "PARTNER_RESPONSE_DEADLINE_EXPIRED",
      });
    }

    let quote: QuoteRow;
    try {
      quote = await loadQuote(admin, booking);
    } catch (error) {
      const code = error instanceof Error
        ? cleanText(error.message, 160) || "INVALID_API_QUOTE"
        : "INVALID_API_QUOTE";
      await markDispatchFailure(admin, booking, code);
      return jsonResponse(
        req,
        { error: "Rezerwacja wymaga sprawdzenia konfiguracji API" },
        409,
      );
    }

    const partnerAmount = finiteNumber(booking.partner_net_price_snapshot);
    const customerTotal = finiteNumber(booking.final_price_snapshot);
    if (
      partnerAmount === null
      || partnerAmount < 0
      || customerTotal === null
      || customerTotal < 0
    ) {
      await markDispatchFailure(admin, booking, "INVALID_PRICE_SNAPSHOT");
      return jsonResponse(
        req,
        { error: "Rezerwacja wymaga sprawdzenia ceny" },
        409,
      );
    }

    const credentials = await loadPartnerCredentials(admin, booking.partner_id);
    const requestPayload = {
      idempotency_key: `ride24:${booking.id}`,
      ride24_booking_id: booking.id,
      reservation_code: booking.reservation_code,
      vehicle_group_id:
        quote.external_group_id || booking.carClass.external_id,
      class_code: booking.carClass.class_code,
      pickup_location_id: quote.pickup_location_external_id,
      dropoff_location_id:
        quote.dropoff_location_external_id
        || quote.pickup_location_external_id,
      pickup_date: booking.start_date,
      return_date: booking.end_date,
      pickup_time: booking.pickup_time,
      return_time: booking.return_time,
      pickup_location: booking.pickup_location,
      return_location: booking.return_location,
      main_driver: {
        name: booking.main_driver_name,
        age: finiteNumber(booking.main_driver_age),
      },
      additional_driver: booking.add_driver_name
        ? {
          name: booking.add_driver_name,
          age: finiteNumber(booking.add_driver_age),
        }
        : null,
      currency: booking.partner_currency,
      partner_amount: partnerAmount,
      customer_total: customerTotal,
      quote_reference: quote.external_quote_reference,
      response_deadline: responseDeadline.toISOString(),
    };

    let responsePayload: unknown;
    try {
      responsePayload = await partnerApiRequest<unknown>(
        credentials,
        endpointFor(credentials, "booking_create"),
        {
          method: "POST",
          body: requestPayload,
        },
      );
    } catch (error) {
      const code = safePartnerErrorCode(error);
      await markDispatchFailure(admin, booking, code);
      throw error;
    }

    const parsedResponse = parsePartnerResponse(responsePayload);
    const safeResponse = sanitizePartnerPayload(responsePayload, 12_000);

    const { data: currentRaw, error: currentError } = await admin
      .from("bookings")
      .select("status, api_booking_reference")
      .eq("id", booking.id)
      .maybeSingle();

    if (currentError || !isRecord(currentRaw)) {
      const cancellation = parsedResponse.status === "rejected"
        ? { cancelled: true, response: null }
        : await tryCancelExternalBooking(
          admin,
          booking,
          credentials,
          parsedResponse.externalReference,
          "local_booking_unavailable",
        );

      await queueManualReview(
        admin,
        booking.id,
        booking.partner.api_provider || "custom",
        cancellation.cancelled ? "local_state_unknown_cancelled" : "cancel_pending",
        cancellation.response || safeResponse,
      );

      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "LOCAL_STATE_UNAVAILABLE_DURING_DISPATCH",
      });
    }

    const currentStatus = cleanText(currentRaw.status, 50);
    const currentExternalReference = cleanText(
      currentRaw.api_booking_reference,
      MAX_REFERENCE_LENGTH,
    );

    if (currentStatus !== "pending" || currentExternalReference) {
      if (
        currentExternalReference
        && parsedResponse.externalReference
        && currentExternalReference === parsedResponse.externalReference
      ) {
        return jsonResponse(req, {
          success: true,
          skipped: true,
          reason: "CONCURRENT_DISPATCH_ALREADY_SAVED",
          external_reference: currentExternalReference,
        });
      }

      const cancellation = parsedResponse.status === "rejected"
        ? { cancelled: true, response: null }
        : await tryCancelExternalBooking(
          admin,
          booking,
          credentials,
          parsedResponse.externalReference,
          currentStatus || "local_state_changed",
        );

      await admin.from("bookings").update({
        api_status: cancellation.cancelled
          || parsedResponse.status === "rejected"
          ? "cancelled"
          : "cancel_pending",
        api_response: sanitizePartnerPayload(
          cancellation.cancelled ? cancellation.response : responsePayload,
          12_000,
        ),
        manual_review: Boolean(
          parsedResponse.externalReference
          && parsedResponse.status !== "rejected"
          && !cancellation.cancelled,
        ),
      }).eq("id", booking.id);

      if (
        parsedResponse.externalReference
        && parsedResponse.status !== "rejected"
        && !cancellation.cancelled
      ) {
        await queueManualReview(
          admin,
          booking.id,
          booking.partner.api_provider || "custom",
          "cancel_pending",
          cancellation.response || safeResponse,
        );
      }

      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "LOCAL_STATE_CHANGED_DURING_DISPATCH",
      });
    }

    if (
      !parsedResponse.externalReference
      && parsedResponse.status !== "rejected"
    ) {
      const invalidUpdate = {
        api_status: "invalid_response",
        api_response: safeResponse,
        manual_review: true,
      };

      await admin.from("bookings").update(invalidUpdate)
        .eq("id", booking.id)
        .eq("status", "pending")
        .is("api_booking_reference", null);

      await writeApiLog(admin, {
        booking_id: booking.id,
        provider: booking.partner.api_provider || "custom",
        action: "create",
        request_payload: {
          ride24_booking_id: booking.id,
          vehicle_group_id:
            quote.external_group_id || booking.carClass.external_id,
        },
        response_payload: safeResponse,
        status: "invalid_response",
      });

      await queueManualReview(
        admin,
        booking.id,
        booking.partner.api_provider || "custom",
        "invalid_response",
        safeResponse,
      );

      return jsonResponse(
        req,
        { error: "API partnera nie zwróciło numeru rezerwacji" },
        502,
      );
    }

    const updatePayload: Record<string, unknown> = {
      api_booking_reference: parsedResponse.externalReference,
      api_status: parsedResponse.status,
      api_response: safeResponse,
      manual_review: false,
    };

    if (parsedResponse.status === "confirmed") {
      const reportedAt = reportedConfirmationTime(
        parsedResponse.payload,
        booking.created_at,
      );
      const confirmedOnTime = reportedAt !== null
        ? reportedAt <= responseDeadline.getTime()
        : Date.now() <= responseDeadline.getTime();

      if (!confirmedOnTime) {
        updatePayload.status = "expired";
        updatePayload.api_status = "late_confirmed";
        updatePayload.manual_review = true;
      } else {
        const paymentDeadline = new Date(Date.now() + PARTNER_RESPONSE_WINDOW_MS);
        updatePayload.status = "awaiting_payment";
        updatePayload.payment_deadline = paymentDeadline.toISOString();
        updatePayload.expires_at = paymentDeadline.toISOString();
      }
    } else if (parsedResponse.status === "rejected") {
      updatePayload.status = "rejected";
    }

    const { data: updatedBooking, error: updateError } = await admin
      .from("bookings")
      .update(updatePayload)
      .eq("id", booking.id)
      .eq("status", "pending")
      .is("api_booking_reference", null)
      .select("id")
      .maybeSingle();

    if (updateError) throw new Error("Nie udało się zapisać odpowiedzi API");

    if (!updatedBooking) {
      const { data: latestRaw } = await admin
        .from("bookings")
        .select("status, api_booking_reference")
        .eq("id", booking.id)
        .maybeSingle();

      const latestReference = isRecord(latestRaw)
        ? cleanText(latestRaw.api_booking_reference, MAX_REFERENCE_LENGTH)
        : null;

      if (
        latestReference
        && parsedResponse.externalReference
        && latestReference === parsedResponse.externalReference
      ) {
        return jsonResponse(req, {
          success: true,
          skipped: true,
          reason: "CONCURRENT_DISPATCH_ALREADY_SAVED",
          external_reference: latestReference,
        });
      }

      const cancellation = parsedResponse.status === "rejected"
        ? { cancelled: true, response: null }
        : await tryCancelExternalBooking(
          admin,
          booking,
          credentials,
          parsedResponse.externalReference,
          "concurrent_local_state_change",
        );

      await queueManualReview(
        admin,
        booking.id,
        booking.partner.api_provider || "custom",
        cancellation.cancelled ? "concurrent_duplicate_cancelled" : "cancel_pending",
        cancellation.response || safeResponse,
      );

      return jsonResponse(req, {
        success: true,
        skipped: true,
        reason: "CONCURRENT_LOCAL_STATE_CHANGE",
      });
    }

    await writeApiLog(admin, {
      booking_id: booking.id,
      provider: booking.partner.api_provider || "custom",
      action: "create",
      request_payload: {
        ride24_booking_id: booking.id,
        vehicle_group_id:
          quote.external_group_id || booking.carClass.external_id,
      },
      response_payload: safeResponse,
      status: String(updatePayload.api_status || parsedResponse.status),
    });

    if (updatePayload.manual_review === true) {
      await queueManualReview(
        admin,
        booking.id,
        booking.partner.api_provider || "custom",
        String(updatePayload.api_status || parsedResponse.status),
        safeResponse,
      );
    }

    if (["awaiting_payment", "rejected"].includes(String(updatePayload.status || ""))) {
      await triggerEmailWorker([booking.id]);
    }

    return jsonResponse(req, {
      success: true,
      status: updatePayload.api_status || parsedResponse.status,
      external_reference: parsedResponse.externalReference,
    });
  } catch (error) {
    console.error(
      "api-booking-dispatch",
      error instanceof Error
        ? error.message === "INTERNAL_AUTH_FAILED"
          ? "INTERNAL_AUTH_FAILED"
          : error.message.startsWith("PARTNER_API_ERROR:")
          ? error.message.slice(0, 120)
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );

    const publicError = publicErrorMessage(error);
    if (publicError.status === 500) {
      return jsonResponse(
        req,
        { error: "Nie udało się przekazać rezerwacji do API partnera" },
        502,
      );
    }

    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
