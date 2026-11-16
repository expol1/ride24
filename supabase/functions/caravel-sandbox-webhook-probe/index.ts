// Caravel SANDBOX webhook connectivity probe — NOT a production receiver.
// Must be deployed with verify_jwt=false because provider requests have no
// Supabase JWT. Every POST is instead authenticated by Caravel's HMAC signature.
// No database writes, no partner activation, no bookings, no Stripe interactions.
// DANGER: never expose the webhook secret in a response, client log or report.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {inspectCaravelSandboxWebhook} from "../_shared/caravel-webhook-probe.ts";

const MAX_BODY_BYTES=32768;
const MAX_AGE_SECS=300;
const UNTIL=Date.parse("2026-11-20T20:00:00Z"); // expires automatically unless explicitly reviewed

serve(async(req)=>{
  if(Date.now()>UNTIL)return new Response(JSON.stringify({error:"WEBHOOK_PROBE_CLOSED"}),{status:410});
  if(req.method!=="POST")return new Response(JSON.stringify({error:"METHOD_NOT_ALLOWED"}),{status:405});
  const advertised=Number(req.headers.get("content-length")||0);
  if(Number.isFinite(advertised)&&advertised>MAX_BODY_BYTES)return new Response(JSON.stringify({error:"BODY_TOO_LARGE"}),{status:413});
  try {
    const raw=await req.text();
    const secrets=[
      Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET"),
      Deno.env.get("CARAVEL_SANDBOX_WEBHOOK_SECRET_OLD"),
    ].filter((x):x is string=>typeof x==="string"&&x.length>0);
    const result=await inspectCaravelSandboxWebhook({
      method:req.method,path:new URL(req.url).pathname,body:raw,
      signature:req.headers.get("X-Caravel-Signature"),secrets,
      nowSecs:Math.floor(Date.now()/1000),
    });
    // Replay is constrained by 300-second HMAC timestamp skew. This probe
    // intentionally does not update booking state or persist delivery events.
    const status=result.status;
    return new Response(JSON.stringify({accepted:result.accepted,reason:result.reason}),{
      status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},
    });
  }catch{
    return new Response(JSON.stringify({error:"WEBHOOK_PROBE_FAILED"}),{status:500});
  }
});
