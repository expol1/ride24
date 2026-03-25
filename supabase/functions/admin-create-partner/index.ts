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
<div style="font-family: Inter, Arial, sans-serif; background: #f8fafc; padding: 40px; margin: 0;">
  <div style="max-width: 600px; margin: auto; background: white; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
    
    <div style="background: #0f172a; padding: 24px; text-align: center;">
      <img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" alt="Ride24 Logo" style="height: 36px; display: block; margin: 0 auto;">
    </div>

    <div style="padding: 30px;">
      <h2 style="color: #0f172a; margin-top: 0; font-size: 22px;">Welcome to Ride24!</h2>
      
      <p style="color: #334155; line-height: 1.6; font-size: 15px;">
        The Ride24 Administrator has successfully created a Partner account for <strong>${company_name}</strong>.
      </p>

      <div style="background: #f1f5f9; padding: 20px; border-radius: 8px; margin: 24px 0; border: 1px solid #e2e8f0;">
        <div style="margin-bottom: 8px; color: #64748b; font-size: 14px;">
          Login (E-mail): <span style="color: #0f172a; font-weight: bold; margin-left: 5px;">${email}</span>
        </div>
        <div style="color: #64748b; font-size: 14px;">
          Temporary Password: <span style="color: #0f172a; font-weight: bold; margin-left: 5px;">${password}</span>
        </div>
      </div>

      <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-bottom: 24px;">
        <em>For security reasons, you will be required to change this temporary password and accept the B2B Terms of Cooperation upon your first login.</em>
      </p>

      <div style="text-align: center;">
        <a href="https://ride24.pl/partner/login.html" 
           style="display: inline-block; background: #2563eb; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">
           Log in to Partner Dashboard
        </a>
      </div>

    </div>
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