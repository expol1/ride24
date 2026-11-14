// Pegasus-only export. NOT deployed. Requires dedicated PEGASUS_EXPORT_TOKEN and explicit activation.
// Never call from checkout, Stripe or shared booking triggers.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.10";
const PARTNER_ID = "b61dfc7b-a4cd-4f27-b059-517cdf4f01cf";
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
function equal(a:string,b:string):boolean {
 const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);
 let diff=x.length^y.length;
 for(let i=0;i<Math.max(x.length,y.length);i++) diff|=(x[i]??0)^(y[i]??0);
 return diff===0;
}
Deno.serve(async req=>{
 if(req.method!=="GET") return json({error:"METHOD_NOT_ALLOWED"},405);
 if(Deno.env.get("PEGASUS_EXPORT_ENABLED")!=="true") return json({error:"NOT_ENABLED"},503);
 const secret=Deno.env.get("PEGASUS_EXPORT_TOKEN");
 const supplied=req.headers.get("x-pegasus-export-token")??"";
 if(!secret||secret.length<32||!equal(supplied,secret)) return json({error:"UNAUTHORIZED"},401);
 const url=new URL(req.url);
 if([...url.searchParams.keys()].some(k=>!["page","limit"].includes(k))) return json({error:"INVALID_QUERY"},400);
 const page=Number(url.searchParams.get("page")??"0");
 const limit=Number(url.searchParams.get("limit")??"100");
 if(!Number.isSafeInteger(page)||page<0||page>100000||!Number.isSafeInteger(limit)||limit<1||limit>100) return json({error:"INVALID_PAGINATION"},400);
 const endpoint=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!endpoint||!service) return json({error:"NOT_CONFIGURED"},503);
 const db=createClient(endpoint,service,{auth:{persistSession:false,autoRefreshToken:false}});
 // Explicit column allowlist. Never expose stripe, platform fees, terms, internal comments.
 const {data,error}=await db.from("bookings")
  .select("id,reservation_code,status,created_at,cancelled_at,start_date,end_date,pickup_time,return_time,pickup_location,return_location,car_class_id,main_driver_name,client_email,client_phone,partner_currency,pickup_payment_partner_currency,pricing_items_snapshot")
  .eq("partner_id",PARTNER_ID).in("status",["paid","cancelled"])
  .order("created_at",{ascending:true}).order("id",{ascending:true})
  .range(page*limit,(page+1)*limit-1);
 if(error) return json({error:"EXPORT_UNAVAILABLE"},503);
 // IMPORTANT: provisional snapshot-only endpoint. Do not activate until revision,
 // cancellation retention, category/location mapping, and extras semantics are verified.
 return json({schemaVersion:"0.1-draft",generatedAt:new Date().toISOString(),page,limit,items:(data??[]).map(b=>({
  bookingId:b.id,reservationCode:b.reservation_code,status:b.status,
  revision:null,lastModifiedAt:null,
  vehicleCategoryId:b.car_class_id,vehicleId:null,
  pickup:{date:b.start_date,time:b.pickup_time,location:b.pickup_location},
  return:{date:b.end_date,time:b.return_time,location:b.return_location},
  customer:{name:b.main_driver_name,email:b.client_email,phone:b.client_phone},
  rental:{currency:b.partner_currency,amountPayableToPartner:b.pickup_payment_partner_currency,extrasIncludedInAmount:null},
  extrasSnapshot:b.pricing_items_snapshot,cancelledAt:b.cancelled_at
 }))});
});
