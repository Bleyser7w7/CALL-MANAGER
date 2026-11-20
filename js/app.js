import { isSupabaseConfigured, requireSupabase } from "./supabase.js";
import { createCallback, fetchCallbacks, finishCall, startCall, assignCallback, closeCallback, statusInfo, localDateTime } from "./callbacks.js";
import { fetchAgents } from "./assignments.js";
import { getSchedules, saveBreak, saveSchedule } from "./schedules.js";
import { fetchNotifications, markNotificationRead, notifyDesktop, subscribeNotifications } from "./notifications.js";
import { exportCsv } from "./reports.js";
import { renderOverview } from "./dashboard.js";

const root = document.querySelector("#app");
const client = isSupabaseConfigured ? requireSupabase() : null;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const weekdays = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
let profile;
let agents = [];
let teamMembers = [];
let currentView = "overview";
let callbackFilters = {};
let selectedScheduleAgentId = "";
let realtimeChannel;
let notificationsChannel;
let userImportEntries = null;
let userImportIssues = [];
let xlsxModulePromise;
let activeSessionKey = "";
let sessionHeartbeatTimer;
let sessionTrackingWarningShown = false;

const SESSION_STORAGE_KEY = "callback-manager-session-id";

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function createSessionKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function startSessionTracking() {
  let sessionKey = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionKey || "")) {
    sessionKey = createSessionKey();
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionKey);
  }
  const { error } = await client.rpc("start_user_session", { p_client_session_id: sessionKey });
  if (error) throw error;
  activeSessionKey = sessionKey;
  sessionTrackingWarningShown = false;
  window.clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = window.setInterval(updateSessionHeartbeat, 60_000);
}

async function updateSessionHeartbeat() {
  refreshSessionDurationDisplays();
  if (!activeSessionKey) return;
  try {
    const { error } = await client.rpc("heartbeat_user_session", { p_client_session_id: activeSessionKey });
    if (error) throw error;
    sessionTrackingWarningShown = false;
  } catch (error) {
    if (!sessionTrackingWarningShown) {
      toast(`No se pudo actualizar el tiempo de sesión: ${error.message}`, "error");
      sessionTrackingWarningShown = true;
    }
  }
}

async function endSessionTracking(reason) {
  if (!activeSessionKey) return;
  const { error } = await client.rpc("end_user_session", {
    p_client_session_id: activeSessionKey,
    p_reason: reason
  });
  if (error) throw error;
  activeSessionKey = "";
  window.clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = null;
}

function endSessionOnPageHide() {
  if (!activeSessionKey) return;
  const sessionKey = activeSessionKey;
  activeSessionKey = "";
  window.clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = null;
  client.rpc("end_user_session", { p_client_session_id: sessionKey, p_reason: "pagehide" })
    .then(({ error }) => {
      if (error) console.error("No se pudo registrar el cierre de sesión:", error.message);
    })
    .catch(error => console.error("No se pudo registrar el cierre de sesión:", error));
}

function formatSessionDuration(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainingMinutes = minutes % 60;
  return days ? `${days} d ${hours} h ${remainingMinutes} min` : `${hours} h ${remainingMinutes} min`;
}

function refreshSessionDurationDisplays() {
  const now = Date.now();
  document.querySelectorAll("[data-session-start]").forEach(element => {
    const start = Number(element.dataset.sessionStart);
    const end = element.dataset.sessionActive === "true" ? now : Number(element.dataset.sessionEnd);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      element.textContent = formatSessionDuration(end - start);
    }
  });
}

function getRoleUrl(role) {
  return role === "admin" ? "admin.html" : role === "agent" ? "dashboard-agent.html"
    : role === "quality" ? "dashboard-quality.html" : "dashboard-supervisor.html";
}

function pageTitle() {
  return {
    overview: ["Panel general", "Vista rápida de las devoluciones de llamada"],
    callbacks: ["Casos", "Gestiona, asigna y registra cada devolución"],
    schedules: ["Horarios", "Turnos y pausas de los agentes"],
    team: ["Equipo", "Usuarios y disponibilidad"],
    settings: ["Configuración", "Parámetros de operación y alertas"],
    history: ["Historial", "Intentos y resultados de tus llamadas"],
    reports: ["Reportes", "Consulta y exporta la actividad"]
  }[currentView] || ["Callback Manager", ""];
}

function navItems() {
  const items = [["overview", "◫", "Resumen"], ["callbacks", "▤", "Casos"]];
  if (profile.role === "admin" || profile.role === "supervisor") {
    items.push(["schedules", "◷", "Horarios"], ["team", "♙", "Equipo"]);
  } else if (profile.role === "agent") items.push(["schedules", "◷", "Horario"], ["history", "↺", "Historial"]);
  else if (profile.role === "quality") items.push(["history", "↺", "Historial"]);
  if (profile.role === "admin") items.push(["settings", "⚙", "Ajustes"]);
  items.push(["reports", "▥", "Reportes"]);
  return items;
}

