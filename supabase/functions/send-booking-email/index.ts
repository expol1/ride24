import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {

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

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select(`
        id,
        reservation_code,
        profiles (
          email
        )
      `)
      .eq("id", booking_id)
      .single();

    if (bookingError || !booking) {
      throw new Error(`Booking error: ${bookingError?.message}`);
    }

    const clientEmail = booking.profiles?.email;

    // 🔥 KLUCZOWY FIX — NIE WYWAŁA SYSTEMU
    if (!clientEmail || typeof clientEmail !== "string") {
      console.error("EMAIL ERROR: clientEmail =", clientEmail);

      await supabase
        .from("email_logs")
        .insert({
          booking_id: booking.id,
          email: null,
          type: "booking_confirmation",
          status: "skipped"
        });

      return new Response(
        JSON.stringify({ skipped: true }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        }
      );
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Ride24 <no-reply@ride24.pl>",
        to: String(clientEmail), // 🔥 zabezpieczenie
        subject: "Ride24 – Twoja rezerwacja została potwierdzona",
       html: `
<div style="margin:0; padding:0; background:#f4f4f7; font-family:Arial, sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
<tr>
<td align="center">

<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:10px; overflow:hidden;">

<tr>
<td align="center" style="padding:30px; border-bottom:1px solid #eee;">
<img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" width="150" style="display:block;" />
</td>
</tr>

<tr>
<td style="padding:40px; text-align:center;">

<h2 style="margin-bottom:20px;">
Twoja rezerwacja została opłacona 🎉
</h2>

<p style="color:#555;">
Voucher jest gotowy w panelu klienta.
</p>

<div style="background:#f8f9fa; padding:20px; border-radius:8px; margin-top:25px;">
<p style="margin:0; font-size:13px; color:#777;">Kod rezerwacji</p>
<p style="margin:10px 0 0 0; font-size:22px; font-weight:bold;">
${booking.reservation_code}
</p>
</div>

<div style="margin-top:30px;">
<a href="https://ride24.pl/panel?reservation=${booking.reservation_code}"
style="background:#000; color:white; padding:14px 26px; text-decoration:none; border-radius:6px; font-weight:600;">
Przejdź do panelu
</a>
</div>

</td>
</tr>

<tr>
<td style="padding:20px; background:#f8f9fa; text-align:center; font-size:12px; color:#999;">
© ${new Date().getFullYear()} Ride24
</td>
</tr>

</table>

</td>
</tr>
</table>

</div>
        `
      })
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {

      console.error("RESEND ERROR:", resendData); // 🔥 DEBUG

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

  } catch (error: any) {

    console.error("SEND EMAIL ERROR:", error.message);

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      }
    );
  }
});