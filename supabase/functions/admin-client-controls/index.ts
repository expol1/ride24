import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ride24RequireAdmin } from "./ride24-admin-auth.ts";

const headers = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"https://ride24.pl",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Cache-Control":"no-store"
};
const respond=(code:number,payload:unknown)=>new Response(JSON.stringify(payload),{status:code,headers});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionable=new Set(["suspend","restore","preflight_delete","delete"]);

Deno.serve(async (req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="POST")return respond(405,{error:"METHOD_NOT_ALLOWED"});
  const denied=await ride24RequireAdmin(req,headers);
  if(denied)return denied;
  const base=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!base||!key)return respond(503,{error:"SERVICE_UNAVAILABLE"});
  const db=createClient(base,key,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    const data=await req.json();
    const uid=data?.user_id,action=data?.action;
    if(typeof uid!=="string"||!UUID.test(uid)||!actionable.has(action))
      return respond(400,{error:"INVALID_REQUEST"});
    const {data:profile,error:profileError}=await db.from("profiles")
      .select("id,role,email").eq("id",uid).maybeSingle();
    if(profileError)return respond(503,{error:"PROFILE_CHECK_FAILED"});
    if(!profile||profile.role!=="client")
      return respond(403,{error:"ONLY_CLIENT_ACCOUNTS_CAN_BE_MODERATED"});

    const {data:adminIdentity,error:identityError}=await db.auth.getUser(
      req.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||""
    );
    if(identityError||!adminIdentity?.user)return respond(401,{error:"ADMIN_SESSION_REQUIRED"});
    const adminId=adminIdentity.user.id;
    if(uid===adminId)return respond(403,{error:"CANNOT_MODERATE_OWN_ACCOUNT"});

    if(action==="preflight_delete"||action==="delete"){
      const {data:check,error:checkError}=await db.rpc("admin_client_delete_preflight",{p_uid:uid});
      if(checkError)return respond(503,{error:"DELETE_CHECK_UNAVAILABLE"});
      if(!check?.eligible)return respond(action==="preflight_delete"?200:409,{eligible:false,blockers:check?.blockers||[],error:"DELETE_BLOCKED"});
      if(action==="preflight_delete")return respond(200,{eligible:true,blockers:[]});
      const confirmation=String(data?.confirm_text||"").trim();
      if(confirmation!==String(profile.email||uid).trim())
        return respond(400,{error:"CONFIRMATION_MISMATCH"});
      const {data:user,error:lookupError}=await db.auth.admin.getUserById(uid);
      if(lookupError||!user?.user)return respond(409,{error:"AUTH_ACCOUNT_NOT_FOUND"});
      const {error:deleteError}=await db.auth.admin.deleteUser(uid,false);
      if(deleteError)return respond(409,{error:"AUTH_DELETE_FAILED_OR_LINKED_DATA_PRESENT"});
      const {data:verification,error:verifyError}=await db.auth.admin.getUserById(uid);
      if(!verifyError||verifyError.status!==404||verification?.user)
        return respond(502,{error:"AUTH_DELETE_NOT_CONFIRMED"});
      const pending:string[]=[];
      for(const [table,col] of [["client_app_devices","user_id"],["client_app_notifications","client_id"],["user_invoice_profiles","user_id"]] as const){
        const {error:e}=await db.from(table).delete().eq(col,uid);
        if(e)pending.push(table);
      }
      const {error:logError}=await db.from("client_account_moderation_log")
        .insert({client_id:uid,admin_id:adminId,action:"delete",reason:"Administrator deleted eligible client"});
      if(logError)pending.push("moderation_log");
      return respond(200,{success:true,auth_deleted:true,cleanup_pending:pending});
    }

    const {data:existing,error:stateError}=await db.from("client_account_controls")
      .select("client_id,suspended_at,suspended_by,reason,updated_at").eq("client_id",uid).maybeSingle();
    if(stateError)return respond(503,{error:"ACCOUNT_STATUS_UNAVAILABLE"});
    const suspending=action==="suspend";
    if(suspending&&existing?.suspended_at)return respond(200,{success:true,status:"suspended",unchanged:true});
    if(!suspending&&!existing?.suspended_at)return respond(200,{success:true,status:"active",unchanged:true});
    const reason=suspending?String(data?.reason||"").trim().slice(0,500)||"Admin moderation":null;
    const now=new Date().toISOString();
    const patch={client_id:uid,suspended_at:suspending?now:null,suspended_by:suspending?adminId:null,reason,updated_at:now};
    const {error:saveError}=await db.from("client_account_controls").upsert(patch,{onConflict:"client_id"});
    if(saveError)return respond(503,{error:"ACCOUNT_STATUS_WRITE_FAILED"});
    const {error:authError}=await db.auth.admin.updateUserById(uid,{
      ban_duration:suspending?"876000h":"none"
    });
    if(authError){
      if(existing){
        await db.from("client_account_controls").upsert(existing,{onConflict:"client_id"});
      }else{
        await db.from("client_account_controls").delete().eq("client_id",uid);
      }
      return respond(503,{error:"AUTH_STATUS_UPDATE_FAILED"});
    }
    const {error:logError}=await db.from("client_account_moderation_log")
      .insert({client_id:uid,admin_id:adminId,action:suspending?"suspend":"restore",reason});
    return respond(200,{success:true,status:suspending?"suspended":"active",audit_pending:!!logError});
  }catch{
    return respond(500,{error:"MODERATION_OPERATION_FAILED"});
  }
});