// Audited admin retry of a verified supplier approval. Received remains pending.
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/ride24-security.ts";
import { loadPartnerCredentials } from "../_shared/partner-api.ts";
import { arventBookingStatus } from "../_shared/arvent-kolaycar.ts";
import { runApiPayment } from "../_shared/api-payment-runtime.ts";

const ARVENT_PARTNER_ID = "bf29a373-c464-4cec-87a7-c3218ea1ea51";
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  let ctx;
  try { ctx = await requireAdmin(req); } catch { return jsonResponse(req, { error: "ADMIN_REQUIRED" }, 403); }
  const { user, admin } = ctx;
  const body = await req.json().catch(() => ({}));

  if (body.action === "list") {
    const { data, error } = await admin.from("api_booking_workflows")
      .select("booking_id,state,last_error,provider_reference,paid_at,supplier_received_at,supplier_deadline_at,bookings!inner(reservation_code,partner_id,client_email,main_driver_name,start_date,end_date,pickup_time,status,api_status)")
      .eq("bookings.partner_id", ARVENT_PARTNER_ID)
      .in("state", ["provider_pending", "unknown", "dispatching", "paid", "revalidating"])
      .order("paid_at", { ascending: true }).limit(100);
    if (error) return jsonResponse(req, { error: "LIST_FAILED" }, 500);
    const ids = (data || []).map((r: any) => r.booking_id);
    const { data: audits } = ids.length
      ? await admin.from("arvent_manual_confirmations").select("booking_id,admin_email,evidence,supplier_status_type,created_at").in("booking_id", ids)
      : { data: [] };
    return jsonResponse(req, { rows: data || [], audits: audits || [] });
  }

  if (body.action !== "confirm") return jsonResponse(req, { error: "UNKNOWN_ACTION" }, 400);
  const bookingId = body.booking_id;
  const evidence = typeof body.evidence === "string" ? body.evidence.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000) : "";
  if (!isUuid(bookingId)) return jsonResponse(req, { error: "INVALID_BOOKING" }, 400);
  if (evidence.length < 15) return jsonResponse(req, { error: "EVIDENCE_REQUIRED", message: "Opisz potwierdzenie Arvent (kto, kiedy, jakim kanałem)." }, 400);

  const { data: w } = await admin.from("api_booking_workflows").select("*").eq("booking_id", bookingId).maybeSingle();
  const { data: b } = await admin.from("bookings").select("id,partner_id,status,api_booking_reference").eq("id", bookingId).maybeSingle();
  if (!w || !b || b.partner_id !== ARVENT_PARTNER_ID || w.prepared_quote?.provider !== "arvent_kolaycar")
    return jsonResponse(req, { error: "NOT_ARVENT_BOOKING" }, 404);
  if (w.state !== "provider_pending" || !w.provider_reference || w.provider_reference !== b.api_booking_reference)
    return jsonResponse(req, { error: "NOT_AWAITING_APPROVAL", state: w.state, last_error: w.last_error }, 409);

  // Match the number independently transcribed from the supplier document.
  if (typeof body.document_reference !== "string" || body.document_reference.trim() !== w.provider_reference)
    return jsonResponse(req, { error: "DOCUMENT_REFERENCE_MISMATCH" }, 409);

  // Live supplier check: never confirm what Arvent has cancelled or changed.
  let live: Record<string, any>;
  try {
    const credentials = await loadPartnerCredentials(admin, ARVENT_PARTNER_ID);
    live = await arventBookingStatus(credentials, w.provider_reference, bookingId);
  } catch {
    return jsonResponse(req, { error: "SUPPLIER_STATUS_UNAVAILABLE" }, 502);
  }
  const supplierStatus = live.supplier_status_type;
  if (supplierStatus !== 1 || live.status !== "confirmed" || live.needs_manual_review !== false || live.extras_verified !== true || live.terms_verified !== true || live.booking_reference !== w.provider_reference)
    return jsonResponse(req, { error: "SUPPLIER_STATUS_NOT_CONFIRMABLE", supplier_status_type: supplierStatus,
      supplier_status_label: live.supplier_status_label, terms_verified: live.terms_verified === true }, 409);

  // Atomic in SQL: provider_pending -> confirmed plus one immutable audit row.
  const now = new Date().toISOString();
  const { data: ok, error: rpcError } = await admin.rpc("arvent_admin_confirm", {
    p_booking_id: bookingId, p_provider_reference: w.provider_reference,
    p_admin_user_id: user.id, p_admin_email: user.email || null, p_evidence: evidence,
    p_supplier_status: supplierStatus, p_supplier_evidence: live.provider_payload || null,
    p_provider_response: { ...live, status: "confirmed", needs_manual_review: false,
      manual_confirmation: { by: user.email || user.id, at: now, supplier_status_type: supplierStatus } },
  });
  if (rpcError) return jsonResponse(req, { error: rpcError.code === "23505" ? "ALREADY_CONFIRMED" : "CONFIRM_FAILED" }, 409);
  if (ok !== true) return jsonResponse(req, { error: "STATE_CHANGED" }, 409);

  // Shared finalisation: booking -> paid, voucher, confirmation email.
  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });
    await runApiPayment(admin, stripe, bookingId);
  } catch {
    // The workflow is confirmed; the status worker retries finalisation.
    return jsonResponse(req, { success: true, finalize: "retry_pending" });
  }
  const { data: after } = await admin.from("bookings").select("status,api_status").eq("id", bookingId).maybeSingle();
  return jsonResponse(req, { success: true, booking_status: after?.status, api_status: after?.api_status, supplier_status_type: supplierStatus });
});
