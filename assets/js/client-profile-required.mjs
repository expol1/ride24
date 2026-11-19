// Ride24 client profile completion rules (pure functions, also tested in Node).
// UI gates use the SAVED profile, never unsaved browser fields, to unlock navigation.
const text = value => typeof value === "string" ? value.trim() : "";
const digits = value => text(value).replace(/\D/g, "");

export function isFirstLicenceDate(value, today = new Date().toISOString().slice(0, 10)) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > today) return false;
  const parsed = new Date(date + "T00:00:00Z");
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

export function clientProfileErrors(profile, email, today) {
  const p = profile || {};
  const missing = [];
  const name = text(p.name);
  if (name.length < 3 || name.split(/\s+/).filter(Boolean).length < 2)
    missing.push({ id: "profile-name", pl: "Imię i nazwisko", en: "First and last name" });
  if (!Number.isInteger(Number(p.age)) || Number(p.age) < 18 || Number(p.age) > 120 || p.age === null || p.age === "")
    missing.push({ id: "profile-age", pl: "Wiek (18–120 lat)", en: "Age (18–120)" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(email)))
    missing.push({ id: "profile-email", pl: "Adres e-mail", en: "Email address" });
  const phoneDigits = digits(p.phone);
  if (phoneDigits.length < 7 || phoneDigits.length > 15)
    missing.push({ id: "profile-phone", pl: "Numer telefonu (7–15 cyfr)", en: "Phone number (7–15 digits)" });
  if (!isFirstLicenceDate(p.license_since, today))
    missing.push({ id: "profile-license-since", pl: "Data pierwszego uzyskania prawa jazdy", en: "Original driving licence date" });
  if (text(p.country).length < 2 || text(p.country).length > 80)
    missing.push({ id: "profile-country", pl: "Kraj zamieszkania", en: "Country of residence" });
  return missing;
}

export function additionalDriverErrors(driver, today) {
  const d = driver || {};
  const errors = [];
  if (text(d.name).length < 3 || text(d.name).split(/\s+/).filter(Boolean).length < 2)
    errors.push({ field: "name", pl: "imię i nazwisko", en: "first and last name" });
  if (d.age === "" || d.age == null || !Number.isInteger(Number(d.age)) || Number(d.age) < 18 || Number(d.age) > 120)
    errors.push({ field: "age", pl: "wiek (18–120 lat)", en: "age (18–120)" });
  if (digits(d.phone).length < 7 || digits(d.phone).length > 15)
    errors.push({ field: "phone", pl: "telefon (7–15 cyfr)", en: "phone number (7–15 digits)" });
  if (!isFirstLicenceDate(d.license_since, today))
    errors.push({ field: "license_since", pl: "datę pierwszego uzyskania prawa jazdy", en: "original driving licence date" });
  return errors;
}

export function invoiceProfileErrors(invoice) {
  const i = invoice || {};
  const errors = [];
  if (text(i.company_name).length < 2)
    errors.push({ id: "invoice-company", pl: "Nazwa firmy", en: "Company name" });
  if (text(i.nip) && !/^\d{10}$/.test(digits(i.nip)))
    errors.push({ id: "invoice-nip", pl: "NIP (10 cyfr) lub pozostaw puste", en: "Tax ID (10 digits) or leave blank" });
  if (text(i.street).length < 3)
    errors.push({ id: "invoice-street", pl: "Ulica i numer", en: "Street and number" });
  if (!/^\d{2}-\d{3}$/.test(text(i.postal_code)))
    errors.push({ id: "invoice-postal", pl: "Kod pocztowy (00-000)", en: "Postal code (00-000)" });
  if (text(i.city).length < 2)
    errors.push({ id: "invoice-city", pl: "Miasto", en: "City" });
  return errors;
}
