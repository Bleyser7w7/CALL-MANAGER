import { requireSupabase } from "./supabase.js";

const STATUSES = {
  pending: ["Pendiente", "gray"], queued: ["En cola", "blue"], assigned: ["Asignado", "blue"],
  due_soon: ["Próximo a vencer", "yellow"], in_call: ["En llamada", "blue"],
  overdue: ["Retrasado", "red"], rescheduled: ["Reprogramado", "yellow"],
  completed: ["Cumplido", "green"], unfulfilled: ["Incumplido", "red"], cancelled: ["Cancelado", "gray"]
};

export function statusInfo(status) {
  const [label, tone] = STATUSES[status] || [status, "gray"];
  return `<span class="pill ${tone}">${label}</span>`;
}

export function localDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium", timeStyle: "short", timeZone: "America/Lima"
  }).format(new Date(value));
}

export async function fetchCallbacks({ profile, filters = {} }) {
  const client = requireSupabase();
  let query = client.from("callbacks").select("*").order("scheduled_at", { ascending: true });
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("scheduled_at", filters.from);
  if (filters.to) query = query.lte("scheduled_at", filters.to);
  if (profile.role === "agent") {
    const { data: assignments, error: assignmentError } = await client
      .from("callback_assignments").select("callback_id").eq("agent_id", profile.id).eq("active", true);
    if (assignmentError) throw assignmentError;
    const ids = (assignments || []).map(item => item.callback_id);
    if (!ids.length) return [];
    query = query.in("id", ids);
  }
  if (filters.supervisorId) query = query.eq("supervisor_id", filters.supervisorId);
  const { data, error } = await query.limit(500);
  if (error) throw error;
  if (!data?.length) return [];

  const ids = data.map(item => item.id);
  const { data: assignments, error: assignmentsError } = await client
    .from("callback_assignments")
    .select("callback_id, agent_id, active")
    .in("callback_id", ids).eq("active", true);
  if (assignmentsError) throw assignmentsError;
  const agentIds = [...new Set((assignments || []).map(item => item.agent_id))];
  const { data: profileRows, error: profileError } = agentIds.length
    ? await client.from("profiles").select("id,full_name,email").in("id", agentIds)
    : { data: [], error: null };
  if (profileError) throw profileError;
  const profilesById = new Map((profileRows || []).map(item => [item.id, item]));
  const byCallback = new Map((assignments || []).map(item => [
    item.callback_id, { ...item, profiles: profilesById.get(item.agent_id) || null }
  ]));
  return data.map(item => ({ ...item, assignment: byCallback.get(item.id) || null }))
    .filter(item => !filters.agentId || item.assignment?.agent_id === filters.agentId);
}

export async function createCallback(values) {
  const client = requireSupabase();
  const { data, error } = await client.from("callbacks").insert({
    case_number: values.case_number.trim(),
    customer_name: values.customer_name.trim(),
    phone: values.phone.trim(),
    scheduled_at: new Date(`${values.scheduled_date}T${values.scheduled_time}:00-05:00`).toISOString(),
    reason: values.reason.trim(),
    problem: values.problem.trim(),
    supervisor_id: values.supervisor_id,
    priority: values.priority,
    notes: values.notes.trim(),
    created_by: values.created_by,
    status: "pending"
  }).select().single();
  if (error) throw error;
  return data;
}

export async function startCall(callback) {
  const client = requireSupabase();
  const { data, error } = await client.rpc("start_callback", { p_callback_id: callback.id });
  if (error) throw error;
  return data;
}

export async function finishCall(callback, outcome, notes, rescheduleAt) {
  const client = requireSupabase();
  const limaReschedule = rescheduleAt
    ? new Date(`${rescheduleAt}:00-05:00`).toISOString()
    : null;
  const { data, error } = await client.rpc("finish_callback", {
    p_callback_id: callback.id,
    p_outcome: outcome,
    p_notes: notes.trim(),
    p_reschedule_at: limaReschedule
  });
  if (error) throw error;
  return data;
}

async function getFunctionErrorMessage(error, data) {
  if (typeof data?.error === "string") return data.error;
  if (error?.context && typeof error.context.clone === "function") {
    let responseBody;
    try {
      responseBody = await error.context.clone().text();
    } catch (readError) {
      return `${error.message || "No se pudo asignar el caso."} (${readError.message})`;
    }
    if (responseBody) {
      try {
        const body = JSON.parse(responseBody);
        if (typeof body === "string") return body;
        if (typeof body?.error === "string") return body.error;
        if (typeof body?.message === "string") return body.message;
      } catch {
        return responseBody;
      }
    }
  }
  return error?.message || "No se pudo asignar el caso.";
}

export async function assignCallback(callbackId, agentId) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke("assign-callback", {
    body: { callback_id: callbackId, agent_id: agentId || null }
  });
  if (error) throw new Error(await getFunctionErrorMessage(error, data));
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function closeCallback(callbackId, status) {
  const client = requireSupabase();
  const { data, error } = await client.rpc("close_callback", {
    p_callback_id: callbackId,
    p_status: status
  });
  if (error) throw error;
  return data;
}

export async function addActivity(callbackId, action, details = {}) {
  const client = requireSupabase();
  const { error } = await client.from("activity_logs").insert({
    callback_id: callbackId, action, details
  });
  if (error) throw error;
}

export { STATUSES };
