import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authenticatedUser, corsHeaders, enforceRateLimit, isUuid, jsonResponse,
  publicErrorMessage, serviceClient
} from "../_shared/ride24-security.ts";
import {CARAVEL_ID, projectCaravelBookingDetails} from "../_shared/client-caravel-booking-details.mjs";

// Read-only, customer-scoped archive of what Caravel actually confirmed.
// Never expose the supplier's raw API payload, internal keys or other customers' records.
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok",{headers:corsHeaders(req)});
  if (req.method !== "POST") return jsonResponse(req,{error:"METHOD_NOT_ALLOWED"},405);
  try {
    if (Number(req.headers.get("content-length") || 0) > 2048)
      return jsonResponse(req,{error:"INVALID_REQUEST"},400);
    const user=await authenticatedUser(req);
    const admin=serviceClient();
    await enforceRateLimit(admin,req,"client-caravel-booking-details",40,60);
    const body=await req.json();
    if (!body || typeof body!=="object" || !isUuid(body.booking_id))
      return jsonResponse(req,{error:"INVALID_BOOKING_ID"},400);
    const {data:booking,error:bookingError}=await admin.from("bookings")
      .select("id,client_id,partner_id,api_quote_id,partner_currency,final_price_snapshot,"+
        "online_payment_pln,pickup_payment_partner_currency,deposit_snapshot,mileage_limit_snapshot,"+
        "main_driver_name,add_driver_name,caravel_terms_document_id,caravel_terms_content_hash,"+
        "caravel_terms_language,caravel_coverage_damage_admin_fee_minor,"+
        "caravel_coverage_excluded_codes")
      .eq("id",body.booking_id).eq("client_id",user.id).eq("partner_id",CARAVEL_ID).maybeSingle();
    if (bookingError) return jsonResponse(req,{error:"BOOKING_DETAILS_UNAVAILABLE"},503);
    if (!booking) return jsonResponse(req,{error:"BOOKING_NOT_FOUND"},404);
    if (!isUuid(booking.api_quote_id))
      return jsonResponse(req,{error:"BOOKING_QUOTE_NOT_RECORDED"},409);
    const {data:quote,error:quoteError}=await admin.from("api_quotes")
      .select("id,partner_id,booking_id,currency,partner_net_total,final_total,raw_response")
      .eq("id",booking.api_quote_id).eq("booking_id",booking.id).eq("partner_id",CARAVEL_ID).maybeSingle();
    if (quoteError || !quote) return jsonResponse(req,{error:"BOOKING_QUOTE_UNAVAILABLE"},409);
    let terms=null;
    if (booking.caravel_terms_document_id && booking.caravel_terms_content_hash) {
      const r=await admin.from("caravel_reviewed_terms")
        .select("document_id,content_hash,language,title,version,body")
        .eq("document_id",booking.caravel_terms_document_id)
        .eq("content_hash",booking.caravel_terms_content_hash)
        .eq("language",booking.caravel_terms_language||"en").maybeSingle();
      if (!r.error) terms=r.data;
    }
    const details=projectCaravelBookingDetails(booking,quote,terms);
    return jsonResponse(req,{success:true,details},200,{"Cache-Control":"no-store"});
  } catch(error) {
    if (error instanceof Error && /CARAVEL_(?:BOOKING_QUOTE|CURRENCY|BOOKED_AMOUNTS)_MISMATCH/.test(error.message))
      return jsonResponse(req,{error:"BOOKING_DETAILS_UNVERIFIED"},409);
    const safe=publicErrorMessage(error);
    return jsonResponse(req,{error:safe.message},safe.status);
  }
});
