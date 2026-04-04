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
  const sig =
    req.headers.get("stripe-signature") ||
    req.headers.get("Stripe-Signature");

  if (!sig) {
    console.error("❌ NO SIGNATURE");
    return new Response("No signature", { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET") as string
    );
  } catch (err: any) {
    console.error("❌ SIGNATURE ERROR:", err.message);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    const bookingId =
      session.metadata?.booking_id || session.client_reference_id;

    if (!bookingId) {
      console.error("❌ NO BOOKING ID");
      return new Response("No booking_id", { status: 400 });
    }

    console.log("💰 PAYMENT OK:", bookingId);

    // 🔒 IDEMPOTENCY
    const { data: existing } = await supabase
      .from("bookings")
      .select("status")
      .eq("id", bookingId)
      .maybeSingle();

    if (existing?.status === "paid") {
      console.log("⚠️ DUPLIKAT — już opłacone:", bookingId);
      return new Response("OK - Already paid", { status: 200 });
    }

    // ==========================================
    // 🔥 1. UPDATE BOOKING
    // ==========================================
    const { error: updateError } = await supabase
      .from("bookings")
      .update({ status: "paid" })
      .eq("id", bookingId);

    if (updateError) {
      console.error("❌ UPDATE ERROR:", updateError.message);
      return new Response("DB error", { status: 500 });
    }

    // ==========================================
    // 🔥 2. INSERT PAYMENT
    // ==========================================
    const { error: insertError } = await supabase
      .from("payments")
      .insert({
        booking_id: bookingId,
        stripe_session_id: session.id,
        amount: session.amount_total
  ? session.amount_total / 100
  : null,
        currency: session.currency || "pln",
        status: "paid",
      });

    if (insertError) {
      console.error("❌ INSERT ERROR:", insertError.message);
    }

    // ==========================================
    // 🔥 3. INSERT VOUCHER (NIE RUSZAMY)
    // ==========================================
    const { error: voucherError } = await supabase
      .from("vouchers")
      .insert({
        booking_id: bookingId,
        status: "pending",
      });

    if (voucherError && !voucherError.message.includes("unique_booking_id")) {
      console.error("❌ VOUCHER ERROR:", voucherError.message);
    }

    // ==========================================
    // 🔥 4. GENERATE VOUCHER (ZOSTAJE)
    // ==========================================
    console.log("🚀 Triggering generate-voucher...");

    try {
      const response = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-voucher`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`
          },
          body: JSON.stringify({ booking_id: bookingId })
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ VOUCHER FETCH ERROR (${response.status}):`, errText);
      } else {
        console.log("🎫 VOUCHER GENERATION TRIGGERED");
      }

    } catch (err: any) {
      console.error("❌ VOUCHER NETWORK ERROR:", err.message);
    }

    // ==========================================
    // 🔥 5. EMAIL QUEUE (ZAWSZE)
    // ==========================================
    const { error: emailError } = await supabase
      .from("email_logs")
      .insert([
        {
          booking_id: bookingId,
          type: "booking_confirmation",
          status: "queued"
        },
        {
          booking_id: bookingId,
          type: "partner_booking_confirmed",
          status: "queued"
        }
      ]);

    if (emailError) {
      console.error("❌ EMAIL LOG ERROR:", emailError.message);
    }

   // ==========================================
    // 🔥 6. TRIGGER WORKER (NON-BLOCKING + AUTH + BODY)
    // ==========================================
    fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/email-worker`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({}) // Dodajemy puste body dla stabilności POST-a
      }
    )
    .then(() => console.log("📨 Worker triggered successfully"))
    .catch(err => console.error("❌ WORKER TRIGGER ERROR:", err));

    console.log("✅ FLOW COMPLETE");
  }

  return new Response("OK", { status: 200 });
});