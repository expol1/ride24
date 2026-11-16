/**
 * Isolated SANDBOX webhook probe. It records no events and mutates no Ride24 data.
 * The probe only establishes that Caravel can deliver correctly signed traffic.
 * Production dispatch, event dedup and booking reconciliation remain disabled.
 */
import {verifyCaravelSignature,parseCaravelWebhookEvent} from "./caravel-webhooks.ts";
const MAX_BYTES=32*1024;
const encoder=new TextEncoder();

/** @returns only a status and non-sensitive metadata, never a booking payload */
export async function inspectCaravelSandboxWebhook(input:{
  method:string;path:string;body:string;signature:string|null;secrets:string[];nowSecs?:number;
}):Promise<{status:number;accepted:boolean;reason:string;event_id?:string;revision?:number}> {
  if(input.method!=="POST")return {status:405,accepted:false,reason:"METHOD_NOT_ALLOWED"};
  if(typeof input.body!=="string" || encoder.encode(input.body).length>MAX_BYTES)
    return {status:413,accepted:false,reason:"BODY_TOO_LARGE"};
  if(!Array.isArray(input.secrets) || !input.secrets.some(x=>typeof x==="string"&&x.length>0))
    return {status:503,accepted:false,reason:"WEBHOOK_SECRET_NOT_CONFIGURED"};
  if(!await verifyCaravelSignature(input.signature,input.secrets,{method:"POST",path:input.path,body:input.body},
    {nowSecs:input.nowSecs}))
    return {status:401,accepted:false,reason:"BAD_SIGNATURE"};
  const event=parseCaravelWebhookEvent(input.body);
  if(!event)return {status:400,accepted:false,reason:"INVALID_EVENT"};
  return {status:202,accepted:true,reason:"VERIFIED_SANDBOX_EVENT",event_id:event.event_id,revision:event.revision};
}
