// Caravel SANDBOX webhook receiver — UNDEPLOYED.
// MUST deploy only with verify_jwt=false (Caravel has no Supabase JWT) and
// with the independently configured HMAC secret + private RPC schema.
// HMAC is mandatory; no customer records, Ride24 bookings or Stripe touched.
// No successful processing if atomic RPC functions are absent.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {serviceClient} from "../_shared/ride24-security.ts";
import {CaravelClient} from "../_shared/caravel-sandbox-adapter.ts";
import {handleCaravelSandboxDelivery} from "../_shared/caravel-webhook-delivery.mjs";
import {createCaravelSandboxWebhookRepository} from "../_shared/caravel-webhook-repository.mjs";

const UNTIL=Date.parse("2026-11-20T20:00:00Z"); // hard expire after the short sandbox window
const MAX_BYTES=32768;
const json=(body:Record<string,unknown>,status:number)=>new Response(JSON.stringify(body),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"},
});
serve(async req=>{
  if(Date.now()>UNTIL)return json({accepted:false,reason:"SANDBOX_RECEIVER_CLOSED"},410);
  if(req.method!=="POST")return json({accepted:false,reason:"METHOD_NOT_ALLOWED"},405);
  const length=Number(req.headers.get("content-length")??"0");
  if(!Number.isFinite(length)||length<0||length>MAX_BYTES)
    return json({accepted:false,reason:"BODY_TOO_LARGE"},413);
  try{
    if(!req.body)return json({accepted:false,reason:"BODY_REQUIRED"},400);
    const reader=req.body.getReader();
    const pieces:Uint8Array[]=[];let bytes=0;
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_BYTES){
        await reader.cancel().catch(()=>{});
        return json({accepted:false,reason:"BODY_TOO_LARGE"},413);
      }
      pieces.push(value);
    }
    const joined=new Uint8Array(bytes);let off=0;
    for(const p of pieces){joined.set(p,off);off+=p.byteLength;}
    const rawBody=new TextDecoder("utf-8",{fatal:true}).decode(joined);
    const secrets=[
      Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET"),
      Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET_OLD"),
    ].filter((x):x is string=>typeof x==="string"&&x.length>0);
    const apiKey=Deno.env.get("CARAVEL_SANDBOX_API_KEY");
    if(!apiKey)return json({accepted:false,reason:"SANDBOX_API_KEY_NOT_CONFIGURED"},503);
    const client=new CaravelClient({apiKey,environment:"sandbox",timeoutMs:8000,retryMaxWaitMs:3000});
    // serviceClient is server-side only and never appears in responses.
    const result=await handleCaravelSandboxDelivery({
      method:req.method,path:new URL(req.url).pathname,rawBody,
      signature:req.headers.get("X-Caravel-Signature"),secrets,
      repository:createCaravelSandboxWebhookRepository(serviceClient()),
      fetchBooking:async (bookingId:string,supplierId:string)=>
        (await client.bookingStatusSandbox(bookingId,supplierId)).data,
    });
    return json({accepted:result.accepted,reason:result.reason,
      ...(result.needs_reconciliation?{needs_reconciliation:true}:{})},result.status);
  }catch{
    return json({accepted:false,reason:"RETRYABLE_RECEIVER_FAILURE"},503);
  }
});
