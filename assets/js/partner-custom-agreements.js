/* Optional signed custom PDF partner agreement. Loaded only by the partner dashboard.
 * No custom record => the original PL/EN agreement generator and signing stay intact. */
(function () {
  "use strict";
  const BUCKET = "partner-agreements";
  let currentDocument = null;
  let displayedSha256 = null;
  let documentUrl = null;
  let renderGeneration = 0;

  const tr = (pl, en, lang) => lang === "pl" ? pl : en;
  function id(value) { return document.getElementById(value); }
  function clearDocumentUrl() {
    if (documentUrl) URL.revokeObjectURL(documentUrl);
    documentUrl = null;
    displayedSha256 = null;
  }
  function blockSigning() {
    if (id("sign-btn")) {
      id("sign-btn").disabled = true;
      id("sign-btn").style.background = "#cbd5e1";
    }
  }
  function element(tag, text) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  async function verifiedDocument(doc, db) {
    if (!doc || typeof doc.storage_path !== "string" ||
        !/^[a-f0-9]{64}$/.test(doc.sha256 || "")) {
      throw new Error("Agreement data is invalid");
    }
    const { data: blob, error } = await db.storage.from(BUCKET).download(doc.storage_path);
    if (error || !blob) throw new Error("Could not download the private agreement PDF");
    if (blob.size < 50 || blob.size > 5 * 1024 * 1024) throw new Error("Agreement PDF size is invalid");
    const bytes = await blob.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5))) !== "%PDF-") {
      throw new Error("Invalid PDF file");
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map(n => n.toString(16).padStart(2, "0")).join("");
    if (digest !== doc.sha256) throw new Error("The agreement PDF has changed; contact Ride24");
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }
  function pdfPanel(target, url, filename, lang) {
    target.replaceChildren();
    const caption = element("p", tr(
      "To indywidualna umowa przypisana przez administratora Ride24. Otwórz i przeczytaj pełny dokument przed podpisaniem.",
      "This is the individual agreement assigned by Ride24. Open and review the full PDF before signing.", lang));
    caption.style.marginBottom = "10px";
    const link = element("a", tr("Otwórz / pobierz umowę PDF: ", "Open / download the agreement PDF: ", lang) + (filename || "Agreement.pdf"));
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.download = filename || "Partner_Agreement.pdf";
    link.style.display = "block";
    link.style.fontWeight = "700";
    link.style.marginBottom = "12px";
    const frame = element("iframe");
    frame.src = url;
    frame.title = tr("Indywidualna umowa partnerska PDF", "Individual partner agreement PDF", lang);
    frame.style.width = "100%";
    frame.style.height = "min(55vh,600px)";
    frame.style.minHeight = "260px";
    frame.style.border = "1px solid #cbd5e1";
    frame.style.borderRadius = "6px";
    frame.setAttribute("referrerpolicy", "no-referrer");
    const note = element("p", tr(
      "Jeżeli podgląd PDF nie działa na Twoim urządzeniu, otwórz dokument powyższym linkiem.",
      "If PDF preview is not supported on your device, open the document using the link above.", lang));
    note.style.fontSize = "12px";
    target.append(caption, link, frame, note);
  }
  function isReady() {
    return Boolean(currentDocument && documentUrl &&
      currentDocument.sha256 === displayedSha256);
  }
  async function render(doc, db, lang) {
    lang = lang === "pl" ? "pl" : "en";
    currentDocument = doc;
    const generation = ++renderGeneration;
    clearDocumentUrl();
    blockSigning();
    const checkbox = id("accept-cb");
    if (checkbox) checkbox.checked = false;
    const title = id("ag-title");
    const subtitle = id("ag-subtitle");
    const content = id("ag-content");
    if (title) title.textContent = tr("Indywidualna umowa partnerska", "Individual Partner Agreement", lang);
    if (subtitle) subtitle.textContent = tr(
      "Przed podpisaniem sprawdź treść oryginalnego PDF.",
      "Please review the original PDF before signing.", lang);
    if (content) content.textContent = tr("Bezpieczne ładowanie umowy...", "Loading private agreement...", lang);
    try {
      const url = await verifiedDocument(doc, db);
      if (generation !== renderGeneration) { URL.revokeObjectURL(url); return; }
      documentUrl = url;
      displayedSha256 = doc.sha256;
      if (content) pdfPanel(content, url, doc.original_filename, lang);
      if (typeof toggleSignButton === "function") toggleSignButton();
    } catch (error) {
      if (generation !== renderGeneration) return;
      console.error("Private agreement PDF unavailable:", error);
      clearDocumentUrl();
      blockSigning();
      if (content) content.textContent = tr(
        "Nie można bezpiecznie wyświetlić dokumentu. Podpis jest zablokowany. Skontaktuj się z Ride24.",
        "The agreement could not be verified. Signing is blocked. Please contact Ride24.", lang);
    }
  }
  async function sign(doc, db, lang) {
    lang = lang === "pl" ? "pl" : "en";
    const button = id("sign-btn");
    if (!isReady() || !doc || currentDocument?.sha256 !== doc.sha256 ||
        !id("accept-cb")?.checked) {
      alert(tr("Otwórz umowę i zaznacz pole akceptacji.", "Review the PDF and accept the agreement first.", lang));
      return;
    }
    button.disabled = true;
    let ip = "";
    try {
      // IP is supporting metadata; the server assigns the authoritative signing timestamp.
      const res = await fetch("https://api.ipify.org?format=json");
      if (res.ok) ip = String((await res.json()).ip || "").slice(0, 100);
    } catch (_) { /* IP lookup is optional */ }
    try {
      const { data, error } = await db.rpc("partner_accept_custom_agreement", {
        p_sha256: displayedSha256,
        p_ip: ip,
      });
      if (error || data !== true) throw error || new Error("Signing was rejected by the server");
      window.location.reload();
    } catch (error) {
      console.error("Custom agreement signing failed:", error);
      alert(tr(
        "Nie udało się podpisać tej wersji umowy. Odśwież stronę i spróbuj ponownie.",
        "Could not sign this agreement version. Refresh the page and try again.", lang));
      if (typeof toggleSignButton === "function") toggleSignButton();
    }
  }
  async function showSigned(snapshot, doc, db, lang) {
    lang = lang === "pl" ? "pl" : "en";
    if (!doc || doc.sha256 !== snapshot.sha256) {
      alert(tr("Nie można zweryfikować podpisanej umowy.", "Cannot verify the signed agreement.", lang));
      return;
    }
    const content = id("signed-agreement-content");
    content.textContent = tr("Otwieranie podpisanej umowy...", "Opening signed agreement...", lang);
    id("view-agreement-modal").style.display = "flex";
    try {
      const url = await verifiedDocument(doc, db);
      pdfPanel(content, url, doc.original_filename, lang);
      const print = id("view-ag-print");
      if (print) print.onclick = () => window.open(url, "_blank", "noopener");
      // No document changes are possible after signing. Keeping the object URL
      // until the next page load lets the partner download/print their copy.
    } catch (error) {
      console.error("Signed agreement document unavailable:", error);
      content.textContent = tr(
        "Nie udało się otworzyć podpisanego dokumentu. Skontaktuj się z Ride24.",
        "Could not open the signed PDF. Please contact Ride24.", lang);
    }
  }
  window.addEventListener("beforeunload", clearDocumentUrl);
  window.Ride24CustomAgreement = { render, sign, showSigned, isReady };
})();