function renderShell() {
  const [title, subtitle] = pageTitle();
  const initials = profile.full_name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  root.innerHTML = `<div class="app-shell">
    <aside class="sidebar"><a class="brand" href="${getRoleUrl(profile.role)}"><span class="brand-mark">C</span><span>CALLBACK<span class="brand-light">MANAGER</span></span></a>
      <div class="nav-label">ESPACIO DE TRABAJO</div><nav>${navItems().map(([key, icon, label]) =>
        `<a href="#" class="nav-link ${currentView === key ? "active" : ""}" data-view="${key}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`).join("")}</nav>
      <div class="sidebar-bottom"><div class="user-mini"><span class="avatar">${escapeHtml(initials)}</span><div><strong>${escapeHtml(profile.full_name)}</strong><small>${escapeHtml(profile.role_label)}</small></div></div>
        <button class="button button-small" style="width:100%" data-action="logout">Cerrar sesión</button></div></aside>
    <main class="main-area"><header class="topbar"><div><p class="eyebrow">${escapeHtml(profile.role_label.toUpperCase())}</p><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>
      <div class="top-actions"><button class="button button-small" data-action="enable-desktop">Activar avisos</button>
      <button class="button button-small" data-action="show-notifications">Avisos <span id="notification-count"></span></button>
      ${["admin", "supervisor"].includes(profile.role) && currentView === "callbacks" ? '<button class="button button-primary button-small" data-action="new-callback">+ Nuevo caso</button>' : ""}</div></header>
      <div id="view-container"><div class="empty-state">Cargando datos…</div></div>
      <footer class="app-footer">© Bleyser7w7 (2026). All rights reserved</footer></main></div>`;
}

function callbackToolbar() {
  const statusOptions = [
    ["", "Todos los estados"], ["pending", "Pendiente"], ["queued", "En cola"], ["assigned", "Asignado"],
    ["due_soon", "Próximo a vencer"], ["in_call", "En llamada"], ["overdue", "Retrasado"],
    ["rescheduled", "Reprogramado"], ["completed", "Cumplido"], ["unfulfilled", "Incumplido"], ["cancelled", "Cancelado"]
  ];
  const from = callbackFilters.from?.slice(0, 10) || "";
  const to = callbackFilters.to?.slice(0, 10) || "";
  const agentOptions = agents.map(agent => `<option value="${agent.id}" ${callbackFilters.agentId === agent.id ? "selected" : ""}>${escapeHtml(agent.full_name)}</option>`).join("");
  const supervisorOptions = teamMembers.filter(user => user.role === "supervisor" || user.role === "admin")
    .map(user => `<option value="${user.id}" ${callbackFilters.supervisorId === user.id ? "selected" : ""}>${escapeHtml(user.full_name)}</option>`).join("");
  return `<div class="toolbar"><select class="field-select" data-filter="status">${statusOptions.map(([value, label]) =>
      `<option value="${value}" ${callbackFilters.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
    <input class="field" type="date" data-filter="from" value="${from}" aria-label="Fecha inicial">
    <input class="field" type="date" data-filter="to" value="${to}" aria-label="Fecha final">
    ${["admin", "supervisor", "quality"].includes(profile.role) ? `<select class="field-select" data-filter="agentId"><option value="">Todos los agentes</option>${agentOptions}</select>` : ""}
    ${profile.role !== "agent" ? `<select class="field-select" data-filter="supervisorId"><option value="">Todos los supervisores</option>${supervisorOptions}</select>` : ""}
    <button class="button button-small" data-action="apply-filters">Filtrar</button>
    <button class="button button-small" data-action="clear-filters">Limpiar</button></div>`;
}

async function callbacksView() {
  const [rows, latestAgents] = await Promise.all([fetchCallbacks({ profile, filters: callbackFilters }), fetchAgents()]);
  teamMembers = latestAgents;
  agents = latestAgents.filter(item => item.role === "agent");
  const supervisors = latestAgents.filter(item => item.role === "supervisor" || item.role === "admin");
  const body = rows.map(row => {
    const assignedTo = row.assignment?.profiles?.full_name || "Sin asignar";
    const canCall = profile.role === "agent" && ["assigned", "pending", "due_soon", "overdue", "rescheduled"].includes(row.status);
    const canAssign = ["admin", "supervisor"].includes(profile.role) && !["completed", "cancelled", "unfulfilled"].includes(row.status);
    const actions = [
      canCall ? `<button class="button button-small button-primary" data-action="start-call" data-id="${row.id}">Iniciar llamada</button>` : "",
      canAssign ? `<button class="button button-small" data-action="assign" data-id="${row.id}">Asignar</button>` : "",
      canAssign ? `<button class="button button-small button-danger" data-action="close-case" data-status="unfulfilled" data-id="${row.id}">Incumplido</button>` : "",
      canAssign ? `<button class="button button-small" data-action="close-case" data-status="cancelled" data-id="${row.id}">Cancelar</button>` : "",
      row.status === "in_call" && profile.role === "agent" ? `<button class="button button-small button-primary" data-action="finish-call" data-id="${row.id}">Finalizar</button>` : ""
    ].filter(Boolean).join("");
    return `<tr><td><strong>${escapeHtml(row.case_number)}</strong><div class="subtle">${escapeHtml(row.reason)}</div></td>
      <td>${escapeHtml(row.customer_name)}<div class="subtle">${escapeHtml(row.phone)}</div></td>
      <td>${escapeHtml(localDateTime(row.scheduled_at))}</td><td>${escapeHtml(assignedTo)}</td>
      <td>${statusInfo(row.status)}</td><td><span class="pill ${row.priority === "urgent" ? "red" : row.priority === "high" ? "yellow" : "gray"}">${escapeHtml(row.priority)}</span></td>
      <td><div class="table-actions">${actions || "—"}</div></td></tr>`;
  }).join("");
  const supervisorOptions = supervisors.map(item => `<option value="${item.id}" ${profile.role === "supervisor" && profile.id === item.id ? "selected" : ""}>${escapeHtml(item.full_name)}</option>`).join("");
  return `<section class="content-view">${callbackToolbar()}
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Caso</th><th>Cliente</th><th>Programado</th><th>Agente</th><th>Estado</th><th>Prioridad</th><th>Acciones</th></tr></thead>
    <tbody>${body || '<tr><td colspan="7" class="empty-state">No hay casos que coincidan con los filtros.</td></tr>'}</tbody></table></article>
    ${profile.role !== "agent" ? `<datalist id="supervisor-options">${supervisorOptions}</datalist>` : ""}</section>`;
}

function newCallbackModal() {
  const supervisors = agents.filter(item => item.role === "supervisor" || item.role === "admin");
  return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><h2 id="modal-title">Registrar caso</h2><button class="text-button" data-action="close-modal" aria-label="Cerrar">✕</button></header>
    <form id="callback-form"><div class="form-grid">
      <label class="field-label">Número de caso<input class="field" name="case_number" required maxlength="80"></label>
      <label class="field-label">Nombre del cliente<input class="field" name="customer_name" required maxlength="160"></label>
      <label class="field-label">Número de celular<input class="field" name="phone" type="tel" required maxlength="30"></label>
      <label class="field-label">Prioridad<select class="field-select" name="priority"><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
      <label class="field-label">Fecha de devolución<input class="field" name="scheduled_date" type="date" required></label>
      <label class="field-label">Hora de devolución<input class="field" name="scheduled_time" type="time" required></label>
      <label class="field-label">Supervisor responsable<select class="field-select" name="supervisor_id" required>${supervisors.map(item => `<option value="${item.id}" ${profile.id === item.id ? "selected" : ""}>${escapeHtml(item.full_name)}</option>`).join("")}</select></label>
      <label class="field-label">Motivo de llamada<input class="field" name="reason" required maxlength="200"></label>
      <label class="field-label full">Problema reportado<textarea class="field-textarea" name="problem" required maxlength="4000"></textarea></label>
      <label class="field-label full">Observaciones<textarea class="field-textarea" name="notes" maxlength="4000"></textarea></label>
    </div><div class="notice" id="modal-message"></div><footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button>
      <button class="button button-primary" type="submit">Guardar y asignar</button></footer></form></section></div>`;
}

async function schedulesView() {
  if (profile.role !== "agent") agents = await fetchAgents();
  const agentsList = agents.filter(item => item.role === "agent");
  const chosen = profile.role === "agent" ? profile.id :
    selectedScheduleAgentId || agentsList[0]?.id;
  selectedScheduleAgentId = chosen || "";
  const rows = chosen ? await getSchedules(chosen) : [];
  const byDay = new Map(rows.map(row => [row.weekday, row]));
  if (profile.role === "agent") {
    return `<section class="content-view"><div class="schedule-grid">${weekdays.map((day, weekday) => {
      const row = byDay.get(weekday);
      return `<article class="schedule-card"><h3>${day}</h3><div class="schedule-list">
        <span>${row?.is_working ? `${row.start_time.slice(0, 5)} – ${row.end_time.slice(0, 5)}` : "Día libre"}</span>
        ${row?.agent_breaks?.map(br => `<span class="subtle">${escapeHtml(br.label)} · ${br.start_time.slice(0, 5)}–${br.end_time.slice(0, 5)}</span>`).join("") || ""}
      </div></article>`;
    }).join("")}</div><p class="subtle">Zona horaria: America/Lima</p></section>`;
  }
  const cards = weekdays.map((day, weekday) => {
    const row = byDay.get(weekday);
    return `<form class="schedule-card schedule-form" data-weekday="${weekday}" data-agent="${chosen || ""}">
      <h3>${day}</h3><div class="schedule-list"><label class="field-label">Turno
        <span class="inline"><input class="field" type="time" name="start_time" value="${row?.start_time?.slice(0, 5) || "09:00"}">
        <span class="muted">—</span><input class="field" type="time" name="end_time" value="${row?.end_time?.slice(0, 5) || "18:00"}"></span></label>
        <label class="inline"><input type="checkbox" name="is_working" ${row?.is_working ? "checked" : ""}> Día laboral</label>
        <button class="button button-small" type="submit">Guardar turno</button>
        ${row?.agent_breaks?.length ? `<div class="subtle">Pausas: ${row.agent_breaks.map(br => `${escapeHtml(br.label)} ${br.start_time.slice(0, 5)}–${br.end_time.slice(0, 5)}`).join(", ")}</div>` : ""}
      </div></form>`;
  }).join("");
  return `<section class="content-view"><div class="toolbar"><label class="field-label">Agente
    <select class="field-select" id="schedule-agent">${agentsList.map(item => `<option value="${item.id}" ${item.id === chosen ? "selected" : ""}>${escapeHtml(item.full_name)}</option>`).join("")}</select></label>
    ${chosen ? '<button class="button button-small" data-action="add-break">Agregar pausa</button>' : ""}</div>
    ${agentsList.length ? `<div class="schedule-grid">${cards}</div>` : '<div class="panel empty-state">No hay agentes. Crea usuarios de rol agente para configurar sus turnos.</div>'}</section>`;
}

async function teamView() {
  const users = await fetchAgents();
  teamMembers = users;
  const rows = users.map(user => {
    const status = user.role === "quality" ? "Calidad" : user.available_now ? "En turno"
      : user.on_break ? "En pausa" : user.on_shift ? "No disponible" : "Fuera de turno";
    return `<tr><td><strong>${escapeHtml(user.full_name)}</strong></td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role_label || user.role)}</td><td><span class="pill ${user.role === "quality" ? "blue" : user.available_now ? "green" : "yellow"}">${status}</span></td></tr>`;
  }).join("");
  const { data: sessions, error: sessionsError } = await client.from("user_sessions")
    .select("id,user_id,started_at,last_seen_at,ended_at,end_reason")
    .order("started_at", { ascending: false }).limit(100);
  const sessionWarning = sessionsError
    ? `<p class="notice error">No se pudo cargar el registro de sesiones: ${escapeHtml(sessionsError.message)}${sessionsError.code === "PGRST205"
      ? " Aplica database/schema.sql y database/policies.sql en Supabase; si la tabla ya existe, recarga la caché del esquema."
      : ""}</p>`
    : "";
  const usersById = new Map(users.map(user => [user.id, user]));
  const sessionRows = (sessions || []).map(session => {
    const user = usersById.get(session.user_id);
    const lastSeen = Date.parse(session.last_seen_at);
    const isStale = !session.ended_at && Date.now() - lastSeen > 2 * 60_000;
    const finish = session.ended_at ? Date.parse(session.ended_at) : isStale ? lastSeen : Date.now();
    const status = session.ended_at
      ? session.end_reason === "inactive" ? "Cierre estimado" : session.end_reason === "pagehide" ? "Pestaña cerrada" : "Cerrada"
      : isStale ? "Sin actividad" : "Activa";
    const endTime = session.ended_at ? localDateTime(session.ended_at) : isStale ? localDateTime(session.last_seen_at) : "Sesión abierta";
    return `<tr><td><strong>${escapeHtml(user?.full_name || "Usuario")}</strong><div class="subtle">${escapeHtml(user?.role_label || "")}</div></td>
      <td>${escapeHtml(localDateTime(session.started_at))}</td><td>${escapeHtml(endTime)}</td>
      <td><span data-session-start="${Date.parse(session.started_at)}" ${!session.ended_at && !isStale
        ? 'data-session-active="true"' : `data-session-end="${finish}"`}>${escapeHtml(formatSessionDuration(finish - Date.parse(session.started_at)))}</span></td>
      <td>${escapeHtml(status)}</td></tr>`;
  }).join("");
  return `<section class="content-view">${profile.role === "admin" ? `<div class="toolbar"><button class="button button-primary button-small" data-action="new-user">+ Crear usuario</button>
    <button class="button button-small" data-action="new-user-import">Importar desde Excel</button>
    <span class="subtle">Alta segura mediante una Edge Function. La plantilla incluye las columnas requeridas.</span></div>` : ""}
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Usuario</th><th>Correo</th><th>Rol</th><th>Estado</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty-state">No hay usuarios registrados.</td></tr>'}</tbody></table></article>
    <div class="section-heading"><h2>Tiempo de sesión por usuario</h2><span class="subtle">Últimas 100 sesiones; las pestañas sin cierre muestran su última actividad.</span></div>
    ${sessionWarning}
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Usuario</th><th>Inicio</th><th>Fin / actividad</th><th>Duración</th><th>Estado</th></tr></thead>
      <tbody>${sessionRows || `<tr><td colspan="5" class="empty-state">${sessionsError ? "Registro de sesiones no disponible." : "Aún no hay sesiones registradas."}</td></tr>`}</tbody></table></article></section>`;
}

async function historyView() {
  let attemptsQuery = client.from("callback_attempts").select("id,callback_id,agent_id,outcome,notes,attempted_at")
    .order("attempted_at", { ascending: false }).limit(200);
  if (profile.role === "agent") attemptsQuery = attemptsQuery.eq("agent_id", profile.id);
  const { data: attempts, error } = await attemptsQuery;
  if (error) throw error;
  const callbackIds = [...new Set((attempts || []).map(attempt => attempt.callback_id))];
  const { data: cases, error: casesError } = callbackIds.length
    ? await client.from("callbacks").select("id,case_number,customer_name").in("id", callbackIds)
    : { data: [], error: null };
  if (casesError) throw casesError;
  const byId = new Map((cases || []).map(item => [item.id, item]));
  const outcomes = {
    contacted: "Cliente contactado", no_answer: "Cliente no contesta", wrong_number: "Número incorrecto",
    callback_requested: "Solicita otra llamada", declined: "Rechaza atención", other: "Otro motivo"
  };
  return `<section class="content-view"><article class="panel table-wrap"><table class="data-table">
    <thead><tr><th>Fecha</th><th>Caso</th><th>Cliente</th><th>Resultado</th><th>Notas</th></tr></thead><tbody>
    ${(attempts || []).map(attempt => {
      const callback = byId.get(attempt.callback_id);
      return `<tr><td>${escapeHtml(localDateTime(attempt.attempted_at))}</td>
        <td>${escapeHtml(callback?.case_number || "Caso no disponible")}</td>
        <td>${escapeHtml(callback?.customer_name || "—")}</td><td>${escapeHtml(outcomes[attempt.outcome] || attempt.outcome)}</td>
        <td>${escapeHtml(attempt.notes || "—")}</td></tr>`;
    }).join("") || '<tr><td colspan="5" class="empty-state">Aún no tienes intentos registrados.</td></tr>'}
    </tbody></table></article></section>`;
}

async function settingsView() {
  const { data, error } = await client.from("system_settings")
    .select("value").eq("key", "callback_alerts").maybeSingle();
  if (error) throw error;
  const settings = data?.value || { first_minutes: 10, second_minutes: 5, overdue_minutes: 10 };
  return `<section class="content-view"><article class="panel"><div class="section-heading" style="margin-top:0">
    <h2>Alertas de devolución</h2><span class="subtle">Los cambios se aplican en el siguiente ciclo del cron.</span></div>
    <form id="settings-form"><div class="form-grid">
      <label class="field-label">Primera alerta (minutos antes)<input class="field" type="number" name="first_minutes" min="2" max="120" required value="${Number(settings.first_minutes)}"></label>
      <label class="field-label">Segundo recordatorio (minutos antes)<input class="field" type="number" name="second_minutes" min="1" max="60" required value="${Number(settings.second_minutes)}"></label>
      <label class="field-label">Marcar retraso (minutos después)<input class="field" type="number" name="overdue_minutes" min="1" max="120" required value="${Number(settings.overdue_minutes)}"></label>
    </div><div class="notice" id="modal-message"></div><footer class="modal-footer">
      <button class="button button-primary">Guardar parámetros</button></footer></form>
  </article><p class="subtle">Zona horaria operativa: America/Lima.</p></section>`;
}

async function reportsView() {
  const latestAgents = await fetchAgents();
  teamMembers = latestAgents;
  agents = latestAgents.filter(item => item.role === "agent");
  const rows = await fetchCallbacks({ profile, filters: callbackFilters });
  const completed = rows.filter(row => row.status === "completed").length;
  const outcome = rows.length ? Math.round(completed / rows.length * 100) : 0;
  const from = callbackFilters.from?.slice(0, 10) || "";
  const to = callbackFilters.to?.slice(0, 10) || "";
  const statusOptions = [
    ["", "Todos los estados"], ["pending", "Pendiente"], ["queued", "En cola"], ["assigned", "Asignado"],
    ["due_soon", "Próximo a vencer"], ["in_call", "En llamada"], ["overdue", "Retrasado"],
    ["rescheduled", "Reprogramado"], ["completed", "Cumplido"], ["unfulfilled", "Incumplido"], ["cancelled", "Cancelado"]
  ];
  return `<section class="content-view"><div class="toolbar">
    <input class="field" type="date" data-filter="from" value="${from}" aria-label="Fecha inicial">
    <input class="field" type="date" data-filter="to" value="${to}" aria-label="Fecha final">
    <select class="field-select" data-filter="status">${statusOptions.map(([value, label]) =>
      `<option value="${value}" ${callbackFilters.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
    ${profile.role !== "agent" ? `<select class="field-select" data-filter="agentId"><option value="">Todos los agentes</option>
      ${agents.map(item => `<option value="${item.id}" ${callbackFilters.agentId === item.id ? "selected" : ""}>${escapeHtml(item.full_name)}</option>`).join("")}</select>` : ""}
    ${profile.role !== "agent" ? `<select class="field-select" data-filter="supervisorId"><option value="">Todos los supervisores</option>
      ${teamMembers.filter(item => item.role === "supervisor" || item.role === "admin").map(item =>
        `<option value="${item.id}" ${callbackFilters.supervisorId === item.id ? "selected" : ""}>${escapeHtml(item.full_name)}</option>`).join("")}</select>` : ""}
    <button class="button button-small" data-action="apply-filters">Aplicar rango</button>
    <button class="button button-primary button-small" data-action="export-csv">Exportar CSV</button>
    <button class="button button-small" data-action="print-report">Imprimir / PDF</button></div>
    <div class="stats-grid"><article class="stat-card"><div class="stat-label">Casos incluidos</div><div class="stat-value">${rows.length}</div></article>
    <article class="stat-card"><div class="stat-label">Cumplidos</div><div class="stat-value">${completed}</div></article>
    <article class="stat-card"><div class="stat-label">Cumplimiento de casos</div><div class="stat-value">${outcome}%</div><div class="stat-foot">Cumplidos / total de casos</div></article>
    <article class="stat-card"><div class="stat-label">Retrasados</div><div class="stat-value">${rows.filter(row => row.status === "overdue").length}</div></article></div>
    <div class="section-heading"><h2>Detalle filtrado</h2><span class="subtle">Para PDF, selecciona «Guardar como PDF» en el diálogo de impresión.</span></div>
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Caso</th><th>Cliente</th><th>Programado</th><th>Estado</th><th>Agente</th></tr></thead>
    <tbody>${rows.map(row => `<tr><td>${escapeHtml(row.case_number)}</td><td>${escapeHtml(row.customer_name)}</td>
      <td>${escapeHtml(localDateTime(row.scheduled_at))}</td><td>${statusInfo(row.status)}</td><td>${escapeHtml(row.assignment?.profiles?.full_name || "Sin asignar")}</td></tr>`).join("") || '<tr><td colspan="5" class="empty-state">Sin resultados.</td></tr>'}</tbody></table></article></section>`;
}

async function renderView() {
  if (profile.role === "quality" && ["schedules", "team", "settings"].includes(currentView)) {
    currentView = "overview";
    renderShell();
  }
  const container = document.querySelector("#view-container");
  if (!container) return;
  container.innerHTML = '<div class="panel empty-state">Cargando datos…</div>';
  try {
    const html = currentView === "overview" ? await renderOverview(profile, callbackFilters)
      : currentView === "callbacks" ? await callbacksView()
      : currentView === "schedules" ? await schedulesView()
      : currentView === "team" ? await teamView()
      : currentView === "settings" ? await settingsView()
      : currentView === "history" ? await historyView()
      : await reportsView();
    container.innerHTML = html;
    renderShellHeader();
  } catch (error) {
    container.innerHTML = `<div class="panel empty-state">No se pudieron cargar los datos: ${escapeHtml(error.message)}</div>`;
  }
}

function renderShellHeader() {
  const header = document.querySelector(".topbar");
  if (!header) return;
  const actions = header.querySelector(".top-actions");
  if (actions) {
    const create = actions.querySelector('[data-action="new-callback"]');
    if (currentView === "callbacks" && ["admin", "supervisor"].includes(profile.role) && !create) {
      actions.insertAdjacentHTML("beforeend", '<button class="button button-primary button-small" data-action="new-callback">+ Nuevo caso</button>');
    } else if (currentView !== "callbacks") create?.remove();
  }
  const [title, subtitle] = pageTitle();
  header.querySelector(".page-title").textContent = title;
  header.querySelector(".page-subtitle").textContent = subtitle;
  header.querySelector(".eyebrow").textContent = profile.role_label.toUpperCase();
}

async function refreshNotifications() {
  const notifications = await fetchNotifications(profile.id);
  const unread = notifications.filter(item => !item.read_at).length;
  const count = document.querySelector("#notification-count");
  if (count) count.textContent = unread ? `(${unread})` : "";
}

function userModal() {
  return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true">
    <header class="modal-header"><h2>Crear usuario</h2><button class="text-button" data-action="close-modal">✕</button></header>
    <form id="user-form"><div class="form-grid"><label class="field-label">Nombre<input class="field" name="full_name" required maxlength="160"></label>
      <label class="field-label">Usuario<input class="field" name="username" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9._-]{2,31}" autocapitalize="none" spellcheck="false"></label>
      <label class="field-label">Correo electrónico<input class="field" name="email" type="email" required></label>
      <label class="field-label">Contraseña temporal<input class="field" name="password" type="password" required minlength="10" autocomplete="new-password"></label>
      <label class="field-label">Rol<select class="field-select" name="role"><option value="agent">Agente</option><option value="quality">Calidad</option><option value="supervisor">Supervisor</option><option value="admin">Administrador</option></select></label></div>
      <div class="notice" id="modal-message">La contraseña temporal debe cambiarse después del primer inicio de sesión.</div>
      <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button><button class="button button-primary">Crear cuenta</button></footer></form>
  </section></div>`;
}

function userImportModal() {
  return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="user-import-title">
    <header class="modal-header"><h2 id="user-import-title">Importar usuarios</h2><button class="text-button" data-action="close-modal" aria-label="Cerrar">✕</button></header>
    <form id="user-import-form"><label class="field-label">Archivo Excel o CSV
      <input class="field" id="user-import-file" name="file" type="file" accept=".xlsx,.xls,.csv" required></label>
      <p class="subtle">La primera hoja debe tener las columnas nombre, usuario, correo y contraseña. La columna rol es opcional; si falta o queda vacía, se asigna «agent». Roles permitidos: agent, quality, supervisor, admin. Contraseña mínima: 10 caracteres.</p>
      <p class="subtle">Usa contraseñas temporales y mantén el archivo protegido. Las claves no se muestran en el informe; se envían a Supabase para crear cada cuenta.</p>
      <button class="button button-small" type="button" data-action="download-user-template">Descargar plantilla .xlsx</button>
      <div class="notice" id="user-import-message" aria-live="polite">Selecciona un archivo para validarlo.</div>
      <ol class="import-results" id="user-import-results" aria-live="polite"></ol>
      <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button>
        <button class="button button-primary" type="submit" disabled>Crear usuarios</button></footer></form>
  </section></div>`;
}

function loadXlsx() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs")
      .catch(error => {
        xlsxModulePromise = null;
        throw new Error(`No se pudo cargar el lector de Excel: ${error.message}`);
      });
  }
  return xlsxModulePromise;
}

