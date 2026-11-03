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