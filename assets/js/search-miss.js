(function (global) {
  "use strict";
  const timers = new Map(), recent = new Map(), storageKey = "ride24.search-misses.v1";
  function normalize(value) {
    const query = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 3 || query.length > 80 || !/\p{L}/u.test(query) ||
        /[@<>]|:\/\/|\d{6}/u.test(query)) return null;
    return query;
  }
  try {
    const saved = JSON.parse(global.sessionStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved)) saved.slice(-50).forEach(([query, time]) => {
      if (normalize(query) && Number(time) > Date.now() - 1800000) recent.set(query, Number(time));
    });
  } catch (_) { /* Search works with storage disabled. */ }
  function cancel(type) { clearTimeout(timers.get(type)); timers.delete(type); }
  function schedule(query, type, box) {
    cancel(type);
    const clean = normalize(query);
    if (!clean || (recent.get(clean) || 0) > Date.now() - 1800000) return;
    timers.set(type, setTimeout(async () => {
      timers.delete(type);
      const input = document.getElementById("smart-search-" + type);
      if (!input || normalize(input.value) !== clean || !box.classList.contains("show")) return;
      try {
        const db = global.supabaseClient;
        if (!db || !db.functions) return;
        const result = await db.functions.invoke("record-search-miss", {
          body: { query: clean }
        });
        if (!result.error) {
          recent.set(clean, Date.now());
          while (recent.size > 50) recent.delete(recent.keys().next().value);
          try { global.sessionStorage.setItem(storageKey, JSON.stringify([...recent])); } catch (_) {}
        }
      } catch (_) { /* Analytics must never interrupt location selection. */ }
    }, 1500));
  }
  global.Ride24SearchMiss = Object.freeze({ normalize, cancel, schedule });
})(window);
