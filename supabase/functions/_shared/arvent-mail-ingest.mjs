// Orchestration for automatic Arvent approval from an emailed confirmation.
// All I/O is injected so the decision path is unit-tested with real fixtures.
//
// deps = {
//   resolveTxt(name) -> string[]              DNS TXT (DKIM keys)
//   pdfText(bytes) -> {text, title}           PDF text + /Title metadata
//   logMessage(row) -> {id, verdict}|null     insert-once by (source, mailbox id)
//   updateMessage(id, patch) -> boolean     only while verdict='received'
//   loadBooking(reservationNumber) -> {booking, workflow, quote, evidence}|null
//   liveStatus(booking, workflow) -> arventBookingStatus() result
//   stripePaid(booking, workflow) -> {ok, reason}
//   confirm(messageId, booking, workflow, supplierStatus, providerResponse) -> boolean
//   finalize(bookingId) -> {voucher:boolean}
//   alert(kind, details)                      admin notification
// }
import { parseMime, verifyDkim, trustedAuthResults, senderVerdict, sha256hex, addressOf, domainOf } from "./mail-authentication.mjs";
import { parseArventCertificate, verifyArventCertificate, ARVENT_SENDER_DOMAIN } from "./arvent-confirmation-document.mjs";

export const ZOHO_AUTHSERV = [/^mx\.zohomail\.(eu|com|in|com\.au|jp|com\.cn|sa)$/, /^mx\.zoho\.(eu|com)$/];
// Gmail relay: Google's own receiving MTA stamps the topmost header.
export const GOOGLE_AUTHSERV = [/^mx\.google\.com$/];
export const MAX_ATTEMPTS = 10;
const isPdf = (p) => p.type === "application/pdf" || (/\.pdf$/i.test(p.filename || "") && /^application\/(octet-stream|x-pdf|pdf)$/.test(p.type));

class Transient extends Error {}
export const transient = (m) => new Transient(m);

/**
 * Process ONE raw message. `source` 'zoho' trusts Zoho's own topmost
 * Authentication-Results in addition to our DKIM verification.
 * Returns {verdict, reasons, booking_id?, message_id?}.
 */
