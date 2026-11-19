// Caravel sandbox live audit CLOSED on 2026-11-18 after the HMAC self-test,
// live E2E and hosted certification run 15adba20-a018-4398-b460-4e335e846059.
// Reads no secret, calls nothing. Redeploy the reviewed source deliberately if a re-run is needed.
Deno.serve(() => new Response(JSON.stringify({error: "AUDIT_CLOSED"}), {
  status: 410, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}}));
