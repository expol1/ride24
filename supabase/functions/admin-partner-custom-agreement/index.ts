import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders, jsonResponse, publicErrorMessage, requireAdmin, isUuid,
} from "../_shared/ride24-security.ts";

const BUCKET = "partner-agreements"; // private; never use getPublicUrl
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_PDF_BYTES + 32768;

function invalid(message: string): never { throw new Error("Nieprawidłowy dokument: " + message); }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    // Read and modify only as a verified Ride24 administrator.
    const { admin, user } = await requireAdmin(req);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return jsonResponse(req, { error: "Nieprawidłowy formularz PDF" }, 400);
    }
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
      return jsonResponse(req, { error: "Nieprawidłowy dokument: maks. 5 MB" }, 413);
    }
    const form = await req.formData();
    if ([...form.keys()].some((key) => !["partner_id","agreement","operation"].includes(key))
        || form.getAll("partner_id").length !== 1
        || form.getAll("operation").length > 1
        || form.getAll("agreement").length > 1) {
      invalid("nieznane pola");
    }
    const partnerId = form.get("partner_id");
    if (typeof partnerId !== "string" || !isUuid(partnerId)) invalid("identyfikator partnera");
    const operation = form.get("operation") || "upload";
    if (operation !== "upload" && operation !== "remove") invalid("operacja");

    const { data: partner, error: partnerError } = await admin.from("partners")
      .select("id,agreement_accepted").eq("id", partnerId).maybeSingle();
    if (partnerError || !partner) return jsonResponse(req, { error: "Nie znaleziono partnera" }, 404);
    if (partner.agreement_accepted !== false) {
      return jsonResponse(req, { error: "Brak dostępu: podpisana umowa jest zablokowana" }, 409);
    }
    const { data: existing, error: existingError } = await admin
      .from("partner_agreement_documents")
      .select("storage_path,sha256,original_filename")
      .eq("partner_id", partnerId).maybeSingle();
    if (existingError) throw existingError;

    if (operation === "remove") {
      if (form.get("agreement") !== null) invalid("plik przy usuwaniu");
      if (!existing) return jsonResponse(req, { success: true, removed: false });
      // The DB trigger serializes with signing and prevents changes after signature.
      const { data: deleted, error: deleteError } = await admin
        .from("partner_agreement_documents").delete()
        .eq("partner_id", partnerId)
        .select("storage_path").maybeSingle();
      if (deleteError || !deleted) {
        return jsonResponse(req, { error: "Brak dostępu: umowa została już podpisana" }, 409);
      }
      const { error: removeError } = await admin.storage.from(BUCKET)
        .remove([deleted.storage_path]);
      return jsonResponse(req, {
        success: true, removed: true,
        cleanup_warning: Boolean(removeError),
      });
    }

    if (existing) return jsonResponse(req, {
      error: "Brak dostępu: usuń poprzedni projekt przed wgraniem kolejnego",
    }, 409);

    const file = form.get("agreement");
    if (!(file instanceof File)) invalid("brak PDF");
    if (!file.name.toLowerCase().endsWith(".pdf")
        || (file.type && file.type.toLowerCase() !== "application/pdf")
        || file.size < 50 || file.size > MAX_PDF_BYTES) invalid("wymagany PDF maks. 5 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") invalid("niepoprawna sygnatura PDF");
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const originalName = file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
    if (originalName.length < 5) invalid("nazwa pliku");
    const path = partnerId + "/" + crypto.randomUUID() + ".pdf";

    const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, {
      contentType: "application/pdf", upsert: false, cacheControl: "0",
    });
    if (uploadError) throw uploadError;
    try {
      // INSERT trigger locks the partner row; a concurrent signature wins or loses
      // atomically, never attaching a new PDF to an already signed agreement.
      const { error: attachError } = await admin.from("partner_agreement_documents").insert({
        partner_id: partnerId,
        storage_path: path,
        original_filename: originalName,
        sha256: fingerprint,
        uploaded_by: user.id,
      });
      if (attachError) throw attachError;
    } catch (error) {
      await admin.storage.from(BUCKET).remove([path]).catch(() => undefined);
      throw error;
    }

    return jsonResponse(req, {
      success: true, uploaded: true, partner_id: partnerId,
      sha256: fingerprint, filename: originalName,
    });
  } catch (error) {
    console.error("admin-partner-custom-agreement:", error instanceof Error
      ? error.message.slice(0, 180) : "UNKNOWN");
    const safe = publicErrorMessage(error);
    return jsonResponse(req, { error: safe.message }, safe.status);
  }
});
