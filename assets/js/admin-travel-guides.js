// Admin-only HTML uploads. GitHub credentials are kept in server-side Vault.
let guideUploadBusy = false;
let guideConfigureBusy = false;
let guideGithubConfigured = false;
let guideAutoTitle = "";
let guideAutoSlug = "";
const GUIDE_HTML_LIMIT = 2 * 1024 * 1024;

function guideMessage(id, message, error = false) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.style.color = error ? "#B91C1C" : "#166534";
  el.setAttribute("role", error ? "alert" : "status");
}
function guideUploadControls() {
  document.getElementById("guide-upload-button").disabled = guideUploadBusy || !guideGithubConfigured;
  ["guide-title", "guide-slug", "guide-html-file"].forEach((id) => {
    document.getElementById(id).disabled = guideUploadBusy;
  });
  document.getElementById("guide-upload-button").textContent = guideUploadBusy ? "Wysyłanie…" : "Wgraj autoprzewodnik";
}
function updateGuideDestination() {
  const slug = document.getElementById("guide-slug").value.trim();
  document.getElementById("guide-destination").textContent =
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? `/travel-guides/${slug}.html` : "/travel-guides/nazwa.html";
}
function guideSlug(value) {
  return value.replace(/[łŁ]/g, "l").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 80).replace(/-+$/g, "") || "przewodnik";
}
function onGuideFileSelected() {
  const input = document.getElementById("guide-html-file");
  const file = input.files[0];
  guideMessage("guide-upload-message", "");
  if (!file) return;
  if (!/\.html?$/i.test(file.name) || !file.size || file.size > GUIDE_HTML_LIMIT) {
    input.value = "";
    guideMessage("guide-upload-message", "Wybierz niepusty plik HTML o rozmiarze do 2 MB.", true);
    return;
  }
  const stem = file.name.replace(/\.html?$/i, "");
  const title = document.getElementById("guide-title");
  const slug = document.getElementById("guide-slug");
  if (!title.value.trim() || title.value === guideAutoTitle) title.value = stem.slice(0, 120);
  if (!slug.value.trim() || slug.value === guideAutoSlug) slug.value = guideSlug(stem);
  guideAutoTitle = stem.slice(0, 120);
  guideAutoSlug = guideSlug(stem);
  updateGuideDestination();
}
async function invokeGuideAdmin(payload) {
  const { data, error } = await db.functions.invoke("admin-travel-guides", { body: payload });
  if (error) {
    let message = "Nie udało się połączyć z serwerem. Spróbuj ponownie.";
    if (error.context && typeof error.context.clone === "function") {
      try {
        const body = await error.context.clone().json();
        if (typeof body.error === "string") message = body.error;
      } catch { /* Never display an upstream HTML response. */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function loadGuideUploadStatus() {
  try {
    const status = await invokeGuideAdmin({ action: "status" });
    guideGithubConfigured = status?.configured === true;
    guideMessage("guide-github-status", guideGithubConfigured ? "GitHub połączony — możesz wgrywać pliki." : "Jednorazowo połącz GitHub, aby wgrywać przewodniki.");
    const setup = document.getElementById("guide-github-setup");
    if (!guideGithubConfigured) setup.open = true;
  } catch (error) {
    guideGithubConfigured = false;
    guideMessage("guide-github-status", error.message, true);
  }
  guideUploadControls();
}
async function configureGuideGithub(event) {
  event.preventDefault();
  if (guideConfigureBusy) return;
  const field = document.getElementById("guide-github-token");
  const token = field.value.trim();
  if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
    guideMessage("guide-configure-message", "Wklej token fine-grained GitHub dla repozytorium ride24.", true);
    return;
  }
  guideConfigureBusy = true;
  field.value = "";
  const button = document.getElementById("guide-configure-button");
  button.disabled = true;
  field.disabled = true;
  guideMessage("guide-configure-message", "Łączenie z GitHub…");
  try {
    await invokeGuideAdmin({ action: "configure", token });
    guideGithubConfigured = true;
    guideMessage("guide-github-status", "GitHub połączony — możesz wgrywać pliki.");
    guideMessage("guide-configure-message", "Połączenie zapisane. Token pozostaje po stronie serwera.");
    document.getElementById("guide-github-setup").open = false;
  } catch (error) { guideMessage("guide-configure-message", error.message, true); }
  finally {
    guideConfigureBusy = false;
    button.disabled = false;
    field.disabled = false;
    guideUploadControls();
  }
}
async function saveGuide(event) {
  event.preventDefault();
  if (guideUploadBusy) return;
  if (!guideGithubConfigured) {
    guideMessage("guide-upload-message", "Najpierw połącz GitHub poniżej.", true);
    return;
  }
  const file = document.getElementById("guide-html-file").files[0];
  const title = document.getElementById("guide-title").value.trim();
  const slug = document.getElementById("guide-slug").value.trim();
  if (!file || !/\.html?$/i.test(file.name) || !file.size || file.size > GUIDE_HTML_LIMIT) {
    guideMessage("guide-upload-message", "Wybierz plik HTML o rozmiarze do 2 MB.", true);
    return;
  }
  if (!title || title.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    guideMessage("guide-upload-message", "Uzupełnij nazwę oraz nazwę pliku: małe litery, cyfry i myślniki.", true);
    return;
  }
  guideUploadBusy = true;
  guideUploadControls();
  guideMessage("guide-upload-message", "Wysyłanie pliku i zapisywanie przewodnika…");
  try {
    let html;
    try { html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error("Zapisz plik HTML w kodowaniu UTF-8 i wybierz go ponownie."); }
    const result = await invokeGuideAdmin({ action: "upload", title, slug, file_name: file.name, html });
    if (result?.success !== true) throw new Error("Nie otrzymano potwierdzenia zapisu. Spróbuj ponownie.");
    document.getElementById("guide-upload-form").reset();
    guideAutoTitle = "";
    guideAutoSlug = "";
    updateGuideDestination();
    guideMessage("guide-upload-message", "Przewodnik zapisany w GitHub i dodany do listy. Przypisz go do lokalizacji poniżej. Publikacja na stronie może potrwać kilka minut.");
    await Promise.all([loadGuides(), loadGuideLocations()]);
  } catch (error) { guideMessage("guide-upload-message", error.message, true); }
  finally { guideUploadBusy = false; guideUploadControls(); }
}
