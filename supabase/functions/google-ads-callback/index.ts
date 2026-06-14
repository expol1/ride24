import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  const url = new URL(req.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  return new Response(
    JSON.stringify({
      success: true,
      code,
      state
    }),
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
});