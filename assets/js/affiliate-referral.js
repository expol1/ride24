/* No analytics calls, timers or external services. Remembering requires explicit opt-in. */
(() => {
  'use strict';
  // Reversible customer-facing pause; stored referrals and accounting remain intact.
  const CUSTOMER_REFERRALS_VISIBLE = false;
  const KEY='ride24_referral_v1', TTL=30*86400000;
  const clean=v=>/^[A-Z0-9]{6,24}$/.test(String(v||'').trim().toUpperCase())?String(v).trim().toUpperCase():'';
  const en=()=>localStorage.getItem('client_lang')==='en'||localStorage.getItem('lang')==='en';
  function saved(){try{const x=JSON.parse(localStorage.getItem(KEY)||'null');if(x&&x.expires>Date.now()&&x.expires<=Date.now()+TTL&&clean(x.code))return x.code;localStorage.removeItem(KEY);}catch{}return '';}
  function forget(){try{localStorage.removeItem(KEY);}catch{}const input=document.getElementById('affiliate-code');if(input)input.value='';}
  function init(){
    if (!CUSTOMER_REFERRALS_VISIBLE) return;
    const code=clean(new URL(location.href).searchParams.get('ref'));
    if(code){
      const box=document.createElement('div');box.style.cssText='position:fixed;bottom:18px;left:16px;right:16px;max-width:570px;background:white;color:#102a43;border:2px solid #168265;border-radius:12px;padding:16px;z-index:99999;box-shadow:0 6px 30px #0003';
      const text=document.createElement('p');text.textContent=en()?`Referral code ${code}. Remember it on this device for 30 days? It does not change your price or loyalty discount.`:`Kod polecający ${code}. Zapamiętać na tym urządzeniu przez 30 dni? Nie zmienia ceny ani rabatu lojalnościowego.`;box.append(text);
      const privacy=document.createElement('a');privacy.href='/privacy.html';privacy.textContent=en()?'Privacy policy':'Polityka prywatności';privacy.style.display='block';box.append(privacy);
      for(const [label,yes] of [[en()?'Remember':'Zapamiętaj',true],[en()?'No thanks':'Nie zapamiętuj',false]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.style.marginRight='12px';b.onclick=()=>{if(yes){try{localStorage.setItem(KEY,JSON.stringify({code,expires:Date.now()+TTL}));}catch{}const i=document.getElementById('affiliate-code');if(i)i.value=code;}else forget();box.remove();const u=new URL(location.href);u.searchParams.delete('ref');history.replaceState(null,'',u);};box.append(b);}document.body.append(box);
    }
    const anchor=document.getElementById('acceptTerms');
    if(anchor){const wrap=document.createElement('div');wrap.style.cssText='margin:14px 0;padding:12px;background:#f1f5f9;border-radius:8px;color:#102a43';
      const label=document.createElement('label');label.htmlFor='affiliate-code';label.textContent=en()?'Referral code (optional, no extra discount)':'Kod polecający (opcjonalnie, bez dodatkowego rabatu)';
      const input=document.createElement('input');input.id='affiliate-code';input.maxLength=24;input.placeholder='RIDE123';input.value=saved();input.style.cssText='display:block;max-width:260px;margin:8px 0;padding:8px;color:#102a43;background:white';
      const clear=document.createElement('button');clear.type='button';clear.textContent=en()?'Forget referral':'Usuń zapamiętane polecenie';clear.onclick=forget;
      wrap.append(label,input,clear);anchor.closest('label')?.parentNode.insertBefore(wrap,anchor.closest('label'));
      if(!document.getElementById('affiliate-code'))anchor.parentNode.before(wrap);
    }
  }
  window.ride24Referral={forget, async attach(db,bookingId){
    if (!CUSTOMER_REFERRALS_VISIBLE) return;
    const raw=document.getElementById('affiliate-code')?.value||saved();if(!raw)return;
    const code=clean(raw);let ok=false;
    if(code&&bookingId){try{const {data,error}=await db.rpc('affiliate_attach',{p_booking:bookingId,p_code:code}).abortSignal(AbortSignal.timeout(5000));ok=!error&&['attached','already_attached'].includes(data?.status);}catch{}}
    if(!ok){const message=en()?'Booking saved. Referral was not attached; contact Ride24 with your booking code.':'Rezerwacja zapisana. Nie przypisano polecenia — skontaktuj się z Ride24, podając numer rezerwacji.';window.showToast?.(message,'error');const notice=document.createElement('p');notice.textContent=message;notice.style.cssText='padding:16px;background:#fff3cd;color:#664d03';notice.setAttribute('role','alert');document.body.prepend(notice);}
  }};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
