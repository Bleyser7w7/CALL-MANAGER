import { fetchCallbacks, statusInfo, localDateTime } from "./callbacks.js";
import { fetchAgents } from "./assignments.js";
import { getSchedules } from "./schedules.js";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

export async function renderOverview(profile, filters = {}) {
  const callbacks = await fetchCallbacks({ profile, filters });
  let team = [];
  let availability;
  let nextBreak;
  if (profile.role === "agent") {
    const weekdayText = new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", weekday: "short" })
      .format(new Date());
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayText);
    const currentTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date());
    const currentMinutes = Number(currentTime.slice(0, 2)) * 60 + Number(currentTime.slice(3, 5));
    const [users, scheduleRows] = await Promise.all([fetchAgents(), getSchedules(profile.id)]);
    availability = users.find(user => user.id === profile.id);
    const todaySchedule = scheduleRows.find(row => row.weekday === weekday);
    nextBreak = todaySchedule?.agent_breaks?.find(item =>
      Number(item.start_time.slice(0, 2)) * 60 + Number(item.start_time.slice(3, 5)) > currentMinutes
    );
  } else {
    team = await fetchAgents();
  }
  const statuses = callbacks.reduce((total, row) => {
    total[row.status] = (total[row.status] || 0) + 1;
    return total;
  }, {});
  const completed = statuses.completed || 0;
  const completionRate = callbacks.length ? Math.round(completed / callbacks.length * 100) : 0;
  const stats = [
    ["Total de casos", callbacks.length, "En el periodo seleccionado"],
    ["Pendientes", (statuses.pending || 0) + (statuses.queued || 0) + (statuses.assigned || 0), "Requieren seguimiento"],
    ["Cumplidos", completed, `${completionRate}% de resolución`],
    ["Retrasados", statuses.overdue || 0, "Requieren atención"]
  ];
  if (profile.role !== "agent") {
    const available = team.filter(user => user.available_now).length;
    stats.push(["Agentes disponibles", available, "En turno y fuera de pausa"]);
    stats.push(["Fuera de turno", team.filter(user => user.role === "agent" && !user.on_shift).length, "Sin turno activo"]);
  }
  const statHtml = stats.map((item, index) => `
    <article class="stat-card"><div class="stat-label">${item[0]}</div>
      <div class="stat-value">${item[1]}</div><div class="stat-foot">${item[2]}</div></article>`).join("");
  const results = Object.entries(statuses).map(([status, value]) => ({
    label: statusInfo(status), value
  }));
  const max = Math.max(1, ...results.map(item => item.value));
  const bars = results.length ? results.map(item => `
    <div class="bar-row"><span>${item.label}</span><div class="bar-track">
      <div class="bar-fill" style="width:${Math.round(item.value / max * 100)}%"></div></div><strong>${item.value}</strong></div>`).join("")
    : '<div class="empty-state">Todavía no hay resultados para mostrar.</div>';
  const upcoming = [...callbacks].sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)).slice(0, 5);
  const rows = upcoming.map(callback => `
    <tr><td><strong>${escapeHtml(callback.case_number)}</strong></td>
      <td>${escapeHtml(callback.customer_name)}</td><td>${escapeHtml(localDateTime(callback.scheduled_at))}</td>
      <td>${statusInfo(callback.status)}</td></tr>`).join("");
  return `<section class="content-view">
    <div class="stats-grid">${statHtml}</div>
    <div class="section-heading"><h2>Resumen de actividad</h2><span class="subtle">Zona horaria: America/Lima</span></div>
    <div class="chart-grid"><article class="panel"><div class="section-heading" style="margin:0"><h2>Casos por estado</h2></div>
      <div class="bar-list">${bars}</div></article>
      <article class="panel"><div class="section-heading" style="margin:0"><h2>Indicadores</h2></div>
        <div class="setting-row"><span class="muted">Tasa de cumplimiento</span><strong>${completionRate}%</strong></div>
        <div class="setting-row"><span class="muted">Casos en llamada</span><strong>${statuses.in_call || 0}</strong></div>
        <div class="setting-row"><span class="muted">Reprogramados</span><strong>${statuses.rescheduled || 0}</strong></div>
        <div class="setting-row"><span class="muted">Incumplidos</span><strong>${statuses.unfulfilled || 0}</strong></div>
        ${profile.role === "agent" ? `<div class="setting-row"><span class="muted">Disponibilidad</span>
          <strong>${availability?.available_now ? "Disponible" : availability?.on_break ? "En pausa" : availability?.on_shift ? "No disponible" : "Fuera de turno"}</strong></div>
          <div class="setting-row"><span class="muted">Próximo descanso</span><strong>${nextBreak ? `${nextBreak.start_time.slice(0, 5)} · ${escapeHtml(nextBreak.label)}` : "No programado"}</strong></div>` : ""}
      </article></div>
    <div class="section-heading"><h2>Próximos casos</h2><button class="button button-small" data-view="callbacks">Ver todos</button></div>
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Caso</th><th>Cliente</th><th>Programado</th><th>Estado</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty-state">No hay casos programados.</td></tr>'}</tbody></table></article>
  </section>`;
}
