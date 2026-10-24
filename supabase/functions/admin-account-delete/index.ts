import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ride24RequireAdmin } from "./ride24-admin-auth.ts";

const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const respond = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return respond(405,{error:"Metoda niedozwolona."});
  const authError = await ride24RequireAdmin(req, headers);
  if (authError) return authError;
  const base = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !serviceKey) return respond(503,{error:"Brak konfiguracji usługi."});
  const admin = createClient(base,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    const payload = await req.json();
    const uid = payload?.user_id;
    const action = payload?.action;
    if (typeof uid!=="string" || !uuid.test(uid) || !["preflight","delete"].includes(action))
      return respond(400,{error:"Nieprawidłowy identyfikator lub operacja."});
    // Re-check immediately before deleting; no dashboard-side authorization shortcut.
    const {data:preflight,error:preflightError} = await admin.rpc("admin_account_delete_preflight",{p_uid:uid});
    if (preflightError) return respond(503,{error:"Nie udało się sprawdzić zależności konta."});
    if (!preflight?.eligible) return respond(409,{error:"Nie można bezpiecznie usunąć konta.",blockers:preflight?.blockers??[]});
    if (action==="preflight") return respond(200,{eligible:true,role:preflight.role});
    const {data:userData,error:lookupError} = await admin.auth.admin.getUserById(uid);
    if (lookupError || !userData?.user) return respond(409,{error:"Nie znaleziono konta Authentication. Nie wykonano usunięcia."});
    // Deletes Auth and cascaded profile/partner rows in one database transaction managed by GoTrue.
    // On a FK or Storage error GoTrue aborts deletion; never silently return success.
    const {error:deleteError} = await admin.auth.admin.deleteUser(uid,false);
    if (deleteError) return respond(409,{error:"Authentication nie usunęło konta. Żadne usunięcie nie zostało potwierdzone. Sprawdź zależności i pliki Storage."});
    const {data:stillThere,error:verifyError} = await admin.auth.admin.getUserById(uid);
    if (!verifyError && stillThere?.user) return respond(502,{error:"Nie udało się potwierdzić usunięcia konta z Auth."});
    const remaining: string[]=[];
    const related = [
      ["client_app_devices","user_id"],["client_app_notifications","client_id"],
      ["user_invoice_profiles","user_id"],["seo_oauth_states","user_id"]
    ] as const;
    for (const [table,col] of related) {
      const {error}=await admin.from(table).delete().eq(col,uid);
      if (error) remaining.push(table);
    }
    return respond(200,{success:true,auth_deleted:true,cleanup_pending:remaining,
      message:remaining.length?"Konto usunięte z Auth. Część danych pomocniczych wymaga sprawdzenia.":"Konto i Auth usunięte."});
  } catch {
    return respond(500,{error:"Operacja nie została zakończona. Odśwież panel i sprawdź status konta."});
  }
});