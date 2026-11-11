// One-time acceptance of Renteon *demo* provider only. No AVIA production bookings.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serviceClient } from "../_shared/ride24-security.ts";
import { loadPartnerCredentials } from "../_shared/partner-api.ts";
import {
  aggregatorAvailability, aggregatorBook, aggregatorStatus, aggregatorCancel,
} from "../_shared/renteon-aggregator.ts";
const PARTNER = "91e04805-31da-4242-9e6f-b6075019d784";
const TABLE = "ride24_avia_bootstrap_jobs";
const respond = (v: unknown, status = 200) => new Response(JSON.stringify(v),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
const dateIn = (n: number) => new Date(Date.now()+n*86_400_000).toISOString().slice(0,10);
const code = (e: unknown) => e instanceof Error &&
  /^PARTNER_API_ERROR:[A-Za-z0-9_:.]{1,120}$/.test(e.message)
  ? e.message : "SANDBOX_ACCEPTANCE_FAILED";
const digest = async (v: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))),
  x=>x.toString(16).padStart(2,"0")
).join("");
serve(async(req)=>{
  if(req.method!=="POST")return respond({error:"METHOD_NOT_ALLOWED"},405);
  if(Number(req.headers.get("content-length")||0)>400)return respond({error:"REQUEST_TOO_LARGE"},413);
  const body=await req.json().catch(()=>null);
  if(typeof body?.job_id!=="string"||!/^[0-9a-f-]{36}$/.test(body.job_id)
    ||typeof body?.token!=="string"||!/^[0-9a-f]{64}$/.test(body.token)){
    return respond({error:"AUTH_REQUIRED"},401);
  }
  const admin=serviceClient();
  const {data:job,error:err}=await admin.from(TABLE).update({
    status:"running",consumed_at:new Date().toISOString(),
  }).eq("id",body.job_id).eq("token_hash",await digest(body.token))
    .eq("status","pending").is("consumed_at",null)
    .gt("expires_at",new Date().toISOString()).select("id").maybeSingle();
  if(err||!job?.id)return respond({error:"AUTH_REQUIRED"},401);
  let reference: string|null=null;
  let diagnostic:Record<string,unknown>={provider:"demo",production_provider_touched:false};
  try {
    const {data:partner,error:perr}=await admin.from("partners")
      .select("api_enabled,api_provider,discount_percent").eq("id",PARTNER).single();
    if(perr||partner?.api_enabled!==false||partner?.api_provider!=="renteon_aggregator"
      ||Number(partner?.discount_percent)!==0)throw new Error("AVIA_PARTNER_NOT_STAGED");
    const live=await loadPartnerCredentials(admin,PARTNER);
    if(live.renteon_provider_code!=="Avia")throw new Error("WRONG_LIVE_PROVIDER");
    const credentials={...live,renteon_provider_code:"demo"};
    const start=dateIn(9),end=dateIn(13);
    const avail=await aggregatorAvailability(credentials,{
      pickup_location_id:"GR-ATH-ATH",dropoff_location_id:"GR-ATH-ATH",
      pickup_date:start,return_date:end,pickup_time:"10:00",return_time:"10:00",
      currency:"EUR",
    });
    if(!avail.length)throw new Error("DEMO_NO_QUOTES");
    const offer=avail.find(x=>x.external_id==="MDMR")||avail[0];
    const rental=offer.public_price_total;
    if(!rental||rental<=0||offer.provider_quote_data?.provider_code!=="demo"){
      throw new Error("DEMO_QUOTE_INVALID");
    }
    diagnostic={...diagnostic,group:offer.external_id,rental_eur:rental,
      availability_offers:avail.length};
    const created=await aggregatorBook(credentials,{
      idempotency_key:"ride24:demo:"+job.id,
      ride24_booking_id:job.id,
      reservation_code:"R24-TEST-"+job.id.slice(0,8),
      vehicle_group_id:offer.external_id,
      pickup_location_id:"GR-ATH-ATH",
      dropoff_location_id:"GR-ATH-ATH",
      pickup_date:start,return_date:end,pickup_time:"10:00",return_time:"10:00",
      main_driver:{name:"Ride24 Sandbox Test",age:35},
      client_email:"ride24-sandbox@example.invalid",
      client_phone:null,
      currency:"EUR",partner_discount_percent:0,
      partner_amount:rental,
      provider_quote_data:offer.provider_quote_data,
    });
    reference=typeof created.booking_reference==="string"?created.booking_reference:null;
    if(!reference)throw new Error("DEMO_SAVE_NO_REFERENCE");
    diagnostic={...diagnostic,booking_created:true,reference,
      booking_status:created.status};
    const opened=await aggregatorStatus(credentials,reference);
    diagnostic={...diagnostic,status_read:true,read_status:opened.status};
    try {
      const cancelled=await aggregatorCancel(credentials,reference);
      diagnostic={...diagnostic,cancelled:cancelled.status==="cancelled"};
    } catch(cancelErr) {
      diagnostic={...diagnostic,cancelled:false,cancel_error:code(cancelErr)};
    }
    const passed=diagnostic.cancelled===true && diagnostic.status_read===true;
    await admin.from(TABLE).update({
      status:passed?"synced":"failed",result:diagnostic,
      error_code:passed?null:"SANDBOX_CANCEL_UNVERIFIED"
    }).eq("id",job.id);
    return respond({success:passed,...diagnostic},passed?200:409);
  }catch(e){
    const message=code(e);
    await admin.from(TABLE).update({
      status:"failed",error_code:message,result:diagnostic
    }).eq("id",job.id);
    console.error("renteon-sandbox-acceptance",message);
    return respond({success:false,error:message,...diagnostic},409);
  }
});
