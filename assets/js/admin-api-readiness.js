(function (global) {
  "use strict";
  const labels = {
    requires_provider_test: "Wymaga testu wypożyczalni",
    metadata_only: "Import danych — wycena do integracji",
    requires_adapter: "Wymaga uzupełnienia adaptera",
    unsupported: "Brak adaptera"
  };
  global.renderApiReadiness = function (value) {
    const box = document.getElementById("api-readiness");
    if (!box) return;
    box.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Zgodność z aktualnym Ride24";
    const note = document.createElement("p");
    note.style.cssText = "margin:8px 0;line-height:1.5";
    note.textContent = "Test połączenia sprawdza dostęp do API. Pełna obsługa dopłat, dodatków i dokumentów wymaga osobnego testu integracji.";
    box.append(heading, note);
    if (!value || !Array.isArray(value.features)) {
      const unavailable = document.createElement("p");
      unavailable.textContent = "Brak wyniku kontroli zgodności. Otwórz ponownie konfigurację API.";
      box.append(unavailable); return;
    }
    const table = document.createElement("table");
    table.style.cssText = "width:100%;font-size:12px";
    value.features.forEach(feature => {
      const tr = document.createElement("tr"), name = document.createElement("td"), status = document.createElement("td");
      name.textContent = feature.label_pl; status.textContent = labels[feature.status] || "Wymaga weryfikacji";
      status.style.color = "#92400e"; tr.append(name, status); table.append(tr);
    });
    box.append(table);
    const next = document.createElement("p");
    next.style.cssText = "margin-top:10px;line-height:1.5";
    next.textContent = value.next_step_pl || "";
    box.append(next);
    if (value.local_pricing_status === "unmapped_supplements") {
      const warning = document.createElement("p");
      warning.style.cssText = "margin-top:8px;color:#b91c1c;font-weight:700";
      warning.textContent = "Wykryto lokalne dodatki lub reguły dopłat bez mapowania API. Aktywacja takich ofert jest blokowana, aby chronić pełną cenę.";
      box.append(warning);
    } else if (value.local_pricing_status === "verification_failed") {
      const warning = document.createElement("p");
      warning.textContent = "Nie udało się sprawdzić konfiguracji dopłat. Ponów odczyt przed aktywacją.";
      box.append(warning);
    }
  };
})(window);
