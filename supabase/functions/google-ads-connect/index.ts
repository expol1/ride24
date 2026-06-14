import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {

  const clientId =
    Deno.env.get("GOOGLE_ADS_CLIENT_ID");

  const redirectUri =
    Deno.env.get("GOOGLE_ADS_REDIRECT_URI");

  const stateSecret =
    Deno.env.get("GOOGLE_ADS_STATE_SECRET");

  if (!clientId || !redirectUri || !stateSecret) {

    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing secrets"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  }

  const state = btoa(
    `${stateSecret}:${Date.now()}`
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/adwords",
    state
  });

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return Response.redirect(authUrl, 302);

});