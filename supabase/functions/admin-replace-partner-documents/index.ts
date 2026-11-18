import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
  isUuid,
} from "../_shared/ride24-security.ts";

// Separate, admin-only replacement workflow. The existing account-creation
// upload function remains unchanged and still refuses to overwrite files.
const BUCKET = "partner-documents";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * MAX_BYTES + 32768;
type DocumentType = "terms" | "rules";

function fileOrNull(value: FormDataEntryValue | null, label: string): File | null {
  if (value === null) return null;
  if (!(value instanceof File) ||
      value.size < 50 || value.size > MAX_BYTES ||
      !value.name.toLowerCase().endsWith(".pdf") ||
      (value.type && value.type.toLowerCase() !== "application/pdf")) {
    throw new Error("Nieprawidłowy PDF: " + label + " (maks. 5 MB)");
  }
  return value;
}

async function bytesOfPdf(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("Nieprawidłowa sygnatura pliku PDF");
  }
  return bytes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { admin } = await requireAdmin(req);
    if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      return jsonResponse(req, { error: "Wymagany formularz z plikami PDF" }, 400);
    }
    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return jsonResponse(req, { error: "Pliki przekraczają limit 5 MB każdy" }, 413);
    }

    const form = await req.formData();
    if ([...form.keys()].some((key) => !["partner_id", "terms", "rules"].includes(key)) ||
        form.getAll("partner_id").length !== 1 ||
        form.getAll("terms").length > 1 ||
        form.getAll("rules").length > 1) {
      return jsonResponse(req, { error: "Nieprawidłowe pola formularza" }, 400);
    }
    const partnerId = form.get("partner_id");
    if (typeof partnerId !== "string" || !isUuid(partnerId)) {
      return jsonResponse(req, { error: "Nieprawidłowy identyfikator partnera" }, 400);
    }

    const terms = fileOrNull(form.get("terms"), "Warunki");
    const rules = fileOrNull(form.get("rules"), "Regulamin");
    if (!terms && !rules) return jsonResponse(req, { error: "Wybierz przynajmniej jeden dokument" }, 400);

    const { data: partner, error: partnerError } = await admin.from("partners")
      .select("id,user_id,agreement_accepted,rental_terms_url,rental_rules_url")
      .eq("id", partnerId).maybeSingle();
    if (partnerError || !partner?.user_id) {
      return jsonResponse(req, { error: "Nie znaleziono partnera" }, 404);
    }
    // Fail closed: never change the customer documents after partner signing.
    if (partner.agreement_accepted !== false) {
      return jsonResponse(req, { error: "Podpisane konto: dokumentów nie można wymienić" }, 409);
    }

    const originals: Record<DocumentType, string | null> = {
      terms: partner.rental_terms_url,
      rules: partner.rental_rules_url,
    };
    const documents: { type: DocumentType; bytes: Uint8Array; path: string }[] = [];
    if (terms) documents.push({
      type: "terms", bytes: await bytesOfPdf(terms),
      path: partner.user_id + "/versions/" + crypto.randomUUID() + "/terms.pdf",
    });
    if (rules) documents.push({
      type: "rules", bytes: await bytesOfPdf(rules),
      path: partner.user_id + "/versions/" + crypto.randomUUID() + "/rules.pdf",
    });

    const uploadedPaths: string[] = [];
    try {
      const updates: Record<string, string> = {};
      for (const doc of documents) {
        // Versioned, immutable filenames prevent overwrites and stale CDN copies.
        const { error: uploadError } = await admin.storage.from(BUCKET)
          .upload(doc.path, doc.bytes, {
            contentType: "application/pdf",
            upsert: false,
            cacheControl: "3600",
          });
        if (uploadError) throw uploadError;
        uploadedPaths.push(doc.path);
        const column = doc.type === "terms" ? "rental_terms_url" : "rental_rules_url";
        updates[column] = admin.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
      }

      // Compare-and-swap: if an administrator changed these URLs or the partner
      // signed while the files were uploading, retain the old DB references.
      let update = admin.from("partners").update(updates)
        .eq("id", partnerId).eq("agreement_accepted", false);
      for (const doc of documents) {
        const column = doc.type === "terms" ? "rental_terms_url" : "rental_rules_url";
        const oldUrl = originals[doc.type];
        update = oldUrl === null ? update.is(column, null) : update.eq(column, oldUrl);
      }
      const { data: saved, error: saveError } = await update
        .select("id,rental_terms_url,rental_rules_url").maybeSingle();
      if (saveError || !saved) {
        throw new Error("Dokumenty zmieniły się podczas zapisu lub umowę podpisano. Odśwież listę.");
      }

      // Old objects are intentionally retained as a historical archive.
      // No delete/upsert of any prior document occurs here.
      return jsonResponse(req, {
        success: true,
        partner_id: partnerId,
        uploaded: documents.map((doc) => doc.type),
        archived_previous: documents.filter((doc) => Boolean(originals[doc.type])).length,
      });
    } catch (error) {
      // Remove only new, unreferenced uploads. Never remove previous PDFs.
      if (uploadedPaths.length) {
        try { await admin.storage.from(BUCKET).remove(uploadedPaths); }
        catch (_) { console.warn("Nowe nieprzypisane PDF wymagają sprzątania"); }
      }
      throw error;
    }
  } catch (error) {
    console.error("admin-replace-partner-documents:",
      error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN");
    const safe = publicErrorMessage(error);
    return jsonResponse(req, { error: safe.message }, safe.status);
  }
});