function normalizeImportHeader(value) {
  return String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function renderUserImportResults(results) {
  const list = document.querySelector("#user-import-results");
  if (!list) return;
  list.replaceChildren();
  for (const result of results) {
    const item = document.createElement("li");
    item.textContent = `Fila ${result.rowNumber} (${result.username || "sin usuario"}): ${result.status} — ${result.message}`;
    list.append(item);
  }
}

async function prepareUserImport(form, file) {
  userImportEntries = null;
  userImportIssues = [];
  renderUserImportResults([]);
  const message = form.querySelector("#user-import-message");
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  if (!file) {
    message.textContent = "Selecciona un archivo para validarlo.";
    return;
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("El archivo supera el límite de 5 MB.");

  const XLSX = await loadXlsx();
  if (!form.isConnected) return;
  let workbook;
  try {
    const fileData = await file.arrayBuffer();
    if (!form.isConnected) return;
    workbook = XLSX.read(fileData, { type: "array", cellText: true, cellDates: false });
  } catch {
    throw new Error("No se pudo leer el archivo. Verifica que sea un Excel o CSV válido.");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("El archivo no contiene una hoja de cálculo.");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true });
  if (rows.length < 2) throw new Error("La hoja debe incluir encabezados y al menos una fila de usuario.");

  const aliases = {
    full_name: ["nombre", "nombres", "nombrecompleto", "fullname"],
    username: ["usuario", "username"],
    email: ["correo", "correoelectronico", "email"],
    password: ["contrasena", "clave", "password"],
    role: ["rol", "role"]
  };
  const headers = rows[0].map(normalizeImportHeader);
  const columns = Object.fromEntries(Object.entries(aliases).map(([field, names]) =>
    [field, headers.findIndex(header => names.includes(header))]));
  const required = ["full_name", "username", "email", "password"];
  const missing = required.filter(field => columns[field] < 0);
  if (missing.length) {
    throw new Error(`Faltan columnas requeridas: ${missing.map(field => ({
      full_name: "nombre", username: "usuario", email: "correo", password: "contraseña"
    }[field])).join(", ")}.`);
  }

  const entries = [];
  const issues = [];
  const seenUsernames = new Set();
  const seenEmails = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.some(value => String(value ?? "").trim())) continue;
    const rowNumber = index + 1;
    const full_name = String(row[columns.full_name] ?? "").trim();
    const username = String(row[columns.username] ?? "").trim().toLowerCase();
    const email = String(row[columns.email] ?? "").trim().toLowerCase();
    const password = String(row[columns.password] ?? "");
    const role = columns.role < 0 ? "agent" : String(row[columns.role] ?? "").trim().toLowerCase() || "agent";
    const errors = [];
    if (!full_name || full_name.length > 160) errors.push("nombre requerido (máximo 160 caracteres)");
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) errors.push("usuario no válido");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("correo no válido");
    if (password.length < 10) errors.push("contraseña debe tener al menos 10 caracteres");
    if (!["admin", "supervisor", "agent", "quality"].includes(role)) errors.push("rol no válido");
    if (seenUsernames.has(username)) errors.push("usuario duplicado en el archivo");
    if (seenEmails.has(email)) errors.push("correo duplicado en el archivo");
    if (errors.length) {
      issues.push({ rowNumber, username, status: "No válido", message: errors.join("; ") });
      continue;
    }
    seenUsernames.add(username);
    seenEmails.add(email);
    entries.push({ rowNumber, user: { full_name, username, email, password, role } });
  }
  if (!entries.length && !issues.length) throw new Error("No se encontraron filas de usuarios.");

  userImportEntries = entries;
  userImportIssues = issues;
  renderUserImportResults(issues);
  message.textContent = `${entries.length} usuario(s) válido(s); ${issues.length} fila(s) con errores. Las filas inválidas se omitirán.`;
  message.className = issues.length ? "notice error" : "notice";
  submit.disabled = entries.length === 0;
}

