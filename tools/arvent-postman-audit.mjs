// Ride24 / Arvent: offline inspection of a vendor-supplied Postman Collection v2.x.
// No network calls. Never prints credentials, header values, request bodies or query strings.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXPECTED_HOST = "racapi.arventcarrental.com";
const REQUIRED = ["locations", "availability", "booking_create", "booking_status", "booking_cancel"];
const SIGNATURES = [
  ["booking_cancel", /cancel|cancell|iptal|annul|delete.?reserv/iu],
  ["booking_status", /status|booking.?detail|reservation.?detail|reservasyon.?detay|reservation.?get|rezervasyon.?sorgu/iu],
  ["booking_create", /book|reserv|rezervasyon|kiralama.?olustur|create.?order/iu],
  ["availability", /availability|search|quote|price|müsait|musait|fiyat|araç.?ara|arac.?ara/iu],
  ["locations", /location|office|branch|station|lokasyon|şube|sube|konum/iu],
  ["groups", /vehicle|car.?group|category|car.?class|arac|araç|kategori/iu],
  ["auth", /auth|login|token|giriş|giris/iu],
];

function redactSegment(segment) {
  if (!segment) return segment;
  if (segment.length > 24 && !segment.startsWith("{{")) return "[REDACTED]";
  if (/^(eyJ[A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{32,})$/.test(segment)) return "[REDACTED]";
  return segment;
}

export function sanitizedPath(url) {
  const raw = typeof url === "string" ? url : (
    url && typeof url === "object" && typeof url.raw === "string" ? url.raw :
    url && typeof url === "object" && Array.isArray(url.path) ? "/" + url.path.join("/") : ""
  );
  const beforeQuery = raw.split(/[?#]/, 1)[0].replace(/\\+/g, "/");
  let pathname = beforeQuery;
  const match = beforeQuery.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (match) pathname = match[1] || "/";
  else pathname = pathname.replace(/^\{\{[^}]+\}\}(?=\/|$)/, "") || "/";
  const chunks = pathname.split("/");
  const normalized = chunks.map((segment, index) => (
    index > 0 && /^(token|password|secret|api[-_]?key|username)$/i.test(chunks[index - 1])
      ? "[REDACTED]" : redactSegment(segment)
  )).join("/");
  return (normalized.startsWith("/") ? normalized : "/" + normalized).slice(0, 500);
}

function methodName(request) {
  return String(request && request.method || "GET").toUpperCase().slice(0, 12);
}

function authType(request, fallback) {
  const auth = request && request.auth;
  if (auth && typeof auth.type === "string") return auth.type.slice(0, 40);
  return fallback || "inherited/unspecified";
}

function headerNames(request) {
  return (Array.isArray(request && request.header) ? request.header : [])
    .filter((h) => h && typeof h.key === "string")
    .map((h) => h.key.slice(0, 100)).slice(0, 60);
}

function explicitHost(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/^https?:\/\/([^/?#]+)/i);
  if (!match) return null;
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), secure: url.protocol === "https:", hasCredentials: Boolean(url.username || url.password) };
  } catch {
    return { host: "invalid-url", secure: false, hasCredentials: true };
  }
}

function flatten(items, inheritedAuth, result) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.item)) {
      flatten(item.item, authType(item, inheritedAuth), result);
      continue;
    }
    const request = typeof item.request === "object" ? item.request : null;
    if (!request) continue;
    const raw = request.url && typeof request.url === "object" ? request.url.raw : request.url;
    const path = sanitizedPath(request.url);
    const method = methodName(request);
    const key = SIGNATURES.find(([, pattern]) => pattern.test(String(item.name || "") + " " + path));
    const host = explicitHost(raw);
    const urlSafety = host && (!host.secure || host.host !== EXPECTED_HOST || host.hasCredentials)
      ? "REQUIRES_HOST_REVIEW" : host ? "EXPECTED_HOST" : "VARIABLE_HOST_REQUIRES_REVIEW";
    result.push({
      index: result.length + 1,
      method,
      path,
      operation_hint: key ? key[0] : "unclassified",
      auth: authType(request, inheritedAuth),
      header_names: headerNames(request),
      url_review: urlSafety,
    });
  }
}

export function auditCollection(collection) {
  if (!collection || typeof collection !== "object" || !Array.isArray(collection.item)) {
    throw new Error("Expected a Postman Collection JSON object with an item array");
  }
  if (collection.item.length > 2500) throw new Error("Collection exceeds review limit");
  const endpoints = [];
  flatten(collection.item, authType(collection, null), endpoints);
  if (endpoints.length > 2500) throw new Error("Collection exceeds review limit");
  const present = new Set(endpoints.map((e) => e.operation_hint));
  const unresolved = REQUIRED.filter((name) => !present.has(name));
  const unsafeHostCount = endpoints.filter((e) => e.url_review !== "EXPECTED_HOST").length;
  return {
    source: "offline_postman_collection",
    vendor: "Arvent/kolayCAR",
    verified_connection: false,
    request_count: endpoints.length,
    operation_hints_unverified: [...present].sort(),
    missing_required_operations: unresolved,
    requests_requiring_host_review: unsafeHostCount,
    all_required_operation_hints_found: unresolved.length === 0,
    ready_for_implementation: false,
    requires_manual_contract_verification: true,
    // A clean inventory is NOT permission to call booking or cancellation endpoints.
    live_booking_tests_allowed: false,
    endpoints,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const filename = process.argv[2];
  if (!filename) {
    console.error("Usage: node tools/arvent-postman-audit.mjs <collection-export.json>");
    process.exitCode = 2;
  } else {
    try {
      const json = JSON.parse(await readFile(filename, "utf8"));
      const report = auditCollection(json);
      console.log(JSON.stringify(report, null, 2));
      if (!report.all_required_operation_hints_found || report.requests_requiring_host_review > 0) process.exitCode = 2;
    } catch (error) {
      console.error("Postman collection audit failed: " + (error instanceof Error ? error.message : "unknown error"));
      process.exitCode = 2;
    }
  }
}
