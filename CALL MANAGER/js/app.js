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

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function getRoleUrl(role) {
  return role === "admin" ? "admin.html" : role === "agent" ? "dashboard-agent.html" : "dashboard-supervisor.html";
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
  if (profile.role !== "agent") items.push(["schedules", "◷", "Horarios"], ["team", "♙", "Equipo"]);
  else items.push(["schedules", "◷", "Horario"], ["history", "↺", "Historial"]);
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
      ${profile.role !== "agent" && currentView === "callbacks" ? '<button class="button button-primary button-small" data-action="new-callback">+ Nuevo caso</button>' : ""}</div></header>
      <div id="view-container"><div class="empty-state">Cargando datos…</div></div></main></div>`;
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
    ${profile.role === "admin" || profile.role === "supervisor" ? `<select class="field-select" data-filter="agentId"><option value="">Todos los agentes</option>${agentOptions}</select>` : ""}
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
    const canAssign = profile.role !== "agent" && !["completed", "cancelled", "unfulfilled"].includes(row.status);
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
  const rows = users.map(user => `<tr><td><strong>${escapeHtml(user.full_name)}</strong></td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.email)}</td>
    <td>${escapeHtml(user.role_label || user.role)}</td><td><span class="pill ${user.available_now ? "green" : "yellow"}">${user.available_now ? "En turno" : user.on_break ? "En pausa" : user.on_shift ? "No disponible" : "Fuera de turno"}</span></td></tr>`).join("");
  return `<section class="content-view">${profile.role === "admin" ? `<div class="toolbar"><button class="button button-primary button-small" data-action="new-user">+ Crear usuario</button>
    <span class="subtle">El alta segura se realiza en el servidor mediante una Edge Function.</span></div>` : ""}
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Usuario</th><th>Correo</th><th>Rol</th><th>Estado</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty-state">No hay usuarios registrados.</td></tr>'}</tbody></table></article></section>`;
}

async function historyView() {
  const { data: attempts, error } = await client.from("callback_attempts")
    .select("id,callback_id,outcome,notes,attempted_at")
    .eq("agent_id", profile.id).order("attempted_at", { ascending: false }).limit(200);
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
    if (currentView === "callbacks" && profile.role !== "agent" && !create) {
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
      <label class="field-label">Rol<select class="field-select" name="role"><option value="agent">Agente</option><option value="supervisor">Supervisor</option><option value="admin">Administrador</option></select></label></div>
      <div class="notice" id="modal-message">La contraseña temporal debe cambiarse después del primer inicio de sesión.</div>
      <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button><button class="button button-primary">Crear cuenta</button></footer></form>
  </section></div>`;
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

async function runAction(action, target) {
  const id = target.dataset.id;
  if (action === "logout") {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    window.location.replace("login.html");
  } else if (action === "new-callback") {
    const latestAgents = await fetchAgents();
    agents = latestAgents;
    root.insertAdjacentHTML("beforeend", newCallbackModal());
  } else if (action === "close-modal") {
    target.closest(".modal-backdrop")?.remove();
  } else if (action === "dismiss-modal" && target.classList.contains("modal-backdrop")) {
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
  const target = event.target.closest("[data-action], [data-view]");
  if (!target) return;
  if (target.dataset.view) {
    event.preventDefault();
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
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      form.closest(".modal-backdrop").remove();
      toast("Usuario creado.");
      await renderView();
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
    const notice = form.querySelector("#modal-message");
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
    if (!userProfile || !["admin", "supervisor", "agent"].includes(userProfile.role)) {
      throw new Error("Tu cuenta no tiene un rol habilitado. Contacta al administrador.");
    }
    profile = userProfile;
    const requiredRole = document.body.dataset.requiredRole;
    if (requiredRole && profile.role !== requiredRole) {
      window.location.replace(getRoleUrl(profile.role));
      return;
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
  if (realtimeChannel) client?.removeChannel(realtimeChannel);
  if (notificationsChannel) client?.removeChannel(notificationsChannel);
});

initialize();
