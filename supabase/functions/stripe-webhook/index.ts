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
  const sig = req.headers.get("stripe-signature")!;
  const body = await req.text();

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("❌ Signature error:", err.message);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const bookingId = session.metadata?.booking_id;

    if (!bookingId) {
      console.error("❌ Brak booking_id");
      return new Response("No booking_id", { status: 400 });
    }

    console.log("💰 PAYMENT OK:", bookingId);

    // 1. Sprawdź czy już było
    const { data: booking } = await supabase
      .from("bookings")
      .select("status")
      .eq("id", bookingId)
      .single();

    if (!booking || booking.status === "paid") {
      console.log("⚠️ Już przetworzone");
      return new Response("OK");
    }

    // 2. Ustaw status PAID
    await supabase
      .from("bookings")
      .update({ status: "paid" })
      .eq("id", bookingId);

    // 3. Pobierz usera
    const { data: bookingUser } = await supabase
      .from("bookings")
      .select("client_id")
      .eq("id", bookingId)
      .single();

    // 4. Loyalty
    if (bookingUser?.client_id) {
      await supabase.rpc("increment_loyalty_and_update_level", {
        target_user_id: bookingUser.client_id,
      });
    }

    // 5. Voucher
    await fetch(
      "https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/generate-voucher",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ booking_id: bookingId }),
      }
    );

    console.log("✅ DONE:", bookingId);
  }

  return new Response("OK");
});