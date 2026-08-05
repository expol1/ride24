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

type PartnerRelation = {
  api_provider: string | null;
  provider_type: string | null;
};

type DispatchCandidate = {
  id: string;
  created_at: string | null;
  partner_response_deadline: string | null;
  partner: PartnerRelation;
};

type PendingBooking = {
  id: string;
  created_at: string | null;
  partner_id: string;
  api_booking_reference: string;
  api_status: string | null;
  status: string;
  partner_response_deadline: string | null;
  partner: PartnerRelation;
};

type CancellationBooking = {
  id: string;
  partner_id: string;
  api_booking_reference: string;
  api_status: string | null;
  status: string;
  expires_at: string | null;
  partner: PartnerRelation;
};

type ProviderStatus = "pending" | "confirmed" | "rejected" | "cancelled";

type PhaseResult = Record<string, number>;

const PARTNER_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CANCELLATION_GRACE_MS = 15 * 60 * 1_000;
const DISPATCH_LIMIT = 25;
const STATUS_LIMIT = 50;
const CANCELLATION_LIMIT = 50;
const MAX_REFERENCE_LENGTH = 500;
const MAX_REVIEW_TEXT_LENGTH = 4_000;
const FINAL_CANCELLATION_STATUSES = [
  "expired",
  "payment_expired",
  "cancelled",
  "rejected",
];

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

function validTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function relationPartner(value: unknown): PartnerRelation | null {
  const row = firstRecord(value);
  if (!row) return null;

  return {
    api_provider: cleanText(row.api_provider, 100),
    provider_type: cleanText(row.provider_type, 20),
  };
}

function normalizeDispatchCandidate(value: unknown): DispatchCandidate | null {
  if (!isRecord(value) || !isUuid(value.id)) return null;

  const partner = relationPartner(value.partners);
  if (!partner || partner.provider_type !== "api") return null;

  return {
    id: value.id,
    created_at: cleanText(value.created_at, 80),
    partner_response_deadline: cleanText(
      value.partner_response_deadline,
      80,
    ),
    partner,
  };
}

function normalizePendingBooking(value: unknown): PendingBooking | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.partner_id)
  ) {
    return null;
  }

  const externalReference = cleanText(
    value.api_booking_reference,
    MAX_REFERENCE_LENGTH,
  );
  const status = cleanText(value.status, 50);
  const partner = relationPartner(value.partners);

  if (
    !externalReference
    || !status
    || !partner
    || partner.provider_type !== "api"
  ) {
    return null;
  }

  return {
    id: value.id,
    created_at: cleanText(value.created_at, 80),
    partner_id: value.partner_id,
    api_booking_reference: externalReference,
    api_status: cleanText(value.api_status, 100),
    status,
    partner_response_deadline: cleanText(
      value.partner_response_deadline,
      80,
    ),
    partner,
  };
}

function normalizeCancellationBooking(
  value: unknown,
): CancellationBooking | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.partner_id)
  ) {
    return null;
  }

  const externalReference = cleanText(
    value.api_booking_reference,
    MAX_REFERENCE_LENGTH,
  );
  const status = cleanText(value.status, 50);
  const partner = relationPartner(value.partners);

  if (
    !externalReference
    || !status
    || !partner
    || partner.provider_type !== "api"
  ) {
    return null;
  }

  return {
    id: value.id,
    partner_id: value.partner_id,
    api_booking_reference: externalReference,
    api_status: cleanText(value.api_status, 100),
    status,
    expires_at: cleanText(value.expires_at, 80),
    partner,
  };
}

function normalizeStatus(value: unknown): ProviderStatus {
  const status = String(value || "pending").trim().toLowerCase();

  if (["confirmed", "accepted", "approved", "ok"].includes(status)) {
    return "confirmed";
  }
  if (["rejected", "declined", "unavailable"].includes(status)) {
    return "rejected";
  }
  if (["cancelled", "canceled"].includes(status)) {
    return "cancelled";
  }
  return "pending";
}

function providerPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return firstRecord(value.data) || value;
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

