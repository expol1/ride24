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

    // 🔥 FIX 3: Bezpieczniejsze ?? zamiast ||
    const reservation = booking.reservation_code ?? booking.id.slice(0,8).toUpperCase()

    // ✅ FIX VERIFY
    const verifyUrl = `https://ride24.pl/verify.html?code=${reservation}`

    // ✅ FIX PICKUP
    const pickup =
      booking.pickup_location_join?.location_name ||
      booking.pickup_location ||
      "-"

    // ✅ FIX KWOT
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

    page.drawText("RENTAL VOUCHER / VOUCHER", { x: 300, y: 755, size: 14, font: bold, color: rgb(1,1,1) })
    page.drawText(`Res / Nr: ${reservation}`, { x: 300, y: 735, size: 12, font, color: rgb(0.8,0.8,0.9) })

    let y = 640

    // ===== CLIENT =====
    page.drawText("CLIENT DETAILS / DANE KLIENTA", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Name / Imię i nazwisko:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.name || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Phone / Telefon:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Email / E-mail:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.email || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 25
    page.drawLine({ start: { x: 50, y }, end: { x: 550, y }, thickness: 1, color: lightGray })
    y -= 30

    // ===== RENTAL =====
    page.drawText("VEHICLE & RENTAL INFO / POJAZD I WYNAJEM", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Class / Klasa:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.car_classes?.class_code || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 18
    page.drawText("Pickup / Miejsce odbioru:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${pickup}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    const pTime = booking.pickup_time ? ` ${booking.pickup_time.slice(0,5)}` : ""
    const rTime = booking.return_time ? ` ${booking.return_time.slice(0,5)}` : ""

    y -= 18
    page.drawText("Start / Odbiór:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.start_date}${pTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 18
    page.drawText("End / Zwrot:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.end_date}${rTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 25
    page.drawText("RENTAL DETAILS / SZCZEGÓŁY WYNAJMU", { x: labelX, y, size: 12, font: bold, color: textGray })

    // --- KAUCJA ---
    y -= 20
    page.drawText("Deposit / Kaucja:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(
      `${booking.deposit_snapshot || 0} ${booking.partner_currency || "EUR"}`, 
      { x: valueX, y, size: 12, font: bold, color: textDark }
    )

    // --- LIMIT KM ---
    y -= 18
    page.drawText("Mileage / Limit km:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(
      booking.mileage_limit_snapshot 
        ? `${booking.mileage_limit_snapshot} km/day` 
        : "Unlimited / Bez limitu",
      { x: valueX, y, size: 12, font: bold, color: textDark }
    )

    // --- KIEROWCA ---
    if (booking.driver_included_snapshot) {
      y -= 18
      page.drawText("Driver / Kierowca:", { x: labelX, y, size: 12, font, color: textGray })
      const hours = booking.driver_hours_snapshot ? ` (${booking.driver_hours_snapshot}h)` : ""
      page.drawText(`Included${hours} / W cenie${hours}`, { x: valueX, y, size: 12, font: bold, color: brandBlue })
    }

    y -= 30

    // ===== PAYMENT BOX (🔥 FIX 1: Pokazujemy tylko gdy do dopłaty jest > 0, wywalone info o PLN) =====
    if (pickupPay > 0) {
      page.drawRectangle({ x: 40, y: y - 55, width: 520, height: 80, color: rgb(0.96,0.97,0.98) })
      page.drawText("PAYMENT SUMMARY / PODSUMOWANIE PŁATNOŚCI", { x: 60, y, size: 12, font: bold, color: textGray })
      y -= 25
      
      page.drawText("To pay at pickup / Do zapłaty na miejscu:", { x: 60, y, size: 12, font, color: textGray })
      page.drawText(`${pickupPay} ${booking.partner_currency || "EUR"}`, { x: 300, y, size: 14, font: bold, color: rgb(0.1,0.6,0.1) })

      y -= 45 // margines po szarym tle
    }

    // ===== RENTAL PARTNER =====
    page.drawText("RENTAL PARTNER / WYPOŻYCZALNIA", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Company / Firma:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.partners?.company_name || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Phone / Telefon:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.partners?.phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Emergency / Tel. alarmowy:", { x: labelX, y, size: 12, font, color: textGray })
    
    // 🔥 FIX 2: Sprytny fallback dla numeru awaryjnego (jeśli null, daje zwykły phone)
    const emergencyPhone = booking.partners?.emergency_phone || booking.partners?.phone || "-";
    page.drawText(`${emergencyPhone}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    // ===== VERIFY =====
    page.drawLine({ start: { x: 50, y: 120 }, end: { x: 550, y: 120 }, thickness: 1, color: lightGray })
    page.drawText("Verify this reservation online / Zweryfikuj rezerwację online:", { x: 50, y: 100, size: 10, font, color: textGray })
    page.drawText(verifyUrl, { x: 50, y: 85, size: 10, font: bold, color: brandBlue })

    // ===== FOOTER =====
    page.drawText("Please present this voucher when picking up the vehicle.", { x: 50, y: 50, size: 10, font, color: textGray })
    page.drawText("Prosimy o okazanie tego vouchera przy odbiorze pojazdu.", { x: 50, y: 38, size: 10, font, color: textGray })

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