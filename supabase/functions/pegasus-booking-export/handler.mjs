const reply = (payload, status=200) => new Response(JSON.stringify(payload), {status,headers:{
'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private',
'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'
}});
function secretEquals(x,y) {
 const a=new TextEncoder().encode(x),b=new TextEncoder().encode(y);
 let diff=a.length^b.length;
 for(let i=0;i<Math.max(a.length,b.length);i++) diff|=(a[i]??0)^(b[i]??0);
 return diff===0;
}
export function makeHandler({getEnv,runPage}) {
 return async function handle(req) {
  if(req.method!=='GET') return reply({error:'METHOD_NOT_ALLOWED'},405);
  const primary=getEnv('PEGASUS_EXPORT_TOKEN_CURRENT')??'';
  const previous=getEnv('PEGASUS_EXPORT_TOKEN_PREVIOUS')??'';
  const supplied=req.headers.get('x-pegasus-export-token')??'';
  if(!primary||primary.length<32||!/^[A-Za-z0-9_-]+$/.test(primary)) return reply({error:'EXPORT_NOT_CONFIGURED'},503);
  const valid=supplied.length<=256&&(secretEquals(supplied,primary)||(previous.length>=32&&secretEquals(supplied,previous)));
  if(!valid) return reply({error:'UNAUTHORIZED'},401);
  if(getEnv('PEGASUS_EXPORT_ENABLED')!=='true') return reply({error:'EXPORT_NOT_ENABLED'},503);
  const u=new URL(req.url),keys=[...u.searchParams.keys()];
  if(keys.some(k=>!['after','limit'].includes(k))||u.searchParams.getAll('after').length>1||u.searchParams.getAll('limit').length>1)
   return reply({error:'INVALID_QUERY'},400);
  const cursor=u.searchParams.get('after');
  if(cursor!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
   return reply({error:'INVALID_CURSOR'},400);
  const n=u.searchParams.get('limit')??'100';
  if(!/^[1-9][0-9]{0,2}$/.test(n)||Number(n)>100) return reply({error:'INVALID_LIMIT'},400);
  try {
   const data=await runPage({cursor,limit:Number(n)});
   if(!data||data.partnerId!=='B61DFC7B'||!Array.isArray(data.items)) return reply({error:'INVALID_EXPORT_RESPONSE'},503);
   return reply(data);
  } catch(e) {
   if(e instanceof Error&&e.message==='EXPORT_RATE_LIMIT') return reply({error:'RATE_LIMITED'},429);
   return reply({error:'EXPORT_TEMPORARILY_UNAVAILABLE'},503);
  }
 };
}