function responseDeadline(
  explicitValue: string | null,
  createdAt: string | null,
): number | null {
  const explicit = validTimestamp(explicitValue);
  if (explicit !== null) return explicit;

  const created = validTimestamp(createdAt);
  return created === null ? null : created + PARTNER_RESPONSE_WINDOW_MS;
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
    bookingId: string;
    provider: string;
    action: "status" | "cancel" | "dispatch";
    requestPayload?: unknown;
    responsePayload?: unknown;
    status: string;
  },
): Promise<void> {
  const { error } = await admin.from("api_booking_logs").insert({
    booking_id: payload.bookingId,
    provider: payload.provider.slice(0, 100),
    action: payload.action,
    request_payload: sanitizePartnerPayload(
      payload.requestPayload ?? {},
      4_000,
    ),
    response_payload: sanitizePartnerPayload(
      payload.responsePayload ?? {},
      12_000,
    ),
    status: payload.status.slice(0, 100),
  });

  if (error) console.error("api-booking-status-sync log write failed");
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
    provider_key: provider.slice(0, 100),
    provider_status: safeStatus,
    api_response: reviewText(
      sanitizePartnerPayload(apiResponse, MAX_REVIEW_TEXT_LENGTH),
    ),
  });

  if (error) {
    console.error("api-booking-status-sync review queue write failed");
  }
}

