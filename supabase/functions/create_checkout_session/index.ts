// Ride24 — bezpieczny zamiennik istniejącej funkcji create_checkout_session.
// Kompatybilny z web i Android: przyjmuje booking_id oraz opcjonalne amount,
// ale wiążącą kwotę zawsze pobiera z bazy po weryfikacji właściciela rezerwacji.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

const cors = (req: Request) => ({
  "Access-Control-Allow-Origin": req.headers.get("origin") === "https://ride24.pl" ? "https://ride24.pl" : "https://ride24.pl",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), { status: 401, headers: cors(req) });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), { status: 401, headers: cors(req) });

    const body = await req.json().catch(() => ({}));
    const bookingId = typeof body.booking_id === "string" ? body.booking_id : "";
    const client = typeof body.client === "string" ? body.client.toLowerCase() : "web";
    if (!bookingId) return new Response(JSON.stringify({ error: "INVALID_BOOKING" }), { status: 400, headers: cors(req) });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: booking, error } = await admin.from("bookings")
      .select("id,client_id,status,online_payment_pln,reservation_code,payment_deadline")
      .eq("id", bookingId).maybeSingle();
    if (error || !booking) return new Response(JSON.stringify({ error: "BOOKING_NOT_FOUND" }), { status: 404, headers: cors(req) });
    if (booking.client_id !== user.id) return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: cors(req) });
    if (!["accepted", "awaiting_payment"].includes(booking.status)) return new Response(JSON.stringify({ error: "PAYMENT_NOT_ALLOWED" }), { status: 409, headers: cors(req) });

    const amount = Number(booking.online_payment_pln || 0);
    if (!Number.isFinite(amount) || amount <= 0) return new Response(JSON.stringify({ error: "INVALID_AMOUNT" }), { status: 409, headers: cors(req) });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "pln",
          product_data: {
            name: "Ride24 – Auta z różnych zakątków świata",
            description: `Rezerwacja: ${booking.reservation_code || booking.id}`,
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      metadata: { booking_id: booking.id, client_id: user.id },
      client_reference_id: booking.id,
      success_url: client === "android"
        ? `${SUPABASE_URL}/functions/v1/payment-return?status=success&booking_id=${encodeURIComponent(booking.id)}&session_id={CHECKOUT_SESSION_ID}`
        : "https://ride24.pl/klient.html?payment=success",
      cancel_url: client === "android"
        ? `${SUPABASE_URL}/functions/v1/payment-return?status=cancel&booking_id=${encodeURIComponent(booking.id)}`
        : "https://ride24.pl/klient.html?payment=cancel",
    });

    await admin.from("bookings").update({ status: "awaiting_payment", stripe_session_id: session.id }).eq("id", booking.id);
    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: cors(req) });
  } catch (e) {
    console.error("create_checkout_session secure", e);
    return new Response(JSON.stringify({ error: "PAYMENT_SESSION_FAILED" }), { status: 500, headers: cors(req) });
  }
});
