/* Ride24 partner email editor. Contact and login remain separate. */
(function () {
  "use strict";
  const get = id => document.getElementById(id);
  const db = window.supabaseClient;
  let working = false;
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
    get("partnerEmailModal").classList.add("active");
    get("partnerEmailNew").value=get("partnerEmail").value||"";
    get("partnerEmailPassword").value="";
    get("partnerEmailModeContact").checked=true;
    get("partnerEmailStatus").textContent="";
    window.r24SwitchEmailMode();
  };
  window.closePartnerEmailModal=()=>{
    if(working)return;
    get("partnerEmailModal").classList.remove("active");
    get("partnerEmailPassword").value="";
    get("partnerEmailNew").value="";
  };
  window.r24SwitchEmailMode=()=>{
    if(working)return;
    const isLogin=mode()==="login";
    get("partnerEmailLoginOptions").hidden=!isLogin;
    get("partnerEmailStatus").textContent="";
    get("partnerEmailPassword").value="";
    const btn=get("partnerEmailSubmit");
    const pl=isLogin?"Wyślij potwierdzenie":"Zapisz adres";
    const en=isLogin?"Send confirmation":"Save email";
    window.Ride24PartnerI18n?.bind(btn,pl,en);
  };
})();