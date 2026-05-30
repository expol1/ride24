import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { PDFDocument, rgb } from "https://esm.sh/pdf-lib"
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1"


const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS"
}

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json"
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    })
  }

  let booking_id: string | null = null
  let supabase: any = null

  try {
    const body = await req.json()
    booking_id = body.booking_id || body.record?.id || body.id

    if (!booking_id) {
      return new Response(
        "Missing booking_id",
        {
          status: 400,
          headers: corsHeaders
        }
      )
    }

    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    // ===== FETCH BOOKING =====
    const { data: booking, error: fetchError } = await supabase
  .from("bookings")
  .select(`
  *,
  profiles!fk_client(name,email,phone),
  partners!bookings_partner_id_fkey(company_name,phone,emergency_phone),
  pickup_location_join:partner_locations!pickup_location_id(location_name),
  car_classes!bookings_car_class_id_fkey(class_code)
`)
  .eq("id", booking_id)
  .single();

// 🔥 NOWE – łapiemy błędy z bazy
if (fetchError) {
  console.error("❌ DB ERROR:", fetchError.message);
  throw new Error(fetchError.message);
}

// 🔥 zostaje jak było
if (!booking || booking.status !== "paid") {
  return new Response(
    "Ignored",
    {
      status: 200,
      headers: corsHeaders
    }
  );
}
const { data: payment, error: paymentError } =
  await supabase
    .from("payments")
    .select(`
      amount,
      stripe_session_id,
      status
    `)
    .eq("booking_id", booking.id)
    .eq("status", "paid")
    .single()

if (paymentError || !payment) {
  throw new Error(
    "Paid payment record not found"
  )
}
// ===== INVOICE PROFILE =====

const {
  data: invoiceProfile
} = await supabase
  .from("user_invoice_profiles")
  .select(`
    company_name,
    nip,
    street,
    postal_code,
    city
  `)
  .eq(
    "user_id",
    booking.client_id
  )
  .single()

if (booking.receipt_generated) {
  return new Response(
    JSON.stringify({
      error: "Receipt already exists"
    }),
    {
      status: 409,
      headers: jsonHeaders
    }
  )
}

// ===== RECEIPT NUMBER =====
const { data: receiptNumber } =
  await supabase.rpc(
    "get_next_receipt_number"
  )

if (!receiptNumber) {
  throw new Error(
    "Cannot generate receipt number"
  )
}

// ===== PDF =====
const pdfDoc = await PDFDocument.create()
pdfDoc.registerFontkit(fontkit)

const [regFont, boldFont, logoRes] = await Promise.all([
  supabase.storage
    .from("assets")
    .download("fonts/Roboto-Regular.ttf"),

  supabase.storage
    .from("assets")
    .download("fonts/Roboto-Medium.ttf"),

  supabase.storage
    .from("assets")
    .download("bez.png")
])

const font =
  await pdfDoc.embedFont(
    await regFont.data.arrayBuffer()
  )

const bold =
  await pdfDoc.embedFont(
    await boldFont.data.arrayBuffer()
  )

const logoImage =
  await pdfDoc.embedPng(
    await logoRes.data.arrayBuffer()
  )

const reservation =
  booking.reservation_code ??
  booking.id.slice(0,8).toUpperCase()

const page =
  pdfDoc.addPage([595.28,841.89])

const brandBlue =
  rgb(0.06,0.22,0.42)

const brandGreen =
  rgb(0.45,0.85,0.25)

const lightGray =
  rgb(0.9,0.9,0.9)
const borderGray =
  rgb(0.84,0.88,0.92)

const cardGray =
  rgb(0.97,0.98,0.99)

const textDark =
  rgb(0.13,0.17,0.23)

const textMuted =
  rgb(0.42,0.48,0.56)

const pageWidth =
  page.getWidth()

const pageHeight =
  page.getHeight()

const marginX = 40
const contentWidth =
  pageWidth - marginX * 2

const issuedDate =
  new Date().toLocaleDateString("pl-PL")

const paymentDate =
  booking.updated_at
    ? new Date(booking.updated_at)
        .toLocaleDateString("pl-PL")
    : issuedDate

const paymentStatus =
  payment.status === "paid"
    ? "Opłacono online"
    : payment.status

const paymentIntent =
  payment?.stripe_session_id || "-"

const sellerLines = [
  "Ride24 – Auta z różnych zakątków świata",
  "Emilia Sowa",
  "ul. Przyszłości 38/3",
  "70-893 Szczecin",
  "Polska"
]

const buyerLines = [
  invoiceProfile?.company_name ||
    booking.profiles?.name || "-",
  ...(invoiceProfile?.nip
    ? [`NIP: ${invoiceProfile.nip}`]
    : []),
  invoiceProfile?.street || "-",
  `${invoiceProfile?.postal_code || ""} ${invoiceProfile?.city || ""}`.trim() || "-"
]

const drawCard = (
  x: number,
  y: number,
  width: number,
  height: number,
  color = cardGray
) => {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color,
    borderColor: borderGray,
    borderWidth: 1
  })
}

