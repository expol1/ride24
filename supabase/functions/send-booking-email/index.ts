import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Obsługa CORS dla frontendu
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const booking_id = body.booking_id || body.record?.id || body.id;

    if (!booking_id) {
      throw new Error("Brak booking_id");
    }

    const supabase = createClient(
      SUPABASE_URL!,
      SUPABASE_SERVICE_ROLE_KEY!
    );

    // 🔥 1. TYLKO DODAJEMY DO KOLEJKI (Email Worker zajmie się resztą)
    console.log(`Queuing booking_confirmation for: ${booking_id}`);
    
    const { error: queueError } = await supabase
      .from("email_logs")
      .insert({
        booking_id: booking_id,
        type: "booking_confirmation",
        status: "queued"
      });

    if (queueError) {
      throw new Error(`Queue Error: ${queueError.message}`);
    }

    // 🔥 2. KOPNIAK DLA WORKERA (Wysyłka natychmiastowa)
    // Nie używamy await, żeby funkcja odpowiedziała błyskawicznie
    fetch(`${SUPABASE_URL}/functions/v1/email-worker`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    }).catch(err => console.error("Worker trigger failed:", err));

    return new Response(
      JSON.stringify({ success: true, message: "Email queued and worker triggered" }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      }
    );

  } catch (error: any) {
    console.error("SEND BOOKING EMAIL ERROR:", error.message);

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      }
    );
  }
});