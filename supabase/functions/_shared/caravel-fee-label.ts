// Only provider-returned, already reconciled amounts are shown to the customer.
const CARAVEL_FEE_NAMES: Record<string, {pl:string;en:string}> = {
  young_driver: {pl:"Młody kierowca",en:"Young driver"},
  senior_driver: {pl:"Starszy kierowca",en:"Senior driver"},
  additional_driver: {pl:"Dodatkowy kierowca",en:"Additional driver"},
  one_way: {pl:"Zwrot w innym punkcie",en:"One-way return"},
  out_of_hours: {pl:"Obsługa poza godzinami pracy",en:"Out-of-hours service"},
  premium_location: {pl:"Dopłata za lokalizację",en:"Premium location fee"},
  delivery: {pl:"Dostawa lub odbiór",en:"Delivery or collection"},
};

export function caravelFeeLabel(type: string, original: string, lang: "pl" | "en") {
  if (type === "out_of_hours") {
    if (/\bpickup\b/i.test(original)) return lang === "pl" ? "Odbiór poza godzinami pracy" : "Out-of-hours pickup";
    if (/\bdropoff\b/i.test(original)) return lang === "pl" ? "Zwrot poza godzinami pracy" : "Out-of-hours return";
  }
  return CARAVEL_FEE_NAMES[type]?.[lang] || original || (lang === "pl" ? "Opłata Caravel" : "Caravel fee");
}
