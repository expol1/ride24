/**
 * Ride24 WEB rental minimum, including pickup-month seasonal rules.
 * A standalone dialog; no changes to the existing search form or its click handler.
 */
(() => {
  "use strict";
  const DAY_MS = 86400000;
  let checking = false;
  let bypass = false;
  let pending = null;
  let returnFocus = null;

  const lang = () => {
    try { return localStorage.getItem("lang") === "en" ? "en" : "pl"; }
    catch (_) { return "pl"; }
  };
  const t = (pl, en) => lang() === "en" ? en : pl;
  const utcDate = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const date = Date.parse(value + "T00:00:00.000Z");
    return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value
      ? date : NaN;
  };
  const rentalRules = window.Ride24RentalDuration;
  const addDays = (start, days) => rentalRules.dateAfter(start, days);

  async function locationsFor(db, selected) {
    if (!selected?.location_name) return [];
    let query = db.from("partner_locations")
      .select("partner_id,partners!inner(id,active,account_status,provider_type,api_enabled,min_rental_days,seasonal_min_rental_days,seasonal_min_rental_months)")
      .eq("active", true).eq("location_name", selected.location_name)
      .eq("partners.active", true).eq("partners.account_status", "active");
    if (selected.country) query = query.eq("country", selected.country);
    if (selected.city) query = query.eq("city", selected.city);
    const {data, error} = await query.limit(1000);
    if (error) throw error;
    return data || [];
  }

  async function minimumAtLocation(search) {
    const db = window.supabaseClient;
    if (!db) return null;
    const pickup = await locationsFor(db, search.pickup_location);
    if (!pickup.length) return null;
    const drop = await locationsFor(db, search.drop_location || search.pickup_location);
    const dropIds = new Set(drop.map(item => item.partner_id));
    const companies = new Map();
    for (const row of pickup) {
      const partner = Array.isArray(row.partners) ? row.partners[0] : row.partners;
      if (dropIds.has(row.partner_id) && partner) companies.set(row.partner_id, partner);
    }
    if (!companies.size) return null;

    const locals = [...companies].filter(([, partner]) => partner.provider_type !== "api").map(([id]) => id);
    const hasCars = new Set();
    if (locals.length) {
      const {data, error} = await db.from("car_classes")
        .select("partner_id").in("partner_id", locals).eq("active", true).limit(1000);
      if (error) throw error;
      for (const item of (data || [])) hasCars.add(item.partner_id);
    }

    const available = [...companies].filter(([id, partner]) => (
      partner.provider_type === "api" ? partner.api_enabled === true : hasCars.has(id)
    ));
    if (!available.length) return null;
    // The lowest eligible minimum wins; a stricter company cannot extend
    // someone else's shorter, valid rental at the same pickup location.
    return Math.min(...available.map(([, partner]) =>
      window.Ride24SeasonalMinimum.effectiveForPickup(partner, search.pickup_date).days));
  }

  function originalSearch(button) {
    bypass = true;
    try { button.click(); }
    finally { bypass = false; }
  }

  function modalElement() {
    let overlay = document.getElementById("r24-minimum-overlay");
    if (overlay) return overlay;
    const style = document.createElement("style");
    style.textContent = [
      "#r24-minimum-overlay{position:fixed;inset:0;z-index:2147483000;display:none;",
      "align-items:center;justify-content:center;padding:16px;box-sizing:border-box;",
      "background:rgba(15,23,42,.57)}",
      "#r24-minimum-overlay.r24-minimum-visible{display:flex}",
      ".r24-minimum-dialog{width:100%;max-width:360px;box-sizing:border-box;padding:23px;",
      "border-radius:17px;background:#fff;border:1px solid #e0eaca;",
      "color:#0f172a;box-shadow:0 22px 60px rgba(0,0,0,.22);font-family:Inter,Arial,sans-serif}",
      ".r24-minimum-icon{display:flex;align-items:center;justify-content:center;",
      "width:42px;height:42px;margin-bottom:12px;border-radius:12px;",
      "background:#f0f9e1;color:#315c16;font-size:21px}",
      ".r24-minimum-dialog h2{font-size:18px;line-height:1.35;font-weight:800;margin:0 0 8px}",
      ".r24-minimum-dialog p{font-size:14px;line-height:1.6;color:#475569;margin:0 0 15px}",
      ".r24-minimum-dates{border-radius:10px;background:#f5faec;border:1px solid #dfedca;",
      "color:#33591d;font-size:13px;line-height:1.5;font-weight:700;padding:11px;margin-bottom:17px}",
      ".r24-minimum-actions{display:flex;gap:10px}",
      ".r24-minimum-actions button{flex:1;min-width:0;border:0;border-radius:10px;",
      "padding:12px 8px;font-size:13px;font-weight:750;cursor:pointer}",
      "#r24-minimum-cancel{background:#f1f5f9;color:#334155}",
      "#r24-minimum-accept{background:#76c900;color:#15390a}",
      "#r24-minimum-overlay button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}",
      "@media(prefers-reduced-motion:no-preference){.r24-minimum-dialog{animation:r24MinimumIn .16s ease-out}",
      "@keyframes r24MinimumIn{from{transform:translateY(7px);opacity:.7}to{transform:translateY(0);opacity:1}}}"
    ].join("");
    document.head.appendChild(style);
    overlay = document.createElement("div");
    overlay.id = "r24-minimum-overlay";
    overlay.innerHTML = [
      '<div class="r24-minimum-dialog" role="dialog" aria-modal="true" aria-labelledby="r24-minimum-title" aria-describedby="r24-minimum-description">',
      '<div class="r24-minimum-icon" aria-hidden="true">📅</div>',
      '<h2 id="r24-minimum-title"></h2>',
      '<p id="r24-minimum-description"></p>',
      '<div class="r24-minimum-dates" id="r24-minimum-dates"></div>',
      '<div class="r24-minimum-actions">',
      '<button type="button" id="r24-minimum-cancel"></button>',
      '<button type="button" id="r24-minimum-accept"></button>',
      '</div></div>'
    ].join("");
    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove("r24-minimum-visible");
      pending = null;
      if (returnFocus?.focus) returnFocus.focus();
    };
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    overlay.querySelector("#r24-minimum-cancel").addEventListener("click", close);
    overlay.querySelector("#r24-minimum-accept").addEventListener("click", () => {
      if (!pending) return;
      const {search, minimum, button} = pending;
      close();
      const dropInput = document.getElementById("drop-date");
      if (!dropInput) return;
      const end = rentalRules.earliestReturnDate(
        search.pickup_date, search.pickup_time || "10:00", search.drop_time || "10:00", minimum
      );
      dropInput.value = end;
      const picker = window.ride24DateRangePicker;
      if (picker?.setDate) picker.setDate([search.pickup_date, end], false, "Y-m-d");
      originalSearch(button);
    });
    document.addEventListener("keydown", event => {
      if (!overlay.classList.contains("r24-minimum-visible")) return;
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const buttons = [...overlay.querySelectorAll("button")];
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault(); buttons[1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[1]) {
        event.preventDefault(); buttons[0].focus();
      }
    });
    return overlay;
  }

  function showMinimum(search, minimum, button) {
    const overlay = modalElement();
    returnFocus = document.activeElement;
    pending = {search, minimum, button};
    overlay.querySelector("#r24-minimum-title").textContent = t("Minimalny okres wynajmu", "Minimum rental period");
    overlay.querySelector("#r24-minimum-description").textContent =
      t("W tej lokalizacji minimalny okres wynajmu wynosi " + minimum + " dni. Możemy dostosować datę zwrotu bez zmieniania pozostałych pól wyszukiwarki.",
        "The minimum rental period at this location is " + minimum + " days. You can extend the return date without changing other search fields.");
    overlay.querySelector("#r24-minimum-dates").textContent =
      t("Nowa data zwrotu: ", "New return date: ") + rentalRules.earliestReturnDate(
          search.pickup_date, search.pickup_time || "10:00", search.drop_time || "10:00", minimum
        );
    overlay.querySelector("#r24-minimum-cancel").textContent = t("Anuluj", "Cancel");
    overlay.querySelector("#r24-minimum-accept").textContent = t("Dostosuj datę", "Adjust date");
    overlay.classList.add("r24-minimum-visible");
    overlay.querySelector("#r24-minimum-accept").focus();
  }

  // Capture the click before the existing search button handler. Its original
  // handler is NEVER edited, replaced or copied. Replay only once after validation.
  document.addEventListener("click", async event => {
    const button = event.target?.closest?.("#searchBtn");
    if (!button || bypass || button.disabled) return;
    if (!window.collectSearchData || !window.supabaseClient) return;
    const search = window.collectSearchData();
    let rental;
    try {
      rental = rentalRules.calculate(
        search.pickup_date, search.drop_date,
        search.pickup_time || "10:00", search.drop_time || "10:00"
      );
    } catch (_) { return; }
    const dropInput = document.getElementById("smart-search-drop");
    if (!search.pickup_location || (dropInput?.value?.trim() && !search.drop_location)
        || !Number.isInteger(rental.billedDays) || rental.billedDays < 1 || rental.billedDays > 366) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (checking || pending) return;
    checking = true;
    try {
      const minimum = await minimumAtLocation(search);
      if (minimum && !rentalRules.meetsMinimum(rental, minimum)) showMinimum(search, minimum, button);
      else originalSearch(button);
    } catch (error) {
      console.error("Ride24 minimum rental availability lookup failed", error);
      // Fail open for search only; the booking server always checks the rule.
      originalSearch(button);
    } finally {
      checking = false;
    }
  }, true);
})();
