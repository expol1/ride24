/* Google Ads proposals are independent of Facebook/Instagram/X posts.
 * A draft never launches a paid campaign. Legacy PMax backend uses marketing_queue_id
 * as its technical source reference; only platform=google_ads is accepted by the RPC.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  let busy = false;
  function setMessage(text, error = false) {
    const status = $("google-creative-message");
    if (status) { status.textContent = text; status.style.color = error ? "#B91C1C" : "#166534"; }
  }
  function action(label, callback, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "btn-danger" : "btn-primary";
    button.textContent = label;
    button.style.cssText = "margin-right:7px;margin-top:7px;padding:9px 13px";
    button.addEventListener("click", callback);
    return button;
  }
  async function ensureAdmin() {
    const { data, error } = await db.auth.getUser();
    if (error || !data?.user) throw new Error("Zaloguj się ponownie jako administrator.");
    const profile = await db.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
    if (profile.error || profile.data?.role !== "admin") throw new Error("Brak uprawnień administratora.");
  }
  async function loadLocations() {
    const select = $("google-creative-location");
    if (!select) return;
    select.replaceChildren();
    try {
      const { data, error } = await db.from("partner_locations")
        .select("city,country").eq("active", true).not("city", "is", null).order("country").limit(1000);
      if (error) throw error;
      const found = new Set();
      for (const row of data || []) {
        const city = String(row.city || "").trim();
        const country = String(row.country || "").trim();
        const key = [city.toLowerCase(), country.toLowerCase()].join("|");
        if (!city || !country || found.has(key)) continue;
        found.add(key);
        const option = document.createElement("option");
        option.value = JSON.stringify({ city, country });
        option.textContent = city + " — " + country;
        select.append(option);
      }
      if (!found.size) {
        const option = document.createElement("option");
        option.textContent = "Brak aktywnych lokalizacji"; option.value = "";
        select.append(option);
      }
    } catch (error) {
      const option = document.createElement("option");
      option.textContent = "Nie udało się pobrać lokalizacji"; option.value = "";
      select.append(option);
      setMessage("Nie udało się pobrać lokalizacji partnerów: " + (error.message || ""), true);
    }
  }
  function makeCopy(city, country) {
    // No promise that every offer is deposit-free. Keep offers conditional.
    return {
      headline: ("Wynajem auta: " + city).slice(0, 110),
      content: ("Poznaj " + city + " (" + country +
        ") z Ride24. Wyszukaj samochód z pełnym ubezpieczeniem i bez konieczności posiadania karty kredytowej. " +
        "Dostępne oferty bez kaucji lub z kaucją gotówkową do 200 EUR — warunki zależą od wybranego partnera. " +
        "Porównaj dostępne auta i sprawdź warunki wynajmu na ride24.pl.")
    };
  }
  async function createDraft() {
    if (busy) return;
    const select = $("google-creative-location");
    const value = select?.value || "";
    if (!value) return setMessage("Najpierw wybierz lokalizację z aktywną ofertą.", true);
    let place;
    try { place = JSON.parse(value); } catch { return setMessage("Nieprawidłowa lokalizacja.", true); }
    if (!place.city || !place.country) return setMessage("Uzupełnij lokalizację.", true);
    if (!confirm("Przygotować niezależny szkic Google Ads dla " + place.city + "? To NIE uruchomi reklamy ani nie opublikuje posta na Facebooku.")) return;
    busy = true; const button = $("google-creative-generate");
    if (button) { button.disabled = true; button.textContent = "Przygotowywanie…"; }
    try {
      await ensureAdmin();
      const copy = makeCopy(place.city, place.country);
      const payload = {
        platform: "google_ads", status: "draft", city: place.city, country: place.country,
        headline: copy.headline, content: copy.content,
        image_status: "google_ads_assets", generation_version: "google_ads_independent_v1"
      };
      const result = await db.from("marketing_queue").insert(payload).select("id").single();
      if (result.error || !result.data?.id) throw result.error || new Error("Nie zapisano szkicu.");
      setMessage("Przygotowano osobny szkic Google Ads. Sprawdź i zatwierdź go poniżej.");
      await loadDrafts();
    } catch (error) {
      setMessage("Nie udało się przygotować reklamy Google Ads: " + (error?.message || ""), true);
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = "Przygotuj reklamę Google Ads"; }
    }
  }
  async function approveDraft(id) {
    if (busy) return;
    if (!confirm("Zatwierdzasz treść tej propozycji GOOGLE ADS. Następnie wybierzesz czas i poznasz limit budżetu przed uruchomieniem. Nie publikujemy jej na Facebooku ani Instagramie. Kontynuować?")) return;
    busy = true;
    try {
      await ensureAdmin();
      const res = await db.from("marketing_queue").update({ status: "approved" })
        .eq("id", id).eq("platform", "google_ads").eq("status", "draft").select("id");
      if (res.error || res.data?.length !== 1) throw res.error || new Error("Szkic został już zmieniony. Odśwież listę.");
      setMessage("Propozycja Google Ads zatwierdzona. Uruchomienie i wydatki wymagają osobnej decyzji.");
      await loadDrafts();
    } catch (error) { setMessage("Nie udało się zatwierdzić: " + (error.message || ""), true); }
    finally { busy = false; }
  }
  async function deleteDraft(id) {
    if (busy || !confirm("Trwale usunąć NIEZATWIERDZONY szkic Google Ads? Żadne kampanie Google nie zostaną wyłączone.")) return;
    busy = true;
    try {
      await ensureAdmin();
      const res = await db.from("marketing_queue").delete()
        .eq("id", id).eq("platform", "google_ads").eq("status", "draft").select("id");
      if (res.error || res.data?.length !== 1) throw res.error || new Error("Nie usunięto szkicu; odśwież listę.");
      setMessage("Usunięto tylko szkic Google Ads.");
      await loadDrafts();
    } catch (error) { setMessage("Nie udało się usunąć szkicu: " + (error.message || ""), true); }
    finally { busy = false; }
  }
  async function reviewCampaign(id) {
    if (busy) return;
    // Re-read to ensure that a social-media post cannot invoke the paid Google flow.
    const { data, error } = await db.from("marketing_queue")
      .select("id,status,platform").eq("id", id).maybeSingle();
    if (error || !data || data.platform !== "google_ads" || data.status !== "approved") {
      return setMessage("Wybierz zatwierdzoną propozycję utworzoną w Google Ads.", true);
    }
    if (typeof openPromotionModal !== "function") {
      return setMessage("Formularz uruchamiania Google Ads jest niedostępny.", true);
    }
    const {data:creative,error:creativeError}=await db.from("google_ads_creatives").select("objective").eq("marketing_queue_id",id).maybeSingle();
    if(creativeError)return setMessage("Nie udało się sprawdzić typu kampanii Google Ads.",true);
    if(creative?.objective==="app_install")return setMessage("Kampania instalacyjna musi być utworzona jako App Campaign w Google Ads. Nie można uruchomić jej jako Performance Max.",true);
    openPromotionModal(id);
  }
  async function loadDrafts() {
    const list = $("google-ads-drafts");
    if (!list) return;
    list.replaceChildren();
    try {
      const { data, error } = await db.from("marketing_queue")
        .select("id,city,country,headline,content,status,created_at,promotion_status")
        .eq("platform", "google_ads").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      if (!data?.length) {
        list.textContent = "Nie ma jeszcze propozycji Google Ads. Utwórz ją powyżej — posty z Facebooka pozostają osobno.";
        return;
      }
      const ids=data.map(row=>row.id);
      const {data:creativeRows,error:creativeError}=await db.from("google_ads_creatives")
        .select("marketing_queue_id,objective,final_url,landscape_url,headlines,long_headline,descriptions,app_store_url")
        .in("marketing_queue_id",ids);
      if(creativeError)throw creativeError;
      const creativeMap=new Map((creativeRows||[]).map(row=>[row.marketing_queue_id,row]));
      for (const item of data) {
        const creative=creativeMap.get(item.id);
        const card = document.createElement("div");
        card.className = "marketing-simple-campaign";
        card.style.cssText = "display:block;margin-bottom:12px";
        const title = document.createElement("strong");
        title.textContent = (item.headline || "Kampania Google Ads") + " · " + (item.city || "") + ", " + (item.country || "");
        const status = document.createElement("small");
        const approved = item.status === "approved";
        const install=creative?.objective==="app_install";
        status.textContent = (install?"App Campaign — instalacje aplikacji · ":"Performance Max · ") +
          (approved ? (install?"Zatwierdzona — przygotowana do ręcznego wdrożenia w Google Ads":"Zatwierdzona — czeka na uruchomienie") :
            (item.status==="draft"?"Szkic — do zatwierdzenia":"Status: "+item.status));
        const description = document.createElement("p");
        description.textContent = item.content || "";
        description.style.cssText = "white-space:pre-wrap;margin:10px 0;color:#334155;font-size:13px";
        card.append(title, status, description);
        if(creative?.landscape_url){
          const picture=document.createElement("img");
          picture.src=creative.landscape_url;
          picture.alt="Własna grafika Google Ads";
          picture.loading="lazy";
          picture.style.cssText="display:block;max-width:280px;width:100%;height:auto;border-radius:8px;margin:10px 0;border:1px solid #E2E8F0";
          card.append(picture);
        }
        if(creative?.final_url){
          const detail=document.createElement("small");
          detail.textContent="Strona docelowa: "+creative.final_url;
          card.append(detail);
        }
        if (item.status === "draft") {
          if(creative&&typeof window.editGoogleAdsCustomDraft==="function")
            card.append(action("Edytuj treść i grafikę",()=>window.editGoogleAdsCustomDraft(item.id)));
          card.append(action("Zatwierdź treść", () => approveDraft(item.id)),
            action("Usuń szkic", () => deleteDraft(item.id), true));
        }
        if (approved && item.promotion_status !== "active" && !install) {
          card.append(action("Wybierz czas i budżet Google Ads", () => reviewCampaign(item.id)));
        }
        if(creative){
          const copy=action("Kopiuj materiały reklamy",async()=>{
            try{
              const text=["Google Ads / "+(creative.objective==="app_install"?"App Campaign":"Performance Max"),
                "Nagłówki:",...(creative.headlines||[]),
                "Długi nagłówek:",creative.long_headline||"",
                "Opisy:",...(creative.descriptions||[]),
                "Strona docelowa: "+(creative.final_url||""),
                creative.app_store_url?"Google Play: "+creative.app_store_url:"",
                "Grafika: "+(creative.landscape_url||"")].filter(Boolean).join("\n");
              await navigator.clipboard.writeText(text);
              setMessage("Skopiowano teksty i linki. W kampanii instalacyjnej użyj ich bezpośrednio w Google Ads.");
            }catch{setMessage("Nie udało się skopiować. Możesz zaznaczyć teksty i otworzyć grafikę z podglądu.",true);}
          });
          card.append(copy);
          if(creative.landscape_url){
            const link=document.createElement("a");
            link.href=creative.landscape_url;link.target="_blank";link.rel="noopener noreferrer";
            link.textContent="Otwórz przesłaną grafikę ↗";
            link.style.cssText="display:inline-block;margin:10px 8px 0 0";
            card.append(link);
          }
        }
        if(install){
          const note=document.createElement("p");
          note.textContent="Instalacje aplikacji wymagają osobnej kampanii App Campaign. Ten szkic nie uruchomi automatycznie Performance Max.";
          note.style.cssText="font-size:12px;color:#B45309;margin:10px 0 0";
          card.append(note);
          const guide=document.createElement("a");
          guide.href="https://ads.google.com/";guide.target="_blank";guide.rel="noopener noreferrer";
          guide.textContent="Otwórz Google Ads i utwórz kampanię aplikacji ↗";
          guide.style.cssText="display:inline-block;margin:10px 8px 0 0";
          card.append(guide);
          if(creative?.app_store_url){
            const link=document.createElement("a");
            link.href=creative.app_store_url;link.target="_blank";link.rel="noopener noreferrer";
            link.textContent="Otwórz aplikację w Google Play ↗";
            card.append(link);
          }
        }
        list.append(card);
      }
    } catch (error) {
      list.textContent = "Nie udało się pobrać propozycji Google Ads.";
      setMessage("Błąd odczytu szkiców Google Ads: " + (error.message || ""), true);
    }
  }
  window.loadGoogleAdLocations = loadLocations;
  window.loadGoogleAdsDrafts = loadDrafts;
  window.createGoogleAdsDraft = createDraft;
  window.approveGoogleAdsDraft = approveDraft;
  window.reviewGoogleAdsCampaign = reviewCampaign;
})();