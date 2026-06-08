import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS"
};

serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }

  try {

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: settings, error: settingsError } =
      await supabase
        .from("marketing_settings")
        .select("*")
        .eq("id", 1)
        .single();

    if (settingsError) {

      return new Response(
        JSON.stringify({
          success: false,
          error: settingsError.message
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    const posts = [
      {
        platform: "facebook",
        content:
          "🚗 Wynajem auta bez depozytu. Pełne ubezpieczenie i program lojalnościowy Ride24.",
        status: "draft"
      },
      {
        platform: "instagram",
        content:
          "☀️ Wakacje bez stresu. Bez depozytu. Bez karty kredytowej. Ride24.",
        status: "draft"
      },
      {
        platform: "x",
        content:
          "✈️ Wynajem samochodu bez karty kredytowej. Ride24.",
        status: "draft"
      }
    ];

    const { error: insertError } =
      await supabase
        .from("marketing_posts")
        .insert(posts);

    if (insertError) {

      return new Response(
        JSON.stringify({
          success: false,
          error: insertError.message
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        module: "Marketing AI",
        status: settings?.is_active
          ? "ACTIVE"
          : "DISABLED",
        monthly_budget:
          settings?.monthly_budget ?? 0,
        daily_budget:
          settings?.daily_budget ?? 0,
        generated_posts: posts.length,
        timestamp:
          new Date().toISOString()
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );

  } catch (err) {

    return new Response(
      JSON.stringify({
        success: false,
        error: String(err)
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );

  }

});