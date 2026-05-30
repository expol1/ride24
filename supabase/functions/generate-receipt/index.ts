import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { PDFDocument, rgb } from "https://esm.sh/pdf-lib"
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1"


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok")

  let booking_id: string | null = null
  let supabase: any = null

  try {
    const body = await req.json()
    booking_id = body.booking_id || body.record?.id || body.id

    if (!booking_id) {
      return new Response("Missing booking_id", { status: 400 })
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
  return new Response("Ignored", { status: 200 });
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


if (booking.receipt_generated) {
  return new Response(
    JSON.stringify({
      error: "Receipt already exists"
    }),
    { status: 409 }
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
  pdfDoc.addPage([600,800])

const brandBlue =
  rgb(0.06,0.22,0.42)

const brandGreen =
  rgb(0.45,0.85,0.25)

const lightGray =
  rgb(0.9,0.9,0.9)

// HEADER
page.drawRectangle({
  x:0,
  y:700,
  width:600,
  height:100,
  color:brandBlue
})

page.drawRectangle({
  x:0,
  y:695,
  width:600,
  height:5,
  color:brandGreen
})

page.drawImage(
  logoImage,
  {
    x:50,
    y:725,
    width:130,
    height:45
  }
)

page.drawText(
  "RACHUNEK",
  {
    x:380,
    y:755,
    size:18,
    font:bold,
    color:rgb(1,1,1)
  }
)

page.drawText(
  receiptNumber,
  {
    x:380,
    y:730,
    size:12,
    font,
    color:rgb(0.9,0.9,0.9)
  }
)

page.drawText(
  "Ride24.pl",
  {
    x:50,
    y:640,
    size:14,
    font:bold
  }
)

page.drawText(
  "Emilia Sowa",
  {
    x:50,
    y:620,
    size:11,
    font
  }
)

page.drawText(
  "ul. Przyszłości 38/3",
  {
    x:50,
    y:605,
    size:11,
    font
  }
)

page.drawText(
  "70-893 Szczecin",
  {
    x:50,
    y:590,
    size:11,
    font
  }
)

page.drawText(
  "Data wystawienia: " +
  new Date().toLocaleDateString("pl-PL"),
  {
    x:380,
    y:710,
    size:11,
    font,
    color:rgb(0.9,0.9,0.9)
  }
)

page.drawText(
  "Opłata rezerwacyjna Ride24",
  {
    x:50,
    y:550,
    size:12,
    font
  }
)

page.drawLine({
  start:{x:50,y:535},
  end:{x:550,y:535},
  thickness:1,
  color:lightGray
})

page.drawText(
  "Numer rezerwacji:",
  {
    x:50,
    y:500,
    size:12,
    font
  }
)

page.drawText(
  reservation,
  {
    x:250,
    y:500,
    size:12,
    font:bold
  }
)

page.drawText(
  "Klasa pojazdu:",
  {
    x:50,
    y:470,
    size:12,
    font
  }
)

page.drawText(
  booking.car_classes?.class_code || "-",
  {
    x:250,
    y:470,
    size:12,
    font:bold
  }
)

page.drawLine({
  start:{x:50,y:450},
  end:{x:550,y:450},
  thickness:1,
  color:lightGray
})


page.drawText(
  "Kwota:",
  {
    x:50,
    y:430,
    size:14,
    font:bold
  }
)
page.drawText(
  `${payment.amount} PLN`,
  {
    x:230,
    y:430,
    size:24,
    font:bold,
    color:brandBlue
  }
)

page.drawLine({
  start:{x:50,y:410},
  end:{x:550,y:410},
  thickness:1,
  color:lightGray
})

page.drawText(
  "Status:",
  {
    x:50,
    y:390,
    size:12,
    font
  }
)

page.drawText(
  "Opłacono online",
  {
    x:250,
    y:390,
    size:12,
    font:bold
  }
)

page.drawText(
  "Nr płatności:",
  {
    x:50,
    y:350,
    size:12,
    font
  }
)
const shortPaymentId =
  payment.stripe_session_id.length > 25
    ? payment.stripe_session_id.substring(0, 25) + "..."
    : payment.stripe_session_id

page.drawText(
  shortPaymentId,
  {
    x:250,
    y:350,
    size:10,
    font
  }
)

page.drawLine({
  start:{x:50,y:120},
  end:{x:550,y:120},
  thickness:1,
  color:lightGray
})

page.drawText(
  "Dziękujemy za rezerwację i zapraszamy ponownie do Ride24.",
  {
    x:50,
    y:90,
    size:10,
    font
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
  })
)
} catch (err: any) {
  console.error(err)

  return new Response(
    JSON.stringify({
      error: err.message
    }),
    { status: 500 }
  )
}
})

