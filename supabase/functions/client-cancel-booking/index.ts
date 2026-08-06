import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authenticatedUser,
  corsHeaders,
  enforceRateLimit,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  serviceClient,
  userScopedClient,
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
  refund_account?: unknown;
  refund_reason?: unknown;
};

type PartnerRelation = {
  api_provider: string | null;
  provider_type: string | null;
};

type BookingRow = {
  id: string;
  client_id: string;
  status: string;
  start_date: string;
  partner_id: string;
  provider_type: string | null;
  api_booking_reference: string | null;
  partner: PartnerRelation;
};

type ApiCancelResult = {
  attempted: boolean;
  ok: boolean;
  errorCode: string | null;
};

const MAX_REQUEST_BYTES = 8_192;
const MAX_REFUND_ACCOUNT_LENGTH = 500;
const MAX_REFUND_REASON_LENGTH = 1_000;
const MAX_API_REFERENCE_LENGTH = 500;
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const CANCELLABLE_STATUSES = new Set([
  "pending",
  "accepted",
  "awaiting_payment",
  "paid",
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
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanOptionalInput(
  value: unknown,
  maxLength: number,
  errorMessage: string,
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(errorMessage);

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(errorMessage);
  return normalized;
}

async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown>> {
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
  if (!reader) throw new Error("Wymagane dane anulowania");

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

function normalizePartner(value: unknown): PartnerRelation {
  const row = firstRecord(value);
  return {
    api_provider: cleanText(row?.api_provider, 100),
    provider_type: cleanText(row?.provider_type, 20),
  };
}

function normalizeBooking(value: unknown): BookingRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.client_id)
    || !isUuid(value.partner_id)
    || typeof value.status !== "string"
  ) {
    return null;
  }

  const startDate = cleanText(value.start_date, 10);
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;

  return {
    id: value.id,
    client_id: value.client_id,
    status: value.status,
    start_date: startDate,
    partner_id: value.partner_id,
    provider_type: cleanText(value.provider_type, 20),
    api_booking_reference: cleanText(
      value.api_booking_reference,
      MAX_API_REFERENCE_LENGTH,
    ),
    partner: normalizePartner(value.partners),
  };
}

function isApiBooking(booking: BookingRow): boolean {
  return booking.provider_type === "api"
    || booking.partner.provider_type === "api";
}

function safeProviderErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "PARTNER_API_ERROR:UNKNOWN";

  if (error.message.startsWith("PARTNER_API_ERROR:")) {
    return error.message.slice(0, 120);
  }
  if (error.message === "API_NOT_CONFIGURED") return "API_NOT_CONFIGURED";
  if (error.message.startsWith("API URL")) return "INVALID_API_URL";
  if (error.message.startsWith("Nieprawidłowy endpoint API")) {
    return "INVALID_ENDPOINT";
  }

  return "PARTNER_API_ERROR:REQUEST_FAILED";
}

async function writeApiLog(
  admin: AdminClient,
  booking: BookingRow,
  responsePayload: unknown,
  status: string,
): Promise<void> {
  const { error } = await admin.from("api_booking_logs").insert({
    booking_id: booking.id,
    provider: booking.partner.api_provider || "custom",
    action: "cancel",
    request_payload: {
      ride24_booking_id: booking.id,
      reason: "client_cancelled",
    },
    response_payload: sanitizePartnerPayload(responsePayload, 12_000),
    status: status.slice(0, 100),
  });

  if (error) console.error("client-cancel-booking api log write failed");
}

async function queueManualReview(
  admin: AdminClient,
  booking: BookingRow,
  providerStatus: string,
  responsePayload: unknown,
): Promise<void> {
  const safeStatus = providerStatus.slice(0, 100);

  const { data: existing, error: lookupError } = await admin
    .from("booking_review_queue")
    .select("id")
    .eq("booking_id", booking.id)
    .eq("provider_status", safeStatus)
    .limit(1)
    .maybeSingle();

  if (!lookupError && existing?.id) return;

  let responseText = '{"error":"REVIEW_PAYLOAD_UNAVAILABLE"}';
  try {
    responseText = JSON.stringify(
      sanitizePartnerPayload(responsePayload, 4_000),
    ).slice(0, 4_000);
  } catch {
    // Zostaje bezpieczna wartość domyślna.
  }

  const { error } = await admin.from("booking_review_queue").insert({
    booking_id: booking.id,
    provider_key: booking.partner.api_provider || "custom",
    provider_status: safeStatus,
    api_response: responseText,
  });

  if (error) {
    console.error("client-cancel-booking review queue write failed");
  }
}

