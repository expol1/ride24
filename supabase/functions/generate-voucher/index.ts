import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib"

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok")
  }

  try {
    const body = await req.json()
    console.log("Webhook payload:", body)

    const booking_id = body.booking_id || body.record?.id || body.id

    if (!booking_id) {
      console.error("Brak ID w payloadzie")
      return new Response("Missing booking_id", { status: 400 })
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // 1. Pobieranie danych z bazy
    const { data: booking, error } = await supabase
      .from("bookings")
      .select(`
  id,
  status,
  reservation_code,
  start_date,
  end_date,
  pickup_time,
  return_time,
  commission_snapshot,
  partner_net_price_snapshot,
  partner_currency,

  deposit_snapshot,
  mileage_limit_snapshot,
  driver_included_snapshot,
  driver_hours_snapshot,

  profiles(name,email,phone),
  partners(company_name,phone,emergency_phone), 
  pickup_location:partner_locations!pickup_location_id(location_name),
  car_classes(class_code)
`)
      .eq("id", booking_id)
      .single()

    if (error || !booking) {
      console.error("Booking fetch error:", error)
      return new Response("Booking not found", { status: 404 })
    }

    if (booking.status !== "paid") {
      console.log(`Ignored: status in DB is '${booking.status}', expected 'paid'`)
      return new Response("Ignored: status not paid", { status: 200 })
    }

    const { data: existingVoucher } = await supabase
      .from("vouchers")
      .select("id")
      .eq("booking_id", booking_id)
      .maybeSingle()

    if (existingVoucher) {
      console.log("Voucher already exists")
      return new Response("Voucher exists", { status: 200 })
    }

    const reservation = booking.reservation_code || booking.id.substring(0,8).toUpperCase()
    const verifyUrl = `https://ride24.pl/verify/${reservation}`

    // 2. Generowanie PDF
    const pdfDoc = await PDFDocument.create()
    const page = pdfDoc.addPage([600, 800])

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    const brandBlue = rgb(0.06, 0.22, 0.42)   
    const brandGreen = rgb(0.45, 0.85, 0.25)  
    const textDark = rgb(0.2, 0.2, 0.2)       
    const textGray = rgb(0.4, 0.4, 0.4)       
    const lightGray = rgb(0.9, 0.9, 0.9)      

    const labelX = 50
    const valueX = 250 

    // --- HEADER ---
    page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: brandBlue })
    page.drawRectangle({ x: 0, y: 695, width: 600, height: 5, color: brandGreen })
    // 🔥 POBIERANIE I OSADZANIE LOGO
    const logoUrl = "https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png";
    const logoBytes = await fetch(logoUrl).then(res => res.arrayBuffer());
    const logoImage = await pdfDoc.embedPng(logoBytes);

    page.drawImage(logoImage, {
  x: 50,
  y: 725,
  width: 130,
  height: 45
});

    
    page.drawText("RENTAL VOUCHER / VOUCHER", { x: 300, y: 755, size: 14, font: bold, color: rgb(1, 1, 1) })
