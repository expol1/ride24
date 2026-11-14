// Isolated Pegasus service-to-service exporter. verify_jwt=false; own dedicated token required.
// Never call from Stripe, checkout or any shared booking/partner flow.
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.49.10";
import {makeHandler} from "./handler.mjs";
const handler=makeHandler({
 getEnv:(key:string)=>Deno.env.get(key),
 runPage:async ({cursor,limit}:{cursor:string|null;limit:number})=>{
  const url=Deno.env.get('SUPABASE_URL');
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!key) throw new Error('DB_CONFIGURATION_MISSING');
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.rpc('pegasus_export_page',{p_after_booking_id:cursor,p_limit:limit});
  if(error) {
   if(error.message?.includes('EXPORT_RATE_LIMIT')) throw new Error('EXPORT_RATE_LIMIT');
   throw new Error('EXPORT_DB_ERROR');
  }
  return data;
 }
});
Deno.serve(handler);
