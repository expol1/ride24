import { ride24RequireAdmin } from "./ride24-admin-auth.ts";

// X / Twitter publishing deliberately retired: the API requires a paid plan.
// This endpoint is kept to return a clear, safe response to old callers.
// It never contacts X, reads connection tokens, or changes stored posts.
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorizationFailure = await ride24RequireAdmin(req, corsHeaders);
  if (authorizationFailure) return authorizationFailure;
  return new Response(
    JSON.stringify({
      success: false,
      code: "X_PUBLISHING_DISABLED",
      error: "Publikowanie na X (Twitter) zostało wyłączone w Ride24. Social Media AI publikuje tylko na Facebooku.",
    }),
    { status: 410, headers: corsHeaders },
  );
});
