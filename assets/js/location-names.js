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
  function currentLang() {
    try { return root.localStorage?.getItem("lang") === "en" ? "en" : "pl"; }
    catch (_) { return "pl"; }
  }
  function displayName(location, language = currentLang()) {
    const key = String(location?.location_name || "").trim();
    const country = String(location?.country || "").trim().toLowerCase();
    const label = country === "turkey" ? turkishAirports[key] : null;
    if (label) return label[language === "en" ? "en" : "pl"];
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
  root.Ride24LocationNames = Object.freeze({ displayName, normalizeForSave });
})(typeof window === "undefined" ? globalThis : window);
