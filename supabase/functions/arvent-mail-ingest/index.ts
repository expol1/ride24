// Automatic Arvent approval from the supplier's emailed confirmation PDF.
// Cron (every minute, x-cron-secret) polls the Ride24 Zoho mailbox through
// the Zoho Mail REST API (read-only scopes). Admins can list the audit log or
// submit a raw .eml (same verification, our own DKIM check) as a fallback.
// Secrets (Supabase Edge secrets, never in the repo):
//   ZOHO_MAIL_CLIENT_ID, ZOHO_MAIL_CLIENT_SECRET, ZOHO_MAIL_REFRESH_TOKEN,
//   ZOHO_MAIL_DC (default "eu"), ZOHO_MAIL_ADDRESS (default kontakt@ride24.pl),
//   ARVENT_MAIL_ALERT_TO (default kontakt@ride24.pl), RESEND_API_KEY.
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { extractText, getDocumentProxy, getMeta } from "npm:unpdf@2.2.3";
import { corsHeaders, jsonResponse, requireAdmin, requireSecret, serviceClient } from "../_shared/ride24-security.ts";
import { loadPartnerCredentials } from "../_shared/partner-api.ts";
import { arventBookingStatus } from "../_shared/arvent-kolaycar.ts";
import { runApiPayment } from "../_shared/api-payment-runtime.ts";
import { processArventMail } from "../_shared/arvent-mail-ingest.mjs";
import { deliveredAtMs, parseMime } from "../_shared/mail-authentication.mjs";
import { ARVENT_SENDER_DOMAIN } from "../_shared/arvent-confirmation-document.mjs";

const ARVENT_PARTNER_ID = "bf29a373-c464-4cec-87a7-c3218ea1ea51";
const LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

// ---------- Zoho Mail (read-only) ----------
let zohoToken: { value: string; until: number } | null = null;
function zohoConfigured() {
  return !!(env("ZOHO_MAIL_CLIENT_ID") && env("ZOHO_MAIL_CLIENT_SECRET") && env("ZOHO_MAIL_REFRESH_TOKEN"));
}
const zohoDc = () => (/^(eu|com|in|com\.au|jp|sa|ca)$/.test(env("ZOHO_MAIL_DC", "eu")) ? env("ZOHO_MAIL_DC", "eu") : "eu");
async function zohoAccess(): Promise<string> {
  if (zohoToken && zohoToken.until > Date.now()) return zohoToken.value;
  const body = new URLSearchParams({ refresh_token: env("ZOHO_MAIL_REFRESH_TOKEN"), client_id: env("ZOHO_MAIL_CLIENT_ID"),
    client_secret: env("ZOHO_MAIL_CLIENT_SECRET"), grant_type: "refresh_token" });
  const r = await fetch(`https://accounts.zoho.${zohoDc()}/oauth/v2/token`, { method: "POST", body, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.access_token !== "string") throw new Error("ZOHO_TOKEN_" + (j.error || r.status));
  zohoToken = { value: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in || 3600) - 300) * 1000 };
  return zohoToken.value;
}
async function zoho(path: string): Promise<any> {
  const r = await fetch(`https://mail.zoho.${zohoDc()}${path}`, {
    headers: { Authorization: "Zoho-oauthtoken " + await zohoAccess(), Accept: "application/json" },
    signal: AbortSignal.timeout(20000), redirect: "error" });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status?.code !== 200) throw new Error("ZOHO_HTTP_" + r.status);
  return j.data;
}
async function zohoAccountId(): Promise<string> {
  const want = env("ZOHO_MAIL_ADDRESS", "kontakt@ride24.pl").toLowerCase();
  const accounts = await zoho("/api/accounts");
  const list = Array.isArray(accounts) ? accounts : [];
  const hit = list.find((a: any) => String(a.primaryEmailAddress || a.mailboxAddress || "").toLowerCase() === want
    || (a.emailAddress || []).some((e: any) => String(e.mailId || "").toLowerCase() === want)) ?? (list.length === 1 ? list[0] : null);
  if (!hit?.accountId) throw new Error("ZOHO_ACCOUNT_NOT_FOUND");
  return String(hit.accountId);
}