async function markApiCancellationFailure(
  admin: AdminClient,
  booking: BookingRow,
  errorCode: string,
): Promise<void> {
  const safeResponse = { error: errorCode };

  await admin.from("bookings").update({
    manual_review: true,
    api_status: "cancel_error",
    api_response: safeResponse,
  })
    .eq("id", booking.id)
    .eq("client_id", booking.client_id)
    .eq("api_booking_reference", booking.api_booking_reference);

  await writeApiLog(admin, booking, safeResponse, "cancel_error");
  await queueManualReview(
    admin,
    booking,
    "cancel_error",
    safeResponse,
  );
}

async function markLocalCancellationMismatch(
  admin: AdminClient,
  booking: BookingRow,
): Promise<void> {
  const safeResponse = {
    error: "EXTERNAL_CANCELLED_LOCAL_CANCELLATION_FAILED",
  };

  await admin.from("bookings").update({
    manual_review: true,
    api_status: "cancelled_local_sync_error",
    api_response: safeResponse,
  })
    .eq("id", booking.id)
    .eq("client_id", booking.client_id);

  await writeApiLog(
    admin,
    booking,
    safeResponse,
    "cancelled_local_sync_error",
  );
  await queueManualReview(
    admin,
    booking,
    "cancelled_local_sync_error",
    safeResponse,
  );
}

async function cancelAtApi(
  admin: AdminClient,
  booking: BookingRow,
  preserveBookingLog: boolean,
): Promise<ApiCancelResult> {
  if (!isApiBooking(booking) || !booking.api_booking_reference) {
    return { attempted: false, ok: true, errorCode: null };
  }

  try {
    // Istniejący booking jest obsługiwany również po wyłączeniu nowych ofert
    // partnera. Nie sprawdzamy tutaj partners.api_enabled.
    const credentials = await loadPartnerCredentials(
      admin,
      booking.partner_id,
    );
    const response = await partnerApiRequest<unknown>(
      credentials,
      endpointFor(credentials, "booking_cancel", {
        id: booking.api_booking_reference,
      }),
      {
        method: "POST",
        body: {
          idempotency_key: `ride24:cancel:${booking.id}`,
          reason: "client_cancelled",
        },
      },
    );

    const safeResponse = sanitizePartnerPayload(response, 12_000);
    await admin.from("bookings").update({
      api_status: "cancelled",
      api_response: safeResponse,
      manual_review: false,
    })
      .eq("id", booking.id)
      .eq("client_id", booking.client_id)
      .eq("api_booking_reference", booking.api_booking_reference);

    // Przy statusie pending lokalny RPC usuwa booking. Nie tworzymy wcześniej
    // rekordu z FK, który mógłby zablokować usunięcie lokalnej rezerwacji.
    if (preserveBookingLog) {
      await writeApiLog(admin, booking, safeResponse, "cancelled");
    }

    return { attempted: true, ok: true, errorCode: null };
  } catch (error) {
    const errorCode = safeProviderErrorCode(error);
    await markApiCancellationFailure(admin, booking, errorCode);

    console.error(
      "client-cancel-booking api cancellation failed",
      booking.id,
      errorCode,
    );

    return { attempted: true, ok: false, errorCode };
  }
}

