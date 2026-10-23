/* Custom Google Ads creatives. All customer-paid campaign actions remain in the existing approval flow. */
(function () {
  "use strict";
  const $=id=>document.getElementById(id);
  let saving=false,editingId=null;
  const prefix="google-custom-";
  const value=name=>String($(prefix+name)?.value||"").trim();
  const fields=["headline1","headline2","headline3","long-headline","description1","description2","final-url","app-url"];
  function notify(message,error=false){const node=$(prefix+"message");if(node){node.textContent=message;node.style.color=error?"#B91C1C":"#166534";}}
  function objective(){return value("objective")||"rental";}
  function labels(){
    const app=objective()==="app_install";
    const field=$(prefix+"app-label");
    if(field)field.hidden=!app;
    const notice=$(prefix+"type-description");
    if(notice)notice.textContent=app
      ?"Instalacje aplikacji wymagają osobnego typu Google App Campaign. Zapiszesz treść i grafikę, lecz tego szkicu NIE uruchomisz przez automat Performance Max."
      : objective()==="app_website"
        ?"Promocja aplikacji przez stronę Ride24 — kampania Performance Max kieruje na podany adres w ride24.pl. To nie jest kampania optymalizowana pod instalacje."
        :"Własna reklama Performance Max kierująca do strony Ride24. Zatwierdzenie treści i wydatku jest osobnym krokiem.";
  }
  function checkTexts(){
    const maxs={headline1:30,headline2:30,headline3:30,"long-headline":90,description1:90,description2:90};
    for(const [name,max] of Object.entries(maxs)){
      const text=value(name);
      if(!text||Array.from(text).length>max)throw new Error("Pole „"+name+"” musi mieć od 1 do "+max+" znaków.");
    }
    const headlines=[value("headline1"),value("headline2"),value("headline3")];
    const descriptions=[value("description1"),value("description2")];
    const distinct=arr=>new Set(arr.map(x=>x.toLowerCase())).size===arr.length;
    if(!distinct(headlines)||!distinct(descriptions))throw new Error("Nagłówki i opisy nie mogą być identyczne.");
    return {headlines,descriptions,long_headline:value("long-headline")};
  }
  function checkLanding(raw){
    const url=new URL(raw);
    if(url.protocol!=="https:"||!["ride24.pl","www.ride24.pl"].includes(url.hostname)||url.username||url.password||url.port||raw.length>2000)
      throw new Error("Adres docelowy musi być stroną HTTPS ride24.pl (np. stroną aplikacji na Ride24).");
    return url.toString();
  }
  function checkAppUrl(raw){
    if(objective()!=="app_install")return null;
    const url=new URL(raw);
    if(url.protocol!=="https:"||url.hostname!=="play.google.com"||
       url.pathname!=="/store/apps/details"||!url.searchParams.get("id"))
      throw new Error("Wklej pełny link aplikacji z Google Play.");
    return url.toString();
  }
  async function requireAdmin(){
    const user=await db.auth.getUser();
    if(user.error||!user.data?.user)throw new Error("Zaloguj się ponownie.");
    const profile=await db.from("profiles").select("role").eq("id",user.data.user.id).maybeSingle();
    if(profile.error||profile.data?.role!=="admin")throw new Error("Wymagane uprawnienia administratora.");
  }
  async function imageSource(file){
    if(!file||!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>12*1024*1024)
      throw new Error("Wybierz grafikę JPG, PNG lub WebP do 12 MB.");
    // Browser decodes image first; this is also a validity check.
    return await new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),image=new Image();
      image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
      image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Nie można otworzyć grafiki."));};
      image.src=url;
    });
  }
  async function crop(image,width,height){
    const canvas=document.createElement("canvas");
    canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext("2d");
    if(!ctx)throw new Error("Brak obsługi przygotowywania grafiki w przeglądarce.");
    // Contain preserves any text and logos in the user's original graphic.
    ctx.fillStyle="#F3F7FB";ctx.fillRect(0,0,width,height);
    const scale=Math.min(width/image.width,height/image.height);
    const w=Math.round(image.width*scale),h=Math.round(image.height*scale);
    ctx.drawImage(image,Math.floor((width-w)/2),Math.floor((height-h)/2),w,h);
    return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Nie można przetworzyć grafiki.")),"image/jpeg",0.88));
  }
  async function uploadImage(file){
    const image=await imageSource(file);
    if(image.width<400||image.height<300)throw new Error("Za mała grafika. Użyj obrazu o rozdzielczości co najmniej 400×300.");
    const prepared=await Promise.all([crop(image,1200,628),crop(image,1200,1200)]);
    const files=[];
    try{
      for(let i=0;i<prepared.length;i++){
        const type=i===0?"landscape":"square";
        if(prepared[i].size>5_120_000)throw new Error("Grafika po przetworzeniu jest za duża dla Google Ads.");
        const name="google-ads/"+crypto.randomUUID()+"-"+type+".jpg";
        const result=await db.storage.from("marketing-images").upload(name,prepared[i],{upsert:false,contentType:"image/jpeg"});
        if(result.error)throw result.error;
        files.push(name);
      }
      const storage=db.storage.from("marketing-images");
      return {landscape_url:storage.getPublicUrl(files[0]).data.publicUrl,
        square_url:storage.getPublicUrl(files[1]).data.publicUrl};
    }catch(e){
      if(files.length)try{await db.storage.from("marketing-images").remove(files);}catch{}
      throw e;
    }
  }
  function reset(){
    editingId=null;
    for(const name of fields){const field=$(prefix+name);if(field)field.value=name==="final-url"?"https://ride24.pl/":"";}
    if($(prefix+"objective"))$(prefix+"objective").value="rental";
    if($(prefix+"image"))$(prefix+"image").value="";
    if($(prefix+"preview")){$(prefix+"preview").hidden=true;$(prefix+"preview").removeAttribute("src");}
    const submit=$(prefix+"submit");if(submit)submit.textContent="Zapisz własny szkic Google Ads";
    labels();
  }
  async function save(){
    if(saving)return;
    const submit=$(prefix+"submit"),file=$(prefix+"image")?.files?.[0];
    saving=true;if(submit){submit.disabled=true;submit.textContent="Zapisywanie…";}
    let queueId=null;
    try{
      await requireAdmin();
      const texts=checkTexts(),final_url=checkLanding(value("final-url"));
      const app_store_url=checkAppUrl(value("app-url"));
      if(!file&&!editingId)throw new Error("Dodaj własną grafikę. System przygotuje format poziomy i kwadratowy.");
      const creative={objective:objective(),headlines:texts.headlines,long_headline:texts.long_headline,
        descriptions:texts.descriptions,final_url,app_store_url};
      // Source file is mandatory on creation; an edit may retain previously uploaded assets.
      if(file)Object.assign(creative,await uploadImage(file));
      if(!editingId){
        if(!confirm("Zapisać własną propozycję Google Ads? Nie spowoduje to publikacji ani wydatku."))return;
        const row={platform:"google_ads",status:"draft",city:null,country:null,
          headline:texts.headlines[0],content:texts.descriptions.join(" "),
          image_url:creative.landscape_url||null,image_status:"ready",generation_version:"google_ads_custom_v1"};
        const create=await db.from("marketing_queue").insert(row).select("id").single();
        if(create.error||!create.data?.id)throw create.error||new Error("Błąd zapisu szkicu.");
        queueId=create.data.id;
        const created=await db.from("google_ads_creatives").insert({marketing_queue_id:queueId,...creative}).select("marketing_queue_id");
        if(created.error)throw created.error;
      }else{
        const valid=await db.from("marketing_queue").select("id,status,platform").eq("id",editingId).maybeSingle();
        if(valid.error||valid.data?.status!=="draft"||valid.data?.platform!=="google_ads")
          throw new Error("Można edytować tylko niezatwierdzony szkic Google Ads.");
        const update=await db.from("google_ads_creatives").update(creative).eq("marketing_queue_id",editingId).select("marketing_queue_id");
        if(update.error||update.data?.length!==1)throw update.error||new Error("Nie zaktualizowano materiałów.");
        const post=await db.from("marketing_queue").update({headline:texts.headlines[0],content:texts.descriptions.join(" "),
          ...(creative.landscape_url?{image_url:creative.landscape_url}:{})})
          .eq("id",editingId).eq("status","draft").eq("platform","google_ads").select("id");
        if(post.error||post.data?.length!==1)throw post.error||new Error("Materiały zapisano; odśwież szkic.");
      }
      notify("Zapisano własne materiały. Sprawdź szkic i zatwierdź treść przed wyborem budżetu.");
      reset();
      await window.loadGoogleAdsDrafts?.();
    }catch(error){
      if(queueId){try{await db.from("marketing_queue").delete().eq("id",queueId).eq("status","draft");}catch{}}
      notify("Nie udało się zapisać: "+(error.message||"Nieznany błąd."),true);
    }finally{saving=false;if(submit){submit.disabled=false;submit.textContent=editingId?"Zapisz zmiany szkicu":"Zapisz własny szkic Google Ads";}}
  }
  async function edit(id){
    if(saving)return;
    try{
      const {data,error}=await db.from("google_ads_creatives").select("*").eq("marketing_queue_id",id).maybeSingle();
      const {data:post,error:postError}=await db.from("marketing_queue").select("status,platform").eq("id",id).maybeSingle();
      if(error||postError||!data||post?.status!=="draft"||post?.platform!=="google_ads")
        throw new Error("Tylko własny niezatwierdzony szkic można edytować.");
      editingId=id;
      if($(prefix+"objective"))$(prefix+"objective").value=data.objective;
      const vals={headline1:data.headlines?.[0],headline2:data.headlines?.[1],headline3:data.headlines?.[2],
        "long-headline":data.long_headline,description1:data.descriptions?.[0],description2:data.descriptions?.[1],
        "final-url":data.final_url,"app-url":data.app_store_url};
      for(const [key,val] of Object.entries(vals)){const field=$(prefix+key);if(field)field.value=val||"";}
      if($(prefix+"image"))$(prefix+"image").value="";
      const preview=$(prefix+"preview");
      if(preview){preview.src=data.landscape_url;preview.hidden=false;}
      const submit=$(prefix+"submit");if(submit)submit.textContent="Zapisz zmiany szkicu";
      labels();notify("Edytujesz szkic nr "+id+". Możesz zachować obecną grafikę lub wybrać nową.");
      $(prefix+"form")?.scrollIntoView({behavior:"smooth",block:"start"});
    }catch(e){notify("Nie udało się otworzyć: "+(e.message||""),true);}
  }
  function preview(){
    const file=$(prefix+"image")?.files?.[0],img=$(prefix+"preview");
    if(!img)return;
    if(window.__googleCustomPreviewUrl){URL.revokeObjectURL(window.__googleCustomPreviewUrl);window.__googleCustomPreviewUrl=null;}
    if(!file){img.hidden=true;return;}
    if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>12*1024*1024){
      notify("Wybierz grafikę JPG, PNG lub WebP do 12 MB.",true);img.hidden=true;return;
    }
    window.__googleCustomPreviewUrl=URL.createObjectURL(file);
    img.src=window.__googleCustomPreviewUrl;img.hidden=false;
  }
  window.googleCustomObjectiveChanged=labels;
  window.googleCustomPreview=preview;
  window.createGoogleAdsCustomDraft=save;
  window.editGoogleAdsCustomDraft=edit;
  window.resetGoogleAdsCustomForm=reset;
})();
