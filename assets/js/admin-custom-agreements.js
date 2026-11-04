/* Admin-only optional private PDF agreements.
 * Empty assignment = use the existing standard Ride24 contract automatically. */
(function () {
  "use strict";
  const FUNCTION = "admin-partner-custom-agreement";
  const BUCKET = "partner-agreements";
  let selectedPartnerId = null;
  let selectedDocument = null;
  let isSigned = false;
  let customPending = false;
  const el = (id) => document.getElementById(id);

  async function getDocument(partnerId) {
    const { data, error } = await db.from("partner_agreement_documents")
      .select("storage_path,sha256,original_filename,uploaded_at")
      .eq("partner_id", partnerId).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function apiRequest(formData) {
    const { data, error } = await db.functions.invoke(FUNCTION, { body: formData });
    if (error) {
      let message = error.message || "Nie można zapisać umowy";
      try {
        const details = await error.context?.json?.();
        if (details?.error) message = details.error;
      } catch (_) { /* No JSON error payload */ }
      throw new Error(message);
    }
    if (!data?.success) throw new Error(data?.error || "Operacja nie powiodła się");
    return data;
  }

  async function uploadFileToPartner(partnerId, file) {
    if (!partnerId || !file) throw new Error("Brak partnera lub umowy PDF.");
    const body = new FormData();
    body.append("partner_id", partnerId);
    body.append("operation", "upload");
    body.append("agreement", file, file.name);
    return await apiRequest(body);
  }

  function renderAdminDocument() {
    const status = el("r24-custom-agreement-status");
    const label = el("r24-custom-agreement-file");
    const file = el("r24-custom-agreement-upload");
    const upload = el("r24-custom-agreement-upload-btn");
    const remove = el("r24-custom-agreement-remove-btn");
    const view = el("r24-custom-agreement-view-btn");
    label.textContent = selectedDocument
      ? "Indywidualna umowa: " + selectedDocument.original_filename
      : customPending
        ? "Indywidualna umowa oczekuje na wgranie — standardowy podpis jest zablokowany."
        : "Brak indywidualnej umowy — partner otrzyma standardową umowę Ride24.";
    status.textContent = isSigned ? "Umowa została już podpisana. Dokumentu nie można zmienić."
      : selectedDocument ? "Własna umowa przypisana (PDF prywatny). Przed podpisaniem możesz ją usunąć i wgrać nową."
      : customPending
        ? "Konto utworzono z własną umową. Wgraj ją lub anuluj ten wybór, aby przywrócić umowę standardową."
        : "Możesz wgrać indywidualny PDF. Jeśli tego nie zrobisz, standardowy generator pozostanie bez zmian.";
    file.value = "";
    file.disabled = isSigned || Boolean(selectedDocument);
    upload.disabled = isSigned || Boolean(selectedDocument);
    remove.disabled = isSigned || (!selectedDocument && !customPending);
    view.disabled = !selectedDocument;
    // Signed PDFs are immutable; the modal becomes a clean read-only preview.
    el("r24-custom-agreement-upload-area").style.display = isSigned ? "none" : "";
    upload.style.display = isSigned ? "none" : "";
    remove.style.display = isSigned ? "none" : "";
    view.style.display = selectedDocument ? "" : "none";
  }

  async function open(partnerId) {
    selectedPartnerId = null;
    selectedDocument = null;
    try {
      const { data: partner, error } = await db.from("partners")
        .select("id,company_name,agreement_accepted,custom_agreement_pending").eq("id", partnerId).single();
      if (error || !partner) throw error || new Error("Nie znaleziono partnera");
      const doc = await getDocument(partnerId);
      selectedPartnerId = partner.id;
      selectedDocument = doc;
      isSigned = partner.agreement_accepted === true;
      customPending = partner.custom_agreement_pending === true;
      el("r24-custom-agreement-partner").textContent = partner.company_name || "Partner";
      renderAdminDocument();
      el("r24-custom-agreement-modal").style.display = "flex";
    } catch (error) {
      alert("Nie można odczytać umowy partnera: " + error.message);
    }
  }

  function close() {
    el("r24-custom-agreement-modal").style.display = "none";
    selectedPartnerId = null;
    selectedDocument = null;
    isSigned = false;
    customPending = false;
  }

  async function upload() {
    if (!selectedPartnerId || isSigned || selectedDocument) return;
    const file = el("r24-custom-agreement-upload").files[0];
    if (!file || !file.name.toLowerCase().endsWith(".pdf") ||
        (file.type && file.type !== "application/pdf") ||
        file.size < 50 || file.size > 5 * 1024 * 1024) {
      alert("Wybierz poprawny PDF, maksymalnie 5 MB.");
      return;
    }
    if (!confirm("Czy ten PDF został sprawdzony i zaakceptowany do podpisania przez partnera?")) return;
    const button = el("r24-custom-agreement-upload-btn");
    button.disabled = true;
    try {
      await uploadFileToPartner(selectedPartnerId, file);
      const id = selectedPartnerId;
      close();
      await open(id);
      alert("Umowa indywidualna przypisana. Partner podpisze właśnie ten PDF.");
    } catch (error) {
      alert("Nie udało się wgrać umowy: " + error.message);
      button.disabled = false;
    }
  }

  async function remove() {
    if (!selectedPartnerId || isSigned || (!selectedDocument && !customPending)) return;
    if (!confirm("Usunąć NIEPODPISANĄ umowę własną? Partner będzie wtedy podpisywał standardowy wzór Ride24.")) return;
    const button = el("r24-custom-agreement-remove-btn");
    button.disabled = true;
    try {
      const body = new FormData();
      body.append("partner_id", selectedPartnerId);
      body.append("operation", "remove");
      const result = await apiRequest(body);
      const id = selectedPartnerId;
      close();
      await open(id);
      if (result.cleanup_warning) {
        alert("Powrócono do umowy standardowej, ale plik wymaga usunięcia technicznego ze Storage.");
      }
    } catch (error) {
      alert("Nie można usunąć dokumentu: " + error.message);
      button.disabled = false;
    }
  }
  async function preview() {
    if (!selectedDocument) return;
    await openPrivatePdf(selectedDocument);
  }

  async function openPrivatePdf(doc) {
    // Open synchronously when permitted. If a browser blocks the popup, provide
    // a visible, user-clickable private link instead of silently doing nothing.
    const popup = window.open("about:blank", "_blank");
    try {
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300);
      if (error || !data?.signedUrl) throw error || new Error("Brak dostępu do pliku");
      if (popup) {
        popup.location.replace(data.signedUrl);
        return;
      }
      let banner = el("r24-custom-pdf-open-link");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "r24-custom-pdf-open-link";
        banner.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:100020;background:white;border:2px solid #2563eb;padding:12px;border-radius:8px;text-align:center;";
        document.body.appendChild(banner);
      }
      banner.replaceChildren();
      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Otwórz indywidualną umowę PDF (link ważny 5 minut)";
      link.style.fontWeight = "700";
      banner.appendChild(link);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "  Zamknij";
      close.style.marginLeft = "12px";
      close.onclick = () => banner.remove();
      banner.appendChild(close);
    } catch (error) {
      popup?.close();
      throw error;
    }
  }

  // Admin's existing "Umowa PDF" button respects the individual assignment
  // and never prints a conflicting standard contract for a custom-PDF partner.
  async function previewIfAssigned(partnerId) {
    try {
      const doc = await getDocument(partnerId);
      if (!doc) return false;
      await openPrivatePdf(doc);
      return true;
    } catch (error) {
      alert("Nie można sprawdzić przypisanej umowy. Nie generuję innego wzoru: " + error.message);
      return true; // fail closed
    }
  }

  window.openPartnerCustomAgreement = open;
  window.closePartnerCustomAgreement = close;
  window.uploadPartnerCustomAgreement = upload;
  window.removePartnerCustomAgreement = remove;
  window.previewPartnerCustomAgreement = () => preview().catch((e) => alert(e.message));
  window.Ride24AdminCustomAgreement = { previewIfAssigned, uploadFileToPartner };
})();