function cancellationRpcError(
  error: unknown,
): { message: string; status: number } | null {
  const message = error instanceof Error ? error.message : "";

  if (message.includes("REFUND_ACCOUNT_REQUIRED")) {
    return {
      message: "Podaj numer rachunku do ręcznego zwrotu",
      status: 400,
    };
  }
  if (message.includes("NO_REFUND_AVAILABLE")) {
    return {
      message:
        "Zwrot nie jest dostępny zgodnie z warunkami anulowania rezerwacji",
      status: 409,
    };
  }
  if (message.includes("ALREADY_CANCELLED")) {
    return {
      message: "Rezerwacja została już anulowana",
      status: 409,
    };
  }
  if (message.includes("BOOKING_CANNOT_BE_CANCELLED")) {
    return {
      message: "Rezerwacja nie może zostać anulowana w tym statusie",
      status: 409,
    };
  }
  if (message.includes("BOOKING_NOT_FOUND_OR_ACCESS_DENIED")) {
    return {
      message: "Nie znaleziono rezerwacji",
      status: 404,
    };
  }

  return null;
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

  let preCancelledPendingApi = false;
  let loadedBooking: BookingRow | null = null;

  try {
    const user = await authenticatedUser(req);
    const admin = serviceClient();

    await enforceRateLimit(
      admin,
      req,
      "client-cancel-booking",
      RATE_LIMIT_REQUESTS,
      RATE_LIMIT_WINDOW_SECONDS,
    );

    const body = await readJsonObject(req) as RequestBody;
    if (!isUuid(body.booking_id)) {
      return jsonResponse(
        req,
        { error: "Nieprawidłowe booking_id" },
        400,
      );
    }

    const refundAccount = cleanOptionalInput(
      body.refund_account,
      MAX_REFUND_ACCOUNT_LENGTH,
      "Nieprawidłowy numer rachunku do zwrotu",
    );
    const refundReason = cleanOptionalInput(
      body.refund_reason,
      MAX_REFUND_REASON_LENGTH,
      "Nieprawidłowy powód zwrotu",
    );

    const { data: rawBooking, error: bookingError } = await admin
      .from("bookings")
      .select(`
        id,
        client_id,
        status,
        start_date,
        partner_id,
        provider_type,
        api_booking_reference,
        partners!bookings_partner_id_fkey(api_provider, provider_type)
      `)
      .eq("id", body.booking_id)
      .maybeSingle();

    const booking = normalizeBooking(rawBooking);
    loadedBooking = booking;

    if (bookingError || !booking) {
      return jsonResponse(
        req,
        { error: "Nie znaleziono rezerwacji" },
        404,
      );
    }
    if (booking.client_id !== user.id) {
      return jsonResponse(
        req,
        { error: "Brak dostępu do rezerwacji" },
        403,
      );
    }
    if (!CANCELLABLE_STATUSES.has(booking.status)) {
      return jsonResponse(
        req,
        { error: "Rezerwacja nie może zostać anulowana w tym statusie" },
        409,
      );
    }
    const pickupTimestamp = Date.parse(`${booking.start_date}T00:00:00.000Z`);
    const now = new Date();
    const todayTimestamp = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const daysUntilPickup = Number.isFinite(pickupTimestamp)
      ? Math.floor((pickupTimestamp - todayTimestamp) / 86_400_000)
      : 0;

    if (booking.status === "paid" && daysUntilPickup >= 30 && !refundAccount) {
      return jsonResponse(
        req,
        { error: "Podaj numer rachunku do ręcznego zwrotu" },
        400,
      );
    }

    // Dla pending API najpierw wycofujemy zapytanie u partnera, ponieważ
    // istniejący RPC usuwa następnie lokalny rekord.
    if (booking.status === "pending") {
      const apiCancel = await cancelAtApi(admin, booking, false);
      if (apiCancel.attempted && !apiCancel.ok) {
        return jsonResponse(
          req,
          {
            error:
              "Nie udało się wycofać zapytania u partnera API. Spróbuj ponownie.",
          },
          502,
        );
      }
      preCancelledPendingApi = apiCancel.attempted && apiCancel.ok;
    }

    const client = userScopedClient(req);
    const { data, error: rpcError } = await client.rpc(
      "client_cancel_booking",
      {
        p_booking_id: booking.id,
        p_refund_account: refundAccount,
        p_refund_reason: refundReason,
      },
    );

    if (rpcError) throw new Error(rpcError.message);

    // Dla accepted/awaiting_payment/paid najpierw obowiązuje lokalny RPC.
    // Refund dla paid pozostaje wyłącznie ręczny: RPC tworzy refund_pending,
    // ale żadna funkcja nie wykonuje automatycznego refundu Stripe.
    let apiWarning = false;
    if (booking.status !== "pending") {
      const apiCancel = await cancelAtApi(admin, booking, true);
      apiWarning = apiCancel.attempted && !apiCancel.ok;
    }

    return jsonResponse(req, {
      success: true,
      result: data,
      api_sync_pending: apiWarning,
      refund_mode: booking.status === "paid" ? "manual" : null,
    });
  } catch (error) {
    if (preCancelledPendingApi && loadedBooking) {
      const admin = serviceClient();
      await markLocalCancellationMismatch(
        admin,
        loadedBooking,
      ).catch(() => undefined);
    }

    console.error(
      "client-cancel-booking",
      error instanceof Error
        ? error.message === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : error.message === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );

    const rpcError = cancellationRpcError(error);
    if (rpcError) {
      return jsonResponse(
        req,
        { error: rpcError.message },
        rpcError.status,
      );
    }

    const publicError = publicErrorMessage(error);
    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
