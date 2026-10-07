// 1. Dane dostępowe z panelu Supabase
const supabaseUrl = "https://zwyerdeuvyzgkgwglowr.supabase.co";
const supabaseKey = "sb_publishable_KMeRBCZCQH-S0Ubnr80v6w_Gub3vcQf";

// 2. Inicjalizacja klienta z obsługą sesji
window.supabaseClient = supabase.createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

console.log("🚀 Ride24: Supabase client aktywny (session enabled)");

// Homepage-only visual layer for the world explorer/map.
// Kept separate from business logic so it can be removed or rolled back safely.
(() => {
  const path = String(window.location.pathname || "").toLowerCase();
  const isHome = path === "/" || path.endsWith("/index.html") || path.endsWith("/");

  if (!isHome || document.querySelector('link[data-ride24-world-premium="1"]')) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "assets/css/world-explorer-premium.css?v=20261007";
  link.dataset.ride24WorldPremium = "1";
  document.head.appendChild(link);
})();
