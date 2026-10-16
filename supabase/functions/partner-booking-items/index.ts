import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authenticatedUser, corsHeaders, enforceRateLimit, isUuid, jsonResponse, publicErrorMessage, serviceClient } from "../_shared/ride24-security.ts";
import { readJsonObject } from "../_shared/booking-request.ts";
import { partnerItems } from "../_shared/booking-items.mjs";
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers:corsHeaders(req)});
  if (req.method !== 'POST') return jsonResponse(req,{error:'METHOD_NOT_ALLOWED'},405);
  try {
    const user=await authenticatedUser(req), admin=serviceClient();
    await enforceRateLimit(admin,req,'partner-booking-items',120,60);
    const body=await readJsonObject(req);
    if (!Array.isArray(body.booking_ids) || body.booking_ids.length>100 || !body.booking_ids.every(isUuid)) throw new Error('Nieprawidłowe rezerwacje');
    if (!body.booking_ids.length) return jsonResponse(req,{bookings:[]});
    // Resolve the authenticated partner first. Explicit partner_id filtering is
    // independent of PostgREST's ambiguous embedded-relation inference.
    const {data:partner,error:partnerError}=await admin.from('partners')
      .select('id').eq('user_id',user.id).maybeSingle();
    if(partnerError || !partner) throw new Error('BOOKING_ITEMS_UNAVAILABLE');
    const {data,error}=await admin.from('bookings')
      .select('id,pricing_items_snapshot')
      .eq('partner_id',partner.id).in('id',body.booking_ids);
    if(error) throw new Error('BOOKING_ITEMS_UNAVAILABLE');
    const bookings=(data || []).map(b=>({id:b.id,items:b.pricing_items_snapshot?.version===2 ? partnerItems(b.pricing_items_snapshot) : []}));
    return jsonResponse(req,{bookings});
  } catch(error) {
    const safe=publicErrorMessage(error);
    return jsonResponse(req,{error:safe.message},safe.status);
  }
});
