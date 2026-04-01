import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@14?target=deno"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
})

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  // 🔥 CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const { booking_id, amount } = await req.json()

    console.log("💰 PAYMENT REQUEST:", booking_id, amount)

    // 🔥 WALIDACJA
    if (!booking_id || !amount || amount <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid booking_id or amount" }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
          status: 400,
        }
      )
    }

    // 🔥 STATUS → awaiting_payment (NOWE, BEZPIECZNE)
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${booking_id}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "awaiting_payment",
      }),
    })

    // 🔥 STRIPE SESSION
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "pln",
            product_data: {
  name: "Ride24 – Auta z różnych zakątków świata",
  description: `Rezerwacja: ${booking_id}`,
},
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],

      metadata: {
        booking_id: booking_id,
      },

      client_reference_id: booking_id,

      success_url: "https://ride24.pl/klient.html?payment=success",
      cancel_url: "https://ride24.pl/klient.html?payment=cancel",
    })

    console.log("✅ STRIPE URL:", session.url)

    return new Response(
      JSON.stringify({ url: session.url }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        status: 200,
      }
    )

  } catch (error) {
    console.error("❌ ERROR:", error)

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        status: 500,
      }
    )
  }
})