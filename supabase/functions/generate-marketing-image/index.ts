import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

  try {

    const body = await req.json();

    const city = body.city;
    const country = body.country;

    const apiKey =
      Deno.env.get("OPENAI_API_KEY");

    const response =
      await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "gpt-image-1",
            size: "1024x1024",
            prompt: `
Professional travel advertisement for Ride24.

Location: ${city}, ${country}

Ultra realistic photography.

Style:
Booking.com
Expedia
Rentalcars

Requirements:

- real photography
- photorealistic
- travel magazine quality
- airport pickup experience
- luxury vacation atmosphere
- natural sunlight
- realistic shadows
- realistic reflections
- authentic modern rental car
- no futuristic vehicles
- no concept cars
- no distorted wheels
- no distorted headlights
- no unrealistic details

Scene:

Tourist arriving at airport and collecting a premium rental car.
Beautiful destination in background.
Luxury travel experience.
High-end commercial photography.

No text.
No logos.
No watermark.
`
          })
        }
      );

    const data =
      await response.json();
      const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const imageBase64 =
  data?.data?.[0]?.b64_json;

if (!imageBase64) {
  throw new Error(
    "No image returned from OpenAI"
  );
}

const imageBytes =
  Uint8Array.from(
    atob(imageBase64),
    c => c.charCodeAt(0)
  );

const fileName =
  `marketing-${Date.now()}.png`;

const { error: uploadError } =
  await supabase.storage
    .from("marketing-images")
    .upload(
      fileName,
      imageBytes,
      {
        contentType: "image/png",
        upsert: false
      }
    );

if (uploadError) {
  throw uploadError;
}

const { data: publicData } =
  supabase.storage
    .from("marketing-images")
    .getPublicUrl(fileName);

const imageUrl =
  publicData.publicUrl;
    return new Response(
  JSON.stringify({
    success: true,
    image_url: imageUrl,
    file_name: fileName
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