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
  const sig = req.headers.get("stripe-signature") || req.headers.get("Stripe-Signature");
  if (!sig) return new Response("No signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET") as string
    );
  } catch (err: any) {
    console.error("❌ Stripe Signature Error:", err.message);
    return new Response(`Signature Error: ${err.message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.booking_id || session.client_reference_id;

    if (!bookingId) return new Response("No booking_id", { status: 400 });

    console.log("💰 Płatność zaakceptowana. Przetwarzam:", bookingId);

    // 1. Przygotuj rekord vouchera (miejsce na dane PDF)
    await supabase.from("vouchers").upsert({ 
      booking_id: bookingId, 
      status: "pending" 
    }, { onConflict: 'booking_id' });

    // 2. Zapisz płatność
    await supabase.from("payments").insert({
      booking_id: bookingId,
      stripe_session_id: session.id,
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || "pln",
      status: "paid",
    });

    // 3. Zaktualizuj status rezerwacji na 'paid'
    await supabase.from("bookings").update({ status: "paid" }).eq("id", bookingId);

    // 🔥 4. BEZPOŚREDNIE WYWOŁANIE GENERATORA (Z await dla pewności logów)
    console.log("🚀 Wysyłam żądanie do generate-voucher...");
    
    try {
      const res = await fetch(
        "https://zwyerdeuvyzgkgwglowr.supabase.co/functions/v1/generate-voucher",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ booking_id: bookingId })
        }
      );

      console.log("🎫 FETCH STATUS:", res.status);
      
      if (!res.ok) {
          const errorText = await res.text();
          console.error("❌ Generator zwrócił błąd:", errorText);
      }
    } catch (err) {
      console.error("❌ KRYTYCZNY BŁĄD FETCH:", err);
    }

    console.log("✅ Proces Webhooka zakończony.");
  }

  return new Response("OK", { status: 200 });
});