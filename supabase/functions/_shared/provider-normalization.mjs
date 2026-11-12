// Ride24 categories, as defined by the existing partner dashboard:
// A Economy, B Compact, C Sedan, D SUV, E Premium, F Van / Family.
// This is a display classification only. Never replace an external group ID.
export function ride24ClassFromAcriss(value, seats = null) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return null;
  const [segment, body] = code;
  if (Number(seats) >= 7 || body === 'V') return 'F';
  if (['F', 'G'].includes(body)) return 'D';
  if (['P', 'U', 'L', 'W', 'X'].includes(segment)) return 'E';
  if (['M', 'N', 'E', 'H'].includes(segment)) return 'A';
  if (['C', 'D'].includes(segment)) return 'B';
  if (['I', 'J', 'S', 'R', 'F', 'G'].includes(segment)) return 'C';
  return null;
}

// Use an explicit supplier IATA code. Only the Renteon adapter may extract it
// from its documented location-code format; city codes are not airport codes.
export function canonicalApiLocation(location) {
  const name = String(location.location_name || '').trim().replace(/\s+/g, ' ');
  const iata = String(location.iata_code || '').trim().toUpperCase();
  if (location.type !== 'airport' || !/^[A-Z]{3}$/.test(iata)) {
    return { ...location, display_name: location.display_name || name };
  }
  const base = name.replace(/\s*\([A-Z]{3}\)\s*$/i, '').replace(/\bairport\b/ig, 'Airport');
  return { ...location, display_name: `${base} (${iata})` };
}

// Missing values do not erase verified metadata. Zero/false remain meaningful.
export function preserveKnownFields(next, previous, fields) {
  const result = { ...next };
  for (const key of fields) {
    if (result[key] === null || result[key] === undefined || result[key] === '') {
      if (previous?.[key] !== null && previous?.[key] !== undefined) result[key] = previous[key];
    }
  }
  return result;
}
