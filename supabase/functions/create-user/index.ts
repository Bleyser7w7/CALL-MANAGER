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
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ error: "Sesión requerida." }, { status: 401, headers: corsHeaders });
  }
  try {
    const token = authorization.slice("Bearer ".length);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const callerClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: userData, error: userError } = await callerClient.auth.getUser(token);
    if (userError || !userData.user) throw new Error("La sesión no es válida.");
    const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: callerProfile, error: roleError } = await adminClient.from("profiles")
      .select("role").eq("id", userData.user.id).single();
    if (roleError) throw roleError;
    if (callerProfile.role !== "admin") throw new Error("Solo un administrador puede crear usuarios.");

    const body = await request.json();
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role;
    if (!fullName || fullName.length > 160 || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      password.length < 10 || !["admin", "supervisor", "agent"].includes(role)) {
      throw new Error("Nombre, usuario, correo, rol o contraseña no válidos.");
    }
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName }
    });
    if (createError) throw createError;
    const id = created.user.id;
    const { error: profileError } = await adminClient.from("profiles")
      .update({ full_name: fullName, username, email, role }).eq("id", id);
    if (profileError) {
      await adminClient.auth.admin.deleteUser(id);
      throw profileError;
    }
    if (role === "agent") {
      const { error } = await adminClient.from("agents").insert({ id });
      if (error) {
        await adminClient.auth.admin.deleteUser(id);
        throw error;
      }
    } else if (role === "supervisor") {
      const { error } = await adminClient.from("supervisors").insert({ id });
      if (error) {
        await adminClient.auth.admin.deleteUser(id);
        throw error;
      }
    }
    return Response.json({ id, username, email }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "No se pudo crear el usuario." },
      { status: 400, headers: corsHeaders });
  }
});
