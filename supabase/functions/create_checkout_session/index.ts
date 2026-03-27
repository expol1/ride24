import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@14?target=deno"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
})

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
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
    if (!booking_id || !amount) {
      return new Response(
        JSON.stringify({ error: "Missing booking_id or amount" }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
          status: 400,
        }
      )
    }

    // 🔥 STRIPE SESSION
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "pln",
            product_data: {
              name: `Booking ${booking_id}`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],

      // 🔥 WAŻNE — przekazujemy booking_id dalej
      metadata: {
        booking_id: booking_id,
      },

      success_url: "https://ride24.pl/panel.html?payment=success",
      cancel_url: "https://ride24.pl/panel.html?payment=cancel",
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