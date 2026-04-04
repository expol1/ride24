import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  // TODO: zmienić na https://ride24.pl po wdrożeniu produkcji
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS" // <-- TO JEST TEN BRAKUJĄCY ELEMENT
}

serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {

    console.log("1. Edge Function start")

    const authHeader =
  req.headers.get("Authorization") ||
  req.headers.get("authorization")
    if (!authHeader) throw new Error("Brak Authorization header")

    // klient do weryfikacji użytkownika
    const supabaseUserClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        global: { headers: { Authorization: authHeader } }
      }
    )

    const { data: { user }, error: userError } = await supabaseUserClient.auth.getUser()

    if (userError || !user) {
      throw new Error("Błąd JWT: " + (userError?.message || "Brak usera"))
    }

    console.log("2. JWT OK")

    // admin client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // sprawdzenie czy admin
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()

    if (profileError || profile?.role !== "admin") {
      throw new Error("Odmowa dostępu – wymagany admin")
    }

    console.log("3. Admin verified")

    const body = await req.json()


    const {
      email,
      password,
      company_name,
      country,
      region,
      phone,
      currency,
      discount_percent
    } = body

    if (!email || !password || !company_name) {
      throw new Error("Brakuje wymaganych danych")
    }

    console.log("4. Tworzenie użytkownika auth")

    const { data: newAuthUser, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: company_name }
      })

    if (authError) throw new Error(authError.message)

    const newPartnerId = newAuthUser.user.id

    console.log("5. Aktualizacja profilu")

    const { error: profileUpdateError } = await supabaseAdmin
      .from("profiles")
      .update({
        role: "partner",
        must_change_password: true,
        name: company_name
      })
      .eq("id", newPartnerId)

    if (profileUpdateError) {
      throw new Error(profileUpdateError.message)
    }

    console.log("6. Insert partners")

    const { error: partnerInsertError } = await supabaseAdmin
      .from("partners")
      .insert([
        {
          user_id: newPartnerId,
          company_name,
          country,
          region,
          phone,
          currency,
          discount_percent: discount_percent ?? 15,
          active: true
        }
      ])

    if (partnerInsertError) {
      throw new Error(partnerInsertError.message)
    }

    console.log("7. Email sending")

    const resendApiKey = Deno.env.get("RESEND_API_KEY")

    if (resendApiKey) {

      const html = `
<div style="font-family: 'Inter', Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 40px 20px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
    
    <div style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
      <img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" alt="Ride24 Logo" style="height: 40px; display: block; margin: 0 auto;">
    </div>

    <div style="padding: 40px 30px;">
      <h2 style="color: #0f172a; margin-top: 0; margin-bottom: 20px; font-size: 24px; font-weight: 700; text-align: center;">Welcome to Ride24!</h2>
      
      <p style="color: #475569; line-height: 1.6; font-size: 16px; margin-bottom: 24px; text-align: center;">
        The Ride24 Administrator has successfully created a Partner account for <strong style="color: #0f172a;">${company_name}</strong>.
      </p>

      <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 30px 0; border: 1px dashed #cbd5e1; text-align: center;">
        <div style="margin-bottom: 12px; color: #64748b; font-size: 15px;">
          Login (E-mail): <br>
          <span style="color: #0f172a; font-weight: 700; font-size: 16px; display: inline-block; margin-top: 4px;">${email}</span>
        </div>
        <div style="color: #64748b; font-size: 15px;">
          Temporary Password: <br>
          <span style="color: #0f172a; font-weight: 700; font-size: 16px; display: inline-block; margin-top: 4px; letter-spacing: 1px;">${password}</span>
        </div>
      </div>

      <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin-bottom: 35px; text-align: center; font-style: italic;">
        For security reasons, you will be required to change this temporary password and accept the B2B Terms of Cooperation upon your first login.
      </p>

      <div style="text-align: center; margin-bottom: 20px;">
        <a href="https://ride24.pl/partner.html" 
           style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 16px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; letter-spacing: 0.5px; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2); border: 1px solid #1d4ed8;">
           Log in to Partner Dashboard
        </a>
      </div>

    </div>
  </div>
  
  <div style="text-align: center; margin-top: 20px; color: #94a3b8; font-size: 13px;">
    &copy; 2026 Ride24. All rights reserved.
  </div>
</div>
`

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Ride24 <noreply@ride24.pl>",
          to: email,
          subject: "Welcome to Ride24 – Your Partner Account",
          html
        })
      })

    } else {

      console.log("RESEND_API_KEY brak – pomijam email")

    }

    console.log("8. DONE")

    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      }
    )

  } catch (error: any) {

    console.error("ERROR:", error.message)

    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      }
    )

  }

})