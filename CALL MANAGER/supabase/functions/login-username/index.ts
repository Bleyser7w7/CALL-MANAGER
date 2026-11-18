import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const invalidCredentials = { error: "Usuario o contraseña incorrectos." };

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") {
    return Response.json({ error: "Método no permitido." }, { status: 405, headers: corsHeaders });
  }
  try {
    const body = await request.json();
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) || !password) {
      return Response.json(invalidCredentials, { status: 401, headers: corsHeaders });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: account, error: accountError } = await adminClient.from("profiles")
      .select("email").eq("username", username).maybeSingle();
    if (accountError) throw accountError;

    const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await authClient.auth.signInWithPassword({
      email: account?.email || `unknown-${username}@callback-manager.invalid`,
      password
    });
    if (!account?.email || error || !data.session) {
      return Response.json(invalidCredentials, { status: 401, headers: corsHeaders });
    }
    return Response.json({ session: data.session }, { headers: corsHeaders });
  } catch {
    return Response.json({ error: "No se pudo validar el acceso. Inténtalo nuevamente." },
      { status: 500, headers: corsHeaders });
  }
});
