import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // zmienimy na ride24.pl przed produkcją
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {

    const { booking_id } = await req.json();

    if (!booking_id) {
      throw new Error("Brak booking_id");
    }

    const supabase = createClient(
      SUPABASE_URL!,
      SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select(`
        id,
        reservation_code,
        profiles:client_id (
          email
        )
      `)
      .eq("id", booking_id)
      .single();

    if (bookingError || !booking) {
      throw new Error(`Booking error: ${bookingError?.message}`);
    }

    const clientEmail = booking.profiles?.email;

    if (!clientEmail) {
      throw new Error("Brak email klienta");
    }

    const resendRes = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Ride24 <no-reply@ride24.pl>",
          to: clientEmail,
          subject: "Ride24 – Twoja rezerwacja została potwierdzona",
          html: `
          <p>Twoja rezerwacja została opłacona.</p>
          <p>Voucher jest gotowy w panelu klienta.</p>
          <p>Kod rezerwacji: <b>${booking.reservation_code}</b></p>
          <p>
          Panel:
          <a href="https://ride24.pl/panel?reservation=${booking.reservation_code}">
          https://ride24.pl/panel
          </a>
          </p>
          `
        })
      }
    );

    const resendData = await resendRes.json();

    if (!resendRes.ok) {

      await supabase
        .from("email_logs")
        .insert({
          booking_id: booking.id,
          email: clientEmail,
          type: "booking_confirmation",
          status: "failed"
        });

      throw new Error(resendData.message);
    }

    await supabase
      .from("email_logs")
      .insert({
        booking_id: booking.id,
        email: clientEmail,
        type: "booking_confirmation",
        status: "sent"
      });

    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      }
    );

  } catch (error) {

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      }
    );

  }

});