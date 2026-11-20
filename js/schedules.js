import { requireSupabase } from "./supabase.js";

export async function getSchedules(agentId) {
  const client = requireSupabase();
  const { data, error } = await client.from("agent_schedules")
    .select("id,agent_id,weekday,start_time,end_time,is_working")
    .eq("agent_id", agentId).order("weekday");
  if (error) throw error;
  const { data: breaks, error: breaksError } = await client.from("agent_breaks")
    .select("id,weekday,start_time,end_time,label").eq("agent_id", agentId).order("start_time");
  if (breaksError) throw breaksError;
  const byDay = new Map();
  for (const item of breaks || []) {
    const list = byDay.get(item.weekday) || [];
    list.push(item);
    byDay.set(item.weekday, list);
  }
  return (data || []).map(item => ({ ...item, agent_breaks: byDay.get(item.weekday) || [] }));
}

export async function saveSchedule(row) {
  const client = requireSupabase();
  const { data, error } = await client.from("agent_schedules").upsert({
    agent_id: row.agent_id,
    weekday: Number(row.weekday),
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    is_working: Boolean(row.is_working)
  }, { onConflict: "agent_id,weekday" }).select().single();
  if (error) throw error;
  return data;
}

export async function saveBreak(row) {
  const client = requireSupabase();
  const { error } = await client.from("agent_breaks").insert({
    agent_id: row.agent_id, weekday: Number(row.weekday),
    start_time: row.start_time, end_time: row.end_time, label: row.label.trim()
  });
  if (error) throw error;
}

export async function fetchAgentAvailability(agentIds) {
  if (!agentIds.length) return new Map();
  const client = requireSupabase();
  const { data: schedules, error } = await client.from("agent_schedules")
    .select("agent_id,weekday,start_time,end_time,is_working")
    .in("agent_id", agentIds);
  if (error) throw error;
  const { data: breaks, error: breaksError } = await client.from("agent_breaks")
    .select("agent_id,weekday,start_time,end_time").in("agent_id", agentIds);
  if (breaksError) throw breaksError;
  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).reduce((parts, item) => ({ ...parts, [item.type]: item.value }), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nowParts.weekday);
  const minute = Number(nowParts.hour) * 60 + Number(nowParts.minute);
  const toMinutes = value => {
    const [hour, mins] = value.slice(0, 5).split(":").map(Number);
    return hour * 60 + mins;
  };
  const output = new Map();
  for (const agentId of agentIds) {
    const shift = (schedules || []).find(item => item.agent_id === agentId && item.weekday === weekday);
    const onShift = Boolean(shift?.is_working && minute >= toMinutes(shift.start_time) && minute < toMinutes(shift.end_time));
    const onBreak = (breaks || []).some(item => item.agent_id === agentId && item.weekday === weekday &&
      minute >= toMinutes(item.start_time) && minute < toMinutes(item.end_time));
    output.set(agentId, { on_shift: onShift, on_break: onBreak, available_now: onShift && !onBreak });
  }
  return output;
}
