import Stripe from "npm:stripe@14.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyApiPayment } from "../_shared/api-payment-flow.mjs";
import { runApiPayment } from "../_shared/api-payment-runtime.ts";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"), {
  apiVersion: "2023-10-16"
});
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Keep late payments for manual reconciliation; never reactivate or refund here.
async function cancelledPayment(bookingId, session, eventId) {
  const reviewStatus = `payment_after_cancellation:${session.id}`;
  const { data: review, error: readError } = await supabase
    .from("booking_review_queue").select("id")
    .eq("booking_id", bookingId).eq("provider_key", "stripe")
    .eq("provider_status", reviewStatus).limit(1).maybeSingle();
  if (readError) return new Response("Review lookup failed", { status: 500 });
  if (!review) {
    const { error } = await supabase.from("booking_review_queue").insert({
      booking_id: bookingId,
      provider_key: "stripe",
      provider_status: reviewStatus,
      api_response: JSON.stringify({ event_id: eventId, session_id: session.id,
        payment_intent: session.payment_intent, amount_total: session.amount_total,
        currency: session.currency, payment_status: session.payment_status }),
      resolved: false
    });
    if (error) return new Response("Review write failed", { status: 500 });
  }
  const { error } = await supabase.from("bookings")
    .update({ manual_review: true }).eq("id", bookingId);
  if (error) return new Response("Review flag failed", { status: 500 });
  console.warn("PAYMENT_AFTER_CANCELLATION_MANUAL_REVIEW", bookingId, session.id);
  return new Response("OK - Cancelled booking retained; manual review", { status: 200 });
}
Deno.serve(async (req)=>{
  const sig = req.headers.get("stripe-signature") || req.headers.get("Stripe-Signature");
  if (!sig) {
    console.error("❌ NO SIGNATURE");
    return new Response("No signature", {
      status: 400
    });
  }
  const body = await req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET"));
  } catch (err) {
    console.error("❌ SIGNATURE ERROR:", err.message);
    return new Response("Invalid signature", {
      status: 400
    });
  }
  if (['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)) {
    const notified=event.data.object;
    const id=notified.metadata?.booking_id||notified.client_reference_id;
    if(id) {
      const {data:b,error}=await supabase.from('bookings').select('id,client_id,provider_type,online_payment_pln,stripe_session_id,status,cancelled_at').eq('id',id).maybeSingle();
      if(error||!b)return new Response('Booking lookup failed',{status:500});
      if(b.provider_type==='api') {
        try {
          // Signed event plus server retrieval; browser redirect is never consulted.
          const session=await stripe.checkout.sessions.retrieve(notified.id);
          if(session.payment_status!=='paid') {
            if(session.id!==b.stripe_session_id||session.metadata?.booking_id!==b.id||session.metadata?.client_id!==b.client_id)
              return new Response('API payment binding mismatch',{status:400});
            const {error:unpaidError}=await supabase.rpc('api_record_unpaid_session',{
              p_booking_id:id,p_session_id:session.id,p_expired:session.status==='expired'});
            return new Response(unpaidError?'Payment state write failed':'API payment not completed',{status:unpaidError?500:200});
          }
          const verified=verifyApiPayment(b,session,!!Deno.env.get('STRIPE_SECRET_KEY')?.startsWith('sk_live_'));
          const {error:recordError}=await supabase.rpc('api_record_verified_payment',{
            p_booking_id:id,p_session_id:verified.session_id,p_intent:verified.payment_intent,
            p_event_id:event.id,p_amount:verified.event_amount,p_currency:verified.currency});
          if(recordError)return new Response('Payment record failed',{status:500});
          // Durable state is committed before contacting the provider. Cron can resume it.
          try {await runApiPayment(supabase,stripe,id);}catch {console.error('API_PAYMENT_FULFILLMENT_RETRY',id);}
          return new Response('API payment recorded',{status:200});
        }catch {return new Response('API payment verification failed',{status:500});}
      }
    }
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata?.booking_id || session.client_reference_id;
    if (!bookingId) {
      console.error("❌ NO BOOKING ID");
      return new Response("No booking_id", {
        status: 400
      });
    }
    console.log("💰 PAYMENT OK:", bookingId);
    // 🔒 IDEMPOTENCY
    const { data: existing, error: lookupError } = await supabase.from("bookings")
      .select("status,cancelled_at").eq("id", bookingId).maybeSingle();
    if (lookupError || !existing) return new Response("Booking lookup failed", { status: 500 });
    if (existing.status === "cancelled" || existing.cancelled_at != null) {
      return await cancelledPayment(bookingId, session, event.id);
    }
    if (existing?.status === "paid") {
      const { data: voucher } = await supabase
        .from("vouchers")
        .select("pdf_path")
        .eq("booking_id", bookingId)
        .maybeSingle();

      if (!voucher?.pdf_path) {
        const retryResponse = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-voucher`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "x-internal-secret": Deno.env.get("RIDE24_INTERNAL_SECRET") ?? ""
            },
            body: JSON.stringify({ booking_id: bookingId })
          }
        );

        if (!retryResponse.ok) {
          const retryError = await retryResponse.text();
          console.error(`VOUCHER RETRY ERROR (${retryResponse.status}):`, retryError);
          return new Response("Voucher retry failed", { status: 500 });
        }

        console.log("VOUCHER RETRY OK:", bookingId);
      }

      console.log("DUPLICATE - already paid:", bookingId);
      return new Response("OK - Already paid", { status: 200 });
    }
    // ==========================================
    // 🔥 1. UPDATE BOOKING
    // ==========================================
    const { data: updated, error: updateError } = await supabase.from("bookings").update({
      status: "paid"
    }).eq("id", bookingId).eq("status", existing.status)
      .neq("status", "cancelled").is("cancelled_at", null).select("id");
    if (updateError) {
      console.error("❌ UPDATE ERROR:", updateError.message);
      return new Response("DB error", {
        status: 500
      });
    }
    // The UPDATE predicate is checked by Postgres, including concurrent cancellations.
    if (!updated?.length) {
      const { data: current, error } = await supabase.from("bookings")
        .select("status,cancelled_at").eq("id", bookingId).maybeSingle();
      if (!error && current && (current.status === "cancelled" || current.cancelled_at != null)) {
        return await cancelledPayment(bookingId, session, event.id);
      }
      // Retry through the normal idempotency path if another request changed status.
      return new Response("Booking changed; retry", { status: 500 });
    }
    // ==========================================
    // 🔥 2. INSERT PAYMENT
    // ==========================================
    const { error: insertError } = await supabase.from("payments").insert({
      booking_id: bookingId,
      stripe_session_id: session.id,
      amount: session.amount_total ? session.amount_total / 100 : null,
      currency: session.currency || "pln",
      status: "paid"
    });
    if (insertError) {
      console.error("❌ INSERT ERROR:", insertError.message);
    }
    // ==========================================
    // 🔥 3. INSERT VOUCHER (NIE RUSZAMY)
    // ==========================================
    const { error: voucherError } = await supabase.from("vouchers").insert({
      booking_id: bookingId,
      status: "pending"
    });
    if (voucherError && !voucherError.message.includes("unique_booking_id")) {
      console.error("❌ VOUCHER ERROR:", voucherError.message);
    }
    // ==========================================
    // 🔥 4. GENERATE VOUCHER (ZOSTAJE)
    // ==========================================
    console.log("🚀 Triggering generate-voucher...");
    try {
      const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-voucher`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "x-internal-secret": Deno.env.get("RIDE24_INTERNAL_SECRET") ?? ""
        },
        body: JSON.stringify({
          booking_id: bookingId
        })
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ VOUCHER FETCH ERROR (${response.status}):`, errText);
      } else {
        console.log("🎫 VOUCHER GENERATION TRIGGERED");
      }
    } catch (err) {
      console.error("❌ VOUCHER NETWORK ERROR:", err.message);
    }
    // ==========================================
    // 🔥 5. EMAIL QUEUE (ZAWSZE)
    // ==========================================
    const { error: emailError } = await supabase.from("email_logs").insert([
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
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email-worker`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({}) // Dodajemy puste body dla stabilności POST-a
    }).then(()=>console.log("📨 Worker triggered successfully")).catch((err)=>console.error("❌ WORKER TRIGGER ERROR:", err));
    console.log("✅ FLOW COMPLETE");
  }
  return new Response("OK", {
    status: 200
  });
});
