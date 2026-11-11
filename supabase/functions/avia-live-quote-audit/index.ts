// One-time server-only AVIA quote audit. Availability/Create/Calculate only.
// NEVER calls /api/bookings/save on live AVIA. No real booking is created.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serviceClient } from "../_shared/ride24-security.ts";
import { loadPartnerCredentials, partnerApiRequest } from "../_shared/partner-api.ts";
import { aggregatorAvailability } from "../_shared/renteon-aggregator.ts";
const ID="91e04805-31da-4242-9e6f-b6075019d784", TABLE="ride24_avia_bootstrap_jobs";
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
const date=(n:number)=>new Date(Date.now()+n*86_400_000).toISOString().slice(0,10);
const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,"0")).join("");
const o=(x:unknown):Record<string,unknown>|null=>
  x!==null && typeof x==="object" && !Array.isArray(x)?x as Record<string,unknown>:null;
const number=(x:unknown)=>x==null?null:Number(x);
serve(async(req)=>{
 if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 if(Number(req.headers.get("content-length")||0)>400)return json({error:"REQUEST_TOO_LARGE"},413);
 const b=await req.json().catch(()=>null);
 if(typeof b?.job_id!=="string"||!/^[0-9a-f-]{36}$/.test(b.job_id)
  ||typeof b?.token!=="string"||!/^[a-f0-9]{64}$/.test(b.token))return json({error:"AUTH_REQUIRED"},401);
 const admin=serviceClient();
 const {data:job,error:err}=await admin.from(TABLE)
  .update({status:"running",consumed_at:new Date().toISOString()})
  .eq("id",b.job_id).eq("token_hash",await digest(b.token))
  .eq("status","pending").is("consumed_at",null)
  .gt("expires_at",new Date().toISOString()).select("id").maybeSingle();
 if(err||!job?.id)return json({error:"AUTH_REQUIRED"},401);
 const items:Record<string,unknown>[]=[];
 try{
  const {data:partner,error:perr}=await admin.from("partners")
   .select("api_enabled,api_provider,discount_percent").eq("id",ID).single();
  if(perr||partner?.api_enabled!==false||partner?.api_provider!=="renteon_aggregator"
    ||Number(partner.discount_percent)!==0)throw new Error("PARTNER_STAGE_INVALID");
  const c=await loadPartnerCredentials(admin,ID);
  if(c.renteon_provider_code!=="Avia")throw new Error("WRONG_PROVIDER");
  const pickup=date(9),dropoff=date(13);
  const offered=await aggregatorAvailability(c,{
   pickup_location_id:"HR-DUB-DBV",dropoff_location_id:"HR-DUB-DBV",
   pickup_date:pickup,return_date:dropoff,pickup_time:"10:00",return_time:"10:00",currency:"EUR"
  });
  if(offered.length<1)throw new Error("NO_LIVE_AVIA_QUOTES");
  const samples=[offered.find(x=>x.external_id==="MCMR"),offered.find(x=>x.external_id==="EDMR")].filter(Boolean).slice(0,2);
  if(samples.length<1)throw new Error("EXPECTED_SAMPLES_MISSING");
  for(const x of samples){
    if(!x)continue;
    const raw=o(x.provider_quote_data)?.offer;
    if(!o(raw))throw new Error("RAW_PROVIDER_QUOTE_MISSING");
    const create=o(await partnerApiRequest<unknown>(c,"/api/bookings/create",{
      method:"POST",body:raw
    }));
    if(!create)throw new Error("AVIA_CREATE_DRAFT_INVALID");
    const calc=o(await partnerApiRequest<unknown>(c,"/api/bookings/calculate",{
      method:"POST",body:{...create,
        ClientName:"Ride24 Quote Audit",
        ClientEmail:"ride24-quote-audit@example.invalid"
      }
    }));
    if(!calc)throw new Error("AVIA_CALCULATE_DRAFT_INVALID");
    const original=number(x.public_price_total),created=number(create.Total),calculated=number(calc.Total);
    const equal=original!==null&&created!==null&&calculated!==null
      &&Math.abs(original-created)<=0.02&&Math.abs(original-calculated)<=0.02;
    const result={group:x.external_id,model:x.model,
      availability_total_eur:original,create_total_eur:created,calculate_total_eur:calculated,
      amount_changed:!equal,prepaid:calc.Prepaid,provider:calc.Provider,
      excess:calc.Excess??null,deposit_field:calc.Deposit??null,
      service_count:Array.isArray(calc.Services)?calc.Services.length:null
    };
    items.push(result);
  }
  const allMatch=items.length>0&&items.every(x=>x.amount_changed===false&&x.prepaid===false&&x.provider==="Avia");
  const summary={provider:"Avia",live_booking_save_called:false,
    checked_samples:items.length,all_price_totals_match:allMatch,items};
  await admin.from(TABLE).update({status:allMatch?"synced":"failed",result:summary,
     error_code:allMatch?null:"PRODUCTION_QUOTE_TOTALS_MISMATCH"}).eq("id",job.id);
  return json({success:allMatch,...summary},allMatch?200:409);
 }catch(e){
  const msg=e instanceof Error?e.message:"UNKNOWN";
  const code=/^PARTNER_API_ERROR:[A-Z0-9_:.-]+$/.test(msg)?msg:"PRODUCTION_QUOTE_AUDIT_FAILED";
  await admin.from(TABLE).update({status:"failed",error_code:code,result:{items}}).eq("id",job.id);
  console.error("avia-quote-audit",code);
  return json({success:false,error:code,live_booking_save_called:false},409);
 }
});
