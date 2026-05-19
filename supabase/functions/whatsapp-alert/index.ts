import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  try {
    const body = await req.json();

    const partnerPhone = body.phone;

    const response = await fetch(
      "https://graph.facebook.com/v25.0/1109826875554987/messages",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: partnerPhone,
          type: "template",
          template: {
            name: "ride24_new_request",
            language: {
              code: "en"
            }
          }
        })
      }
    );

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });

  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err.message
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});