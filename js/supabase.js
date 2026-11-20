import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CALLBACK_MANAGER_CONFIG } from "./config.js";

const config = CALLBACK_MANAGER_CONFIG;
const url = config.url;
const anonKey = config.anonKey;

export const isSupabaseConfigured = Boolean(
  url && anonKey && !String(url).includes("TU-PROYECTO") && !String(anonKey).includes("TU-CLAVE")
);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      },
      realtime: { params: { eventsPerSecond: 5 } }
    })
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase no está configurado. Sigue las instrucciones de README.md.");
  }
  return supabase;
}
