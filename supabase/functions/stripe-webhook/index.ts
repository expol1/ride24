import Stripe from "npm:stripe@14.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") as string,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
);

Deno.serve(async (req) => {
  // 🔥 HEADER (case safe)
  const sig =
    req.headers.get("stripe-signature") ||
    req.headers.get("Stripe-Signature");

  if (!sig) {
    console.error("❌ NO SIGNATURE");
    return new Response("No signature", { status: 400 });
  }

  // 🔥 RAW BODY (KLUCZOWE)
  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET") as string
    );
  } catch (err: any) {
    console.error("❌ SIGNATURE ERROR:", err.message);
    return new Response("Invalid signature", { status: 400 });
  }

  // 🔥 OBSŁUGA
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    const bookingId =
      session.metadata?.booking_id || session.client_reference_id;

    if (!bookingId) {
      console.error("❌ NO BOOKING ID");
      return new Response("No booking_id", { status: 400 });
    }

    console.log("💰 PAYMENT OK:", bookingId);

    // 🔥 UPDATE BOOKING
    await supabase
      .from("bookings")
      .update({ status: "paid" })
      .eq("id", bookingId);

    // 🔥 INSERT PAYMENT
    await supabase.from("payments").insert({
      booking_id: bookingId,
      stripe_session_id: session.id,
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || "pln",
      status: "paid",
    });

    console.log("✅ SAVED TO DB");
  }

  return new Response("OK", { status: 200 });
});