function dispatchFunctionUrl(): string {
  const rawUrl = Deno.env.get("SUPABASE_URL");
  if (!rawUrl) throw new Error("API_DISPATCH_CONFIGURATION_MISSING");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("API_DISPATCH_CONFIGURATION_MISSING");
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("API_DISPATCH_CONFIGURATION_MISSING");
  }

  url.pathname = "/functions/v1/api-booking-dispatch";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function invokeDispatch(
  bookingId: string,
  internalSecret: string,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(dispatchFunctionUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ booking_id: bookingId }),
      signal: controller.signal,
      redirect: "error",
    });

    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchUndispatched(
  admin: AdminClient,
): Promise<PhaseResult> {
  const internalSecret = Deno.env.get("RIDE24_INTERNAL_SECRET");
  if (!internalSecret) throw new Error("API_DISPATCH_CONFIGURATION_MISSING");

  const { data, error } = await admin
    .from("bookings")
    .select(`
      id,
      created_at,
      partner_response_deadline,
      api_status,
      partners!bookings_partner_id_fkey(provider_type)
    `)
    .eq("partners.provider_type", "api")
    .eq("status", "pending")
    .is("api_booking_reference", null)
    .limit(DISPATCH_LIMIT);

  if (error) throw new Error("Nie udało się odczytać rezerwacji do wysłania");

  const bookings = ((data || []) as unknown[])
    .map(normalizeDispatchCandidate)
    .filter((item): item is DispatchCandidate => Boolean(item));

  let dispatched = 0;
  let expired = 0;
  let skipped = 0;
  let errors = 0;

  for (const booking of bookings) {
    const deadline = responseDeadline(
      booking.partner_response_deadline,
      booking.created_at,
    );

    if (deadline !== null && deadline < Date.now()) {
      const { data: updated, error: updateError } = await admin
        .from("bookings")
        .update({
          status: "expired",
          api_status: "expired_before_dispatch",
        })
        .eq("id", booking.id)
        .eq("status", "pending")
        .is("api_booking_reference", null)
        .select("id")
        .maybeSingle();

      if (updateError) {
        errors += 1;
      } else if (updated) {
        expired += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    try {
      const result = await invokeDispatch(booking.id, internalSecret);
      if (result.ok) {
        dispatched += 1;
      } else {
        errors += 1;
        console.error(
          "api-booking-status-sync dispatch failed",
          booking.id,
          result.status,
        );
      }
    } catch {
      errors += 1;
      console.error(
        "api-booking-status-sync dispatch failed",
        booking.id,
        "NETWORK_ERROR",
      );
    }
  }

  return {
    candidates: bookings.length,
    dispatched,
    expired,
    skipped,
    errors,
  };
}

async function processPending(
  admin: AdminClient,
): Promise<PhaseResult> {
  const { data, error } = await admin
    .from("bookings")
    .select(`
      id,
      created_at,
      partner_id,
      api_booking_reference,
      api_status,
      status,
      partner_response_deadline,
      partners!bookings_partner_id_fkey(api_provider, provider_type)
    `)
    .eq("partners.provider_type", "api")
    .eq("status", "pending")
    .not("api_booking_reference", "is", null)
    .limit(STATUS_LIMIT);

  if (error) throw new Error("Nie udało się odczytać oczekujących rezerwacji API");

  const bookings = ((data || []) as unknown[])
    .map(normalizePendingBooking)
    .filter((item): item is PendingBooking => Boolean(item));

  let confirmed = 0;
  let rejected = 0;
  let pending = 0;
  let expired = 0;
  let skipped = 0;
  let errors = 0;
  const emailBookingIds: string[] = [];

  for (const booking of bookings) {
    const provider = booking.partner.api_provider || "custom";
    const deadline = responseDeadline(
      booking.partner_response_deadline,
      booking.created_at,
    );

    if (deadline !== null && deadline < Date.now()) {
      const { data: updated, error: updateError } = await admin
        .from("bookings")
        .update({
          status: "expired",
          api_status: "expired_waiting_for_partner",
        })
        .eq("id", booking.id)
        .eq("status", "pending")
        .eq("api_booking_reference", booking.api_booking_reference)
        .select("id")
        .maybeSingle();

      if (updateError) {
        errors += 1;
      } else if (updated) {
        expired += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    try {
      // Nie sprawdzamy partners.api_enabled. Istniejące rezerwacje muszą być
      // obsługiwane również po wyłączeniu nowych ofert danego partnera.
      const credentials = await loadPartnerCredentials(
        admin,
        booking.partner_id,
      );
      const response = await partnerApiRequest<unknown>(
        credentials,
        endpointFor(credentials, "booking_status", {
          id: booking.api_booking_reference,
        }),
      );

      const payload = providerPayload(response);
      const providerStatus = normalizeStatus(payload.status);
      const safeResponse = sanitizePartnerPayload(response, 12_000);

      const update: Record<string, unknown> = {
        api_status: providerStatus,
        api_response: safeResponse,
        manual_review: false,
      };

      let manualReviewStatus: string | null = null;

      if (providerStatus === "confirmed") {
        const reportedAt = reportedConfirmationTime(
          payload,
          booking.created_at,
        );
        const confirmedOnTime = deadline === null
          || (reportedAt !== null
            ? reportedAt <= deadline
            : Date.now() <= deadline);

        if (!confirmedOnTime) {
          update.status = "expired";
          update.api_status = "late_confirmed";
          update.manual_review = true;
          manualReviewStatus = "late_confirmed";
        } else {
          const paymentDeadline = new Date(Date.now() + PAYMENT_WINDOW_MS);
          update.status = "awaiting_payment";
          update.payment_deadline = paymentDeadline.toISOString();
          update.expires_at = paymentDeadline.toISOString();
        }
      } else if (
        providerStatus === "rejected"
        || providerStatus === "cancelled"
      ) {
        update.status = "rejected";
      }

      const { data: updated, error: updateError } = await admin
        .from("bookings")
        .update(update)
        .eq("id", booking.id)
        .eq("status", "pending")
        .eq("api_booking_reference", booking.api_booking_reference)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error("Nie udało się zapisać statusu API");
      }

      if (!updated) {
        skipped += 1;
        continue;
      }

      await writeApiLog(admin, {
        bookingId: booking.id,
        provider,
        action: "status",
        requestPayload: {
          ride24_booking_id: booking.id,
          external_reference: booking.api_booking_reference,
        },
        responsePayload: safeResponse,
        status: String(update.api_status || providerStatus),
      });

      if (manualReviewStatus) {
        await queueManualReview(
          admin,
          booking.id,
          provider,
          manualReviewStatus,
          safeResponse,
        );
      }

      if (["awaiting_payment", "rejected"].includes(String(update.status || ""))) {
        emailBookingIds.push(booking.id);
      }

      if (providerStatus === "confirmed" && !manualReviewStatus) {
        confirmed += 1;
      } else if (
        providerStatus === "rejected"
        || providerStatus === "cancelled"
      ) {
        rejected += 1;
      } else if (manualReviewStatus) {
        expired += 1;
      } else {
        pending += 1;
      }
    } catch (itemError) {
      errors += 1;
      const code = safeProviderErrorCode(itemError);

      await writeApiLog(admin, {
        bookingId: booking.id,
        provider,
        action: "status",
        requestPayload: {
          ride24_booking_id: booking.id,
          external_reference: booking.api_booking_reference,
        },
        responsePayload: { error: code },
        status: "error",
      });

      console.error(
        "api-booking-status-sync status failed",
        booking.id,
        code,
      );
    }
  }

  await triggerEmailWorker(emailBookingIds);

  return {
    processed: bookings.length,
    confirmed,
    rejected,
    pending,
    expired,
    skipped,
    errors,
  };
}

async function cancelFinalized(
  admin: AdminClient,
): Promise<PhaseResult> {
  const graceCutoff = Date.now() - CANCELLATION_GRACE_MS;

  const { data, error } = await admin
    .from("bookings")
    .select(`
      id,
      partner_id,
      api_booking_reference,
      api_status,
      status,
      expires_at,
      partners!bookings_partner_id_fkey(api_provider, provider_type)
    `)
    .eq("partners.provider_type", "api")
    .in("status", FINAL_CANCELLATION_STATUSES)
    .not("api_booking_reference", "is", null)
    .neq("api_status", "cancelled")
    .limit(CANCELLATION_LIMIT);

  if (error) throw new Error("Nie udało się odczytać rezerwacji do anulowania");

  const bookings = ((data || []) as unknown[])
    .map(normalizeCancellationBooking)
    .filter((item): item is CancellationBooking => Boolean(item));

  let cancelled = 0;
  let skippedGrace = 0;
  let conflicts = 0;
  let errors = 0;

  for (const booking of bookings) {
    if (
      ["expired", "payment_expired"].includes(booking.status)
      && validTimestamp(booking.expires_at) !== null
      && validTimestamp(booking.expires_at)! > graceCutoff
    ) {
      skippedGrace += 1;
      continue;
    }

    const provider = booking.partner.api_provider || "custom";

    try {
      // Credentials pozostają używane dla istniejących bookingów nawet wtedy,
      // gdy partner.api_enabled został później wyłączony.
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
            reason: booking.status,
          },
        },
      );

      const safeResponse = sanitizePartnerPayload(response, 12_000);
      const { data: updated, error: updateError } = await admin
        .from("bookings")
        .update({
          api_status: "cancelled",
          api_response: safeResponse,
          manual_review: false,
        })
        .eq("id", booking.id)
        .eq("api_booking_reference", booking.api_booking_reference)
        .in("status", FINAL_CANCELLATION_STATUSES)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error("Nie udało się zapisać anulowania API");
      }

      await writeApiLog(admin, {
        bookingId: booking.id,
        provider,
        action: "cancel",
        requestPayload: {
          ride24_booking_id: booking.id,
          reason: booking.status,
        },
        responsePayload: safeResponse,
        status: updated ? "cancelled" : "cancelled_state_conflict",
      });

      if (updated) {
        cancelled += 1;
        continue;
      }

      conflicts += 1;

      const conflictResponse = {
        error: "EXTERNAL_BOOKING_CANCELLED_AFTER_LOCAL_STATE_CHANGE",
      };
      await admin.from("bookings").update({
        api_status: "cancelled_state_conflict",
        api_response: conflictResponse,
        manual_review: true,
      })
        .eq("id", booking.id)
        .eq("api_booking_reference", booking.api_booking_reference);

      await queueManualReview(
        admin,
        booking.id,
        provider,
        "cancelled_state_conflict",
        conflictResponse,
      );
    } catch (itemError) {
      errors += 1;
      const code = safeProviderErrorCode(itemError);
      const safeResponse = { error: code };

      await admin.from("bookings").update({
        manual_review: true,
        api_status: "cancel_error",
        api_response: safeResponse,
      })
        .eq("id", booking.id)
        .eq("api_booking_reference", booking.api_booking_reference)
        .in("status", FINAL_CANCELLATION_STATUSES);

      await writeApiLog(admin, {
        bookingId: booking.id,
        provider,
        action: "cancel",
        requestPayload: {
          ride24_booking_id: booking.id,
          reason: booking.status,
        },
        responsePayload: safeResponse,
        status: "cancel_error",
      });

      await queueManualReview(
        admin,
        booking.id,
        provider,
        "cancel_error",
        safeResponse,
      );

      console.error(
        "api-booking-status-sync cancellation failed",
        booking.id,
        code,
      );
    }
  }

  return {
    candidates: bookings.length,
    cancelled,
    skipped_grace: skippedGrace,
    conflicts,
    errors,
  };
}

