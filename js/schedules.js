import { requireSupabase } from "./supabase.js";

export async function getSchedules(agentId) {
  const client = requireSupabase();
  const { data, error } = await client.from("agent_schedules")
    .select("id,agent_id,weekday,start_time,end_time,is_working")
    .eq("agent_id", agentId).order("weekday");
  if (error) throw error;
  return data || [];
}

export async function saveDailySchedule({ agent_id, start_time, end_time, rest_day }) {
  const client = requireSupabase();
  const dayOff = Number(rest_day);
  if (!Number.isInteger(dayOff) || dayOff < 0 || dayOff > 6) {
    throw new Error("Selecciona un único día de descanso.");
  }
  if (!start_time || !end_time || start_time >= end_time) {
    throw new Error("La hora de fin debe ser posterior a la hora de inicio.");
  }
  const rows = Array.from({ length: 7 }, (_, weekday) => ({
    agent_id,
    weekday,
    start_time,
    end_time,
    is_working: weekday !== dayOff
  }));
  const { data, error } = await client.from("agent_schedules")
    .upsert(rows, { onConflict: "agent_id,weekday" }).select();
  if (error) throw error;
  return data;
}

export async function fetchAgentAvailability(agentIds) {
  if (!agentIds.length) return new Map();
  const client = requireSupabase();
  const dateKey = value => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const nowDate = new Date();
  const today = dateKey(nowDate);
  const todayStart = new Date(`${today}T00:00:00-05:00`);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const todayStartMs = todayStart.getTime();
  const tomorrowStartMs = tomorrowStart.getTime();
  const now = nowDate.getTime();
  const { data: schedules, error } = await client.from("agent_schedules")
    .select("agent_id,weekday,is_working")
    .in("agent_id", agentIds);
  if (error) throw error;
  const { data: activity, error: activityError } = await client.from("agent_activity_events")
    .select("agent_id,status,shift_started_at,shift_ends_at,started_at,ended_at")
    .in("agent_id", agentIds).gte("shift_started_at", todayStart.toISOString())
    .lt("shift_started_at", tomorrowStart.toISOString());
  if (activityError) throw activityError;
  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima", weekday: "short"
  }).formatToParts(nowDate).reduce((parts, item) => ({ ...parts, [item.type]: item.value }), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nowParts.weekday);
  const output = new Map();
  for (const agentId of agentIds) {
    const agentSchedules = (schedules || []).filter(item => item.agent_id === agentId);
    const daySchedule = (schedules || []).find(item => item.agent_id === agentId && item.weekday === weekday);
    const workingSchedules = agentSchedules.filter(item => item.is_working);
    const restDays = agentSchedules.filter(item => !item.is_working);
    const scheduleConfigured = agentSchedules.length === 7 && workingSchedules.length === 6 && restDays.length === 1
      && workingSchedules.every(item => item.start_time === workingSchedules[0].start_time
        && item.end_time === workingSchedules[0].end_time);
    const agentActivity = (activity || []).filter(item => item.agent_id === agentId);
    const activeStatus = agentActivity.find(item => !item.ended_at && Date.parse(item.shift_ends_at) > now);
    const availableSeconds = agentActivity.reduce((total, item) => {
      if (item.status !== "available") return total;
      const start = Math.max(Date.parse(item.started_at), todayStartMs);
      const end = Math.min(item.ended_at ? Date.parse(item.ended_at) : now,
        Date.parse(item.shift_ends_at), tomorrowStartMs, now);
      return total + Math.max(0, Math.floor((end - start) / 1000));
    }, 0);
    const isRestDay = scheduleConfigured && Boolean(daySchedule && !daySchedule.is_working);
    const availabilityLimitReached = availableSeconds >= 8 * 60 * 60;
    output.set(agentId, {
      on_shift: Boolean(activeStatus),
      schedule_configured: scheduleConfigured,
      is_rest_day: isRestDay,
      on_break: activeStatus?.status === "break",
      activity_status: activeStatus?.status || null,
      available_seconds: availableSeconds,
      availability_limit_reached: availabilityLimitReached,
      available_now: Boolean(scheduleConfigured && daySchedule?.is_working
        && activeStatus?.status === "available" && !availabilityLimitReached)
    });
  }
  return output;
}
