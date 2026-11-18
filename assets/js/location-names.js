/* Canonical public labels without changing legacy partner_locations.location_name keys.
 * Old Android clients and the Ride24 API continue to filter on original stored names.
 */
(function (root) {
  "use strict";
  const points = [
    { city: "Tbilisi", type: "airport", code: "TBS", region: "Tbilisi", display_name: "Tbilisi International Airport (TBS)" },
    { city: "Tbilisi", type: "city", code: "", region: "Tbilisi", display_name: "Tbilisi City" },
    { city: "Kutaisi", type: "airport", code: "KUT", region: "Imereti", display_name: "Kutaisi International Airport (KUT)" },
    { city: "Batumi", type: "airport", code: "BUS", region: "Adjara", display_name: "Batumi International Airport (BUS)" },
  ];
  // Public labels are language-specific; database location_name remains the stable booking key.
  const turkishAirports = Object.freeze({
    "Milas-Bodrum Airport": {
      pl: "Lotnisko Milas–Bodrum (BJV)",
      en: "Milas–Bodrum Airport (BJV)"
    },
    "İzmir Adnan Menderes Airport": {
      pl: "Lotnisko Izmir-Adnan Menderes (ADB)",
      en: "Izmir Adnan Menderes Airport (ADB)"
    }
  });
  // Polish public labels for Maneuver's exact Hurghada pickup/return areas.
  // The stored location_name remains in English for existing booking contracts.
  const hurghadaPolish = Object.freeze({
    "Hurghada International Airport (HRG)": "Lotnisko Hurgada (HRG)",
    "Maneuver Office - Hurghada": "Biuro Maneuver – Hurgada",
    "Hurghada - Sakkala": "Hurgada – Sakkala (centrum)",
    "Hurghada - El Dahar": "Hurgada – El Dahar",
    "Hurghada - El Hadaba": "Hurgada – El Hadaba",
    "Hurghada - Arabia": "Hurgada – Arabia",
    "Hurghada - El Kawther": "Hurgada – El Kawther",
    "Hurghada - El Mamsha": "Hurgada – El Mamsha",
    "Hurghada - Villages Road": "Hurgada – Villages Road",
    "Hurghada - Intercontinental": "Hurgada – Intercontinental",
    "Hurghada - Magawish": "Hurgada – Magawish",
    "Hurghada - El Ahyaa": "Hurgada – El Ahyaa"
  });
  const croatianAirports = Object.freeze({
    "Dubrovnik airport": { pl: "Lotnisko Dubrownik (DBV)", en: "Dubrovnik Airport (DBV)" },
    "Pula airport": { pl: "Lotnisko Pula (PUY)", en: "Pula Airport (PUY)" },
    "Split airport": { pl: "Lotnisko Split (SPU)", en: "Split Airport (SPU)" },
    "Zadar airport": { pl: "Lotnisko Zadar (ZAD)", en: "Zadar Airport (ZAD)" },
    "Zagreb airport": { pl: "Lotnisko Zagrzeb (ZAG)", en: "Zagreb Airport (ZAG)" }
  });
  // Partner panel + public WWW share the same verified PL/EN dictionary.
  // Database location_name remains the technical booking key for old clients.
  let dictionaryRows = [];
  let dictionaryLoadPromise = null;
  const normalized = value => String(value || "").trim().toLocaleLowerCase("pl")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");

  function canonicalCountry(value) {
    const original = String(value || "").trim();
    const needle = normalized(original);
    if (!needle) return "";
    const aliases = {
      "bosna i hercegovina": "Bosnia and Herzegovina",
      "bosna i herzegovina": "Bosnia and Herzegovina",
      "bosnia & herzegovina": "Bosnia and Herzegovina",
    };
    if (aliases[needle]) return aliases[needle];
    const countries = root.RIDE24_COUNTRIES || {};
    for (const [name, record] of Object.entries(countries)) {
      if ([name, record.en, record.pl, record.code].some(candidate => normalized(candidate) === needle)) {
        return record.en || name;
      }
    }
    const dictionaryCountry = dictionaryRows.find(row => row.category === "country"
      && [row.name_en, row.name_pl].some(candidate => normalized(candidate) === needle));
    return dictionaryCountry?.name_en || original;
  }

  function localizedCountry(value, language = currentLang()) {
    const canonical = canonicalCountry(value);
    const row = dictionaryRows.find(item => item.category === "country"
      && normalized(item.name_en) === normalized(canonical));
    return row ? (language === "en" ? row.name_en : row.name_pl) : String(value || "");
  }

  function localizedCity(value, country, language = currentLang()) {
    const name = normalized(value);
    const parent = normalized(canonicalCountry(country));
    const matches = dictionaryRows.filter(item => item.category === "city"
      && normalized(item.name_en) === name
      && (!item.parent_country_en || normalized(canonicalCountry(item.parent_country_en)) === parent));
    const row = matches.find(item => normalized(item.parent_country_en) === parent) || matches[0];
    return row ? (language === "en" ? row.name_en : row.name_pl) : String(value || "");
  }

  function dictionaryLocation(location) {
    const country = normalized(canonicalCountry(location?.country));
    const name = normalized(location?.location_name || location?.display_name);
    if (!country || !name) return null;
    return dictionaryRows.find(row => row.category === "location"
      && normalized(canonicalCountry(row.parent_country_en)) === country
      && [row.name_en, row.name_pl].some(candidate => normalized(candidate) === name)) || null;
  }

  function canonicalLocationName(value, country) {
    const original = String(value || "").trim();
    const row = dictionaryLocation({ country, location_name: original });
    return row?.name_en || original;
  }

  function localizedNames(location) {
    const match = dictionaryLocation(location);
    return {
      en: displayName(location, "en"),
      pl: displayName(location, "pl"),
      verified: Boolean(match),
    };
  }

  async function loadDictionary(client) {
    if (!dictionaryLoadPromise) {
      dictionaryLoadPromise = (async () => {
        const { data, error } = await client.from("locations_dictionary")
          .select("category,name_en,name_pl,parent_country_en")
          .in("category", ["country", "region", "city", "location"])
          .limit(1000);
        if (error) throw error;
        dictionaryRows = Array.isArray(data) ? data : [];
      })().catch(error => {
        dictionaryLoadPromise = null;
        throw error;
      });
    }
    return dictionaryLoadPromise;
  }

  function currentLang() {
    try { return root.localStorage?.getItem("lang") === "en" ? "en" : "pl"; }
    catch (_) { return "pl"; }
  }
  function displayName(location, language = currentLang()) {
    const dictionaryMatch = dictionaryLocation(location);
    if (dictionaryMatch) return language === "en" ? dictionaryMatch.name_en : dictionaryMatch.name_pl;
    const key = String(location?.location_name || "").trim();
    const country = String(location?.country || "").trim().toLowerCase();
    const label = country === "turkey" ? turkishAirports[key]
      : country === "croatia" ? croatianAirports[key] : null;
    if (label) return country === "croatia" ? label.en : label[language];
    if (country === "egypt" && language === "pl" && hurghadaPolish[key]) {
      return hurghadaPolish[key];
    }
    return String(location?.display_name || location?.location_name || location?.city || "");
  }
  function normalizeForSave(data) {
    if (String(data?.country || "").trim().toLowerCase() !== "georgia") return data;
    const type = String(data.type || "").trim().toLowerCase();
    const name = String(data.location_name || "").trim().toLowerCase();
    const city = String(data.city || "").trim().toLowerCase();
    const target = points.find(point =>
      point.type === type &&
      (name.includes(point.city.toLowerCase()) || city === point.city.toLowerCase()
        || (point.code && new RegExp("(?:^|\\W)" + point.code.toLowerCase() + "(?:$|\\W)").test(name)))
    );
    if (target) return { ...data, region: target.region, city: target.city, display_name: target.display_name };
    const regionValue = String(data.region || "").trim();
    const cityValue = String(data.city || "").trim();
    if (!regionValue || !cityValue || regionValue.toLowerCase() === "other") {
      throw new Error("GEORGIA_LOCATION_FIELDS_REQUIRED");
    }
    return { ...data, display_name: String(data.location_name || "").trim() };
  }
  // Warm the public PL/EN dictionary before rendering search, map and results labels.
  // Do not alter stored booking keys or block the page when the dictionary is unavailable.
  function warmDictionary() {
    const client = root.supabaseClient;
    if (client && typeof client.from === "function") {
      loadDictionary(client).catch(() => {
        // The existing public display_name / location_name fallback remains usable.
      });
    }
  }
  if (root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", warmDictionary, { once: true });
    } else {
      warmDictionary();
    }
  }
  root.Ride24LocationNames = Object.freeze({ displayName, normalizeForSave, loadDictionary, canonicalCountry, canonicalLocationName, localizedCountry, localizedCity, localizedNames });
})(typeof window === "undefined" ? globalThis : window);
