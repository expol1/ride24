import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { paymentReturnBridgeUrl } from "../_shared/payment-return.mjs";

serve((req: Request) => {
  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("METHOD_NOT_ALLOWED", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  }
  try {
    return new Response(null, { status: 302, headers: { ...headers, Location: paymentReturnBridgeUrl(req.url) } });
  } catch {
    return new Response("Open Ride24 and check your bookings. / Otwórz Ride24 i sprawdź rezerwacje.", {
      status: 400, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});
