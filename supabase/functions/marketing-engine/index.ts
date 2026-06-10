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
    // usuwanie postów starszych niż 30 dni

const thirtyDaysAgo =
  new Date(
    Date.now() -
    30 * 24 * 60 * 60 * 1000
  ).toISOString();

await supabase
  .from("marketing_queue")
  .delete()
  .lt(
    "created_at",
    thirtyDaysAgo
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
    const { data: recentRuns } =
  await supabase
    .from("marketing_runs")
    .select("cities_used")
    .order("created_at", {
      ascending: false
    })
    .limit(5);

const recentCities =
  new Set(
    (recentRuns || [])
      .flatMap(run =>
        (run.cities_used || "")
          .split(",")
          .map(city => city.trim())
      )
      .filter(Boolean)
  );

    
    const uniqueLocations = [
  ...new Map(
    (locations || [])
      .filter(
        loc =>
          loc.city &&
          loc.city.trim() !== "" &&
          !recentCities.has(
            loc.city
          )
      )
      .map(loc => [
        `${loc.city}-${loc.country}`,
        loc
      ])
  ).values()
];
if (
  uniqueLocations.length < 3
) {

  const fallbackLocations = [
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

  uniqueLocations.length = 0;
  uniqueLocations.push(
    ...fallbackLocations
  );
}

    const shuffled =
  [...uniqueLocations].sort(
    () => Math.random() - 0.5
  );

    const selected =
      shuffled.slice(0, 3);
if (selected.length === 0) {
  throw new Error(
    "No active locations found"
  );
}
    const facebookLocation =
      selected[0];
      let cityPL =
  facebookLocation.city;

let countryPL =
  facebookLocation.country;

const { data: cityDict } =
  await supabase
    .from("locations_dictionary")
    .select("name_pl")
    .eq("category", "city")
    .eq(
      "name_en",
      facebookLocation.city
    )
    .maybeSingle();

if (cityDict?.name_pl) {

  cityPL =
    cityDict.name_pl;

}

const { data: countryDict } =
  await supabase
    .from("locations_dictionary")
    .select("name_pl")
    .eq("category", "country")
    .eq(
      "name_en",
      facebookLocation.country
    )
    .maybeSingle();

if (countryDict?.name_pl) {

  countryPL =
    countryDict.name_pl;

}
    

    const templates = [
      (city: string) =>
`🚗 Odkrywaj ${city} bez ograniczeń.

Bez depozytu.
Bez karty kredytowej.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`☀️ ${city} czeka na Twoje wakacje.

Zwiedzaj własnym tempem.
Bez depozytu.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`✈️ City break w ${city} zaczyna się wygodnie.

Bez karty kredytowej.
Bez depozytu.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`👨‍👩‍👧‍👦 Rodzinny wyjazd do ${city} bez stresu.

Więcej swobody.
Pełne ubezpieczenie.
Bez depozytu.

Ride24.`,

      (city: string) =>
`💼 Podróż służbowa do ${city} może być prostsza.

Szybki wynajem.
Bez karty kredytowej.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🌍 Zwiedzaj ${city} bez zbędnych formalności.

Bez depozytu.
Program lojalnościowy Ride24.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🛡️ Bezpieczeństwo w ${city} ma znaczenie.

Pełne ubezpieczenie.
Bez karty kredytowej.
Spokojna podróż z Ride24.`,

      (city: string) =>
`🏨 Ruszasz do hotelu w ${city}?

Odbierz auto szybko.
Bez depozytu.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🛬 Lądujesz w ${city}?

Wynajmij auto bez karty kredytowej.
Bez depozytu.
Ride24.`,

      (city: string) =>
`🎒 Weekend w ${city} bez ograniczeń.

Zwiedzaj więcej.
Pełne ubezpieczenie.
Bez depozytu.

Ride24.`,

      (city: string) =>
`🚙 Komfort podróżowania po ${city} zaczyna się tutaj.

Pełne ubezpieczenie.
Bez depozytu.
Bez karty kredytowej.

Ride24.`,

      (city: string) =>
`📍 Odkrywaj najlepsze zakątki ${city}.

Bez depozytu.
Program lojalnościowy.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🌴 Wakacje w ${city} smakują lepiej z pełną swobodą.

Bez karty kredytowej.
Bez depozytu.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🧳 Biznes, hotel i lotnisko w ${city}?

Jedno auto.
Pełna wygoda.
Ride24.`,

      (city: string) =>
`📸 Zobacz więcej w ${city}.

Wynajem auta bez depozytu.
Pełne ubezpieczenie.
Ride24.`,

      (city: string) =>
`🚘 Podróżuj po ${city} wygodnie i bez stresu.

Bez karty kredytowej.
Pełne ubezpieczenie.
Ride24.`,

      (city: string) =>
`✨ Krótki wypad do ${city}, maksymalna niezależność.

Bez depozytu.
Program lojalnościowy Ride24.
Ride24.`,

      (city: string) =>
`🔑 Odbierz kluczyki i ruszaj przez ${city}.

Bez depozytu.
Bez karty kredytowej.
Pełne ubezpieczenie.

Ride24.`,

      (city: string) =>
`🌆 ${city} na city break?

Wybierz wygodę.
Wybierz pełne ubezpieczenie.
Wybierz Ride24.`,

      (city: string) =>
`🗺️ Zwiedzanie ${city} po swojemu.

Bez depozytu.
Bez karty kredytowej.
Program lojalnościowy.

Ride24.`
    ];

    function buildHashtags(
      city: string,
      country: string
    ): string {
      return `

#Ride24
#CarRental
#NoDeposit
#NoCreditCard
#FullInsurance
#${country.replace(/\s/g, "")}
#${city.replace(/\s/g, "")}`;
    }

    function randomTemplate(
      city: string
    ): string {

      const template =
        templates[
          Math.floor(
            Math.random() *
            templates.length
          )
        ];

      return template(city);
    }

    const contentResponse =
  await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-marketing-content`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        city: cityPL,
        country: countryPL
      })
    }
  );

const contentData =
  await contentResponse.json();

if (!contentResponse.ok) {

  console.error(
    "CONTENT RESPONSE ERROR",
    contentData
  );

  throw new Error(
    JSON.stringify(contentData)
  );
}

const imageResponse =
  await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-marketing-image`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        city: cityPL,
        country: countryPL
      })
    }
  );

const imageData =
  await imageResponse.json();

if (!imageResponse.ok) {

  console.error(
    "IMAGE RESPONSE ERROR",
    imageData
  );

  throw new Error(
    JSON.stringify(imageData)
  );
}
const posts = [
  {
    platform: "all",

    city: cityPL,

    country: countryPL,

    content:
      contentData.content,

    image_url:
      imageData.image_url,

    image_status:
      "ready",

    image_prompt:
      `${cityPL}, ${countryPL}`,

    image_generated_at:
      new Date().toISOString(),

    generation_version:
      "v2",

    status:
      "draft"
  }
];

    const { error: insertError } =
      await supabase
  .from("marketing_queue")
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

    cities_used:
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
    console.error(
  "MARKETING ENGINE ERROR",
  err
);
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
