import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
  isUuid,
} from "../_shared/ride24-security.ts";

const BUCKET = "partner-documents";
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * MAX_PDF_BYTES + 32_768;

type DocumentKind = "terms" | "rules";

function validatePdf(file: FormDataEntryValue | null, label: string): File | null {
  if (file === null) return null;
  if (!(file instanceof File)) throw new Error("Wymagany plik PDF: " + label);
  if (file.size < 50 || file.size > MAX_PDF_BYTES) {
    throw new Error("Nieprawidłowy rozmiar PDF (maks. 5 MB): " + label);
  }
  if (file.type && file.type.toLowerCase() !== "application/pdf") {
    throw new Error("Dozwolone są tylko pliki PDF: " + label);
  }
  return file;
}

async function verifyPdfMagic(file: File): Promise<void> {
  const firstBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const header = String.fromCharCode(...firstBytes);
  if (header !== "%PDF-") throw new Error("Nieprawidłowy plik PDF");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  // No object is written before administrator authorization and input validation.
  try {
    const { admin } = await requireAdmin(req);
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return jsonResponse(req, { error: "Wymagany formularz z plikami PDF" }, 400);
    }
    const lengthHeader = req.headers.get("content-length");
    if (lengthHeader && Number(lengthHeader) > MAX_REQUEST_BYTES) {
      return jsonResponse(req, { error: "Zbyt duże pliki PDF (maks. 5 MB każdy)" }, 413);
    }

    const form = await req.formData();
    if ([...form.keys()].some((key) => !["partner_id", "terms", "rules"].includes(key))) {
      return jsonResponse(req, { error: "Nieprawidłowe pola formularza" }, 400);
    }
    if (form.getAll("partner_id").length !== 1 ||
      form.getAll("terms").length > 1 || form.getAll("rules").length > 1) {
      return jsonResponse(req, { error: "Nieprawidłowe dane formularza" }, 400);
    }

    const partnerId = form.get("partner_id");
    if (typeof partnerId !== "string" || !isUuid(partnerId)) {
      return jsonResponse(req, { error: "Nieprawidłowy identyfikator partnera" }, 400);
    }
    const terms = validatePdf(form.get("terms"), "Warunki");
    const rules = validatePdf(form.get("rules"), "Regulamin");
    if (!terms && !rules) return jsonResponse(req, { error: "Wybierz co najmniej jeden plik PDF" }, 400);
    if (terms) await verifyPdfMagic(terms);
    if (rules) await verifyPdfMagic(rules);

    const { data: partner, error: partnerError } = await admin
      .from("partners")
      .select("id,user_id,rental_terms_url,rental_rules_url")
      .eq("id", partnerId)
      .maybeSingle();
    if (partnerError || !partner?.user_id) {
      return jsonResponse(req, { error: "Nie znaleziono konta partnera" }, 404);
    }

    const documents: { kind: DocumentKind; file: File; path: string; column: string }[] = [];
    if (terms) {
      if (partner.rental_terms_url) return jsonResponse(req, { error: "Warunki już przypisane. Nie nadpisuję zatwierdzonego PDF." }, 409);
      documents.push({ kind: "terms", file: terms, path: partner.user_id + "/terms.pdf", column: "rental_terms_url" });
    }
    if (rules) {
      if (partner.rental_rules_url) return jsonResponse(req, { error: "Regulamin już przypisany. Nie nadpisuję zatwierdzonego PDF." }, 409);
      documents.push({ kind: "rules", file: rules, path: partner.user_id + "/rules.pdf", column: "rental_rules_url" });
    }

    const newlyUploaded: string[] = [];
    try {
      for (const doc of documents) {
        const bytes = await doc.file.arrayBuffer();
        const { error } = await admin.storage.from(BUCKET).upload(doc.path, bytes, {
          contentType: "application/pdf",
          upsert: false,
          cacheControl: "3600",
        });
        if (error) throw new Error("Nie udało się wgrać " + doc.kind + " (plik może już istnieć w Storage).");
        newlyUploaded.push(doc.path);
      }

      const fields: Record<string, string> = {};
      for (const doc of documents) {
        fields[doc.column] = admin.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
      }

      const { data: updated, error: updateError } = await admin.from("partners")
        .update(fields)
        .eq("id", partner.id)
        .is("rental_terms_url", terms ? null : partner.rental_terms_url)
        .is("rental_rules_url", rules ? null : partner.rental_rules_url)
        .select("id")
        .maybeSingle();

      if (updateError || !updated) throw new Error("Nie udało się przypisać dokumentów do partnera");

      return jsonResponse(req, { success: true, uploaded: documents.map((doc) => doc.kind), partner_id: partner.id });
    } catch (error) {
      // Never leave orphaned uploads when database linking fails.
      if (newlyUploaded.length) {
        await admin.storage.from(BUCKET).remove(newlyUploaded).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    console.error("admin-upload-partner-documents:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    const publicError = publicErrorMessage(error);
    return jsonResponse(req, { error: publicError.message }, publicError.status);
  }
});
