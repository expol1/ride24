import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.0.0";
import { ride24RequireAdmin } from "./ride24-admin-auth.ts";

const headers={ "Content-Type":"application/json", "Access-Control-Allow-Origin":"https://ride24.pl",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
  "Access-Control-Allow-Methods":"GET,OPTIONS", "Cache-Control":"no-store" };
const send=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="GET" && req.method!=="POST")return send(405,{error:"Method not allowed"});
  const denied=await ride24RequireAdmin(req,headers);
  if(denied)return denied;
  const key=Deno.env.get("STRIPE_SECRET_KEY");
  if(!key)return send(503,{error:"Nie skonfigurowano odczytu Stripe."});
  const stripe=new Stripe(key,{apiVersion:"2023-10-16"});
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{
    auth:{persistSession:false,autoRefreshToken:false}});
  try{
    const {data:rows,error:dbError}=await admin.from("payments")
      .select("id,booking_id,stripe_session_id,amount,currency,status,bookings!inner(id,status,online_payment_pln)")
      .eq("status","paid").order("created_at",{ascending:false}).limit(1000);
    if(dbError)return send(503,{error:"Nie udało się odczytać księgi płatności."});
    if(!rows)return send(503,{error:"Brak danych płatności."});
    if(rows.length>=1000)return send(409,{error:"Limit kontroli 1000 płatności — potrzebne stronicowanie przed pełnym bilansem."});
    const seen=new Set<string>(),issues:string[]=[];
    const totals={gross:0,refunds:0,fees:0,net:0,verified:0,unverified:0,cancelled_paid:0,fee_missing:0,refund_pending:0};
    // Hard safety rule: unidentified or unverified payments never inflate displayed revenue.
    for(const p of rows){
      const id=p.stripe_session_id;
      if(!id||seen.has(id)){totals.unverified++;issues.push("Płatność bez identyfikatora lub z duplikatem sesji Stripe.");continue;}
      seen.add(id);
      try{
        const session=await stripe.checkout.sessions.retrieve(id);
        if(session.payment_status!=="paid" || !session.payment_intent || session.currency!=="pln" || session.amount_total==null){
          totals.unverified++;issues.push("Sesja nie jest potwierdzoną płatnością PLN.");continue;
        }
        const paymentIntentId=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent.id;
        const intent=await stripe.paymentIntents.retrieve(paymentIntentId,{expand:["latest_charge.balance_transaction"]});
        if(intent.status!=="succeeded" || intent.amount_received<=0){
          totals.unverified++;issues.push("Stripe nie potwierdził pobrania środków.");continue;
        }
        const amount=session.amount_total/100;
        if(Math.abs(Number(p.amount)-amount)>.02 || Math.abs(Number(p.bookings?.online_payment_pln??0)-amount)>.02){
          issues.push("Kwota rezerwacji/płatności różni się od kwoty Stripe.");
        }
        const refunds=await stripe.refunds.list({payment_intent:paymentIntentId,limit:100});
        if(refunds.has_more)throw new Error("REFUNDS_PAGINATION");
        const completedRefund=refunds.data.filter(r=>r.status==="succeeded").reduce((s,r)=>s+r.amount/100,0);
        totals.refund_pending+=refunds.data.filter(r=>r.status==="pending").length;
        const charge=intent.latest_charge && typeof intent.latest_charge!=="string"?intent.latest_charge:null;
        const balance=charge?.balance_transaction && typeof charge.balance_transaction!=="string"?charge.balance_transaction:null;
        let fee=0;
        if(balance?.currency==="pln")fee=balance.fee/100;
        else {totals.fee_missing++;issues.push("Nie udało się odczytać prowizji Stripe w PLN.");}
        totals.gross+=amount;totals.refunds+=completedRefund;totals.fees+=fee;totals.verified++;
        if(["cancelled","rejected"].includes(p.bookings?.status)&& completedRefund<amount-.01)
          totals.cancelled_paid++;
      }catch(e){
        totals.unverified++;
        issues.push(e instanceof Error && e.message==="REFUNDS_PAGINATION"?"Za dużo zwrotów w jednej płatności — wymaga sprawdzenia.":"Nie udało się zweryfikować sesji Stripe (sprawdź konfigurację lub połączenie).");
      }
    }
    for(const k of ["gross","refunds","fees"] as const)totals[k]=Math.round(totals[k]*100)/100;
    totals.net=Math.round((totals.gross-totals.refunds-totals.fees)*100)/100;
    return send(200,{currency:"PLN",totals,verified_at:new Date().toISOString(),
      complete:totals.unverified===0 && totals.fee_missing===0,
      issues:[...new Set(issues)].slice(0,15),
      note:"Dane Stripe; suma dla wszystkich potwierdzonych opłat, także dotyczących później anulowanych rezerwacji. Zwroty według statusu succeeded. Wymaga zgodności z raportem księgowym."});
  }catch{return send(503,{error:"Nie udało się uzgodnić transakcji ze Stripe. Licznik pozostaje niepotwierdzony."});}
});