export async function processArventMail(deps, { source, mailboxMessageId, receivedAtMs, raw }) {
  const msg = parseMime(raw);
  // Privacy: anything not claiming to come from the partner domain is
  // dropped before parsing, verification or storage.
  const claimed = msg.all("from");
  if (claimed.length !== 1 || domainOf(addressOf(claimed[0])) !== ARVENT_SENDER_DOMAIN)
    return { verdict: "ignored", reasons: ["NOT_PARTNER_SENDER"], stored: false };
  const dkim = await verifyDkim(msg, deps.resolveTxt);
  const ar = source === "zoho" ? trustedAuthResults(msg, ZOHO_AUTHSERV)
    : source === "gmail" ? trustedAuthResults(msg, GOOGLE_AUTHSERV) : null;
  const sender = senderVerdict({ msg, dkim, authResults: ar, domain: ARVENT_SENDER_DOMAIN });
  const pdfs = msg.parts.filter(isPdf).slice(0, 5);
  const docs = [];
  for (const p of pdfs) {
    const sha = await sha256hex(p.bytes);
    let parsed;
    try {
      const { text, title } = await deps.pdfText(p.bytes);
      parsed = parseArventCertificate(text, { title });
    } catch { parsed = { ok: false, doc: null, errors: ["PDF_UNREADABLE"] }; }
    docs.push({ sha, filename: p.filename, ...parsed });
  }
  const usable = docs.filter((d) => d.ok);
  const primary = usable[0] ?? docs[0] ?? null;
  const authentication = { dkim, provider: ar, sender };

  const logged = await deps.logMessage({
    source, mailbox_message_id: String(mailboxMessageId),
    rfc822_message_id: (msg.get("message-id") || "").slice(0, 500) || null,
    received_at: new Date(receivedAtMs).toISOString(),
    from_address: sender.from, subject: (msg.get("subject") || "").slice(0, 500),
    pdf_sha256: primary?.sha ?? null,
    reservation_number: primary?.doc?.reservation_number ?? null,
    authentication, document: primary ? { filename: primary.filename, errors: primary.errors, ...(primary.doc || {}) } : null,
  });
  if (!logged || logged.verdict !== "received") return { verdict: logged?.verdict ?? "duplicate", reasons: [] };
  const messageId = logged.id;

  const reject = async (reasons, extra = {}) => {
    // updateMessage only changes rows still 'received' (a parallel run may
    // have approved this message already); alert once, on the real change.
    const changed = await deps.updateMessage(messageId, { verdict: "rejected", reasons, processed_at: new Date().toISOString(), ...extra });
    if (changed) await deps.alert("ARVENT_EMAIL_REJECTED", { message_id: messageId, from: sender.from, reservation: primary?.doc?.reservation_number ?? null, reasons, ...extra });
    return { verdict: "rejected", reasons, message_id: messageId, ...extra };
  };
  const ignore = async (reasons) => {
    await deps.updateMessage(messageId, { verdict: "ignored", reasons, processed_at: new Date().toISOString() });
    return { verdict: "ignored", reasons, message_id: messageId };
  };

  if (!sender.ok) return reject(sender.reasons.map((r) => "SENDER_" + r));
  if (!pdfs.length) return ignore(["NO_PDF"]);
  if (!usable.length) return reject((primary?.errors || ["PDF_NOT_ARVENT_CERTIFICATE"]).map((e) => "DOCUMENT_" + e));
  if (new Set(usable.map((d) => d.doc.reservation_number)).size !== 1) return reject(["DOCUMENT_MULTIPLE_RESERVATIONS"]);

  const doc = primary.doc;
  try {
    const ctx = await deps.loadBooking(doc.reservation_number);
    if (!ctx) return reject(["BOOKING_NOT_FOUND"]);
    const { booking, workflow, quote, evidence } = ctx;
    await deps.updateMessage(messageId, { booking_id: booking.id });
    if (workflow?.state === "confirmed" || booking.status === "paid") return ignore(["ALREADY_CONFIRMED"]);
    if (booking.cancelled_at || booking.refund_status || ["cancelled", "rejected", "expired", "payment_expired"].includes(booking.status))
      return reject(["BOOKING_CANCELLED_OR_REFUNDED"], { booking_id: booking.id });
    if (workflow?.state !== "provider_pending") return reject(["WORKFLOW_STATE_" + String(workflow?.state || "missing").toUpperCase()], { booking_id: booking.id });

    const live = await deps.liveStatus(booking, workflow, { quote, evidence });
    const supplierStatus = live?.supplier_status_type;
    if (supplierStatus === 3 || supplierStatus === 6) return reject(["SUPPLIER_STATUS_" + supplierStatus], { booking_id: booking.id });
    if (!(supplierStatus === 0 || supplierStatus === 1) || live.booking_reference !== workflow.provider_reference
      || live.terms_verified !== true || live.extras_verified !== true
      || (supplierStatus === 0 && live.status !== "pending") || (supplierStatus === 1 && live.status !== "confirmed"))
      return reject(["SUPPLIER_READBACK_NOT_CONFIRMABLE"], { booking_id: booking.id });

    const check = verifyArventCertificate({ doc, booking, workflow, live: live.provider_payload || {}, quote, evidence, receivedAtMs });
    if (!check.ok) return reject(check.reasons.map((r) => "MISMATCH_" + r), { booking_id: booking.id });

    const paid = await deps.stripePaid(booking, workflow);
    if (!paid.ok) return reject(["STRIPE_" + paid.reason], { booking_id: booking.id });

    const now = new Date().toISOString();
    const providerResponse = { ...live, status: "confirmed", needs_manual_review: false,
      email_confirmation: { source: "supplier_email_pdf", message_id: messageId, pdf_sha256: primary.sha,
        sender: sender.from, dkim_verified: sender.dkim_verified, delivered_at: new Date(receivedAtMs).toISOString(),
        document_reference: doc.reservation_number, supplier_status_type: supplierStatus, at: now } };
    const ok = await deps.confirm(messageId, booking, workflow, supplierStatus, providerResponse);
    if (!ok) return reject(["CONFIRM_STATE_CHANGED"], { booking_id: booking.id });
    let fin = { voucher: false };
    try { fin = await deps.finalize(booking.id); } catch { /* status worker retries finalisation of confirmed */ }
    if (!fin.voucher) await deps.alert("ARVENT_EMAIL_APPROVED_VOUCHER_RETRY", { booking_id: booking.id, message_id: messageId });
    return { verdict: "approved", reasons: [], booking_id: booking.id, message_id: messageId, voucher: fin.voucher === true };
  } catch (e) {
    // Arvent/Stripe/DB temporarily unavailable: keep 'received' and retry.
    const attempts = (logged.attempts ?? 0) + 1;
    const reason = String(e?.message || e).replace(/[^A-Z0-9_:]/gi, "_").slice(0, 80);
    if (attempts >= MAX_ATTEMPTS) {
      await deps.updateMessage(messageId, { verdict: "error", attempts, reasons: ["RETRY_EXHAUSTED", reason], processed_at: new Date().toISOString() });
      await deps.alert("ARVENT_EMAIL_PROCESSING_FAILED", { message_id: messageId, reason });
      return { verdict: "error", reasons: [reason], message_id: messageId };
    }
    await deps.updateMessage(messageId, { attempts, reasons: ["RETRY:" + reason] });
    return { verdict: "received", reasons: ["RETRY:" + reason], message_id: messageId };
  }
}
