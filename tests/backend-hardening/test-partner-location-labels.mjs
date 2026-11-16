import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../../assets/js/location-names.js", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../partner-dashboard.html", import.meta.url), "utf8");
const root = {
  localStorage: { getItem: () => "pl" },
  RIDE24_COUNTRIES: {
    "Bosnia and Herzegovina": {
      code: "BA", en: "Bosnia and Herzegovina",
      pl: "Bośnia i Hercegowina", flag: "🇧🇦",
    },
    Greece: { code: "GR", en: "Greece", pl: "Grecja", flag: "🇬🇷" },
  },
};
const context = createContext({ window: root });
new Script(source, { filename: "location-names.js" }).runInContext(context);
const names = root.Ride24LocationNames;
assert.ok(names);
const dictionary = [
  { category: "country", name_en: "Bosnia and Herzegovina", name_pl: "Bośnia i Hercegowina", parent_country_en: null },
  { category: "location", name_en: "Mostar Airport (OMO)", name_pl: "Mostar – Lotnisko (OMO)", parent_country_en: "Bosnia and Herzegovina" },
  { category: "location", name_en: "Mostar City", name_pl: "Mostar – Centrum", parent_country_en: "Bosnia and Herzegovina" },
];
const client = {
  from: table => {
    assert.equal(table, "locations_dictionary");
    return { select: () => ({ in: () => ({
      limit: async () => ({ data: dictionary, error: null }),
    }) }) };
  },
};
await names.loadDictionary(client);
assert.equal(names.canonicalCountry("Bośnia i Hercegowina"), "Bosnia and Herzegovina");
assert.equal(names.canonicalCountry("Bosna I Hercegovina"), "Bosnia and Herzegovina");
assert.equal(names.canonicalCountry("Grecja"), "Greece");
assert.equal(names.canonicalLocationName("Mostar – Lotnisko (OMO)", "Bośnia i Hercegowina"), "Mostar Airport (OMO)");
assert.equal(names.displayName({ country: "Bosnia and Herzegovina", location_name: "Mostar Airport (OMO)" }, "pl"), "Mostar – Lotnisko (OMO)");
assert.equal(names.displayName({ country: "Bosnia and Herzegovina", location_name: "Mostar Airport (OMO)" }, "en"), "Mostar Airport (OMO)");
assert.equal(names.displayName({ country: "Bosnia and Herzegovina", location_name: "Unknown Pickup" }, "pl"), "Unknown Pickup");
assert.equal(names.localizedNames({ country: "Bosnia and Herzegovina", location_name: "Mostar City" }).verified, true);
assert.equal(names.normalizeForSave({ country: "Georgia", city: "Tbilisi", type: "airport", location_name: "Tbilisi Airport (TBS)" }).display_name, "Tbilisi International Airport (TBS)");

for (const required of [
  "locationData.display_name = String(",
  "canonicalCountry(document.getElementById('locCountry').value)",
  "canonicalLocationName(",
  "locationDropdown",
  "name_pl.ilike.",
  "locNameTranslationPreview",
]) {
  assert.ok(panel.includes(required), "Missing partner panel integration: " + required);
}
console.log("PASS: partner panel and location name normalization");
