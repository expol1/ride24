import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {

  try {

    const body = await req.json();

    const city = body.city;
    const country = body.country;

    const apiKey =
      Deno.env.get("OPENAI_API_KEY");

    const response =
      await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
             {
  role: "system",
  content: `
Jesteś ekspertem marketingu turystycznego Ride24.

Tworzysz profesjonalne posty Facebook po POLSKU.

Nigdy nie używaj języka angielskiego.
Nigdy nie używaj cudzysłowów.
`
},
{
  role: "user",
  content: `
Napisz post Facebook po polsku.

Lokalizacja:
Miasto: ${city}
Kraj: ${country}

Wymagania:

- 80-150 słów
- styl reklamowy premium
- zachęć do podróży
- wspomnij:
  • brak depozytu
  • brak karty kredytowej
  • pełne ubezpieczenie
- zakończ krótkim CTA
- dodaj hashtagi

Marka:
Ride24
`
}
            ]
          })
        }
      );

    const data =
      await response.json();

    return new Response(
      JSON.stringify({
        success: true,
        content:
          data.choices?.[0]
            ?.message?.content
      }),
      {
        headers: {
          "Content-Type":
            "application/json"
        }
      }
    );

  } catch (error) {

    return new Response(
      JSON.stringify({
        success: false,
        error: String(error)
      }),
      {
        status: 500
      }
    );
  }

});