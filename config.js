// Nastavenie pripojenia. Anon kľúč je verejný (Supabase → Project Settings → API → anon public);
// prístup chránia roly a RLS v databáze, nie tento kľúč.
// Ukážkový režim s vymyslenými dátami sa dá zapnúť aj s kľúčom: adresa appky + ?ukazka
export const CONFIG = {
  supabaseUrl: "https://eaokitrxdxjyaarjyvnt.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhb2tpdHJ4ZHhqeWFhcmp5dm50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5NDMwMzcsImV4cCI6MjEwODUxOTAzN30.HSVv0MivJdfG0XohKXS3DgdnD0_7OjVuaZ3VF0p5O_Y",
  nazovSkladu: "Hlavný sklad",
};
