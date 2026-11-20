import { requireSupabase } from "./supabase.js";

export async function fetchNotifications(userId) {
  const client = requireSupabase();
  const { data, error } = await client.from("notifications")
    .select("id,title,message,created_at,read_at,callback_id")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  return data || [];
}

export async function markNotificationRead(notificationId) {
  const client = requireSupabase();
  const { error } = await client.from("notifications").update({ read_at: new Date().toISOString() })
    .eq("id", notificationId);
  if (error) throw error;
}

export function subscribeNotifications(userId, onNotification) {
  const client = requireSupabase();
  return client.channel(`notifications-${userId}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}`
    }, payload => onNotification(payload.new))
    .subscribe();
}

export function notifyDesktop(notification) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(notification.title, { body: notification.message, tag: notification.id });
}
