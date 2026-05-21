import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {

try {


const body = await req.json();

const targetPhone = body.phone;

// domyślnie partner template
const templateName =
  body.template || "ride24_new_request";

const response = await fetch(
  "https://graph.facebook.com/v25.0/1131721920024746/messages",
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: targetPhone,
      type: "template",
      template: {
        name: templateName,
        language: {
          code:
            templateName === "ride24_booking_approved"
              ? "pl"
              : "en"
        }
      }
    })
  }
);

const data = await response.json();

console.log("WHATSAPP RESPONSE:", data);

return new Response(
  JSON.stringify(data),
  {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  }
);


} catch (err) {


return new Response(
  JSON.stringify({
    error: err.message
  }),
  {
    status: 500,
    headers: {
      "Content-Type": "application/json"
    }
  }
);

}

});
