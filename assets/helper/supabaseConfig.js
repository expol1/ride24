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