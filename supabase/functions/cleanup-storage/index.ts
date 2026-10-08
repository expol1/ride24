import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  requireSecret,
  serviceClient,
} from "./_live_shared/ride24-security.ts";

type AdminClient = ReturnType<typeof serviceClient>;

type VoucherRow = {
  id: string;
  booking_id: string;
  pdf_path: string | null;
};

const RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 200;
const MAX_VOUCHERS_PER_RUN = 2_000;
const MAX_PATH_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStoragePath(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const path = value.trim();
  if (
    !path
    || path.length > MAX_PATH_LENGTH
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\u0000")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !path.toLowerCase().endsWith(".pdf")
  ) {
    return null;
  }

  // Obecny generator zapisuje pliki jako vouchers/<kod>.pdf.
  // Dopuszczamy również starszy bezpieczny format <kod>.pdf.
  const segments = path.split("/");
  if (segments.length > 2) return null;
  if (segments.length === 2 && segments[0] !== "vouchers") return null;

  const fileName = segments.at(-1)!;
  if (!/^[A-Za-z0-9._-]+\.pdf$/i.test(fileName)) return null;

  return path;
}

function normalizeVoucher(value: unknown): VoucherRow | null {
  if (
    !isRecord(value)
    || !isUuid(value.id)
    || !isUuid(value.booking_id)
  ) {
    return null;
  }

  return {
    id: value.id,
    booking_id: value.booking_id,
    pdf_path: cleanStoragePath(value.pdf_path),
  };
}

function endDateExpiry(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const endDate = Date.parse(`${value}T23:59:59.999Z`);
  if (!Number.isFinite(endDate)) return null;

  const normalized = new Date(endDate).toISOString().slice(0, 10);
  if (normalized !== value) return null;

  return endDate + RETENTION_MS;
}

async function deleteVoucher(
  admin: AdminClient,
  voucher: VoucherRow,
): Promise<"deleted" | "skipped" | "error"> {
  if (!voucher.pdf_path) {
    console.error("cleanup-storage invalid voucher path", voucher.id);
    return "skipped";
  }

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select("end_date")
    .eq("id", voucher.booking_id)
    .maybeSingle();

  if (bookingError) {
    console.error("cleanup-storage booking lookup failed", voucher.id);
    return "error";
  }

  if (booking) {
    const expiry = endDateExpiry(booking.end_date);
    if (expiry === null) {
      console.error("cleanup-storage invalid booking end date", voucher.id);
      return "skipped";
    }
    if (expiry >= Date.now()) return "skipped";
  }

  const { error: storageError } = await admin.storage
    .from("vouchers")
    .remove([voucher.pdf_path]);

  if (storageError) {
    console.error("cleanup-storage storage remove failed", voucher.id);
    return "error";
  }

  const { data: deleted, error: deleteError } = await admin
    .from("vouchers")
    .delete()
    .eq("id", voucher.id)
    .eq("booking_id", voucher.booking_id)
    .eq("pdf_path", voucher.pdf_path)
    .select("id")
    .maybeSingle();

  if (deleteError) {
    console.error("cleanup-storage voucher row delete failed", voucher.id);
    return "error";
  }

  if (!deleted) {
    console.error("cleanup-storage voucher changed during cleanup", voucher.id);
    return "error";
  }

  return "deleted";
}

async function runCleanup(admin: AdminClient): Promise<Record<string, number>> {
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  while (scanned < MAX_VOUCHERS_PER_RUN) {
    const limit = Math.min(PAGE_SIZE, MAX_VOUCHERS_PER_RUN - scanned);
    const { data, error } = await admin
      .from("vouchers")
      .select("id, pdf_path, booking_id")
      .order("id", { ascending: true })
      .range(scanned, scanned + limit - 1);

    if (error) throw new Error("Nie udało się odczytać voucherów");

    const rawRows = (data || []) as unknown[];
    if (!rawRows.length) break;

    for (const raw of rawRows) {
      scanned += 1;

      const voucher = normalizeVoucher(raw);
      if (!voucher) {
        skipped += 1;
        continue;
      }

      const result = await deleteVoucher(admin, voucher);
      if (result === "deleted") deleted += 1;
      else if (result === "skipped") skipped += 1;
      else errors += 1;
    }

    if (rawRows.length < limit) break;
  }

  return { scanned, deleted, skipped, errors };
}

function authorizeCleanupRequest(req: Request): void {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token && key) {
    const a = new TextEncoder().encode(token), b = new TextEncoder().encode(key);
    let difference = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] || 0) ^ (b[i] || 0);
    if (difference === 0) return;
  }
  requireSecret(req, "x-cron-secret", "RIDE24_CRON_SECRET");
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
    authorizeCleanupRequest(req);

    const result = await runCleanup(serviceClient());
    return jsonResponse(req, {
      success: result.errors === 0,
      retention_days: 180,
      ...result,
    });
  } catch (error) {
    console.error(
      "cleanup-storage",
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