const drawCardLines = (
  lines: string[],
  x: number,
  startY: number,
  maxWidth: number
) => {
  lines.forEach((line, index) => {
    page.drawText(
      line,
      {
        x,
        y: startY - index * 15,
        size: 10.5,
        font,
        color: textDark,
        maxWidth,
        lineHeight: 13
      }
    )
  })
}

let cursorY =
  pageHeight - 36

// ===== SEKCJA 1: HEADER =====
const headerHeight = 114
const headerY =
  cursorY - headerHeight

drawCard(
  marginX,
  headerY,
  contentWidth,
  headerHeight,
  rgb(1,1,1)
)

page.drawRectangle({
  x: marginX,
  y: headerY + headerHeight - 6,
  width: contentWidth,
  height: 6,
  color: brandBlue
})

page.drawRectangle({
  x: marginX,
  y: headerY + headerHeight - 10,
  width: contentWidth,
  height: 4,
  color: brandGreen
})

page.drawImage(
  logoImage,
  {
    x: marginX + 16,
    y: headerY + 28,
    width: 128,
    height: 44
  }
)

const headerInfoWidth = 228
const headerInfoX =
  marginX + contentWidth - headerInfoWidth - 14
const headerInfoY =
  headerY + 16

drawCard(
  headerInfoX,
  headerInfoY,
  headerInfoWidth,
  headerHeight - 28,
  rgb(0.96,0.98,1)
)

page.drawText(
  "RACHUNEK",
  {
    x: headerInfoX + 14,
    y: headerInfoY + 65,
    size: 16,
    font: bold,
    color: brandBlue
  }
)

page.drawText(
  receiptNumber,
  {
    x: headerInfoX + 14,
    y: headerInfoY + 47,
    size: 11,
    font: bold,
    color: textDark
  }
)

page.drawText(
  `Data wystawienia: ${issuedDate}`,
  {
    x: headerInfoX + 14,
    y: headerInfoY + 30,
    size: 9.8,
    font,
    color: textMuted
  }
)

page.drawText(
  `Numer rezerwacji: ${reservation}`,
  {
    x: headerInfoX + 14,
    y: headerInfoY + 14,
    size: 9.8,
    font,
    color: textMuted,
    maxWidth: headerInfoWidth - 24,
    lineHeight: 12
  }
)

// ===== SEKCJA 2: SPRZEDAWCA / NABYWCA =====
cursorY = headerY - 18

const columnsGap = 16
const columnWidth =
  (contentWidth - columnsGap) / 2
const cardsHeight = 136
const cardsY =
  cursorY - cardsHeight

drawCard(
  marginX,
  cardsY,
  columnWidth,
  cardsHeight
)

drawCard(
  marginX + columnWidth + columnsGap,
  cardsY,
  columnWidth,
  cardsHeight
)

page.drawText(
  "SPRZEDAWCA",
  {
    x: marginX + 14,
    y: cardsY + cardsHeight - 22,
    size: 11,
    font: bold,
    color: brandBlue
  }
)

drawCardLines(
  sellerLines,
  marginX + 14,
  cardsY + cardsHeight - 40,
  columnWidth - 24
)

const buyerX =
  marginX + columnWidth + columnsGap

page.drawText(
  "NABYWCA",
  {
    x: buyerX + 14,
    y: cardsY + cardsHeight - 22,
    size: 11,
    font: bold,
    color: brandBlue
  }
)

drawCardLines(
  buyerLines,
  buyerX + 14,
  cardsY + cardsHeight - 40,
  columnWidth - 24
)

// ===== SEKCJA 3: SZCZEGÓŁY TRANSAKCJI =====
cursorY = cardsY - 20

page.drawText(
  "SZCZEGÓŁY TRANSAKCJI",
  {
    x: marginX,
    y: cursorY,
    size: 12.5,
    font: bold,
    color: textDark
  }
)

const tableTop =
  cursorY - 16

const transactionRows:
  Array<[string, string]> = [
    ["Numer rezerwacji", reservation],
    [
      "Klasa pojazdu",
      booking.car_classes?.class_code || "-"
    ],
    ["Status płatności", paymentStatus],
    [
      "Payment Intent",
      paymentIntent.length > 42
        ? paymentIntent.slice(0, 42) + "..."
        : paymentIntent
    ],
    ["Data płatności", paymentDate]
  ]

const tableHeaderHeight = 30
const tableRowHeight = 28
const tableHeight =
  tableHeaderHeight +
  transactionRows.length * tableRowHeight
const tableBottom =
  tableTop - tableHeight
const splitX =
  marginX + contentWidth * 0.44

drawCard(
  marginX,
  tableBottom,
  contentWidth,
  tableHeight,
  rgb(1,1,1)
)