async function runPhase(
  name: string,
  operation: () => Promise<PhaseResult>,
): Promise<{ result: PhaseResult; fatalError: string | null }> {
  try {
    return { result: await operation(), fatalError: null };
  } catch {
    console.error("api-booking-status-sync phase failed", name);
    return {
      result: { errors: 1 },
      fatalError: `${name.toUpperCase()}_FAILED`,
    };
  }
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
    requireSecret(req, "x-cron-secret", "RIDE24_CRON_SECRET");
    const admin = serviceClient();

    const dispatch = await runPhase(
      "dispatch",
      () => dispatchUndispatched(admin),
    );
    const pending = await runPhase(
      "pending",
      () => processPending(admin),
    );
    const cancellations = await runPhase(
      "cancellations",
      () => cancelFinalized(admin),
    );

    const fatalErrors = [
      dispatch.fatalError,
      pending.fatalError,
      cancellations.fatalError,
    ].filter((value): value is string => Boolean(value));

    return jsonResponse(
      req,
      {
        success: fatalErrors.length === 0,
        dispatch: dispatch.result,
        pending: pending.result,
        cancellations: cancellations.result,
        phase_errors: fatalErrors,
      },
      fatalErrors.length === 0 ? 200 : 500,
    );
  } catch (error) {
    console.error(
      "api-booking-status-sync",
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
