import { requireSupabase } from "./supabase.js";
import { assignCallback } from "./callbacks.js";
import { fetchAgentAvailability } from "./schedules.js";

export async function fetchAgents() {
  const client = requireSupabase();
  const { data, error } = await client.from("profiles")
    .select("id,full_name,username,email,role,role_label")
    .in("role", ["admin", "agent", "supervisor", "quality"]).order("full_name");
  if (error) throw error;
  const agentIds = (data || []).filter(user => user.role === "agent").map(user => user.id);
  if (!agentIds.length) return data || [];
  const { data: agentRows, error: agentsError } = await client.from("agents")
    .select("id,is_available").in("id", agentIds);
  if (agentsError) throw agentsError;
  const availability = new Map((agentRows || []).map(agent => [agent.id, agent.is_available]));
  const shifts = await fetchAgentAvailability(agentIds);
  return (data || []).map(user => {
    const shift = shifts.get(user.id) || { on_shift: false, on_break: false, available_now: false };
    const enabled = availability.get(user.id) ?? false;
    return { ...user, is_available: enabled, ...shift, available_now: enabled && shift.available_now };
  });
}

export async function autoAssign(callbackId) {
  return assignCallback(callbackId, null);
}

export async function manualAssign(callbackId, agentId) {
  if (!agentId) throw new Error("Selecciona un agente para asignar el caso.");
  return assignCallback(callbackId, agentId);
}
