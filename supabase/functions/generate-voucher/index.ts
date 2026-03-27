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
    const { data: booking } = await supabase
      .from("bookings")
      .select(`
        *,
        profiles(name,email,phone),
        partners(company_name,phone,emergency_phone), 
        pickup_location_join:partner_locations!pickup_location_id(location_name),
        car_classes(class_code)
      `)
      .eq("id", booking_id)
      .single()

    if (!booking || booking.status !== "paid") {
      return new Response("Ignored", { status: 200 })
    }

    // ===== VOUCHER ROW =====
    const { data: existing } = await supabase
      .from("vouchers")
      .select("id, status")
      .eq("booking_id", booking_id)
      .maybeSingle()

    if (!existing) {
      await supabase.from("vouchers").insert({
        booking_id,
        status: "generating"
      })
    } else {
      await supabase
        .from("vouchers")
        .update({ status: "generating" })
        .eq("booking_id", booking_id)
    }

    const reservation = booking.reservation_code || booking.id.slice(0,8).toUpperCase()

    // ✅ FIX VERIFY
    const verifyUrl = `https://ride24.pl/verify.html?code=${reservation}`

    // ✅ FIX PICKUP
    const pickup =
      booking.pickup_location_join?.location_name ||
      booking.pickup_location ||
      "-"

    // ✅ FIX KWOT
    const paid = booking.online_payment_pln || 0
    const pickupPay = booking.pickup_payment_partner_currency || 0

    // ===== PDF =====
    const pdfDoc = await PDFDocument.create()
    pdfDoc.registerFontkit(fontkit)

    const [regFont, boldFont, logoRes] = await Promise.all([
      supabase.storage.from("assets").download("fonts/Roboto-Regular.ttf"),
      supabase.storage.from("assets").download("fonts/Roboto-Medium.ttf"),
      supabase.storage.from("assets").download("bez.png")
    ])

    const font = await pdfDoc.embedFont(await regFont.data.arrayBuffer())
    const bold = await pdfDoc.embedFont(await boldFont.data.arrayBuffer())
    const logoImage = await pdfDoc.embedPng(await logoRes.data.arrayBuffer())

    const page = pdfDoc.addPage([600, 800])

    const brandBlue = rgb(0.06, 0.22, 0.42)
    const brandGreen = rgb(0.45, 0.85, 0.25)
    const textDark = rgb(0.2, 0.2, 0.2)
    const textGray = rgb(0.4, 0.4, 0.4)
    const lightGray = rgb(0.9, 0.9, 0.9)

    const labelX = 50
    const valueX = 250

    // ===== HEADER =====
    page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: brandBlue })
    page.drawRectangle({ x: 0, y: 695, width: 600, height: 5, color: brandGreen })

    page.drawImage(logoImage, { x: 50, y: 725, width: 130, height: 45 })

    page.drawText("RENTAL VOUCHER", { x: 300, y: 755, size: 14, font: bold, color: rgb(1,1,1) })
    page.drawText(`Res: ${reservation}`, { x: 300, y: 735, size: 12, font, color: rgb(0.8,0.8,0.9) })

    let y = 640

    // ===== CLIENT =====
    page.drawText("CLIENT", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Name:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.name || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Phone:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Email:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.email || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 25
    page.drawLine({ start: { x: 50, y }, end: { x: 550, y }, thickness: 1, color: lightGray })
    y -= 30

    // ===== RENTAL =====
    page.drawText("RENTAL", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Class:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.car_classes?.class_code || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 18
    page.drawText("Pickup:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${pickup}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    const pTime = booking.pickup_time ? ` ${booking.pickup_time.slice(0,5)}` : ""
    const rTime = booking.return_time ? ` ${booking.return_time.slice(0,5)}` : ""

    y -= 18
    page.drawText("Start:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.start_date}${pTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 18
    page.drawText("End:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.end_date}${rTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 30

    // ===== PAYMENT (TYLKO JEŚLI >0) =====
    if (paid > 0 || pickupPay > 0) {
      page.drawRectangle({ x: 40, y: y - 75, width: 520, height: 100, color: rgb(0.96,0.97,0.98) })
      page.drawText("PAYMENT", { x: 60, y, size: 12, font: bold, color: textGray })
      y -= 25

      if (paid > 0) {
        page.drawText("Paid online:", { x: 60, y, size: 12, font, color: textGray })
        page.drawText(`${paid} PLN`, { x: 300, y, size: 12, font: bold, color: textDark })
        y -= 20
      }

      if (pickupPay > 0) {
        page.drawText("To pay at pickup:", { x: 60, y, size: 12, font, color: textGray })
        page.drawText(`${pickupPay} ${booking.partner_currency}`, { x: 300, y, size: 14, font: bold, color: rgb(0.1,0.6,0.1) })
        y -= 20
      }
    }

    // ===== VERIFY =====
    page.drawLine({ start: { x: 50, y: 120 }, end: { x: 550, y: 120 }, thickness: 1, color: lightGray })
    page.drawText("Verify reservation:", { x: 50, y: 100, size: 10, font, color: textGray })
    page.drawText(verifyUrl, { x: 50, y: 85, size: 10, font: bold, color: brandBlue })

    const pdfBytes = await pdfDoc.save()
    const filePath = `vouchers/${reservation}.pdf`

    await supabase.storage.from("vouchers").upload(filePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: true
    })

    await supabase.from("vouchers").update({
      reservation_code: reservation,
      pdf_path: filePath,
      status: "ready"
    }).eq("booking_id", booking_id)

    console.log("Voucher READY:", reservation)

    await supabase.functions.invoke("send-booking-email", {
      body: { booking_id }
    })

    return new Response(JSON.stringify({ ok: true }))

  } catch (err: any) {
    console.error(err)

    if (booking_id && supabase) {
      await supabase
        .from("vouchers")
        .update({ status: "error" })
        .eq("booking_id", booking_id)
    }

    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})