import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {

  const supabase =
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

  const { data } =
    await supabase
      .from("social_connections")
      .select("refresh_token")
      .eq("platform", "google_ads")
      .single();

  if (!data?.refresh_token) {

    return new Response(
      JSON.stringify({
        success: false,
        error: "Google Ads not connected"
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  }

  const tokenResponse =
    await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id:
            Deno.env.get("GOOGLE_ADS_CLIENT_ID")!,
          client_secret:
            Deno.env.get("GOOGLE_ADS_CLIENT_SECRET")!,
          refresh_token:
            data.refresh_token,
          grant_type:
            "refresh_token"
        })
      }
    );

  const tokenData =
    await tokenResponse.json();

  const accessToken =
    tokenData.access_token;

  const response =
    await fetch(
      "https://googleads.googleapis.com/v20/customers/5360768094/googleAds:search",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "developer-token":
            Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,

          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          query: `
            SELECT
              customer.id,
              customer.descriptive_name,
              customer.currency_code,
              customer.time_zone,
              customer.manager
            FROM customer
          `
        })
      }
    );

  const result =
    await response.json();

  return new Response(
    JSON.stringify(result),
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

});