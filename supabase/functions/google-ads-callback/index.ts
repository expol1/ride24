import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

const url = new URL(req.url);

const code =
url.searchParams.get("code");

if (!code) {


return new Response(
  JSON.stringify({
    success: false,
    error: "Missing code"
  }),
  {
    status: 400,
    headers: {
      "Content-Type": "application/json"
    }
  }
);


}

const clientId =
Deno.env.get("GOOGLE_ADS_CLIENT_ID");

const clientSecret =
Deno.env.get("GOOGLE_ADS_CLIENT_SECRET");

const redirectUri =
Deno.env.get("GOOGLE_ADS_REDIRECT_URI");

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
code,
client_id: clientId ?? "",
client_secret: clientSecret ?? "",
redirect_uri: redirectUri ?? "",
grant_type: "authorization_code"
})
}
);

const tokenData =
await tokenResponse.json();

const refreshToken =
tokenData.refresh_token;

if (!refreshToken) {


return new Response(
  JSON.stringify({
    success: false,
    tokenData
  }),
  {
    headers: {
      "Content-Type": "application/json"
    }
  }
);


}

const supabase =
createClient(
Deno.env.get("SUPABASE_URL")!,
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const { error } =
await supabase
.from("social_connections")
.upsert(
{
user_id:
"5d8df05f-0b5d-443e-b688-b696490e1dce",

      platform:
        "google_ads",

      provider:
        "google_ads",

      refresh_token:
        refreshToken,

      connected_at:
        new Date().toISOString()
    },
    {
      onConflict:
        "user_id,platform"
    }
  );


if (error) {


return new Response(
  JSON.stringify({
    success: false,
    error
  }),
  {
    headers: {
      "Content-Type": "application/json"
    }
  }
);


}

return new Response(
JSON.stringify({
success: true,
connected: true
}),
{
headers: {
"Content-Type": "application/json"
}
}
);

});