// ---------- shared dependencies ----------
async function resolveTxt(name: string): Promise<string[]> {
  for (const base of ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"]) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.Status !== 0) continue;
      return (j.Answer || []).filter((a: any) => a.type === 16)
        .map((a: any) => String(a.data).replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
    } catch { /* try next resolver */ }
  }
  throw new Error("DNS_UNAVAILABLE");
}
async function pdfText(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const meta = await getMeta(pdf).catch(() => ({ info: {} as any }));
  const { text } = await extractText(pdf, { mergePages: false });
  return { text: (Array.isArray(text) ? text : [text]).join("\n"), title: (meta as any)?.info?.Title ?? null };
}
async function sendAlert(kind: string, details: Record<string, unknown>) {
  const admin = serviceClient();
  const bookingId = isUuid(details.booking_id) ? details.booking_id as string : null;
  if (bookingId) {
    const { data: open } = await admin.from("booking_review_queue").select("id").eq("booking_id", bookingId)
      .eq("provider_status", kind.toLowerCase()).eq("resolved", false).limit(1).maybeSingle();
    if (!open) await admin.from("booking_review_queue").insert({ booking_id: bookingId, provider_key: "arvent_email",
      provider_status: kind.toLowerCase(), api_response: JSON.stringify(details).slice(0, 4000), resolved: false });
  }
  const key = env("RESEND_API_KEY");
  if (!key) return;
  const rows = Object.entries(details).map(([k, v]) => `<tr><td><b>${k}</b></td><td>${String(Array.isArray(v) ? v.join(", ") : v ?? "")
    .replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" } as any)[c])}</td></tr>`).join("");
  await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "Idempotency-Key": `ride24-arvent-mail/${kind}/${details.message_id ?? details.booking_id ?? Date.now()}` },
    body: JSON.stringify({ from: "Ride24 <noreply@ride24.pl>", to: [env("ARVENT_MAIL_ALERT_TO", "kontakt@ride24.pl")],
      subject: `Ride24 Arvent: ${kind}`, html: `<p>Automatyczne potwierdzenie Arvent wymaga uwagi.</p><table>${rows}</table>` }) })
    .then((r) => r.body?.cancel()).catch(() => undefined);
}

function makeDeps(admin: any, stripe: Stripe) {
  let credentials: any = null;
  return {
    resolveTxt, pdfText, alert: sendAlert,
    logMessage: async (row: any) => {
      const { data, error } = await admin.from("arvent_email_messages").insert(row).select("id,verdict,attempts").maybeSingle();
      if (!error && data) return data;
      if (error && error.code !== "23505") throw new Error("MAIL_LOG_FAILED");
      const { data: existing } = await admin.from("arvent_email_messages").select("id,verdict,attempts")
        .eq("source", row.source).eq("mailbox_message_id", row.mailbox_message_id).maybeSingle();
      return existing ?? null;
    },
    updateMessage: async (id: string, patch: any) => {
      const { data, error } = await admin.from("arvent_email_messages").update(patch).eq("id", id).eq("verdict", "received").select("id");
      if (error) throw new Error("MAIL_LOG_UPDATE_FAILED");
      return (data || []).length === 1;
    },
    loadBooking: async (reference: string) => {
      const { data: booking } = await admin.from("bookings").select("*").eq("partner_id", ARVENT_PARTNER_ID)
        .eq("api_booking_reference", reference).maybeSingle();
      if (!booking) return null;
      const { data: workflow } = await admin.from("api_booking_workflows").select("*").eq("booking_id", booking.id).maybeSingle();
      const { data: quote } = booking.api_quote_id ? await admin.from("api_quotes")
        .select("external_group_id,pickup_location_external_id,dropoff_location_external_id,raw_response")
        .eq("id", booking.api_quote_id).eq("partner_id", ARVENT_PARTNER_ID).maybeSingle() : { data: null };
      const { data: evidence } = await admin.from("arvent_dispatch_evidence").select("one_way_fee,extras")
        .eq("booking_id", booking.id).maybeSingle();
      return { booking, workflow, quote, evidence };
    },
    liveStatus: async (booking: any, workflow: any) => {
      credentials ||= await loadPartnerCredentials(admin, ARVENT_PARTNER_ID);
      return arventBookingStatus(credentials, workflow.provider_reference, booking.id);
    },
    stripePaid: async (booking: any, workflow: any) => {
      const pi: any = await stripe.paymentIntents.retrieve(workflow.payment_intent, { expand: ["latest_charge"] });
      const charge = pi.latest_charge;
      if (pi.status !== "succeeded") return { ok: false, reason: "NOT_SUCCEEDED" };
      if (pi.amount_received !== Number(workflow.amount_cents) || Number(booking.stripe_amount_cents) !== pi.amount_received) return { ok: false, reason: "AMOUNT" };
      if (pi.currency !== "pln" || pi.id !== booking.payment_intent_id) return { ok: false, reason: "INTENT_MISMATCH" };
      if (!charge || charge.refunded || charge.amount_refunded !== 0 || charge.disputed) return { ok: false, reason: "REFUNDED_OR_DISPUTED" };
      return { ok: true };
    },
    confirm: async (messageId: string, booking: any, workflow: any, supplierStatus: number, providerResponse: any) => {
      const { data, error } = await admin.rpc("arvent_email_confirm", { p_message_id: messageId, p_booking_id: booking.id,
        p_provider_reference: workflow.provider_reference, p_supplier_status: supplierStatus, p_provider_response: providerResponse });
      if (error) throw new Error("CONFIRM_RPC_FAILED");
      return data === true;
    },
    finalize: async (bookingId: string) => {
      await runApiPayment(admin, stripe, bookingId);
      const { data } = await admin.from("api_booking_workflows").select("fulfilled_at,state").eq("booking_id", bookingId).maybeSingle();
      return { voucher: !!data?.fulfilled_at && data.state === "confirmed" };
    },
  };
}

