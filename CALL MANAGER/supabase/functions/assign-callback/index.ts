import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return Response.json({ error: "Método no permitido." }, { status: 405, headers: corsHeaders });
  const authorization = request.headers.get("Authorization");
  if (!authorization) return Response.json({ error: "Sesión requerida." }, { status: 401, headers: corsHeaders });
  try {
    const body = await request.json();
    if (typeof body.callback_id !== "string" ||
      (body.agent_id !== null && body.agent_id !== undefined && typeof body.agent_id !== "string")) {
      return Response.json({ error: "Los datos de asignación no son válidos." }, { status: 400, headers: corsHeaders });
    }
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await client.rpc("assign_callback", {
      p_callback_id: body.callback_id,
      p_agent_id: body.agent_id || null
    });
    if (error) throw error;
    return Response.json(data, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "No se pudo asignar el caso." },
      { status: 400, headers: corsHeaders });
  }
});