async function downloadUserTemplate() {
  const XLSX = await loadXlsx();
  const worksheet = XLSX.utils.aoa_to_sheet([["nombre", "usuario", "correo", "contraseña", "rol"]]);
  worksheet["!cols"] = [{ wch: 24 }, { wch: 20 }, { wch: 30 }, { wch: 24 }, { wch: 16 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Usuarios");
  XLSX.writeFile(workbook, "plantilla-usuarios.xlsx");
}

function explainUserCreationError(message) {
  const detail = String(message || "No se pudo crear.");
  if (/already.*(registered|exists)|email_exists|profiles_email_key/i.test(detail)) {
    return "Ese correo ya está registrado. Usa un correo diferente.";
  }
  if (/profiles_username_key/i.test(detail)) {
    return "Ese nombre de usuario ya está en uso.";
  }
  return detail;
}

async function getUserCreationError(error, data) {
  if (typeof data?.error === "string") return explainUserCreationError(data.error);
  if (error?.context && typeof error.context.clone === "function") {
    try {
      const body = await error.context.clone().json();
      if (typeof body?.error === "string") return explainUserCreationError(body.error);
    } catch {
      return explainUserCreationError(error.message);
    }
  }
  return explainUserCreationError(error?.message);
}

async function createImportedUsers(form) {
  const submit = form.querySelector('button[type="submit"]');
  const fileInput = form.querySelector("#user-import-file");
  const message = form.querySelector("#user-import-message");
  if (!Array.isArray(userImportEntries)) throw new Error("Selecciona y valida un archivo antes de continuar.");
  if (!userImportEntries.length) throw new Error("No hay filas válidas para crear.");
  if (!window.confirm(`Se intentará crear ${userImportEntries.length} usuario(s). Las filas inválidas se omitirán. ¿Continuar?`)) return;

  const entries = userImportEntries;
  const total = entries.length;
  const results = [...userImportIssues];
  let created = 0;
  form.dataset.busy = "true";
  submit.disabled = true;
  fileInput.disabled = true;
  message.className = "notice";
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const payload = { ...entry.user };
      message.textContent = `Creando usuario ${index + 1} de ${total}…`;
      try {
        const { data, error } = await client.functions.invoke("create-user", { body: payload });
        if (error) throw new Error(await getUserCreationError(error, data));
        if (data?.error) throw new Error(data.error);
        created += 1;
        results.push({ rowNumber: entry.rowNumber, username: entry.user.username, status: "Creado", message: "Cuenta creada correctamente." });
      } catch (error) {
        results.push({ rowNumber: entry.rowNumber, username: entry.user.username, status: "Error", message: error.message || "No se pudo crear." });
      } finally {
        payload.password = "";
        entry.user.password = "";
      }
      renderUserImportResults(results.sort((first, second) => first.rowNumber - second.rowNumber));
    }
  } finally {
    userImportEntries = null;
    userImportIssues = [];
    fileInput.value = "";
    fileInput.disabled = false;
    submit.disabled = true;
    form.dataset.busy = "false";
  }
  const failed = total - created + results.filter(result => result.status === "No válido").length;
  message.textContent = `Proceso terminado: ${created} creado(s), ${failed} con error.`;
  message.className = failed ? "notice error" : "notice success";
  toast(`${created} usuario(s) creado(s); ${failed} con error.`, failed ? "error" : "success");
  await renderView();
}

