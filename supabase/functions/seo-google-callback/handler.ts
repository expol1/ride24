import {hash,SeoError} from '../admin-seo/core.ts';
import {CALLBACK,SCOPES,credentials} from '../admin-seo/google.ts';
type Deps={service:()=>any;fetch:typeof fetch;env:(name:string)=>string|undefined};
export function createCallbackHandler(deps:Deps){return async(req:Request)=>{
 const redirect=(result:string)=>new Response(null,{status:303,headers:{Location:'https://ride24.pl/admin/?seo_google='+encodeURIComponent(result)+'#seo','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 if(req.method!=='GET')return new Response('Method not allowed',{status:405});
 try{
  const u=new URL(req.url);const state=u.searchParams.get('state');if(!state||!/^[A-Za-z0-9_-]{43}$/.test(state))return redirect('invalid_state');
  const admin=deps.service();
  // Consume state once, including denied consents. Never carry session tokens in URLs.
  const {data,error}=await admin.from('seo_oauth_states').delete().eq('state_hash',await hash(state)).gt('expires_at',new Date().toISOString()).select('*').maybeSingle();
  if(error||!data)return redirect('expired_state');
  const profile=await admin.from('profiles').select('role').eq('id',data.user_id).maybeSingle();if(profile.error||profile.data?.role!=='admin')return redirect('access_denied');
  if(u.searchParams.has('error'))return redirect('cancelled');const code=u.searchParams.get('code');if(!code||code.length>4096)return redirect('missing_code');
  const s=await admin.from('seo_settings').select('*').eq('id',1).single();if(s.error||!s.data?.enabled)return redirect('disabled');
  const sec=await admin.rpc('admin_seo_secret',{p_name:'google_client_secret'});if(sec.error)return redirect('configuration_error');
  const client=credentials(s.data,sec.data,deps.env);if(!client.id||!client.secret)return redirect('configuration_error');
  const r=await deps.fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.id,client_secret:client.secret,code,code_verifier:data.verifier,redirect_uri:CALLBACK,grant_type:'authorization_code'})});
  if(!r.ok)return redirect('connection_failed');const tokens=await r.json();
  const required=SCOPES[data.provider as keyof typeof SCOPES];if(!required||typeof tokens.scope!=='string'||!tokens.scope.split(' ').includes(required)||typeof tokens.refresh_token!=='string')return redirect('missing_permission');
  const saved=await admin.rpc('admin_seo_secret',{p_name:data.provider+'_refresh',p_value:tokens.refresh_token});if(saved.error)return redirect('save_failed');
  return redirect(data.provider+'_connected');
 }catch{return redirect('connection_failed');}
};}
