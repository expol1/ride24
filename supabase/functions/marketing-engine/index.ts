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
      throw settingsError;
    }

    const {
      data: locations,
      error: locationsError
    } = await supabase
      .from("partner_locations")
      .select("city,country")
      .eq("active", true)
      .not("city", "is", null);

    if (locationsError) {
      throw locationsError;
    }

    const uniqueLocations = [
      ...new Map(
        (locations || [])
          .filter(
            loc =>
              loc.city &&
              loc.city.trim() !== ""
          )
          .map(loc => [
            `${loc.city}-${loc.country}`,
            loc
          ])
      ).values()
    ];

    const shuffled =
      uniqueLocations.sort(
        () => Math.random() - 0.5
      );

    const selected =
      shuffled.slice(0, 3);

    const facebookLocation =
      selected[0];

    const instagramLocation =
      selected[1] || selected[0];

    const xLocation =
      selected[2] || selected[0];

    const posts = [
      {
        platform: "facebook",
        city: facebookLocation.city,
        country: facebookLocation.country,
        content:
          `🚗 Odkrywaj ${facebookLocation.city} bez ograniczeń.

Bez depozytu.
Bez karty kredytowej.
Pełne ubezpieczenie.

Ride24.`,
        status: "draft"
      },

      {
        platform: "instagram",
        city: instagramLocation.city,
        country: instagramLocation.country,
        content:
          `☀️ ${instagramLocation.city} czeka.

Zwiedzaj własnym tempem.

Bez depozytu.
Pełne ubezpieczenie.
Program lojalnościowy Ride24.`,
        status: "draft"
      },

      {
        platform: "x",
        city: xLocation.city,
        country: xLocation.country,
        content:
          `✈️ ${xLocation.city} bez karty kredytowej.

Pełne ubezpieczenie.
Ride24.`,
        status: "draft"
      }
    ];

    const { error: insertError } =
      await supabase
        .from("marketing_posts")
        .insert(posts);

    if (insertError) {
      throw insertError;
    }
    const citiesUsed =
    posts
    .map(post => post.city)
    .join(", ");

    await supabase
       .from("marketing_runs")
       .insert({
         posts_generated:
      posts.length,

    status:
      "success",

    error_message:
      citiesUsed
    });
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

        generated_posts:
          posts.length,

        locations_found:
          locations?.length || 0,

        sample_location:
          locations?.[0] || null,

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
