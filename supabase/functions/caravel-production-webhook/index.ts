// Production Caravel HMAC webhook: no Supabase JWT, but mandatory signature.
// NOT DEPLOYED. Deploy with verify_jwt=false only after configuring the current
// Caravel webhook signing secret and the restricted durable RPC.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {serviceClient} from "../_shared/ride24-security.ts";
import {loadPartnerCredentials} from "../_shared/partner-api.ts";
import {caravelProductionReadClient} from "../_shared/caravel-paid-fulfillment.ts";
import {handleCaravelProductionDelivery, CARAVEL_PRODUCTION_WEBHOOK_PATH} from "../_shared/caravel-production-webhook-delivery.mjs";
import {CARAVEL_PARTNER_ID} from "../_shared/caravel-release.ts";

const MAX_BYTES = 32768;
const respond = (status:number, body:Record<string,unknown>) => new Response(JSON.stringify(body), {
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"},
});
serve(async(req)=>{
  const route = new URL(req.url).pathname;
  if(req.method!=="POST" || (route!==CARAVEL_PRODUCTION_WEBHOOK_PATH && route!=="/caravel-production-webhook"))
    return respond(405,{accepted:false,reason:"METHOD_OR_PATH_INVALID"});
  const advertised=Number(req.headers.get("content-length")??"0");
  if(!Number.isFinite(advertised)||advertised<0||advertised>MAX_BYTES)
    return respond(413,{accepted:false,reason:"BODY_TOO_LARGE"});
  try {
    if(!req.body)return respond(400,{accepted:false,reason:"BODY_REQUIRED"});
    const reader=req.body.getReader();const parts:Uint8Array[]=[];let len=0;
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      len+=value.byteLength;
      if(len>MAX_BYTES){await reader.cancel().catch(()=>{});return respond(413,{accepted:false,reason:"BODY_TOO_LARGE"});}
      parts.push(value);
    }
    const all=new Uint8Array(len);let offset=0;
    for(const bytes of parts){all.set(bytes,offset);offset+=bytes.length;}
    const rawBody=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(all);
    const secrets=[Deno.env.get("CARAVEL_PRODUCTION_WEBHOOK_SECRET"),Deno.env.get("CARAVEL_PRODUCTION_WEBHOOK_SECRET_OLD")]
      .filter((s):s is string=>typeof s==="string"&&s.length>0);
    let db:ReturnType<typeof serviceClient>|null=null;
    const admin=()=> db ?? (db=serviceClient());
    let client:ReturnType<typeof caravelProductionReadClient>|null=null;
    const supplier=async()=>{
      if(client)return client;
      client=caravelProductionReadClient(await loadPartnerCredentials(admin(),CARAVEL_PARTNER_ID));
      return client;
    };
    const result=await handleCaravelProductionDelivery({
      method:req.method,path:CARAVEL_PRODUCTION_WEBHOOK_PATH,rawBody,
      signature:req.headers.get("X-Caravel-Signature"),secrets,
      fetchBooking:async(bookingId:string,supplierId:string)=>
        (await (await supplier()).bookingStatusSandbox(bookingId,supplierId)).data,
      record:async(e:Record<string,unknown>)=>{
        const {data,error}=await admin().rpc("caravel_record_verified_webhook_event",{
          p_event_id:e.event_id,p_event_type:e.event_type,p_occurred_at:e.occurred_at,
          p_operator_id:e.operator_id,p_supplier_id:e.supplier_id,
          p_supplier_booking_id:e.supplier_booking_id,p_external_ref:e.external_ref,
          p_event_revision:e.event_revision,p_fetched_revision:e.fetched_revision,
          p_sequence:e.sequence,p_provider_status:e.provider_status,
        });
        if(error)throw Error("CARAVEL_EVENT_RECORD_FAILED");
        return data;
      },
    });
    return respond(result.status,{accepted:result.accepted,reason:result.reason,
      ...(result.needs_reconciliation?{needs_reconciliation:true}:{})});
  } catch {
    return respond(503,{accepted:false,reason:"RETRYABLE_WEBHOOK_FAILURE"});
  }
});
