import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async request => {
  if (request.method !== "POST") return Response.json({ error: "Método no permitido." }, { status: 405 });
  const expectedSecret = Deno.env.get("CRON_SECRET");
  const suppliedSecret = request.headers.get("x-cron-secret");
  if (!expectedSecret || !suppliedSecret || suppliedSecret !== expectedSecret) {
    return Response.json({ error: "No autorizado." }, { status: 401 });
  }
  try {
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await client.rpc("process_callback_alerts");
    if (error) throw error;
    return Response.json({ processed: data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "No se pudieron procesar las alertas." }, { status: 500 });
  }
});