function finishModal(callbackId) {
  return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true">
    <header class="modal-header"><h2>Registrar resultado de llamada</h2><button class="text-button" data-action="close-modal">✕</button></header>
    <form id="finish-form" data-id="${callbackId}"><div class="form-grid">
      <label class="field-label">Resultado<select class="field-select" name="outcome" required>
        <option value="contacted">Cliente contactado</option><option value="no_answer">Cliente no contesta</option>
        <option value="wrong_number">Número incorrecto</option><option value="callback_requested">Solicita otra llamada</option>
        <option value="declined">Rechaza atención</option><option value="other">Otro motivo</option></select></label>
      <label class="field-label">Reprogramar (opcional)<input class="field" name="reschedule_at" type="datetime-local"></label>
      <label class="field-label full">Notas<textarea class="field-textarea" name="notes"></textarea></label></div>
      <p class="subtle">No contactar al cliente no marca el caso como incumplido. Puedes reprogramar o dejarlo asignado para otro intento.</p>
      <div class="notice" id="modal-message"></div><footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button>
      <button class="button button-primary">Guardar resultado</button></footer></form></section></div>`;
}

function assignmentModal(callbackId) {
      const agentOptions = agents.filter(item => item.role === "agent")
        .map(item => `<option value="${item.id}">${escapeHtml(item.full_name)}${item.available_now ? " · En turno" : item.on_break ? " · En pausa" : " · Fuera de turno"}</option>`).join("");
      return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true">
        <header class="modal-header"><h2>Asignar caso</h2><button class="text-button" data-action="close-modal">✕</button></header>
        <form id="assign-form" data-id="${callbackId}"><div class="form-grid">
          <label class="field-label">Método<select class="field-select" name="mode"><option value="auto">Automático · equilibrar carga</option><option value="manual">Manual</option></select></label>
          <label class="field-label">Agente<select class="field-select" name="agent_id"><option value="">Selecciona un agente</option>${agentOptions}</select></label>
        </div><div class="notice" id="modal-message">Solo se asignará a agentes dentro de su turno y fuera de sus pausas.</div>
        <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button>
          <button class="button button-primary">Asignar caso</button></footer></form></section></div>`;
}

