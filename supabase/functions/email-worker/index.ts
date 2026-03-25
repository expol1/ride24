import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js"

// Funkcja pomocnicza do budowania szablonu
const getBaseTemplate = (title: string, content: string, buttonText?: string, buttonUrl?: string) => `
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ride24</title>

<style>
body{font-family:'Inter',-apple-system,sans-serif;background:#F8FAFC;color:#0F172A;margin:0;padding:0}

img{max-width:100%;height:auto;display:block;margin:0 auto}

.wrapper{width:100%;padding:40px 0;background:#F8FAFC}

.container{
max-width:600px;
margin:0 auto;
background:#fff;
border-radius:18px;
overflow:hidden;
box-shadow:0 10px 25px rgba(0,0,0,.05);
border:1px solid #E2E8F0
}

.header{padding:36px;text-align:center;border-bottom:1px solid #F1F5F9}

.content{padding:42px 34px;line-height:1.6}

.footer{
padding:30px;
text-align:center;
font-size:13px;
color:#64748B;
background:#F8FAFC;
border-top:1px solid #F1F5F9
}

h1{
font-size:26px;
font-weight:800;
color:#1E3A8A;
margin-top:0;
text-align:center
}

p{margin-bottom:24px;font-size:16px;color:#334155}

.btn{
display:inline-block;
padding:15px 30px;
background:#2563EB;
color:#fff!important;
text-decoration:none;
border-radius:12px;
font-weight:700;
font-size:16px
}

.highlight-box{
background:#DCFCE7;
border:1px solid #BBF7D0;
padding:22px;
border-radius:14px;
margin-bottom:26px
}

.label{
font-size:11px;
font-weight:800;
text-transform:uppercase;
color:#64748B;
margin-bottom:4px
}

.value{
font-size:18px;
font-weight:700;
color:#0F172A
}
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
© 2026 Ride24.pl — Wypożyczalnia aut bez kaucji.<br>
Twoje bezstresowe podróże zaczynają się tutaj.
</div>

</div>
</div>
</body>
</html>
`

serve(async () => {

const supabase = createClient(
Deno.env.get("SUPABASE_URL")!,
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

const { data: queue } = await supabase
.from("email_logs")
.select("*")
.eq("status","queued")
.order("created_at",{ascending:true})
.limit(50)

if(!queue || queue.length===0) return new Response("Queue empty")

for(const log of queue){

try{

const { data: booking } = await supabase
.from("bookings")
.select("*")
.eq("id",log.booking_id)
.single()

if(!booking) continue

let subject=""
let html=""

switch(log.type){

/* =======================
   PARTNER EMAILS (EN)
======================= */

case "partner_new_request":

subject=`New booking request: ${booking.reservation_code}`

html=getBaseTemplate(
"New Booking Request",

`<p>Hello,</p>

<p>A new car rental request has been submitted for your fleet.</p>

<div class="highlight-box">
<div class="label">Reservation Code</div>
<div class="value">${booking.reservation_code}</div>

<div style="margin-top:12px"></div>

<div class="label">Car Class</div>
<div class="value">Class ${booking.class_code}</div>
</div>

<p>Please log in to your partner dashboard within 12 hours to accept or reject this request.</p>`,

"Open Partner Panel",
"https://ride24.pl/partner-dashboard"
)

break


case "partner_booking_confirmed":

subject=`Booking confirmed – ${booking.reservation_code}`

html=getBaseTemplate(
"Booking Confirmed",

`<p>Hello,</p>

<p>The customer has completed the online payment.</p>

<div class="highlight-box">
<div class="label">Reservation Code</div>
<div class="value">${booking.reservation_code}</div>
</div>

<p>Please prepare the vehicle for the scheduled pickup.</p>`,

"Open Partner Panel",
"https://ride24.pl/partner-dashboard"
)

break


case "partner_new_request_reminder":

subject=`Reminder: Booking ${booking.reservation_code}`

html=getBaseTemplate(
"Action Required",

`<p>Hello,</p>

<p>This booking request is still awaiting your decision and will expire soon.</p>

<div class="highlight-box">
<div class="label">Reservation Code</div>
<div class="value">${booking.reservation_code}</div>
</div>

<p>Please accept or reject the request in your partner panel.</p>`,

"Review Request",
"https://ride24.pl/partner-dashboard"
)

break


/* =======================
   CLIENT EMAILS (PL)
======================= */

case "client_payment_required":

subject=`Potwierdź rezerwację ${booking.reservation_code}`

html=getBaseTemplate(
"Twoja rezerwacja czeka!",

`<p>Dobra wiadomość! Wypożyczalnia zaakceptowała Twoje zapytanie.</p>

<div class="highlight-box">
<div class="label">Numer rezerwacji</div>
<div class="value">${booking.reservation_code}</div>
</div>

<p>Aby ostatecznie potwierdzić rezerwację i zablokować auto, prosimy o dokonanie płatności rezerwacyjnej online.</p>`,

"Opłać rezerwację",
`https://ride24.pl/panel?id=${booking.id}`
)

break


case "booking_confirmation":

subject=`Potwierdzenie i Voucher – ${booking.reservation_code}`

html=getBaseTemplate(
"Twoja podróż zaczyna się tutaj!",

`<p>Gratulacje! Płatność została zaksięgowana. Twoja rezerwacja jest już w pełni potwierdzona.</p>

<div class="highlight-box">
<div class="label">Kod rezerwacji</div>
<div class="value">${booking.reservation_code}</div>
</div>

<p>Twój voucher PDF jest gotowy do pobrania w panelu klienta. Nie musisz go drukować – wystarczy wersja na telefonie.</p>`,

"Pobierz Voucher",
"https://ride24.pl/panel"
)

break


case "booking_expired":

subject=`Rezerwacja ${booking.reservation_code} wygasła`

html=getBaseTemplate(
"Zapytanie wygasło",

`<p>Niestety Twoje zapytanie wygasło, ponieważ wypożyczalnia nie odpowiedziała w wymaganym czasie.</p>

<p>Zapraszamy do ponownego wyszukania – mamy wiele innych ofert bez kaucji!</p>`,

"Szukaj aut ponownie",
"https://ride24.pl/index.html"
)

break

default:
continue
}

const res = await fetch("https://api.resend.com/emails",{
method:"POST",
headers:{
"Authorization":`Bearer ${Deno.env.get("RESEND_API_KEY")}`,
"Content-Type":"application/json"
},
body:JSON.stringify({
from:"Ride24 <noreply@ride24.pl>",
to:log.email,
subject,
html
})
})

if(res.ok){
await supabase
.from("email_logs")
.update({status:"sent"})
.eq("id",log.id)
}

}catch(e){
console.error("Worker error",e)
}

}

return new Response("Emails processed")

})