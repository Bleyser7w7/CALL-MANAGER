drop policy if exists "profiles read authenticated" on public.profiles;
create policy "profiles read authenticated" on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('admin', 'supervisor', 'quality'));
drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles for update to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "agents read authenticated" on public.agents;
create policy "agents read authenticated" on public.agents for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('admin', 'supervisor', 'quality'));
drop policy if exists "agents admin manage" on public.agents;
create policy "agents admin manage" on public.agents for all to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "supervisors read authenticated" on public.supervisors;
create policy "supervisors read authenticated" on public.supervisors for select to authenticated using (true);
drop policy if exists "supervisors admin manage" on public.supervisors;
create policy "supervisors admin manage" on public.supervisors for all to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "callbacks role select" on public.callbacks;
create policy "callbacks role select" on public.callbacks for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or exists (
    select 1 from public.callback_assignments ca
    where ca.callback_id = callbacks.id and ca.agent_id = auth.uid()
  ));
drop policy if exists "callbacks manager insert" on public.callbacks;
create policy "callbacks manager insert" on public.callbacks for insert to authenticated
  with check (public.current_user_role() in ('admin', 'supervisor') and created_by = auth.uid());
drop policy if exists "callbacks manager update" on public.callbacks;
create policy "callbacks manager update" on public.callbacks for update to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));
drop policy if exists "callbacks manager delete" on public.callbacks;
create policy "callbacks manager delete" on public.callbacks for delete to authenticated
  using (public.current_user_role() = 'admin');

drop policy if exists "assignments read by scope" on public.callback_assignments;
create policy "assignments read by scope" on public.callback_assignments for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or agent_id = auth.uid());
drop policy if exists "assignments manager insert" on public.callback_assignments;
create policy "assignments manager insert" on public.callback_assignments for insert to authenticated
  with check (public.current_user_role() in ('admin', 'supervisor') and assigned_by = auth.uid());
drop policy if exists "assignments manager update" on public.callback_assignments;
create policy "assignments manager update" on public.callback_assignments for update to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists "attempts read by scope" on public.callback_attempts;
create policy "attempts read by scope" on public.callback_attempts for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or agent_id = auth.uid());
drop policy if exists "attempts assigned insert" on public.callback_attempts;
create policy "attempts assigned insert" on public.callback_attempts for insert to authenticated
  with check (agent_id = auth.uid() and exists (
    select 1 from public.callback_assignments ca
    where ca.callback_id = callback_attempts.callback_id and ca.agent_id = auth.uid() and ca.active
  ));

drop policy if exists "schedules read authenticated" on public.agent_schedules;
create policy "schedules read authenticated" on public.agent_schedules for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or agent_id = auth.uid());
drop policy if exists "schedules manager manage" on public.agent_schedules;
create policy "schedules manager manage" on public.agent_schedules for all to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists "breaks read authenticated" on public.agent_breaks;
create policy "breaks read authenticated" on public.agent_breaks for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or agent_id = auth.uid());
drop policy if exists "breaks manager manage" on public.agent_breaks;
create policy "breaks manager manage" on public.agent_breaks for all to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists "notifications own read" on public.notifications;
create policy "notifications own read" on public.notifications for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "notifications own update" on public.notifications;
create policy "notifications own update" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "activity read by role" on public.activity_logs;
create policy "activity read by role" on public.activity_logs for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor', 'quality') or exists (
    select 1 from public.callback_assignments ca
    where ca.callback_id = activity_logs.callback_id and ca.agent_id = auth.uid()
  ));
drop policy if exists "settings read authenticated" on public.system_settings;
create policy "settings read authenticated" on public.system_settings for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'));
drop policy if exists "settings admin manage" on public.system_settings;
create policy "settings admin manage" on public.system_settings for all to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "user sessions read by scope" on public.user_sessions;
create policy "user sessions read by scope" on public.user_sessions for select to authenticated
  using (user_id = auth.uid() or public.current_user_role() in ('admin', 'supervisor'));

revoke all on function public.assign_callback(uuid, uuid) from public, anon;
revoke all on function public.start_callback(uuid) from public, anon;
revoke all on function public.finish_callback(uuid, text, text, timestamptz) from public, anon;
revoke all on function public.close_callback(uuid, text) from public, anon;
revoke all on function public.process_callback_alerts() from public, anon, authenticated;
revoke all on function public.start_user_session(uuid) from public, anon;
revoke all on function public.heartbeat_user_session(uuid) from public, anon;
revoke all on function public.end_user_session(uuid, text) from public, anon;
grant execute on function public.assign_callback(uuid, uuid) to authenticated;
grant execute on function public.start_callback(uuid) to authenticated;
grant execute on function public.finish_callback(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.close_callback(uuid, text) to authenticated;
grant execute on function public.process_callback_alerts() to service_role;
grant execute on function public.start_user_session(uuid) to authenticated;
grant execute on function public.heartbeat_user_session(uuid) to authenticated;
grant execute on function public.end_user_session(uuid, text) to authenticated;
revoke all on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated, service_role;

revoke all on public.profiles, public.agents, public.supervisors, public.callbacks,
  public.callback_assignments, public.callback_attempts, public.agent_schedules,
  public.agent_breaks, public.notifications, public.activity_logs, public.system_settings,
  public.user_sessions
  from anon, authenticated;

grant select on public.profiles, public.agents, public.supervisors, public.callbacks,
  public.callback_assignments, public.callback_attempts, public.agent_schedules,
  public.agent_breaks, public.notifications, public.activity_logs, public.system_settings,
  public.user_sessions
  to authenticated;
grant update on public.profiles, public.agents, public.supervisors, public.callbacks,
  public.agent_schedules, public.agent_breaks, public.system_settings to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant insert on public.callbacks, public.agent_schedules, public.agent_breaks, public.system_settings
  to authenticated;
grant delete on public.agents, public.supervisors, public.callbacks,
  public.agent_schedules, public.agent_breaks, public.system_settings to authenticated;
grant all on public.profiles, public.agents, public.supervisors, public.callbacks,
  public.callback_assignments, public.callback_attempts, public.agent_schedules,
  public.agent_breaks, public.notifications, public.activity_logs, public.system_settings,
  public.user_sessions
  to service_role;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
    and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
    and schemaname = 'public' and tablename = 'callbacks') then
    alter publication supabase_realtime add table public.callbacks;
  end if;
end $$;