function breakModal(agentId) {
  return `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true">
    <header class="modal-header"><h2>Agregar pausa</h2><button class="text-button" data-action="close-modal">✕</button></header>
    <form id="break-form" data-agent="${agentId}"><div class="form-grid">
      <label class="field-label">Día<select class="field-select" name="weekday" required>${weekdays.map((day, index) =>
        `<option value="${index}">${day}</option>`).join("")}</select></label>
      <label class="field-label">Nombre<input class="field" name="label" value="Almuerzo" required maxlength="80"></label>
      <label class="field-label">Hora de inicio<input class="field" name="start_time" type="time" required></label>
      <label class="field-label">Hora de fin<input class="field" name="end_time" type="time" required></label>
    </div><div class="notice" id="modal-message"></div><footer class="modal-footer">
      <button class="button" type="button" data-action="close-modal">Cancelar</button>
      <button class="button button-primary">Guardar pausa</button></footer></form></section></div>`;
}

async function showNotificationList() {
  const notifications = await fetchNotifications(profile.id);
  const content = notifications.map(item => `<div class="setting-row"><div><strong>${escapeHtml(item.title)}</strong><div class="subtle">${escapeHtml(item.message)}</div></div>
    ${item.read_at ? '<span class="subtle">Leído</span>' : `<button class="button button-small" data-action="read-notification" data-id="${item.id}">Marcar leído</button>`}</div>`).join("");
  root.insertAdjacentHTML("beforeend", `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true">
    <header class="modal-header"><h2>Notificaciones</h2><button class="text-button" data-action="close-modal">✕</button></header>
    ${content || '<div class="empty-state">No tienes notificaciones.</div>'}</section></div>`);
}

