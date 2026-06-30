import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

  try {

    const body = await req.json();

    const city = body.city;
    const country = body.country;
    const headline =
  body.headline || "";

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
            size: "1536x1024",
            prompt: `
LAYOUT VARIATION RULE:

Randomly choose ONE style:

STYLE A
Classic left panel

STYLE B
Floating luxury card

STYLE C
Bottom-left information block

STYLE D
Diagonal split composition

STYLE E
Minimal luxury tourism poster

Use a different style whenever possible.

Avoid repeating the same composition.
Create a PREMIUM TRAVEL ADVERTISEMENT.

Location:
${city}, ${country}

Headline:
${headline}

IMPORTANT:

The provided headline is FINAL.

Use the headline exactly as provided.

Do NOT rewrite it.
Do NOT shorten it.
Do NOT improve it.
Do NOT generate a new headline.

Design references:

* DiscoverCars
* Rentalcars
* Booking.com
* FlixBus
* Premium travel magazines

Corporate colors:

Primary Green:
#73D700

Primary Navy:
#043268

Secondary Navy:
#26548b

Premium Sky Blue:
#2E8BFF

Premium Light Blue:
#5CAEFF
Corporate colors:

Primary Green:
#73D700

Primary Navy:
#043268

Secondary Navy:
#26548b

Premium Sky Blue:
#2E8BFF

Premium Light Blue:
#5CAEFF

IMPORTANT GREEN COLOR RULE:

Use ONLY this exact green color:
#73D700

Do not use:
#31A100
#64E62C
dark green
olive green
lime green variations

All green accents must match the bright FlixBus-style green.

Color balance:

60% destination photography
30% navy design elements
... 
Color balance:

60% destination photography

30% navy design elements

7% blue accent elements

9%-15% green highlights

Green (#73D700) must be used ONLY for:

* highlighted headline words
* icon accents
* contour lines
* separator lines
* geometric accents
* decorative details
Use significantly more green decorative accents.

Target approximately:

15%-20% visible green accents.

Examples:

* flowing contour lines
* premium location markers
* decorative curves
* tourism route lines
* premium separators
* luxury accent shapes

The design should visibly reflect Ride24 green branding.

Green accents must be noticeable but never dominate the advertisement.
Green must NEVER be a dominant background color.

Never create large green areas.

Blue accents (#2E8BFF and #5CAEFF) should appear more frequently than green.

Use premium gradients between:

#002B5C
#0A3D7A
#2E8BFF

The design should feel brighter, more modern and more premium.
Ride24 visual accents:

Use bright premium green accents frequently.

Examples:

* flowing green contour lines
* luxury curved strokes
* dynamic travel paths
* premium glow accents
* elegant separators
* modern geometric details
* destination markers
* subtle motion trails

Every advertisement must contain multiple green accent elements.

The advertisement should immediately feel connected to Ride24 branding.

Destination photography:

The destination is ALWAYS the hero.

Show iconic landmarks and beautiful scenery.

Photography must feel:

* premium
* aspirational
* luxurious
* realistic
* magazine quality

Avoid generic stock-photo appearance.

Information panel:

Randomly choose one position:

* left side
* bottom left
* floating card

All layouts should be used equally often.

Do not favor left side.

Avoid repeating the same layout in consecutive generations.

Width:
35%-45%

The text area must always be larger than the headline area.

For headlines containing 3 or more words:

automatically increase panel width.

Never allow text to touch the photo area.
Text must remain 100% inside the information panel.

No text may cross the panel boundary.

No letters may overlap photography.
Keep at least 8% empty margin
between text and photography.

Every advertisement should use a different composition.

Photography:
55%-65%

Panel requirements:

* premium luxury appearance
* curved geometry
* asymmetric design
* layered shapes
* flowing transitions
* organic contours
* premium agency styling

Never use:

* rectangles
* square boxes
* PowerPoint layouts
* flat corporate panels

Avoid straight vertical separations.

Create elegant flowing transitions between panel and photography.
The information panel must remain fully readable.

Do not allow destination photography
to overlap text areas.

Text must always sit on a clean navy background.

The photography must start only after
the panel boundary.

Avoid photo elements entering the text zone.
Typography:

Use premium tourism typography.

Headline must:

* fit comfortably
* prefer 1-2 lines
* maximum 3 lines
* automatically reduce font size for long locations
* never overlap benefits
* never touch image area
* never exceed 4 words
* never occupy more than 18% of panel height
* maintain generous margins

Avoid oversized typography.

Prefer elegant typography over giant typography.
TYPOGRAPHY VARIATION:

Every advertisement must use a different typography style.

Randomly choose ONE style:

STYLE A
Luxury magazine serif headline
Modern sans-serif body

STYLE B
Bold geometric tourism headline
Elegant light body font

STYLE C
Premium travel poster typography
Condensed headline
Wide spacing body text

STYLE D
Luxury editorial typography
High contrast serif headline
Modern sans-serif benefits

STYLE E
Contemporary travel campaign
Rounded headline
Minimalist body font
PREMIUM FONT DIRECTION:

Typography must feel like a luxury tourism campaign.

Frequently use:

* elegant serif typography
* editorial magazine typography
* handwritten luxury script accents
* premium calligraphy-inspired typography
* boutique hotel style typography
* luxury travel brochure typography

For some advertisements:

use a beautiful handwritten or calligraphic style
for one headline line only.

Examples:

"Witaj w"
(handwritten luxury script)

"Lizbonie"
(elegant serif)

or

"Poznaj"
(calligraphic accent)

"Maderę"
(luxury magazine serif)

Mix font families creatively.

Avoid using the same font style
for all headline lines.

The headline should feel designed
by a premium advertising agency.

Create visual WOW effect through typography.

Typography should resemble:

* luxury travel magazines
* premium resort campaigns
* boutique hotel advertising
* high-end tourism brands

Avoid generic corporate fonts.
Avoid using the same typography in consecutive generations.
Avoid using the same typography style repeatedly.

Headlines and benefit text should not always use the same font family.

The advertisement should resemble a professionally designed tourism campaign.

Never use identical typography across consecutive generations.
HEADLINE STYLING VARIATION:

Randomly choose ONE headline styling:

STYLE A
First line white
Location green

STYLE B
Location white
Country or region green

STYLE C
All white headline

STYLE D
Luxury mixed emphasis

STYLE E
Green accent only on one keyword

Do not always highlight the same word.

Do not always use green on the location.

Use different visual emphasis in different advertisements.
Information panel content:

ONLY display:

${headline}

✓ Bez depozytu

✓ Bez karty kredytowej

✓ Pełne ubezpieczenie

Below the benefits add two premium value tiles.

Tile 1:
AUTOPRZEWODNIK
GRATIS

Tile 2:
RABATY
do -20%

Below the tiles add:

one unique travel slogan.

Never repeat the same slogan.
Avoid overusing words:

* odkrywaj
* zwiedzaj
* podróżuj

Use a wide variety of premium travel phrases.

Examples:

Wynajem auta w lepszym stylu.
Komfort zaczyna się tutaj.
Twoja trasa, Twoje tempo.
Więcej podróży, mniej formalności.
Lepszy wynajem, lepsza podróż.
Swoboda zaczyna się tutaj.
Każda trasa to nowa historia.

maximum 8 words

This text must remain secondary.

PREMIUM VALUE TILES:

Create two visually strong premium tiles inside the information panel.

Tile 1 must promote the free thematic driver guide.

Meaning of this tile:
The customer receives a free thematic autoprzewodnik with driver information and ready-made thematic routes with direct Google Maps navigation.

But on the image display ONLY short readable text:

AUTOPRZEWODNIK
GRATIS

Tile 2 must promote discounts.

Display ONLY:

RABATY
do -20%

Do NOT write:
LOYALTY
Loyalty Program
opłaty rezerwacyjnej
reservation fee
15 tras Google Maps
Google Maps
Driver Guide

Tile design rules:

* both tiles must feel premium, modern and elegant
* both tiles should use Ride24 green #73D700 as the main visual accent
* at least one tile should have a strong green background
* preferably both tiles should use green #73D700 as the main fill
* use white or navy text depending on readability
* tiles must be rounded, polished and agency-quality
* tiles must look like premium travel benefit cards
* tiles must not look like cheap coupons
* tiles must not look like supermarket discount labels
* tiles must not dominate the whole image
* tiles should be placed below the main benefits
* tiles should be clearly readable
* tiles should have elegant shadows, subtle glow or premium depth
* tiles should be visually aligned and consistent

Discount tile special style:

The "RABATY do -20%" tile may use a premium radial burst, spotlight, glow, elegant starburst, or luxury highlight effect.

Important:
The burst must look luxury, modern and refined.
It must NOT look like a comic explosion.
It must NOT look cheap.
It should feel like a premium travel campaign highlight.

Autoprzewodnik tile special style:

The "AUTOPRZEWODNIK GRATIS" tile should feel like a valuable premium travel bonus.

It may include subtle premium icons:
* map pin
* route line
* steering wheel
* small map outline
* navigation arrow

Green accents around the tiles:

Add clearly visible Ride24 green decorative accents near and around the tiles:

* short horizontal green bars
* thin contour lines
* flowing route lines
* small green dots
* premium separators
* elegant motion stripes
* subtle travel path curves
* refined green glow accents

The design should clearly show that the green tiles are part of Ride24 premium branding.

Green accents must be more visible than in previous versions, but still elegant.
Do not create large green backgrounds outside the tiles.
Do not overload the layout.
Icons:

Randomize between:

* premium checkmarks
* shield icons
* payment card icons
* location icons
* decorative dots
* premium accent lines

Do not repeat the same icon set every time.

Each advertisement should look unique.

Vehicle rules:
Vehicle variation:

Randomize between:

* SUV
* sedan
* hatchback
* crossover
* cabrio

Do not always use SUVs.
Vehicle is optional.
Vehicle should appear in no more than 50% of advertisements.

Many advertisements should contain no vehicle at all.

If the destination scenery is strong enough,
omit the vehicle completely.
If a vehicle appears:

* realistic
* premium
* maximum 10% image area
* secondary element
* near image edge
* partially cropped if necessary
* never centered
* never larger than landmarks

Branding:

TOP-RIGHT CORNER IS A STRICT LOGO SAFE ZONE.

Reserve the entire top-right area.

Minimum reserved area:

20% image width
20% image height

This area must remain completely empty.

Do not place:

text
headlines
slogans
icons
decorative elements
vehicles
buildings
landmarks
accent lines
graphic details

Nothing may appear inside this area.

The area is reserved exclusively for the real Ride24 logo added later.

Keep this corner visually clean and uncluttered.

Do not generate any logo.

Do not generate any branding.

ABSOLUTE RESTRICTIONS:

Never generate:

* Ride24
* RIDE24
* ride24
* company names
* business names
* logos
* branding text
* wordmarks
* website addresses
* trademarks
* watermarks

The advertisement must contain ZERO generated branding.

Branding will be added later externally.

Visual quality:

Use:

* realistic shadows
* realistic reflections
* premium depth
* luxury composition
* high-end tourism aesthetics

Avoid:

* stock-photo appearance
* cartoon style
* illustration style
* flat corporate templates
* giant typography
* distorted vehicles
* large green backgrounds

The final result should look like a €50,000 agency-created luxury travel campaign.


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
const logoResponse =
  await fetch(
    "https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/ride24-logo-v2.png"
  );

const logoBytes =
  new Uint8Array(
    await logoResponse.arrayBuffer()
  );

const image =
  await Image.decode(
    imageBytes
  );

const logo =
  await Image.decode(
    logoBytes
  );



logo.resize(
  300,
  Image.RESIZE_AUTO
);

image.composite(
  logo,
  image.width -
    logo.width -
    40,
  40
);
const fileName =
  `marketing-${Date.now()}.png`;
  const finalImage =
  await image.encode();

const { error: uploadError } =
  await supabase.storage
    .from("marketing-images")
    .upload(
  fileName,
  finalImage,
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
    file_name: fileName,
    prompt:
  `${headline} | ${city}, ${country}`
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