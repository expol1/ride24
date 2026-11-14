// Ride24 — bezpieczny zamiennik istniejącej funkcji create_checkout_session.
// Kompatybilny z web i Android: przyjmuje booking_id oraz opcjonalne amount,
// ale wiążącą kwotę zawsze pobiera z bazy po weryfikacji właściciela rezerwacji.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { androidPaymentReturnUrl } from "../_shared/payment-return.mjs";
import { apiPaymentEnabled } from "../_shared/api-payment-runtime.ts";
import { hasPaidFulfillmentAdapter } from "../_shared/api-provider-fulfillment.ts";
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
      .select("id,client_id,status,online_payment_pln,reservation_code,payment_deadline,provider_type,stripe_session_id,cancelled_at,api_quote_id,partners!bookings_partner_id_fkey(api_provider)")
      .eq("id", bookingId).maybeSingle();
    if (error || !booking) return new Response(JSON.stringify({ error: "BOOKING_NOT_FOUND" }), { status: 404, headers: cors(req) });
    if (booking.client_id !== user.id) return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: cors(req) });
    if (!["accepted", "awaiting_payment"].includes(booking.status)) return new Response(JSON.stringify({ error: "PAYMENT_NOT_ALLOWED" }), { status: 409, headers: cors(req) });

    const amount = Number(booking.online_payment_pln || 0);
    if (!Number.isFinite(amount) || amount <= 0) return new Response(JSON.stringify({ error: "INVALID_AMOUNT" }), { status: 409, headers: cors(req) });

    const isApi=booking.provider_type==='api';
    if(isApi) {
      if(!await apiPaymentEnabled(admin)||!hasPaidFulfillmentAdapter(booking.partners?.api_provider))
        return new Response(JSON.stringify({error:'API_PAYMENT_FLOW_PAUSED'}),{status:503,headers:cors(req)});
      if(booking.cancelled_at||!booking.payment_deadline||Date.parse(booking.payment_deadline)<=Date.now())
        return new Response(JSON.stringify({error:'PAYMENT_DEADLINE_EXPIRED'}),{status:409,headers:cors(req)});
      const {data:w,error:we}=await admin.from('api_booking_workflows').select('paid_at,state').eq('booking_id',booking.id).maybeSingle();
      if(we||w?.paid_at||(w&&!['awaiting_payment'].includes(w.state)))
        return new Response(JSON.stringify({error:'PAYMENT_NOT_ALLOWED'}),{status:409,headers:cors(req)});
      if(booking.stripe_session_id) {
        const old=await stripe.checkout.sessions.retrieve(booking.stripe_session_id);
        if(old.status==='open'&&old.amount_total===Math.round(amount*100)&&old.currency==='pln')
          return new Response(JSON.stringify({url:old.url}),{status:200,headers:cors(req)});
        return new Response(JSON.stringify({error:'PAYMENT_ALREADY_STARTED_OR_EXPIRED'}),{status:409,headers:cors(req)});
      }
      const {data:q,error:qe}=await admin.from('api_quotes').select('raw_response,booking_id,expires_at').eq('id',booking.api_quote_id).maybeSingle();
      if(q?.expires_at&&Date.parse(q.expires_at)<=Date.now())return new Response(JSON.stringify({error:'QUOTE_EXPIRED'}),{status:409,headers:cors(req)});
      if(Date.parse(booking.payment_deadline)-Date.now()<30*60*1000)return new Response(JSON.stringify({error:'PAYMENT_DEADLINE_TOO_CLOSE'}),{status:409,headers:cors(req)});
      if(qe||q?.booking_id!==booking.id||!q?.raw_response?.ride24_options||!q?.raw_response?.provider_quote_data?.calculated)
        return new Response(JSON.stringify({error:'ACCEPTED_QUOTE_REQUIRED'}),{status:409,headers:cors(req)});
    }

    const session = await stripe.checkout.sessions.create({
      ...(isApi?{expires_at:Math.floor(Date.parse(booking.payment_deadline)/1000)}:{}),
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
        ? androidPaymentReturnUrl(SUPABASE_URL, booking.id, "success", body.return_app, body.language)
        : "https://ride24.pl/klient.html?payment=success",
      cancel_url: client === "android"
        ? androidPaymentReturnUrl(SUPABASE_URL, booking.id, "cancel", body.return_app, body.language)
        : "https://ride24.pl/klient.html?payment=cancel",
    },isApi?{idempotencyKey:'ride24-api-checkout:'+booking.id}:undefined);

    if(isApi) {
      const {data:saved,error:saveError}=await admin.from("bookings").update({status:"awaiting_payment",stripe_session_id:session.id,
        stripe_amount_cents:Math.round(amount*100),stripe_currency:'pln',stripe_checkout_created_at:new Date().toISOString()
      }).eq('id',booking.id).eq('status',booking.status).is('cancelled_at',null).select('id');
      if(saveError||!saved?.length)throw Error('PAYMENT_SESSION_NOT_BOUND');
    } else {
      const {error}=await admin.from('bookings').update({status:'awaiting_payment',stripe_session_id:session.id}).eq('id',booking.id);
      if(error)throw Error('PAYMENT_SESSION_NOT_BOUND');
    }
    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: cors(req) });
  } catch (e) {
    console.error("create_checkout_session secure", e);
    return new Response(JSON.stringify({ error: "PAYMENT_SESSION_FAILED" }), { status: 500, headers: cors(req) });
  }
});
