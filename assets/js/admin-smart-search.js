(function (global) {
  "use strict";
  const types = ["country", "region", "city", "location"];
  const labels = { country: "Państwo", region: "Region / wyspa", city: "Miasto", location: "Punkt odbioru" };
  const normalize = value => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  let dictionary = [], dismissed = [], selected = null, pendingKeyword = "", saving = false;
  const el = id => document.getElementById(id);
  const client = () => global.supabaseClient;
  const message = (text, error) => {
    const box = el("dict-status");
    if (box) { box.textContent = text; box.style.color = error ? "#b91c1c" : "var(--gray)"; }
  };

  function findEntry(rows, name, category, context) {
    const candidates = rows.filter(row => row.category === category && normalize(row.name_en) === normalize(name));
    const country = normalize(context && context.country);
    const region = normalize(context && context.region);
    const compatible = row =>
      (!country || !row.parent_country_en || normalize(row.parent_country_en) === country) &&
      (!region || !row.parent_region_en || normalize(row.parent_region_en) === region);
    return candidates.filter(compatible).sort((a, b) =>
      Number(Boolean(b.parent_country_en)) - Number(Boolean(a.parent_country_en)))[0] || null;
  }

  function buildQueue(locations, rows) {
    const queue = new Map();
    locations.forEach(row => {
      [["country", row.country], ["region", row.region], ["city", row.city], ["location", row.location_name]].forEach(([type, name]) => {
        if (!normalize(name)) return;
        const context = {
          country: type === "country" ? "" : row.country || "",
          region: ["city", "location"].includes(type) ? row.region || "" : ""
        };
        const existing = findEntry(rows, name, type, context);
        if (existing && normalize(existing.name_pl)) return;
        const key = [type, normalize(name), normalize(context.country), normalize(context.region)].join("|");
        const item = queue.get(key) || { name: String(name).trim(), type, context, existing, count: 0 };
        item.count++;
        queue.set(key, item);
      });
    });
    return [...queue.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pl"));
  }

  async function allRows(table, fields) {
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const result = await client().from(table).select(fields).order("id").range(start, start + 999);
      if (result.error) throw result.error;
      rows.push(...(result.data || []));
      if (!result.data || result.data.length < 1000) return rows;
    }
  }

  const mappingKey = item => [item.type, normalize(item.name), normalize(item.context.country), normalize(item.context.region)].join("|");
  const isDismissed = (kind, key) => dismissed.some(row => row.kind === kind && row.entry_key === key);
  function deleteButtonState() {
    const button = el("dict-delete");
    if (button) button.disabled = saving || !selected?.existing?.id;
  }
  function renderDismissals() {
    const tbody = el("smart-dismissed-tbody"), count = el("smart-dismissed-count");
    if (count) count.textContent = String(dismissed.length);
    if (!tbody) return;
    tbody.replaceChildren();
    if (!dismissed.length) return tableMessage(tbody, "Nie ma usuniętych propozycji.", 3);
    dismissed.forEach(item => {
      const tr = document.createElement("tr"), kind = document.createElement("td"),
        label = document.createElement("td"), action = document.createElement("td"),
        button = document.createElement("button");
      kind.textContent = item.kind === "mapping" ? "Mapowanie" : "Błędne zapytanie";
      label.textContent = item.label;
      button.type = "button"; button.className = "btn-secondary"; button.textContent = "Przywróć";
      button.style.cssText = "padding:6px 12px;font-size:11px";
      button.addEventListener("click", () => restoreDismissal(item));
      action.append(button); tr.append(label, kind, action); tbody.append(tr);
    });
  }
  async function readDismissals() {
    dismissed = await allRows("smart_search_dismissals", "id,kind,entry_key,label");
    renderDismissals();
    return dismissed;
  }
  async function dismissEntry(kind, key, label) {
    if (saving || !["mapping","search"].includes(kind) || !key) return;
    if (!confirm("Usunąć „" + label + "” z listy? Nie usunie to lokalizacji partnera ani historii wyszukiwań. Pozycję można przywrócić w sekcji Usunięte.")) return;
    saving = true;
    try {
      const result = await client().from("smart_search_dismissals").insert({ kind, entry_key:key, label });
      if (result.error && result.error.code !== "23505") throw result.error;
      await Promise.all([global.loadUnmappedLocations(), global.loadSearchLogs()]);
      message("Usunięto „" + label + "” z listy. Wpis nie wróci przy odświeżaniu.");
    } catch (error) {
      message("Nie udało się usunąć pozycji. Sprawdź uprawnienia administratora i spróbuj ponownie.", true);
      console.error("Smart Search: dismiss failed", error?.code || "");
    } finally { saving = false; }
  }
  async function restoreDismissal(item) {
    if (saving || !confirm("Przywrócić „" + item.label + "” do listy Smart Search?")) return;
    saving = true;
    try {
      const result = await client().from("smart_search_dismissals").delete().eq("id", item.id).select("id");
      if (result.error) throw result.error;
      if (!result.data?.length) throw new Error("Wpis zmieniony lub brak uprawnień.");
      await Promise.all([global.loadUnmappedLocations(), global.loadSearchLogs()]);
      message("Przywrócono „" + item.label + "”. Jeśli nadal wymaga mapowania, pojawi się na liście.");
    } catch (error) {
      message("Nie udało się przywrócić pozycji. Odśwież sekcję i spróbuj ponownie.", true);
      console.error("Smart Search: restore failed", error?.code || "");
    } finally { saving = false; }
  }

  async function readDictionary() {
    dictionary = await allRows("locations_dictionary", "id,category,name_en,name_pl,keywords,slug,parent_country_en,parent_region_en");
    renderDictionaryOptions();
    return dictionary;
  }

  function renderDictionaryOptions() {
    const select = el("dict-existing");
    if (!select) return;
    const term = normalize(el("dict-find") && el("dict-find").value);
    select.replaceChildren(new Option("Wybierz nazwę, aby poprawić tłumaczenie lub dopisać synonim…", ""));
    dictionary.filter(row => !term || normalize([row.name_en, row.name_pl, row.keywords].join(" ")).includes(term))
      .sort((a, b) => String(a.name_en).localeCompare(String(b.name_en), "pl"))
      .forEach(row => select.add(new Option(
        row.name_en + " → " + (row.name_pl || "brak tłumaczenia") + " · " + (labels[row.category] || row.category) +
        (row.parent_country_en ? " · " + row.parent_country_en : ""), row.id)));
    if (selected && selected.existing) select.value = selected.existing.id;
  }

  function resetForm(clearKeyword) {
    types.forEach(type => ["en", "pl"].forEach(lang => {
      const input = el("dict-" + type + "-" + lang);
      if (input) { input.value = ""; input.readOnly = false; }
    }));
    if (clearKeyword !== false) pendingKeyword = "";
    el("dict-keywords").value = pendingKeyword;
    selected = null;
    if (el("dict-existing")) el("dict-existing").value = "";
    deleteButtonState();
  }

  function prefill(item) {
    resetForm(false);
    selected = item;
    deleteButtonState();
    const existing = item.existing;
    el("dict-" + item.type + "-en").value = item.name;
    el("dict-" + item.type + "-en").readOnly = true;
    el("dict-" + item.type + "-pl").value = existing && existing.name_pl || "";
    el("dict-keywords").value = [...new Set(
      [existing && existing.keywords || "", pendingKeyword].join(",").split(",").map(normalize).filter(Boolean)
    )].join(", ");
    message("Mapowanie: " + item.name + (item.context.country ? " · " + item.context.country : "") +
      ". Uzupełnij polską nazwę i zapisz.");
    el("dict-" + item.type + "-pl").focus();
    el("dict-editor").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function tableMessage(tbody, text, columns) {
    const cell = document.createElement("td"), row = document.createElement("tr");
    cell.colSpan = columns; cell.textContent = text; row.append(cell); tbody.replaceChildren(row);
  }

  global.loadUnmappedLocations = async function () {
    const tbody = el("unmapped-locations-tbody");
    if (!tbody) return;
    tableMessage(tbody, "Sprawdzam nazwy partnerów i polskie tłumaczenia…", 3);
    try {
      const [locations, rows] = await Promise.all([
        allRows("partner_locations", "id,country,region,city,location_name"), readDictionary(), readDismissals()
      ]);
      const queue = buildQueue(locations, rows).filter(item => !isDismissed("mapping", mappingKey(item)));
      el("unmapped-count").textContent = String(queue.length);
      if (!queue.length) return tableMessage(tbody, "Brak pozycji do zmapowania — nazwy są przetłumaczone lub usunięte z kolejki.", 3);
      tbody.replaceChildren();
      queue.forEach(item => {
        const tr = document.createElement("tr"), name = document.createElement("td"),
          type = document.createElement("td"), action = document.createElement("td");
        const title = document.createElement("strong"), context = document.createElement("div");
        title.textContent = item.name;
        context.textContent = [item.context.region, item.context.country].filter(Boolean).join(", ");
        context.style.cssText = "font-size:11px;color:var(--gray);margin-top:3px";
        name.append(title, context); type.textContent = labels[item.type];
        const button = document.createElement("button");
        button.type = "button"; button.className = "btn-primary"; button.textContent = "Tłumacz";
        button.style.cssText = "padding:6px 12px;font-size:11px";
        button.addEventListener("click", () => prefill(item));
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "btn-secondary"; remove.textContent = "Usuń";
        remove.style.cssText = "padding:6px 12px;font-size:11px;margin-left:6px;background:#b91c1c";
        remove.addEventListener("click", () => dismissEntry("mapping", mappingKey(item), item.name + " · " + labels[item.type]));
        action.append(button, remove); tr.append(name, type, action); tbody.append(tr);
      });
    } catch (error) {
      tableMessage(tbody, "Nie udało się pobrać nazw. Odśwież sekcję lub zaloguj się ponownie.", 3);
      console.error("Smart Search: mapping load failed", error && error.code || "");
    }
  };

  global.loadSearchLogs = async function () {
    const tbody = el("search-logs-tbody");
    if (!tbody) return;
    tableMessage(tbody, "Ładowanie…", 3);
    try {
      const [result] = await Promise.all([client().rpc("get_top_searches"), readDismissals()]);
      if (result.error) throw result.error;
      const rows = (result.data || []).filter(item => !isDismissed("search", normalize(item.query)));
      if (!rows.length) return tableMessage(tbody, "Brak nieprzypisanych zapytań bez wyników.", 3);
      tbody.replaceChildren();
      rows.forEach(item => {
        const tr = document.createElement("tr"), query = document.createElement("td"),
          count = document.createElement("td"), action = document.createElement("td");
        query.textContent = item.query; count.textContent = String(item.count);
        const button = document.createElement("button");
        button.type = "button"; button.className = "btn-primary"; button.textContent = "Przypisz";
        button.style.cssText = "padding:6px 12px;font-size:11px";
        button.addEventListener("click", () => {
          pendingKeyword = normalize(item.query);
          resetForm(false);
          message("Fraza „" + item.query + "”: wybierz poniżej istniejącą nazwę albo wpisz nowe mapowanie.");
          el("dict-existing").focus();
          el("dict-editor").scrollIntoView({ behavior: "smooth", block: "start" });
        });
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "btn-secondary"; remove.textContent = "Usuń";
        remove.style.cssText = "padding:6px 12px;font-size:11px;margin-left:6px;background:#b91c1c";
        remove.addEventListener("click", () => dismissEntry("search", normalize(item.query), String(item.query)));
        action.append(button, remove); tr.append(query, count, action); tbody.append(tr);
      });
    } catch (error) {
      tableMessage(tbody, "Nie udało się pobrać logów. Odśwież sekcję lub zaloguj się ponownie.", 3);
      console.error("Smart Search: log load failed", error && error.code || "");
    }
  };

  global.filterSmartDictionary = renderDictionaryOptions;
  global.editSmartDictionary = function () {
    const row = dictionary.find(item => item.id === el("dict-existing").value);
    if (row) prefill({ name: row.name_en, type: row.category, existing: row,
      context: { country: row.parent_country_en || "", region: row.parent_region_en || "" } });
    else resetForm(true);
  };
  global.clearSmartDictionary = function () { resetForm(true); message("Wybierz nazwę z listy albo wypełnij nowy wpis."); };
  global.prefillDictionary = function (name, type) {
    prefill({ name, type, context: {}, existing: findEntry(dictionary, name, type, {}) });
  };

  global.deleteSmartDictionary = async function () {
    if (saving || !selected?.existing?.id) return;
    const row = dictionary.find(item => item.id === selected.existing.id);
    if (!row) return message("Wybierz zapisane tłumaczenie ze słownika.", true);
    if (!confirm("Trwale usunąć tłumaczenie „" + row.name_en + " → " + row.name_pl + "” oraz jego synonimy? Nazwy partnera nie zostaną usunięte. Jeśli partner używa tej nazwy, pojawi się ponownie w kolejce Do zmapowania.")) return;
    saving = true; deleteButtonState();
    try {
      const result = await client().from("locations_dictionary").delete().eq("id", row.id).select("id");
      if (result.error) throw result.error;
      if (!result.data?.length) throw new Error("Wpis zmieniony lub brak uprawnień do usunięcia.");
      resetForm(true);
      await Promise.all([global.loadUnmappedLocations(), global.loadSearchLogs()]);
      message("Usunięto tłumaczenie „" + row.name_en + "” i powiązane z nim synonimy.");
    } catch (error) {
      message("Nie udało się usunąć tłumaczenia. " + (error?.message || "Spróbuj ponownie."), true);
      console.error("Smart Search: dictionary delete failed", error?.code || "");
    } finally { saving = false; deleteButtonState(); }
  };

  global.addDictionary = async function () {
    if (saving) return;
    const populated = types.filter(type => el("dict-" + type + "-en").value.trim() || el("dict-" + type + "-pl").value.trim());
    if (!populated.length || populated.some(type => !el("dict-" + type + "-en").value.trim() || !el("dict-" + type + "-pl").value.trim())) {
      message("Dla każdego uzupełnionego poziomu wpisz oryginał i polskie tłumaczenie.", true); return;
    }
    const button = el("dict-save");
    saving = true; if (button) button.disabled = true;
    try {
      await readDictionary();
      const deepest = populated[populated.length - 1], inputKeywords = el("dict-keywords").value;
      const writes = populated.map(type => {
        const name = el("dict-" + type + "-en").value.trim(), pl = el("dict-" + type + "-pl").value.trim();
        if (name.length > 250 || pl.length > 250 || inputKeywords.length > 4000) throw new Error("Zbyt długa nazwa lub lista synonimów.");
        const context = selected && selected.type === type ? selected.context : {
          country: type === "country" ? "" : el("dict-country-en").value.trim(),
          region: ["city", "location"].includes(type) ? el("dict-region-en").value.trim() : ""
        };
        const existing = selected && selected.type === type && selected.existing
          ? dictionary.find(row => row.id === selected.existing.id) : findEntry(dictionary, name, type, context);
        const keywords = [...new Set([existing && existing.keywords || "", type === deepest ? inputKeywords : ""]
          .join(",").split(",").map(normalize).filter(Boolean))].join(", ");
        const id = existing && existing.id || crypto.randomUUID();
        return { id, category: type, name_en: name, name_pl: pl, keywords,
          slug: existing && existing.slug || type + "-" + normalize(name).replace(/\s+/g, "-").slice(0, 80) + "-" + id.slice(0, 8),
          parent_country_en: existing && existing.parent_country_en || context.country || null,
          parent_region_en: existing && existing.parent_region_en || context.region || null };
      });
      const result = await client().from("locations_dictionary").upsert(writes, { onConflict: "id" });
      if (result.error) throw result.error;
      resetForm(true); message("Zapisano tłumaczenie i synonimy. Wyszukiwarka korzysta z nich od razu.");
      await Promise.all([global.loadUnmappedLocations(), global.loadSearchLogs()]);
    } catch (error) {
      message(error && error.code === "42501" ? "Brak uprawnień. Zaloguj się ponownie na konto administratora."
        : error && error.code === "23505" ? "Ta nazwa już istnieje. Wybierz ją z listy i ponów zapis."
        : "Nie udało się zapisać. " + (error instanceof Error ? error.message : "Odśwież sekcję i spróbuj ponownie."), true);
    } finally { saving = false; if (button) button.disabled = false; }
  };

  global.Ride24SmartSearchAdmin = Object.freeze({ normalize, findEntry, buildQueue });
})(window);
