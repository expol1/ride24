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
Jesteś dyrektorem marketingu Ride24.

Tworzysz reklamy turystyczne po polsku.

Zwracasz WYŁĄCZNIE JSON.


Format:

{
  "headline":"",
  "content":"",
  "hashtags":""
}
Zwracaj zawsze wszystkie pola:

- headline
- content
- hashtags

Nigdy nie pomijaj pola hashtags.

hashtags musi być ciągiem tekstowym zawierającym hashtagi oddzielone spacją.
Zasady:

- język polski
- profesjonalny marketing
- bez depozytu
- bez karty kredytowej
- pełne ubezpieczenie
- nie wspominaj skuterów
- nie wspominaj transferów
- nie wspominaj kierowców
- nie wspominaj konkretnych modeli pojazdów
- zakończ CTA
- headline ma brzmieć jak slogan luksusowej kampanii turystycznej
`
},
{
  role: "user",
  content: `
Lokalizacja:

Miasto: ${city}
Kraj: ${country}

Przygotuj:

1. headline
2. content

Headline:

2-4 słowa.

Musi wyglądać jak nagłówek profesjonalnej reklamy turystycznej premium.

Headline będzie później używany jako główny napis reklamy graficznej.

Przykłady:

Poznaj magię Funchal
Witaj w Pafos
Odkryj Porto
Malaga czeka
Poznaj Cypr
Odkryj Maderę
Poznaj Maderę
Podziwiaj Cypr
Pafos na Cyprze
Funchal na Maderze
Lizbona w Portugalii
Porto w Portugalii

NIE używaj:

* teraz
* dziś
* już dziś
* natychmiast
* promocja
* oferta
* rabat
* tanio
* najlepszy

NIE używaj konstrukcji:

* Uroki Pafos Cypru
* Magia Porto Portugalii
* Piękno Funchal Madery
* Uroki Teneryfy Hiszpanii

Jeżeli używasz miasta i kraju, stosuj naturalną polską składnię:

* Pafos na Cyprze
* Funchal na Maderze
* Lizbona w Portugalii
* Malaga w Hiszpanii
* Porto w Portugalii
* Nusa Penida w Indonezji

Nigdy nie używaj:

* Penida Indonezji
* Pafos Cypru
* Funchal Madery
* Lizbona Portugalii
* Porto Portugalii
* Malaga Hiszpanii

Jeżeli używasz miasta i kraju:

zawsze stosuj:

miasto + "w" + kraj

lub

miasto + "na" + wyspa

Poprawne przykłady:

* Nusa Penida w Indonezji
* Pafos na Cyprze
* Funchal na Maderze
* Lizbona w Portugalii
* Porto w Portugalii

Niepoprawne przykłady:

* Penida Indonezji
* Pafos Cypru
* Funchal Madery
* Lizbona Portugalii
Nagłówek ma być:

* krótki
* elegancki
* turystyczny
* emocjonalny
* premium
* naturalny językowo
* związany z lokalizacją

Maksymalnie 4 słowa.

Rotate naturally between:

* Odkryj
* Poznaj
* Podziwiaj
* Witaj w
* Zobacz
* Przeżyj
* Zwiedzaj
* Poczuj klimat
* Kierunek
* Magia
* Perła
* Do not overuse any single opening phrase.

Avoid generating "Odkryj" in consecutive advertisements.

Prefer a different opening phrase than the previous generation whenever possible.
Preferowane konstrukcje:

* Odkryj ${city}
* Poznaj ${city}
* Witaj w ${city}
* ${city} czeka
* ${city} w ${country}
If the destination belongs to a well-known island,
archipelago, region or tourism destination brand,
prefer including it in the headline.

Examples:

* Pafos na Cyprze
* Funchal na Maderze
* Ponta Delgada na Azorach
* Porto w Portugalii
* Lizbona w Portugalii

For famous islands and regions:

prefer destination + region

instead of city-only headlines.

Avoid using only the city name when the island
or region is the stronger tourism destination.

Przykład:

Poprawnie:
Odkryj Nusa Penida
Poznaj Nusa Penida

Niepoprawnie:
Nusa Penida w Indonezji
Penida Indonezji
Jeżeli lokalizacja znajduje się na wyspie:

* ${city} na Cyprze
* ${city} na Maderze
* ${city} na Teneryfie
Nigdy nie dodawaj znaków:

!
?
"
:
;

Headline musi być gotowy do użycia jako główny tytuł reklamy graficznej.




Content:

Content:

80-150 słów.

Profesjonalny post Facebook.



Następnie wygeneruj pole:

hashtags

Wymagania dla hashtagów:

- 8-15 hashtagów
- związane z podróżami
- związane z lokalizacją
- związane z krajem
- związane z wakacjami
- związane z wynajmem samochodów
OBOWIĄZKOWO zawsze dodaj:

#Ride24
#CarRental
#WynajemSamochodu
#BezDepozytu
#BezKarty

Hashtag #Ride24 musi zawsze występować jako pierwszy.
Format:

#Travel #Vacation #CarRental

Hashtagi mają być zwrócone wyłącznie w polu:

hashtags
`
}
]
          })
        }
      );

    const data =
  await response.json();
console.log(
  "OPENAI:",
  JSON.stringify(data)
);
if (data.error) {

  throw new Error(
    "OPENAI ERROR: " +
    data.error.message
  );

}

if (
  !data.choices ||
  !data.choices[0]
) {

  throw new Error(
    "OPENAI INVALID RESPONSE: " +
    JSON.stringify(data)
  );

}

const result =
  JSON.parse(
    data.choices[0]
      .message.content
  );

return new Response(
  JSON.stringify({
    success: true,

    headline:
      result.headline,

    content:
  result.content +
  "\n\n🌍 Odkrywaj więcej: https://ride24.pl",

    hashtags:
  result.hashtags ||
  "#Ride24 #CarRental #Travel #Vacation"
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