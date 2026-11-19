/** Caravel-only fail-closed launch hold; no supplier calls or secret access.
 * The fixed UUID also catches this partner before api_provider changes from
 * custom to caravel. Remove only when its full paid-before-supplier lifecycle
 * and certification have been deployed and independently verified.
 */
const CARAVEL_PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
function rec(v){return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null;}
export function isCaravelBooking(row){
 const r=rec(row);
 if(!r)return false;
 if(r.partner_id===CARAVEL_PARTNER_ID)return true;
 const p=Array.isArray(r.partners)?r.partners[0]:r.partners;
 return rec(p)?.api_provider==="caravel";
}
export const CARAVEL_PRE_CERTIFICATION_ERROR="CARAVEL_CERTIFICATION_PENDING";