async function pollZoho(admin: any, stripe: Stripe) {
  if (!zohoConfigured()) return { configured: false };
  const accountId = await zohoAccountId();
  const folders: any[] = await zoho(`/api/accounts/${accountId}/folders`);
  const watched = folders.filter((f) => /^(inbox|spam)$/i.test(String(f.folderType || f.folderName)));
  const deps = makeDeps(admin, stripe);
  const results: any[] = [];
  for (const folder of watched) {
    const list: any[] = await zoho(`/api/accounts/${accountId}/messages/view?folderId=${folder.folderId}&limit=50&sortorder=false&sortBy=date`);
    const candidates = (list || []).filter((m) => Number(m.receivedTime) > Date.now() - LOOKBACK_MS
      && String(m.fromAddress || "").toLowerCase().endsWith("@" + ARVENT_SENDER_DOMAIN) && String(m.hasAttachment) !== "0");
    if (!candidates.length) continue;
    const { data: known } = await admin.from("arvent_email_messages").select("mailbox_message_id,verdict").eq("source", "zoho")
      .in("mailbox_message_id", candidates.map((m) => String(m.messageId)));
    const done = new Set((known || []).filter((k: any) => k.verdict !== "received").map((k: any) => k.mailbox_message_id));
    for (const m of candidates.filter((c) => !done.has(String(c.messageId))).slice(0, 10)) {
      const original = await zoho(`/api/accounts/${accountId}/messages/${m.messageId}/originalmessage`);
      const raw = typeof original?.content === "string" ? original.content : "";
      if (!raw) continue;
      const r = await processArventMail(deps, { source: "zoho", mailboxMessageId: String(m.messageId), receivedAtMs: Number(m.receivedTime), raw })
        .catch((e) => ({ verdict: "error", reasons: [String(e?.message || e).slice(0, 80)] }));
      results.push({ message: String(m.messageId), ...r });
    }
  }
  return { configured: true, processed: results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  const stripe = new Stripe(env("STRIPE_SECRET_KEY"), { apiVersion: "2023-10-16" });
  if (req.headers.get("x-cron-secret")) {
    try { requireSecret(req, "x-cron-secret", "RIDE24_CRON_SECRET"); } catch { return jsonResponse(req, { error: "FORBIDDEN" }, 403); }
    try { return jsonResponse(req, await pollZoho(serviceClient(), stripe)); }
    catch (e) { console.error("ARVENT_MAIL_POLL_FAILED", String((e as Error)?.message || e).slice(0, 120));
      return jsonResponse(req, { error: "POLL_FAILED" }, 502); }
  }
  let ctx;
  try { ctx = await requireAdmin(req); } catch { return jsonResponse(req, { error: "ADMIN_REQUIRED" }, 403); }
  const body = await req.json().catch(() => ({}));
  if (body.action === "list") {
    const { data } = await ctx.admin.from("arvent_email_messages")
      .select("id,source,received_at,from_address,subject,reservation_number,booking_id,verdict,reasons,attempts,pdf_sha256,processed_at")
      .order("received_at", { ascending: false }).limit(100);
    return jsonResponse(req, { rows: data || [], mailbox_configured: zohoConfigured() });
  }
  if (body.action === "poll") return jsonResponse(req, await pollZoho(ctx.admin, stripe).catch(() => ({ error: "POLL_FAILED" })));
  if (body.action === "upload_eml") {
    // Fallback for a message that reached another mailbox: the original
    // .eml must still carry a valid Arvent DKIM signature (checked here).
    const raw = typeof body.eml_base64 === "string" && body.eml_base64.length < 20_000_000
      ? new TextDecoder().decode(Uint8Array.from(atob(body.eml_base64), (c) => c.charCodeAt(0))) : "";
    // Delivery time comes from the receiving server's Received stamp, never
    // from the request; the original 24h deadline still applies.
    const delivered = raw ? deliveredAtMs(parseMime(raw)) : NaN;
    if (!raw || !Number.isFinite(delivered)) return jsonResponse(req, { error: "EML_WITH_DELIVERY_STAMP_REQUIRED" }, 400);
    const id = "upload:" + (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
      .then((d) => Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("")));
    const result = await processArventMail(makeDeps(ctx.admin, stripe), { source: "admin_upload", mailboxMessageId: id, receivedAtMs: delivered, raw });
    return jsonResponse(req, result);
  }
  return jsonResponse(req, { error: "UNKNOWN_ACTION" }, 400);
});
