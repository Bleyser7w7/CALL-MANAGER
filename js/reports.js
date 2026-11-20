import { fetchCallbacks } from "./callbacks.js";

export async function exportCsv(profile, filters = {}) {
  const rows = await fetchCallbacks({ profile, filters });
  const columns = [
    ["case_number", "Caso"], ["customer_name", "Cliente"], ["phone", "Teléfono"],
    ["scheduled_at", "Programado (UTC)"], ["status", "Estado"], ["priority", "Prioridad"],
    ["reason", "Motivo"], ["problem", "Problema"], ["agent", "Agente"]
  ];
  const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    columns.map(([, label]) => escape(label)).join(","),
    ...rows.map(row => columns.map(([key]) => escape(
      key === "agent" ? row.assignment?.profiles?.full_name || "" : row[key]
    )).join(","))
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `callback-manager-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportAgentActivityCsv(rows) {
  const columns = [
    ["full_name", "Agente"], ["shift_started_at", "Inicio de turno (UTC)"],
    ["shift_ends_at", "Fin de turno (UTC)"], ["current_status", "Estado actual"],
    ["available_seconds", "Disponible (segundos)"], ["break_seconds", "Break (segundos)"],
    ["pause_seconds", "Pausa (segundos)"], ["bathroom_seconds", "Baño (segundos)"],
    ["training_seconds", "Capacitación (segundos)"], ["feedback_seconds", "Feedback (segundos)"]
  ];
  const statusLabels = {
    available: "Disponible", break: "Break", pause: "Pausa", bathroom: "Baño",
    training: "Capacitación", feedback: "Feedback", off_shift: "Fuera de turno"
  };
  const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    columns.map(([, label]) => escape(label)).join(","),
    ...rows.map(row => columns.map(([key]) => escape(
      key === "current_status" ? statusLabels[row[key]] || row[key] : row[key]
    )).join(","))
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `callback-manager-tiempos-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