page.drawRectangle({
  x: marginX,
  y: tableTop - tableHeaderHeight,
  width: contentWidth,
  height: tableHeaderHeight,
  color: lightGray
})

page.drawLine({
  start: { x: splitX, y: tableBottom },
  end: { x: splitX, y: tableTop },
  thickness: 1,
  color: borderGray
})

page.drawText(
  "Opis",
  {
    x: marginX + 12,
    y: tableTop - 20,
    size: 10.5,
    font: bold,
    color: textDark
  }
)

page.drawText(
  "Wartość",
  {
    x: splitX + 12,
    y: tableTop - 20,
    size: 10.5,
    font: bold,
    color: textDark
  }
)

transactionRows.forEach(
  ([label, value], index) => {
    const rowTop =
      tableTop -
      tableHeaderHeight -
      index * tableRowHeight
    const rowY =
      rowTop - tableRowHeight

    page.drawLine({
      start: { x: marginX, y: rowY },
      end: { x: marginX + contentWidth, y: rowY },
      thickness: 1,
      color: borderGray
    })

    page.drawText(
      label,
      {
        x: marginX + 12,
        y: rowTop - 18,
        size: 10.2,
        font,
        color: textDark
      }
    )

    page.drawText(
      value,
      {
        x: splitX + 12,
        y: rowTop - 18,
        size: 10.2,
        font: label === "Payment Intent" ? font : bold,
        color: textDark,
        maxWidth: marginX + contentWidth - (splitX + 24),
        lineHeight: 12
      }
    )
  }
)

// ===== SEKCJA 4: PODSUMOWANIE =====
cursorY = tableBottom - 24

page.drawLine({
  start: { x: marginX, y: cursorY },
  end: { x: marginX + contentWidth, y: cursorY },
  thickness: 2,
  color: brandBlue
})

const summaryHeight = 86
const summaryY =
  cursorY - summaryHeight - 10

drawCard(
  marginX,
  summaryY,
  contentWidth,
  summaryHeight,
  rgb(0.95,0.98,1)
)

page.drawText(
  "KWOTA DO ZAPŁATY",
  {
    x: marginX + 16,
    y: summaryY + 52,
    size: 11,
    font: bold,
    color: textMuted
  }
)

page.drawText(
  `${payment.amount} PLN`,
  {
    x: marginX + 16,
    y: summaryY + 18,
    size: 27,
    font: bold,
    color: brandBlue
  }
)

// ===== SEKCJA 5: INFORMACJE =====
const infoBoxHeight = 62
const infoBoxY =
  summaryY - infoBoxHeight - 14

drawCard(
  marginX,
  infoBoxY,
  contentWidth,
  infoBoxHeight,
  lightGray
)

page.drawText(
  "Rachunek dotyczy opłaty rezerwacyjnej Ride24.",
  {
    x: marginX + 14,
    y: infoBoxY + 38,
    size: 10,
    font,
    color: textMuted
  }
)

page.drawText(
  "Płatność została zrealizowana online.",
  {
    x: marginX + 14,
    y: infoBoxY + 22,
    size: 10,
    font,
    color: textMuted
  }
)

// ===== SEKCJA 6: STOPKA =====
const footerLineY = 84

page.drawLine({
  start: { x: marginX, y: footerLineY },
  end: { x: marginX + contentWidth, y: footerLineY },
  thickness: 1,
  color: borderGray
})

page.drawText(
  "Dziękujemy za skorzystanie z Ride24.",
  {
    x: marginX,
    y: 62,
    size: 10,
    font: bold,
    color: textDark
  }
)

page.drawText(
  "Zapraszamy ponownie na Ride24.pl",
  {
    x: marginX,
    y: 48,
    size: 10,
    font,
    color: textDark
  }
)

page.drawText(
  "Dokument wygenerowany automatycznie przez system Ride24.",
  {
    x: marginX,
    y: 32,
    size: 9,
    font,
    color: textMuted
  }
)

const pdfBytes =
  await pdfDoc.save()

const filePath =
  `receipts/${receiptNumber}.pdf`

await supabase.storage
  .from("receipts")
  .upload(
    filePath,
    pdfBytes,
    {
      contentType:"application/pdf",
      upsert:true
    }
  )

await supabase
  .from("receipts")
  .insert({
    booking_id: booking.id,
    user_id: booking.client_id,
    receipt_number: receiptNumber,
    pdf_url: filePath
  })

await supabase
  .from("bookings")
  .update({
    receipt_generated: true
  })
  .eq("id", booking.id)

console.log(
  "Receipt READY:",
  receiptNumber
)

return new Response(
  JSON.stringify({
    ok:true,
    receipt_number:receiptNumber
  }),
  {
    headers: jsonHeaders
  }
)
} catch (err: any) {
  console.error(err)

  return new Response(
    JSON.stringify({
      error: err.message
    }),
    {
      status: 500,
      headers: jsonHeaders
    }
  )
}
})
