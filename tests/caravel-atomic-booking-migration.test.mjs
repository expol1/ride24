import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../docs/integrations/caravel-atomic-pending-booking.sql",import.meta.url),"utf8");
test("Caravel atomic pending booking and quote claim use one DB transaction",()=>{
 assert.equal((sql.match(/\bBEGIN\s*;/g)||[]).length,1);
 assert.equal((sql.match(/\bCOMMIT\s*;/g)||[]).length,1);
 assert.match(sql,/FOR UPDATE;/);
 assert.match(sql,/INSERT INTO public\.bookings\(/);
 assert.match(sql,/UPDATE public\.api_quotes/);
 assert.match(sql,/WHERE id=v_q\.id AND used_at IS NULL AND booking_id IS NULL/);
 assert.match(sql,/RAISE EXCEPTION 'CARAVEL_ATOMIC_QUOTE_RACE'/);
 assert.doesNotMatch(sql,/SECURITY DEFINER/);
});
test("the release gate defaults CLOSED and service_role only; no browser RPC access",()=>{
 assert.match(sql,/certified boolean NOT NULL DEFAULT false/);
 assert.match(sql,/allow_customer_checkout boolean NOT NULL DEFAULT false/);
 assert.match(sql,/VALUES \(true,false,false\) ON CONFLICT/);
 assert.match(sql,/NOT v_gate\.certified/);
 assert.match(sql,/NOT v_gate\.allow_customer_checkout/);
 assert.match(sql,/REVOKE ALL ON FUNCTION public\.caravel_commit_pending_booking\(uuid,uuid,jsonb\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
 assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.caravel_commit_pending_booking\(uuid,uuid,jsonb\)[\s\S]*?TO service_role/);
 assert.match(sql,/ALTER TABLE public\.caravel_release_control ENABLE ROW LEVEL SECURITY/);
});
test("booking pays only a separate Ride24 fee; not paid or sent to supplier prematurely",()=>{
 assert.match(sql,/'awaiting_payment','api','caravel_awaiting_stripe'/);
 assert.match(sql,/round\(v_q\.commission_total \*/);
 assert.match(sql,/payment_model' IS DISTINCT FROM 'pay_on_arrival'/);
 assert.match(sql,/pay_now/);
 assert.match(sql,/pay_at_pickup/);
 assert.doesNotMatch(sql,/INSERT INTO public\.payments|stripe\.checkout|POST \/v1\/bookings/);
});
test("identity, immutable terms, excluded Premium coverage and both Ride24 locations are checked",()=>{
 for(const token of [
  "p_client_id","p_quote_id","caravel_terms_content_hash",
  "caravel_coverage_excluded_codes","caravel_coverage_damage_admin_fee_minor",
  "CARAVEL_EXCLUSION_CONSENT_REQUIRED","CARAVEL_RETURN_NOT_APPROVED",
  "CARAVEL_PICKUP_NOT_APPROVED","CARAVEL_QUOTE_MONEY_INVALID",
  "CARAVEL_BOOKING_TIME_CHANGED","CARAVEL_PARTNER_NOT_CERTIFIED",
  "CARAVEL_RELEASE_GATE_CLOSED"
 ])assert.ok(sql.includes(token),token);
});

test("additional Caravel driver atomically matches supplier quote, owned profile and licence date",()=>{
 const sql=readFileSync(new URL("../docs/integrations/caravel-second-driver-atomic-sql.sql",import.meta.url),"utf8");
 assert.match(sql,/jsonb_array_length\(v_prov->'drivers'\) NOT IN \(1,2\)/);
 assert.match(sql,/CARAVEL_MAIN_DRIVER_QUOTE_MISMATCH/);
 assert.match(sql,/CARAVEL_ADDITIONAL_DRIVER_QUOTE_MISMATCH/);
 assert.match(sql,/CARAVEL_ADDITIONAL_DRIVER_NOT_VERIFIED/);
 assert.match(sql,/CARAVEL_UNQUOTED_ADDITIONAL_DRIVER/);
 assert.match(sql,/FROM public\.drivers WHERE id=\(p_payload->>'additional_driver_id'\)::uuid/);
 assert.match(sql,/AND user_id=p_client_id/);
 assert.match(sql,/v_add\.license_since IS NULL OR v_add\.license_since > v_q\.start_date/);
 assert.match(sql,/additional_driver_id,add_driver_name,add_driver_age,additional_driver_license_since/);
 assert.match(sql,/current_user NOT IN \('service_role','postgres'\)/);
});
