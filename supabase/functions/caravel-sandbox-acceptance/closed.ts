// Closed version of caravel-sandbox-acceptance: deploy with entrypoint
// `closed.ts` right after the sandbox tests. It reads no secret, calls nothing
// and answers 410 to every request.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(() => new Response(JSON.stringify({ error: "ACCEPTANCE_CLOSED" }), {
  status: 410,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
}));
