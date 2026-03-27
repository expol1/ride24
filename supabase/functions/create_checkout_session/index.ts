import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  // 🔥 CORS preflight (MUSI BYĆ)
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    // 🔥 Odbieramy dane z frontu
    const { booking_id, amount } = await req.json()

    console.log("💰 PAYMENT REQUEST:", booking_id, amount)

    // 🔥 WALIDACJA (ważne!)
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

    // 🔥 TU DOCZELOWO BĘDZIE STRIPE
    // Na razie testowy redirect:
    const fakeStripeUrl = "https://checkout.stripe.com/test"

    console.log("➡️ RETURN URL:", fakeStripeUrl)

    return new Response(
      JSON.stringify({ url: fakeStripeUrl }),
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