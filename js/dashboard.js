import { fetchCallbacks, statusInfo, localDateTime } from "./callbacks.js";
import { fetchAgents } from "./assignments.js";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

export async function renderOverview(profile, filters = {}) {
  const callbacks = await fetchCallbacks({ profile, filters });
  let team = [];
  let availability;
  if (profile.role === "agent") {
    const users = await fetchAgents();
    availability = users.find(user => user.id === profile.id);
  } else if (profile.role !== "quality") {
    team = await fetchAgents();
  }
  const statuses = callbacks.reduce((total, row) => {
    total[row.status] = (total[row.status] || 0) + 1;
    return total;
  }, {});
  const completed = statuses.completed || 0;
  const completionRate = callbacks.length ? Math.round(completed / callbacks.length * 100) : 0;
  const activityLabels = {
    available: "Disponible", break: "Break", pause: "Pausa", bathroom: "Baño",
    training: "Capacitación", feedback: "Feedback"
  };
  const agentAvailabilityLabel = availability?.availability_limit_reached ? "Límite diario alcanzado; Pausa"
    : availability?.is_rest_day ? "Día de descanso"
    : !availability?.schedule_configured ? "Horario sin configurar"
      : availability?.activity_status === "available"
        ? availability.available_now ? "Disponible" : "No disponible"
        : activityLabels[availability?.activity_status] || (availability?.on_shift ? "No disponible" : "Aún no inició");
  const stats = [
    ["Total de casos", callbacks.length, "En el periodo seleccionado"],
    ["Pendientes", (statuses.pending || 0) + (statuses.queued || 0) + (statuses.assigned || 0), "Requieren seguimiento"],
    ["Cumplidos", completed, `${completionRate}% de resolución`],
    ["Retrasados", statuses.overdue || 0, "Requieren atención"]
  ];
  if (profile.role !== "agent" && profile.role !== "quality") {
    const available = team.filter(user => user.available_now).length;
    stats.push(["Agentes disponibles", available, "Marcados Disponible en día laboral"]);
    stats.push(["No disponibles", team.filter(user => user.role === "agent" && !user.available_now).length, "Pausa, descanso o aún no iniciaron"]);
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
          <strong>${agentAvailabilityLabel}</strong></div>
          <div class="setting-row"><span class="muted">Máximo Disponible</span><strong>8 horas por día</strong></div>` : ""}
      </article></div>
    <div class="section-heading"><h2>Próximos casos</h2><button class="button button-small" data-view="callbacks">Ver todos</button></div>
    <article class="panel table-wrap"><table class="data-table"><thead><tr><th>Caso</th><th>Cliente</th><th>Programado</th><th>Estado</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty-state">No hay casos programados.</td></tr>'}</tbody></table></article>
  </section>`;
}
