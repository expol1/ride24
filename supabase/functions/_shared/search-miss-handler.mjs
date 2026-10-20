const ORIGINS = new Set(["https://ride24.pl", "https://www.ride24.pl"]);
export function normalizeSearchMiss(value) {
  if (typeof value !== "string") return null;
  const query = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (query.length < 3 || query.length > 80 || !/\p{L}/u.test(query) ||
      /[@<>]|:\/\/|\d{6}/u.test(query)) return null;
  return query;
}

export function makeSearchMissHandler({ url, serviceKey, internalSecret, publicKeys, fetchImpl = fetch }) {
  return async request => {
    const origin = request.headers.get("origin");
    const headers = {
      "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://ride24.pl",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"
    };
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !ORIGINS.has(origin)) return response({ error: "ORIGIN_NOT_ALLOWED" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);
    // Public client identification is deliberate: anonymous visitors search too.
    // The gateway's JWT check is disabled for publishable keys. Database writes
    // remain service-only, behind validation, rate limits and a real no-match check.
    if (!publicKeys.filter(Boolean).includes(request.headers.get("apikey"))) return response({ error: "INVALID_API_KEY" }, 401);
    if (!url || !serviceKey || !internalSecret) return response({ error: "UNAVAILABLE" }, 503);
    try {
      if (Number(request.headers.get("content-length") || 0) > 1024) return response({ error: "INVALID_QUERY" }, 400);
      const raw = await request.text();
      if (raw.length > 1024) return response({ error: "INVALID_QUERY" }, 400);
      let body;
      try { body = JSON.parse(raw); } catch (_) { return response({ error: "INVALID_QUERY" }, 400); }
      const query = normalizeSearchMiss(body && body.query);
      if (!query) return response({ error: "INVALID_QUERY" }, 400);
      const rest = async (path, { params, method = "GET", body: data } = {}) => {
        const target = new URL("/rest/v1/" + path, url);
        Object.entries(params || {}).forEach(([key, value]) => target.searchParams.set(key, String(value)));
        const result = await fetchImpl(target, {
          method,
          headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey,
            "Content-Type": "application/json", Prefer: "return=minimal" },
          body: data === undefined ? undefined : JSON.stringify(data),
          signal: AbortSignal.timeout(6000)
        });
        if (!result.ok) throw new Error("DATABASE_UNAVAILABLE");
        return result.status === 204 || path === "search_logs" ? null : result.json();
      };
      const ip = request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode("search-miss|" + ip + "|" + internalSecret)));
      const rateKey = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      const allowed = await rest("rpc/consume_rate_limit", { method: "POST",
        body: { p_scope: "search-miss", p_key: rateKey, p_limit: 30, p_window_seconds: 3600 } });
      if (allowed !== true) return response({ error: "RATE_LIMITED" }, 429);
      const pattern = value => JSON.stringify("%" + value + "%");
      const matches = await rest("locations_dictionary", { params: {
        select: "name_en,name_pl,keywords", limit: 200,
        or: "(" + ["name_en", "name_pl", "keywords"].map(field => field + ".ilike." + pattern(query)).join(",") + ")"
      } });
      const terms = [...new Set([query, ...(matches || []).flatMap(row =>
        [row.name_en, row.name_pl, ...String(row.keywords || "").split(",")])]
        .map(value => String(value || "").trim().toLowerCase()).filter(Boolean))];
      // Do not create false spelling logs from oversized/ambiguous filter sets.
      if (terms.length > 120) return response({ logged: false, reason: "AMBIGUOUS_QUERY" });
      const found = await rest("partner_locations", { params: {
        select: "id", active: "eq.true", limit: 1,
        or: "(" + terms.flatMap(term => ["location_name", "city", "region", "country"]
          .map(field => field + ".ilike." + pattern(term))).join(",") + ")"
      } });
      if (found && found.length) return response({ logged: false, reason: "LOCATION_EXISTS" });
      await rest("search_logs", { method: "POST", body: { query } });
      return response({ logged: true }, 202);
    } catch (_) {
      return response({ error: "UNAVAILABLE" }, 503);
    }
  };
}
