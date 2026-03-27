import Stripe from "npm:stripe@14.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return new Response("No signature", { status: 400 });
  }

  const body = await req.text();

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const bookingId =
      session.metadata?.booking_id || session.client_reference_id;

    if (!bookingId) {
      return new Response("No booking_id", { status: 400 });
    }

    await supabase
      .from("bookings")
      .update({ status: "paid" })
      .eq("id", bookingId);

    await supabase.from("payments").insert({
      booking_id: bookingId,
      stripe_session_id: session.id,
      amount: session.amount_total / 100,
      currency: "pln",
      status: "paid",
    });
  }

  return new Response("OK");
});