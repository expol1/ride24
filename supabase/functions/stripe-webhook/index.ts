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
  // 🔥 HEADER (case-safe)
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
    // 🔥 FIX dla Deno
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET") as string
    );
  } catch (err: any) {
    console.error("❌ SIGNATURE ERROR:", err.message);
    return new Response("Invalid signature", { status: 400 });
  }

  // 🔥 OBSŁUGA PŁATNOŚCI
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    console.log("📦 SESSION:", session);

    const bookingId =
      session.metadata?.booking_id || session.client_reference_id;

    if (!bookingId) {
      console.error("❌ NO BOOKING ID");
      return new Response("No booking_id", { status: 400 });
    }

    console.log("💰 PAYMENT OK:", bookingId);

    // 🔥 SPRAWDŹ CZY JUŻ OPŁACONE (idempotency)
    const { data: existing, error: fetchError } = await supabase
      .from("bookings")
      .select("status")
      .eq("id", bookingId)
      .single();

    if (fetchError) {
      console.error("❌ FETCH ERROR:", fetchError.message);
      return new Response("DB error", { status: 500 });
    }

    if (existing?.status === "paid") {
      console.log("⚠️ DUPLIKAT — już opłacone:", bookingId);
      return new Response("OK - Already paid", { status: 200 });
    }

    // 🔥 1. UPDATE BOOKING
    const { error: updateError } = await supabase
      .from("bookings")
      .update({ status: "paid" })
      .eq("id", bookingId);

    if (updateError) {
      console.error("❌ UPDATE ERROR:", updateError.message);
      return new Response("DB error", { status: 500 });
    }

    // 🔥 2. INSERT PAYMENT
    const { error: insertError } = await supabase
      .from("payments")
      .insert({
        booking_id: bookingId,
        stripe_session_id: session.id,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || "pln",
        status: "paid",
      });

    if (insertError) {
      console.error("❌ INSERT ERROR:", insertError.message);
    }

    // 🔥 3. INSERT VOUCHER (To rozwiąże problem z pustą tabelą!)
    const { error: voucherError } = await supabase
  .from("vouchers")
  .insert({
    booking_id: bookingId,
    status: "pending" 
  });

    if (voucherError && !voucherError.message.includes("unique_booking_id")) {
  console.error("❌ VOUCHER ERROR:", voucherError.message);
}

    /* 🔥 OPCJONALNIE: ZAPIS DO TABELI TRANSACTIONS (odkomentuj jeśli potrzebujesz)
    await supabase.from("transaction").insert({
        booking_id: bookingId,
        type: "payment",
        amount: (session.amount_total || 0) / 100
    });
    */

    console.log("✅ SAVED TO DB (Booking, Payment, Voucher)");
  }

  return new Response("OK", { status: 200 });
});