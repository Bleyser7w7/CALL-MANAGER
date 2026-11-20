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
