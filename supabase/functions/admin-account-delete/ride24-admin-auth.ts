function secretsEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] || 0) ^ (y[i] || 0);
  return difference === 0;
}

export async function ride24RequireAdmin(req: Request, responseHeaders: Record<string, string> = {}): Promise<Response | null> {
  const failure = (status: number, error: string) => new Response(JSON.stringify({ error }), {
    status, headers: { ...responseHeaders, "Content-Type": "application/json" },
  });
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return failure(401, "AUTH_REQUIRED");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const baseUrl = Deno.env.get("SUPABASE_URL");
  if (!serviceKey || !baseUrl) return failure(503, "AUTH_CONFIGURATION_MISSING");
  if (secretsEqual(token, serviceKey)) return null;
  try {
    const userResponse = await fetch(baseUrl + "/auth/v1/user", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!userResponse.ok) return failure(userResponse.status >= 500 ? 503 : 401, "AUTH_FAILED");
    const user = await userResponse.json();
    if (typeof user.id !== "string" || !user.id) return failure(401, "AUTH_FAILED");
    const headers: Record<string, string> = { apikey: serviceKey };
    if (!serviceKey.startsWith("sb_secret_")) headers.Authorization = "Bearer " + serviceKey;
    const query = new URLSearchParams({ select: "role", id: "eq." + user.id, limit: "1" });
    const profileResponse = await fetch(baseUrl + "/rest/v1/profiles?" + query, {
      headers, signal: AbortSignal.timeout(5000),
    });
    if (!profileResponse.ok) return failure(503, "AUTH_FAILED");
    const profiles = await profileResponse.json();
    if (!Array.isArray(profiles) || profiles[0]?.role !== "admin") return failure(403, "ADMIN_REQUIRED");
    return null;
  } catch {
    return failure(503, "AUTH_FAILED");
  }
}

export function ride24RequireInternal(req: Request): Response | null {
  const secret = Deno.env.get("RIDE24_INTERNAL_SECRET");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (secretsEqual(req.headers.get("x-internal-secret"), secret) || secretsEqual(token, serviceKey)) return null;
  return new Response(JSON.stringify({ error: "INTERNAL_AUTH_REQUIRED" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

