// Caravel SANDBOX silent-webhook poll — NOT DEPLOYED.
// Deploy only after separate SQL/RLS/security review. verify_jwt=false ONLY
// with a dedicated long x-internal-secret (no customer access).
// No production reads, no Stripe calls, no Ride24 booking mutations.
import {serve} from "https://deno.land/std@0.224.0/http/server.ts";
import {serviceClient,requireSecret} from "../_shared/ride24-security.ts";
import {CaravelClient} from "../_shared/caravel-sandbox-adapter.ts";
import {createCaravelSandboxWebhookRepository} from "../_shared/caravel-webhook-repository.mjs";
import {runCaravelSandboxPeriodicPoll} from "../_shared/caravel-sandbox-periodic.mjs";

const UNTIL=Date.parse("2026-11-20T20:00:00Z");
const json=(data:Record<string,unknown>,status:number)=>new Response(JSON.stringify(data),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"},
});
serve(async req=>{
  if(Date.now()>UNTIL)return json({error:"PERIODIC_POLL_CLOSED"},410);
  if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
  try{requireSecret(req,"x-internal-secret","CARAVEL_SANDBOX_PERIODIC_SECRET");}
  catch{return json({error:"AUTH_REQUIRED"},401);}
  const size=Number(req.headers.get("content-length")??"0");
  if(!Number.isFinite(size)||size<0||size>256)
    return json({error:"REQUEST_TOO_LARGE"},413);
  const body=await req.json().catch(()=>null);
  if(!body||typeof body!=="object"||Array.isArray(body)||
     Object.keys(body).length!==1||body.action!=="tick")
    return json({error:"BAD_REQUEST"},400);
  try{
    const apiKey=Deno.env.get("CARAVEL_SANDBOX_API_KEY");
    if(!apiKey)return json({error:"SANDBOX_API_KEY_MISSING"},503);
    const client=new CaravelClient({
      apiKey,environment:"sandbox",timeoutMs:6500,
      retryMaxAttempts:2,retryMaxWaitMs:3000,
    });
    const repository=createCaravelSandboxWebhookRepository(serviceClient());
    const result=await runCaravelSandboxPeriodicPoll({
      client,repository,maxRows:100,budgetMs:75000,
    });
    return json(result,result.ok?200:503);
  }catch{
    return json({error:"PERIODIC_POLL_FAILED"},503);
  }
});