function clearUserImportData() {
  if (Array.isArray(userImportEntries)) {
    for (const entry of userImportEntries) entry.user.password = "";
  }
  userImportEntries = null;
  userImportIssues = [];
}

async function runAction(action, target) {
  const id = target.dataset.id;
  if (action === "logout") {
    try {
      await endSessionTracking("logout");
    } catch (sessionError) {
      console.error("No se pudo registrar la salida:", sessionError);
      toast(`No se pudo guardar la hora de salida: ${sessionError.message}`, "error");
    }
    const { error } = await client.auth.signOut();
    if (error) throw error;
    window.location.replace("login.html");
  } else if (action === "new-callback") {
    const latestAgents = await fetchAgents();
    agents = latestAgents;
    root.insertAdjacentHTML("beforeend", newCallbackModal());
  } else if (action === "close-modal") {
    const modal = target.closest(".modal-backdrop");
    const importForm = modal?.querySelector("#user-import-form");
    if (importForm?.dataset.busy === "true") {
      toast("Espera a que termine la importación.", "error");
      return;
    }
    if (importForm) clearUserImportData();
    target.closest(".modal-backdrop")?.remove();
  } else if (action === "dismiss-modal" && target.classList.contains("modal-backdrop")) {
    const importForm = target.querySelector("#user-import-form");
    if (importForm?.dataset.busy === "true") {
      toast("Espera a que termine la importación.", "error");
      return;
    }
    if (importForm) clearUserImportData();
    target.remove();
  } else if (action === "start-call") {
    const { data: callback, error } = await client.from("callbacks").select("*").eq("id", id).single();
    if (error) throw error;
    await startCall(callback);
    toast("Llamada iniciada. Las alertas de demora quedan detenidas.");
    await renderView();
  } else if (action === "finish-call") {
    root.insertAdjacentHTML("beforeend", finishModal(id));
  } else if (action === "assign") {
    agents = await fetchAgents();
    root.insertAdjacentHTML("beforeend", assignmentModal(id));
  } else if (action === "close-case") {
    const status = target.dataset.status;
    const label = status === "unfulfilled" ? "incumplido" : "cancelado";
    if (!window.confirm(`¿Marcar este caso como ${label}?`)) return;
    await closeCallback(id, status);
    toast(`Caso marcado como ${label}.`);
    await renderView();
  } else if (action === "apply-filters") {
    callbackFilters = { ...callbackFilters };
    document.querySelectorAll("[data-filter]").forEach(input => {
      if (input.value) callbackFilters[input.dataset.filter] = input.dataset.filter === "from"
        ? `${input.value}T00:00:00-05:00` : input.dataset.filter === "to"
          ? `${input.value}T23:59:59-05:00` : input.value;
      else delete callbackFilters[input.dataset.filter];
    });
    await renderView();
  } else if (action === "clear-filters") {
    callbackFilters = {};
    await renderView();
  } else if (action === "export-csv") {
    await exportCsv(profile, callbackFilters);
  } else if (action === "print-report") {
    window.print();
  } else if (action === "enable-desktop") {
    if (!("Notification" in window)) throw new Error("Este navegador no admite notificaciones de escritorio.");
    const permission = await Notification.requestPermission();
    toast(permission === "granted" ? "Avisos de escritorio activados." : "El permiso de notificaciones no fue concedido.",
      permission === "granted" ? "success" : "error");
  } else if (action === "show-notifications") {
    await showNotificationList();
  } else if (action === "read-notification") {
    await markNotificationRead(id);
    target.closest(".modal-backdrop")?.remove();
    await showNotificationList();
    await refreshNotifications();
  } else if (action === "new-user") {
    root.insertAdjacentHTML("beforeend", userModal());
  } else if (action === "new-user-import") {
    clearUserImportData();
    root.insertAdjacentHTML("beforeend", userImportModal());
  } else if (action === "download-user-template") {
    await downloadUserTemplate();
  } else if (action === "add-break") {
    const selected = document.querySelector("#schedule-agent")?.value;
    if (!selected) throw new Error("Selecciona un agente para configurar su pausa.");
    root.insertAdjacentHTML("beforeend", breakModal(selected));
  } else if (action === "view") {
    currentView = target.dataset.view;
    renderShell();
    await renderView();
  }
}

