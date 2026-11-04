/* Admin-only optional private PDF agreements.
 * Empty assignment = use the existing standard Ride24 contract automatically. */
(function () {
  "use strict";
  const FUNCTION = "admin-partner-custom-agreement";
  const BUCKET = "partner-agreements";
  let selectedPartnerId = null;
  let selectedDocument = null;
  let isSigned = false;
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

  function renderAdminDocument() {
    const status = el("r24-custom-agreement-status");
    const label = el("r24-custom-agreement-file");
    const file = el("r24-custom-agreement-upload");
    const upload = el("r24-custom-agreement-upload-btn");
    const remove = el("r24-custom-agreement-remove-btn");
    const view = el("r24-custom-agreement-view-btn");
    label.textContent = selectedDocument
      ? "Indywidualna umowa: " + selectedDocument.original_filename
      : "Brak indywidualnej umowy — partner otrzyma standardową umowę Ride24.";
    status.textContent = isSigned ? "Umowa została już podpisana. Dokumentu nie można zmienić."
      : selectedDocument ? "Własna umowa przypisana (PDF prywatny). Przed podpisaniem możesz ją usunąć i wgrać nową."
      : "Możesz wgrać indywidualny PDF. Jeśli tego nie zrobisz, standardowy generator pozostanie bez zmian.";
    file.value = "";
    file.disabled = isSigned || Boolean(selectedDocument);
    upload.disabled = isSigned || Boolean(selectedDocument);
    remove.disabled = isSigned || !selectedDocument;
    view.disabled = !selectedDocument;
  }

  async function open(partnerId) {
    selectedPartnerId = null;
    selectedDocument = null;
    try {
      const { data: partner, error } = await db.from("partners")
        .select("id,company_name,agreement_accepted").eq("id", partnerId).single();
      if (error || !partner) throw error || new Error("Nie znaleziono partnera");
      const doc = await getDocument(partnerId);
      selectedPartnerId = partner.id;
      selectedDocument = doc;
      isSigned = partner.agreement_accepted === true;
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
      const body = new FormData();
      body.append("partner_id", selectedPartnerId);
      body.append("operation", "upload");
      body.append("agreement", file, file.name);
      await apiRequest(body);
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
    if (!selectedPartnerId || isSigned || !selectedDocument) return;
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
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300);
    if (error || !data?.signedUrl) throw error || new Error("Brak dostępu do pliku");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
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
  window.Ride24AdminCustomAgreement = { previewIfAssigned };
})();
