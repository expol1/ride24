import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js"

const getBaseTemplate = (title: string, content: string, buttonText?: string, buttonUrl?: string) => `
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: 'Inter', -apple-system, sans-serif; background: #F8FAFC; color: #0F172A; margin: 0; padding: 0; }
  .wrapper { width: 100%; padding: 40px 0; background: #F8FAFC; }
  .container { 
    max-width: 600px; margin: 0 auto; background: #ffffff; 
    border-radius: 20px; overflow: hidden; 
    box-shadow: 0 15px 35px rgba(30, 58, 138, 0.1); 
    border: 1px solid #E2E8F0;
    border-top: 8px solid #73D700; /* Flagowy zielony pasek Ride24 */
  }
  .header { padding: 32px; text-align: center; background: #1E3A8A; } /* Ciemny granat z Twojego headeru */
  .content { padding: 40px 35px; line-height: 1.6; }
  .footer { padding: 25px; text-align: center; font-size: 13px; color: #94A3B8; background: #0F172A; border-top: 1px solid #1E293B; }
  
  h1 { font-size: 24px; font-weight: 800; color: #1E3A8A; margin-top: 0; text-align: center; }
  p { margin-bottom: 22px; font-size: 16px; color: #334155; }
  
  /* PRZYCISK RIDE24 GREEN */
  .btn { 
    display: inline-block; padding: 16px 32px; 
    background: #73D700; color: #ffffff !important; 
    text-decoration: none; border-radius: 12px; 
    font-weight: 800; font-size: 16px;
    box-shadow: 0 6px 20px rgba(115, 215, 0, 0.3);
  }
  
  /* RAMKA NA KOD (JASNA ZIELEŃ) */
  .highlight-box { 
    background: #F1FCE3; border: 1px solid rgba(115, 215, 0, 0.2); 
    padding: 22px; border-radius: 16px; margin-bottom: 26px; text-align: center; 
  }
  .label { font-size: 11px; font-weight: 800; text-transform: uppercase; color: #64748B; margin-bottom: 4px; letter-spacing: 0.5px; }
  .value { font-size: 20px; font-weight: 800; color: #1E3A8A; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/assets/bez.png" width="160" alt="Ride24">
      </div>
      <div class="content">
        <h1>${title}</h1>
        ${content}
        ${buttonText && buttonUrl ? `<div style="text-align:center;margin-top:35px"><a href="${buttonUrl}" class="btn">${buttonText}</a></div>` : ''}
      </div>
      <div class="footer">
        &copy; 2026 Ride24.pl — Samochody z różnych zakątków świata.<br>
        Twoje bezstresowe podróże zaczynają się tutaj.
      </div>
    </div>
  </div>
</body>
</html>
`

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok")

  // drain body (edge stability)
  try { await req.json() } catch (_) {}

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  )

  let processedInThisSession = 0

  // 🔥 START PĘTLI WHILE - Przetwarzamy kolejkę do zera
  while (true) {

    const { data: queue, error: fetchError } = await supabase
      .from("email_logs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(10)

    if (fetchError || !queue || queue.length === 0) {
      break
    }

    console.log("Batch size:", queue.length);

    for (const log of queue) {
      try {
        // 🔒 ATOMIC LOCK
        const { data: lock } = await supabase
          .from("email_logs")
          .update({ status: "processing" })
          .eq("id", log.id)
          .eq("status", "queued")
          .select()

        if (!lock || lock.length === 0) {
          console.log("SKIP LOCKED:", log.id)
          continue
        }

        console.log("PROCESSING:", log.id)

        const { data: booking, error: dbError } = await supabase
          .from("bookings")
          .select(`
            *,
            profiles!fk_client(email),
            partners!bookings_partner_id_fkey(email),
            car_classes!bookings_car_class_id_fkey(class_code)
          `)
          .eq("id", log.booking_id)
          .single()

        if (dbError || !booking) {
          console.error("DB ERROR:", dbError?.message)

          await supabase
            .from("email_logs")
            .update({ status: "failed" })
            .eq("id", log.id)

          continue
        }

        let subject = ""
        let html = ""

        switch (log.type) {
          // 1. DLA KLIENTA: Prośba o wpłatę (PL)
          case "client_payment_required":
            subject = `Potwierdź rezerwację ${booking.reservation_code}`
            html = getBaseTemplate(
              "Twoja rezerwacja czeka!",
              `<p>Dobra wiadomość! Wypożyczalnia zaakceptowała Twoje zapytanie.</p>
               <div class="highlight-box">
                 <div class="label">Numer rezerwacji</div>
                 <div class="value">${booking.reservation_code}</div>
               </div>
               <p>Aby potwierdzić rezerwację i zablokować auto, prosimy o dokonanie płatności online w ciągu 24h.</p>`,
              "Opłać rezerwację",
              `https://ride24.pl/panel?id=${booking.id}`
            )
            break

          // 2. DLA KLIENTA: Potwierdzenie i Voucher (PL)
          case "booking_confirmation":
            subject = `Ride24 – Twoja rezerwacja została potwierdzona`
            html = getBaseTemplate(
              "Twoja rezerwacja została opłacona 🎉",
              `<p>Świetna wiadomość! Twoja płatność została pomyślnie zaksięgowana. Rezerwacja jest już w pełni potwierdzona, a auto zarezerwowane na Twój termin.</p>
               <div class="highlight-box">
                 <div class="label">Kod rezerwacji</div>
                 <div class="value">${booking.reservation_code}</div>
               </div>
               <p>Twój voucher PDF oraz szczegóły odbioru pojazdu są już dostępne w panelu klienta. Prosimy o okazanie vouchera (na telefonie lub wydrukowanego) przy odbiorze auta.</p>
               <p style="margin-top: 30px;"><b>Dziękujemy za zaufanie!</b> Życzymy bezpiecznej podróży oraz samych udanych przejazdów. Będzie nam bardzo miło gościć Cię u nas ponownie.</p>`,
              "Przejdź do panelu i pobierz voucher",
              `https://ride24.pl/panel?reservation=${booking.reservation_code}`
            )
            break

          // 3. DLA PARTNERA: Nowe zapytanie (EN)
          case "partner_new_request":
            subject = `New booking request: ${booking.reservation_code}`
            html = getBaseTemplate(
              "New Booking Request",
              `<p>You have received a new booking request for car class: <b>${booking.car_classes?.class_code || "-"}</b>.</p>
               <div class="highlight-box">
                 <div class="label">Reservation Code</div>
                 <div class="value">${booking.reservation_code}</div>
               </div>
               <p>Please log in to your dashboard to accept or decline this request.</p>`,
              "Open Partner Dashboard",
              "https://ride24.pl/partner-dashboard"
            )
            break

          // 4. DLA PARTNERA: Klient potwierdził (EN)
          case "partner_booking_confirmed":
            subject = `Booking confirmed – ${booking.reservation_code}`
            html = getBaseTemplate(
              "Booking Confirmed",
              `<p>The client has officially confirmed the reservation: <b>${booking.reservation_code}</b>.</p>
               <div class="highlight-box">
                 <div class="label">Reservation Code</div>
                 <div class="value">${booking.reservation_code}</div>
                 <div class="label" style="margin-top:10px">Car Class</div>
                 <div class="value">${booking.car_classes?.class_code || "-"}</div>
               </div>
               <p>Please prepare the vehicle for the scheduled pickup. Full reservation details are available in your dashboard.</p>
               <p>Thank you for your partnership!</p>`,
              "Open Partner Dashboard",
              "https://ride24.pl/partner-dashboard"
            )
            break

          default:
            console.log("SKIP TYPE:", log.type)
            await supabase.from("email_logs").update({ status: "failed" }).eq("id", log.id)
            continue
        }

        // 🔥 PRECYZYJNE KIEROWANIE MAILI
        let finalEmail = log.email; 

        if (!finalEmail) {
          if (log.type.startsWith("partner_")) {
            finalEmail = booking.partners?.email;
          } else {
            finalEmail = booking.profiles?.email;
          }
        }

        console.log("EMAIL TARGET:", log.id, finalEmail);

        // ✅ walidacja email
        if (!finalEmail || typeof finalEmail !== "string") {
          console.error("NO EMAIL:", log.id)

          await supabase
            .from("email_logs")
            .update({ status: "failed" })
            .eq("id", log.id)

          continue
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "Ride24 <noreply@ride24.pl>",
            to: finalEmail,
            subject,
            html,
            headers: {
              "Idempotency-Key": log.id
            }
          }),
          signal: controller.signal
        })

        // ✅ CLEAR TIMEOUT po fetchu
        clearTimeout(timeout);

        if (res.ok) {
          console.log("SENT:", finalEmail)

          await supabase
            .from("email_logs")
            .update({ status: "sent" })
            .eq("id", log.id)
          
          processedInThisSession++

        } else {
          const err = await res.text()
          console.error("RESEND ERROR:", err)

          await supabase
            .from("email_logs")
            .update({ status: "failed" })
            .eq("id", log.id)
        }

      } catch (e: any) {
        if (e.name === "AbortError") {
          console.error("TIMEOUT:", log.id);
        } else {
          console.error("ERROR:", e);
        }

        await supabase
          .from("email_logs")
          .update({ status: "failed" })
          .eq("id", log.id)
      }
    } // Koniec pętli FOR

  } // Koniec pętli WHILE

  return new Response(`DONE. Processed: ${processedInThisSession}`)
})