root?.addEventListener("click", async event => {
  if (event.target.classList.contains("modal-backdrop")) {
    try {
      await runAction("dismiss-modal", event.target);
    } catch (error) {
      toast(error.message || "No se pudo cerrar el cuadro.", "error");
    }
    return;
  }
  const target = event.target.closest("[data-action], [data-view]");
  if (!target || target.dataset.action === "dismiss-modal") return;
  if (target.dataset.view) {
    event.preventDefault();
    clearUserImportData();
    currentView = target.dataset.view;
    renderShell();
    await renderView();
    return;
  }
  try {
    await runAction(target.dataset.action, target);
  } catch (error) {
    toast(error.message || "La acción no pudo completarse.", "error");
  }
});

root?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "callback-form") {
      const values = Object.fromEntries(new FormData(form));
      const callback = await createCallback({ ...values, created_by: profile.id });
      form.closest(".modal-backdrop").remove();
      toast("Caso registrado.");
      try {
        await assignCallback(callback.id, null);
        toast("Se asignó automáticamente a un agente disponible.");
      } catch (assignmentError) {
        toast(`Caso creado, pendiente de asignación: ${assignmentError.message}`, "error");
      }
      currentView = "callbacks";
      renderShell();
      await renderView();
    } else if (form.id === "finish-form") {
      const values = Object.fromEntries(new FormData(form));
      await finishCall({ id: form.dataset.id }, values.outcome, values.notes || "", values.reschedule_at || null);
      form.closest(".modal-backdrop").remove();
      toast("Resultado guardado.");
      await renderView();
    } else if (form.id === "assign-form") {
      const values = Object.fromEntries(new FormData(form));
      const agentId = values.mode === "manual" ? values.agent_id : null;
      if (values.mode === "manual" && !agentId) throw new Error("Selecciona un agente para la asignación manual.");
      const result = await assignCallback(form.dataset.id, agentId);
      form.closest(".modal-backdrop").remove();
      toast(result?.status === "queued" ? "No hay agentes disponibles; el caso quedó en cola." : "Caso asignado.");
      await renderView();
    } else if (form.id === "break-form") {
      const values = Object.fromEntries(new FormData(form));
      await saveBreak({ ...values, agent_id: form.dataset.agent });
      form.closest(".modal-backdrop").remove();
      toast("Pausa guardada.");
      await renderView();
    } else if (form.id === "settings-form") {
      const values = Object.fromEntries(new FormData(form));
      const first = Number(values.first_minutes);
      const second = Number(values.second_minutes);
      if (second >= first) throw new Error("El segundo recordatorio debe ocurrir antes de la primera alerta.");
      const { error } = await client.from("system_settings").upsert({
        key: "callback_alerts",
        value: { first_minutes: first, second_minutes: second, overdue_minutes: Number(values.overdue_minutes) },
        updated_by: profile.id,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      toast("Parámetros guardados.");
    } else if (form.id === "user-form") {
      const values = Object.fromEntries(new FormData(form));
      const { data, error } = await client.functions.invoke("create-user", { body: values });
      if (error) throw new Error(await getUserCreationError(error, data));
      if (data?.error) throw new Error(data.error);
      form.closest(".modal-backdrop").remove();
      toast("Usuario creado.");
      await renderView();
    } else if (form.id === "user-import-form") {
      await createImportedUsers(form);
    } else if (form.matches(".schedule-form")) {
      if (!form.dataset.agent) throw new Error("Selecciona un agente.");
      const values = new FormData(form);
      await saveSchedule({
        agent_id: form.dataset.agent,
        weekday: form.dataset.weekday,
        start_time: values.get("start_time"),
        end_time: values.get("end_time"),
        is_working: values.get("is_working") === "on"
      });
      toast("Turno guardado.");
    }
  } catch (error) {
    const notice = form.querySelector("#modal-message, #user-import-message");
    if (notice) {
      notice.textContent = error.message || "No se pudo completar la operación.";
      notice.className = "notice error";
    } else toast(error.message || "No se pudo completar la operación.", "error");
  }
});

root?.addEventListener("change", async event => {
  if (event.target.id === "schedule-agent") {
    selectedScheduleAgentId = event.target.value;
    await renderView();
  } else if (event.target.id === "user-import-file") {
    const form = event.target.form;
    const message = form.querySelector("#user-import-message");
    const submit = form.querySelector('button[type="submit"]');
    event.target.disabled = true;
    submit.disabled = true;
    message.textContent = "Leyendo y validando el archivo…";
    message.className = "notice";
    try {
      await prepareUserImport(form, event.target.files?.[0]);
    } catch (error) {
      userImportEntries = null;
      userImportIssues = [];
      renderUserImportResults([]);
      message.textContent = error.message || "No se pudo validar el archivo.";
      message.className = "notice error";
    } finally {
      event.target.disabled = false;
    }
  }
});

async function initialize() {
  if (!client) {
    root.innerHTML = '<div class="login-card"><h1>Supabase no configurado</h1><p class="muted">Completa la configuración indicada en README.md y vuelve a cargar la página.</p><a class="button button-primary" href="login.html">Ir al inicio</a></div>';
    return;
  }
  try {
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    if (!session) {
      window.location.replace("login.html");
      return;
    }
    const { data: userProfile, error: profileError } = await client.from("profiles")
      .select("id,full_name,email,role,role_label").eq("id", session.user.id).single();
    if (profileError) throw profileError;
    if (!userProfile || !["admin", "supervisor", "agent", "quality"].includes(userProfile.role)) {
      throw new Error("Tu cuenta no tiene un rol habilitado. Contacta al administrador.");
    }
    profile = userProfile;
    const requiredRole = document.body.dataset.requiredRole;
    if (requiredRole && profile.role !== requiredRole) {
      window.location.replace(getRoleUrl(profile.role));
      return;
    }
    try {
      await startSessionTracking();
    } catch (sessionError) {
      toast(`No se pudo iniciar el registro de tiempo: ${sessionError.message}`, "error");
    }
    renderShell();
    await renderView();
    await refreshNotifications();
    notificationsChannel = subscribeNotifications(profile.id, notification => {
      notifyDesktop(notification);
      toast(notification.title, "success");
      refreshNotifications().catch(error => toast(error.message, "error"));
    });
    realtimeChannel = client.channel("callback-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "callbacks" }, () => {
        renderView().catch(error => toast(error.message, "error"));
      }).subscribe();
  } catch (error) {
    root.innerHTML = `<div class="login-card"><h1>Error de acceso</h1><p class="notice error">${escapeHtml(error.message)}</p><a class="button button-primary" href="login.html">Volver a iniciar sesión</a></div>`;
  }
}

window.addEventListener("pagehide", () => {
  clearUserImportData();
  endSessionOnPageHide();
  if (realtimeChannel) client?.removeChannel(realtimeChannel);
  if (notificationsChannel) client?.removeChannel(notificationsChannel);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateSessionHeartbeat();
});

initialize();
