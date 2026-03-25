import Stripe from "npm:stripe@14.25.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string);

Deno.serve(async (req) => {
  try {
    const { amount } = await req.json();

    if (!amount) {
      return new Response("Brak kwoty", { status: 400 });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "pln",
            product_data: {
              name: "Opłata rezerwacyjna Ride24",
            },
            unit_amount: amount, // np. 5000 = 50 zł
          },
          quantity: 1,
        },
      ],

      success_url: "http://localhost:5500/success.html",
      cancel_url: "http://localhost:5500/cancel.html",
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return new Response("Błąd serwera", { status: 500 });
  }
});