page.drawText(`Res / Nr: ${reservation}`, { x: 300, y: 735, size: 12, font, color: rgb(0.8, 0.8, 0.9) })
    let y = 640

    // --- CLIENT DETAILS ---
    page.drawText("CLIENT DETAILS / DANE KLIENTA", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText(`Name / Imie i nazwisko:`, { x: labelX, y, size: 12, font, color: textGray })
    const safeName = (booking.profiles?.name ?? "-").normalize("NFD").replace(/[\u0300-\u036f\u0141\u0142]/g, "l")
    page.drawText(`${safeName}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText(`Phone / Telefon:`, { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText(`Email / E-mail:`, { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.profiles?.email || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    y -= 25
    page.drawLine({ start: { x: 50, y }, end: { x: 550, y }, thickness: 1, color: lightGray })
    y -= 30

    // --- VEHICLE & RENTAL INFO ---
    page.drawText("VEHICLE & RENTAL INFO / POJAZD I WYNAJEM", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Class / Klasa:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.car_classes?.class_code || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("Pickup / Miejsce odbioru:", { x: labelX, y, size: 12, font, color: textGray })
    const safeLocation = (booking.pickup_location?.location_name ?? "-").normalize("NFD").replace(/[\u0300-\u036f\u0141\u0142]/g, "l")
    page.drawText(`${safeLocation}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    
    const pTime = booking.pickup_time ? ` ${booking.pickup_time.substring(0,5)}` : "";
    const rTime = booking.return_time ? ` ${booking.return_time.substring(0,5)}` : "";

    y -= 18
    page.drawText("Start / Odbior:", { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.start_date}${pTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText("End / Zwrot:", { x: labelX, y, size: 12, font, color: textGray })
page.drawText(`${booking.end_date}${rTime}`, { x: valueX, y, size: 12, font: bold, color: textDark })

y -= 25

    page.drawText("RENTAL DETAILS / SZCZEGÓŁY WYNAJMU", { 
      x: labelX, 
      y, 
      size: 12, 
      font: bold, 
      color: textGray 
    })

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

    // --- KIEROWCA (Warunkowo) ---
    if (booking.driver_included_snapshot) {
      y -= 18
      page.drawText("Driver / Kierowca:", { x: labelX, y, size: 12, font, color: textGray })

      const hours = booking.driver_hours_snapshot 
        ? ` (${booking.driver_hours_snapshot}h)` 
        : ""

      page.drawText(
        `Included${hours} / W cenie${hours}`, 
        { x: valueX, y, size: 12, font: bold, color: brandBlue } // brandBlue
      )
    }
   

    y -= 30

    // --- PAYMENT BOX ---
    page.drawRectangle({ x: 40, y: y - 75, width: 520, height: 100, color: rgb(0.96, 0.97, 0.98) }) 
    page.drawText("PAYMENT SUMMARY / PODSUMOWANIE PLATNOSCI", { x: 60, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText("Paid online / Oplacono online:", { x: 60, y, size: 12, font, color: textGray })
    page.drawText(`${booking.commission_snapshot || 0} PLN`, { x: 300, y, size: 12, font: bold, color: textDark })
    y -= 22
    page.drawText("To pay at pickup / Do zaplaty na miejscu:", { x: 60, y, size: 12, font, color: textGray })
    page.drawText(
      `${booking.partner_net_price_snapshot || 0} ${booking.partner_currency || "EUR"}`, 
      { x: 300, y, size: 14, font: bold, color: rgb(0.1, 0.6, 0.1) } 
    )

    y -= 65

    // --- RENTAL PARTNER ---
    page.drawText("RENTAL PARTNER / WYPOZYCZALNIA", { x: labelX, y, size: 12, font: bold, color: textGray })
    y -= 25
    page.drawText(`Company / Firma:`, { x: labelX, y, size: 12, font, color: textGray })
    const safeCompany = (booking.partners?.company_name ?? "-").normalize("NFD").replace(/[\u0300-\u036f\u0141\u0142]/g, "l")
    page.drawText(`${safeCompany}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText(`Phone / Telefon:`, { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.partners?.phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })
    y -= 18
    page.drawText(`Emergency / Tel. alarmowy:`, { x: labelX, y, size: 12, font, color: textGray })
    page.drawText(`${booking.partners?.emergency_phone || "-"}`, { x: valueX, y, size: 12, font: bold, color: textDark })

    // --- VERIFY LINK ---
    page.drawLine({ start: { x: 50, y: 120 }, end: { x: 550, y: 120 }, thickness: 1, color: lightGray })
    page.drawText("Verify this reservation online / Zweryfikuj rezerwacje online:", { x: 50, y: 100, size: 10, font, color: textGray })
    page.drawText(verifyUrl, { x: 50, y: 85, size: 10, font: bold, color: brandBlue })

    // --- FOOTER ---
    page.drawText("Please present this voucher when picking up the vehicle.", { x: 50, y: 50, size: 10, font, color: textGray })
    page.drawText("Prosimy o okazanie tego vouchera przy odbiorze pojazdu.", { x: 50, y: 38, size: 10, font, color: textGray })

    const pdfBytes = await pdfDoc.save()
    const filePath = `vouchers/${reservation}.pdf`

    // 3. Upload do Storage
    const { error: uploadError } = await supabase.storage
      .from("vouchers")
      .upload(filePath, pdfBytes, {
        contentType: "application/pdf",
        upsert: false 
      })

    if (uploadError) {
      throw uploadError
    }

    // 4. Zapis do bazy
    await supabase.from("vouchers").insert({
      booking_id: booking.id,
      reservation_code: reservation,
      pdf_path: filePath
    })

    console.log("Voucher generated:", reservation)

    // ====================================================================
    // --- KROK 3: WYWOŁANIE WYSYŁKI MAILA (POPRAWIONA METODA INVOKE) ---
    // ====================================================================
    console.log(`Wywołuję funkcję send-booking-email dla rezerwacji: ${booking_id}`);

    const { data: invokeData, error: invokeError } = await supabase.functions.invoke("send-booking-email", {
      body: { booking_id: booking_id },
    });

    if (invokeError) {
      console.error("Uwaga: Voucher wygenerowany, ale funkcja email zwróciła błąd:", invokeError);
    } else {
      console.log("Funkcja mailowa wywołana pomyślnie. Odpowiedź:", invokeData);
    }

    return new Response(JSON.stringify({ ok: true }))

  } catch (err: any) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})