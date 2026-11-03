/* Ride24 partner email editor. Contact and login remain separate. */
(function () {
  "use strict";
  const get = id => document.getElementById(id);
  const db = window.supabaseClient;
  let working = false;
  let pending = false;
  const tr = (pl,en) => window.Ride24PartnerI18n?.text(pl,en) || en;
  const status = (pl,en,ok=false) => {
    const field=get("partnerEmailStatus");
    field.textContent=tr(pl,en);
    field.style.color=ok?"#166534":"#b91c1c";
  };
  const mode = () => document.querySelector('input[name="partnerEmailMode"]:checked')?.value || "contact";

  let captchaId=null;
  let lastFocus=null;
  const siteKey="0x4AAAAAACu2gUuoR8cE8lAv"; // Public widget key from partner login.

  async function authenticatedUser() {
    const {data,error}=await db.auth.getUser();
    if(error || !data?.user?.id || !data.user.email) throw Error("AUTH");
    return data.user;
  }

  function renderCaptcha() {
    if(mode()!=="login" || !get("partnerEmailModal").classList.contains("active"))return;
    if(!window.turnstile?.render)return;
    if(captchaId!==null){ window.turnstile.reset(captchaId); return; }
    const id=window.turnstile.render(get("partnerEmailCaptcha"),{
      sitekey:siteKey,theme:"light"
    });
    if(id!==undefined && id!==null)captchaId=id;
  }
  function ensureCaptcha(){
    if(window.turnstile?.render){renderCaptcha();return;}
    if(document.querySelector('script[data-r24-partner-email-captcha]'))return;
    const script=document.createElement("script");
    script.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async=true;
    script.dataset.r24PartnerEmailCaptcha="1";
    script.onload=renderCaptcha;
    script.onerror=()=>status(
      "Nie można uruchomić weryfikacji. Spróbuj później.",
      "Security check unavailable. Please try again."
    );
    document.head.appendChild(script);
  }

  window.openPartnerEmailModal=()=>{
    lastFocus=document.activeElement;
    pending=false;
    get("partnerEmailModal").classList.add("active");
    get("partnerEmailModal").setAttribute("aria-hidden","false");
    get("partnerEmailNew").value=get("partnerEmail").value||"";
    get("partnerEmailPassword").value="";
    get("partnerEmailModeContact").checked=true;
    get("partnerEmailStatus").textContent="";
    get("partnerEmailSubmit").disabled=false;
    window.r24SwitchEmailMode();
    get("partnerEmailNew").focus();
  };
  window.closePartnerEmailModal=()=>{
    if(working)return;
    get("partnerEmailModal").classList.remove("active");
    get("partnerEmailModal").setAttribute("aria-hidden","true");
    get("partnerEmailPassword").value="";
    get("partnerEmailNew").value="";
    lastFocus?.focus?.();
  };
  window.r24SwitchEmailMode=()=>{
    if(working)return;
    const isLogin=mode()==="login";
    get("partnerEmailLoginOptions").hidden=!isLogin;
    get("partnerEmailStatus").textContent="";
    get("partnerEmailPassword").value="";
    if(isLogin){
      get("partnerEmailNew").value="";
      authenticatedUser().then(user=>{
        if(get("partnerEmailModal").classList.contains("active")&&mode()==="login")get("partnerEmailCurrentLogin").textContent=user.email;
      }).catch(()=>status("Zaloguj się ponownie.","Please sign in again."));
      ensureCaptcha();
    } else get("partnerEmailNew").value=get("partnerEmail").value||"";
    const btn=get("partnerEmailSubmit");
    const pl=isLogin?"Wyślij potwierdzenie":"Zapisz adres";
    const en=isLogin?"Send confirmation":"Save email";
    window.Ride24PartnerI18n?.bind(btn,pl,en);
  };

  window.r24SavePartnerEmail=async()=>{
    if(working || pending)return;
    const email=get("partnerEmailNew").value.trim();
    const login=mode()==="login";
    const button=get("partnerEmailSubmit");
    get("partnerEmailStatus").textContent="";
    if(email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      return status("Podaj poprawny adres e-mail.","Enter a valid email address.");
    }
    if(login && !get("partnerEmailPassword").value){
      return status("Wpisz aktualne hasło.","Enter your current password.");
    }
    if(login && (captchaId===null || !window.turnstile?.getResponse?.(captchaId) ||
      window.turnstile?.isExpired?.(captchaId))){
      return status("Ukończ weryfikację bezpieczeństwa.","Complete the security check.");
    }
    working=true;
    button.disabled=true;
    let closeOnSuccess=false;
    try{
      const user=await authenticatedUser();
      const current=login?user.email:get("partnerEmail").value.trim();
      if(current.toLowerCase()===email.toLowerCase()){
        status("To już jest obecny adres e-mail.","This is already the current email.");
        return;
      }
      if(login){
        await requestLoginEmailChange(user,email);
        pending=true;
        status(
          "Prośba wysłana. Sprawdź stare i nowe konto e-mail. Login zmieni się dopiero po wymaganych potwierdzeniach. Adres kontaktowy pozostaje bez zmian.",
          "Request sent. Check your old and new inboxes. Your login changes after required confirmations. Contact email remains unchanged.",
          true
        );
      } else {
        const {data,error}=await db.from("partners").update({email})
          .eq("user_id",user.id).select("id,email").single();
        if(error || !data || data.email!==email)throw Error("SAVE_FAILED");
        get("partnerEmail").value=data.email;
        closeOnSuccess=true;
        window.showToast?.(tr("Zmieniono e-mail kontaktowy.","Contact email updated."),"success");
      }
    }catch(error){
      status(
        error.message==="AUTH"?"Sesja wygasła. Zaloguj się ponownie.":"Nie udało się dokonać zmiany. Sprawdź dane i spróbuj ponownie.",
        error.message==="AUTH"?"Session expired. Please sign in again.":"Change failed. Check your details and try again."
      );
    }finally{
      get("partnerEmailPassword").value="";
      if(login && captchaId!==null)try{window.turnstile?.reset?.(captchaId);}catch(_){}
      working=false;
      button.disabled=pending;
      if(closeOnSuccess)window.closePartnerEmailModal();
    }
  };

  document.addEventListener("keydown",e=>{
    if(e.key==="Escape" && get("partnerEmailModal")?.classList.contains("active")){
      e.preventDefault();
      window.closePartnerEmailModal();
    }
  });
})();