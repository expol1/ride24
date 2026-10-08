import { ride24RequireAdmin } from "./ride24-admin-auth.ts";
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
  const authorizationFailure = await ride24RequireAdmin(req);
  if (authorizationFailure) return authorizationFailure;

  try {
    const { transaction_id, amount } = await req.json();

    if (!transaction_id || !amount) {
      return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
    }

    // 🔥 Pobieramy transakcję
    const { data: tx } = await supabase
      .from("transactions")
      .select("booking_id")
      .eq("id", transaction_id)
      .single();

    if (!tx) throw new Error("Transaction not found");

    // 🔥 Pobieramy booking
    const { data: booking } = await supabase
      .from("bookings")
      .select("stripe_session_id, online_payment_pln")
      .eq("id", tx.booking_id)
      .single();

    if (!booking) throw new Error("Booking not found");

    if (!booking.stripe_session_id) {
      throw new Error("No Stripe session");
    }

    // 🔥 TWORZYMY REFUND
    const refund = await stripe.refunds.create({
      payment_intent: booking.stripe_session_id,
      amount: Math.round(amount * 100), // grosze
    });

    return new Response(JSON.stringify({ success: true, refund }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
