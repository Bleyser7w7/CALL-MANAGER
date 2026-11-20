create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  username text not null unique constraint profiles_username_format_check
    check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  email text not null default '',
  role text not null default 'agent' check (role in ('admin', 'supervisor', 'agent', 'quality')),
  role_label text generated always as (
    case role when 'admin' then 'Administrador' when 'supervisor' then 'Supervisor'
      when 'quality' then 'Calidad' else 'Agente' end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
update public.profiles
set username = left(
  coalesce(nullif(regexp_replace(split_part(lower(email), '@', 1), '[^a-z0-9._-]', '', 'g'), ''), 'user'),
  24
) || '_' || substr(replace(id::text, '-', ''), 1, 7)
where username is null;
alter table public.profiles alter column username set not null;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'supervisor', 'agent', 'quality'));
alter table public.profiles drop column if exists role_label;
alter table public.profiles add column role_label text generated always as (
  case role when 'admin' then 'Administrador' when 'supervisor' then 'Supervisor'
    when 'quality' then 'Calidad' else 'Agente' end
) stored;
create unique index if not exists profiles_username_lower_idx on public.profiles(lower(username));
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_username_format_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles add constraint profiles_username_format_check
      check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
  end if;
end $$;

create table if not exists public.agents (
  id uuid primary key references public.profiles(id) on delete cascade,
  is_available boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.supervisors (
  id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.callbacks (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique,
  customer_name text not null,
  phone text not null,
  scheduled_at timestamptz not null,
  reason text not null,
  problem text not null,
  supervisor_id uuid not null references public.profiles(id),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  notes text not null default '',
  status text not null default 'pending' check (
    status in ('pending', 'queued', 'assigned', 'due_soon', 'in_call', 'overdue',
      'rescheduled', 'completed', 'unfulfilled', 'cancelled')
  ),
  created_by uuid not null references public.profiles(id),
  call_started_at timestamptz,
  call_finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.callback_assignments (
  id uuid primary key default gen_random_uuid(),
  callback_id uuid not null references public.callbacks(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists callback_assignments_one_active_idx
  on public.callback_assignments(callback_id) where active;
create index if not exists callback_assignments_agent_active_idx
  on public.callback_assignments(agent_id, active);
create index if not exists callbacks_scheduled_status_idx
  on public.callbacks(scheduled_at, status);
create index if not exists callbacks_supervisor_idx on public.callbacks(supervisor_id, scheduled_at);

create table if not exists public.callback_attempts (
  id uuid primary key default gen_random_uuid(),
  callback_id uuid not null references public.callbacks(id) on delete cascade,
  agent_id uuid not null references public.profiles(id),
  outcome text not null check (outcome in ('contacted', 'no_answer', 'wrong_number', 'callback_requested', 'declined', 'other')),
  notes text not null default '',
  attempted_at timestamptz not null default now()
);
create index if not exists callback_attempts_callback_idx on public.callback_attempts(callback_id, attempted_at desc);

create table if not exists public.agent_schedules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time,
  end_time time,
  is_working boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(agent_id, weekday),
  check ((is_working and start_time is not null and end_time is not null and start_time < end_time)
    or (not is_working))
);

create table if not exists public.agent_breaks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  label text not null default 'Pausa',
  check (start_time < end_time)
);
create index if not exists agent_breaks_agent_day_idx on public.agent_breaks(agent_id, weekday);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  callback_id uuid references public.callbacks(id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text not null,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists notifications_deduplicate_idx
  on public.notifications(user_id, callback_id, notification_type, scheduled_at);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);

create table if not exists public.agent_activity_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  status text not null check (status in ('available', 'break', 'pause', 'bathroom', 'training', 'feedback')),
  shift_started_at timestamptz not null,
  shift_ends_at timestamptz not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  check (shift_ends_at > shift_started_at),
  check (started_at >= shift_started_at and started_at < shift_ends_at),
  check (ended_at is null or (ended_at >= started_at and ended_at <= shift_ends_at))
);
create unique index if not exists agent_activity_one_open_idx
  on public.agent_activity_events(agent_id) where ended_at is null;
create index if not exists agent_activity_shift_idx
  on public.agent_activity_events(agent_id, shift_started_at, started_at);

create table if not exists public.agent_break_alerts (
  agent_id uuid not null references public.agents(id) on delete cascade,
  shift_started_at timestamptz not null,
  alerted_at timestamptz not null default now(),
  primary key (agent_id, shift_started_at)
);

create table if not exists public.agent_availability_alerts (
  agent_id uuid not null references public.agents(id) on delete cascade,
  activity_day_started_at timestamptz not null,
  alerted_at timestamptz not null default now(),
  primary key (agent_id, activity_day_started_at)
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  callback_id uuid references public.callbacks(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null default auth.uid(),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_callback_created_idx on public.activity_logs(callback_id, created_at desc);

create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.list_case_supervisors()
returns table(id uuid, full_name text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.current_user_role() is distinct from 'agent' then
    raise exception 'Solo un agente autenticado puede consultar la lista de supervisores.';
  end if;
  return query
    select p.id, p.full_name
    from public.profiles p
    join public.supervisors s on s.id = p.id
    where p.role = 'supervisor'
    order by p.full_name;
end;
$$;

create or replace function public.agent_shift_window(p_agent_id uuid, p_at timestamptz default now())
returns table(shift_started_at timestamptz, shift_ends_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select (((p_at at time zone 'America/Lima')::date::timestamp) at time zone 'America/Lima'),
         ((((p_at at time zone 'America/Lima')::date + 1)::timestamp) at time zone 'America/Lima')
  from public.agents a
  where a.id = p_agent_id;
$$;

create or replace function public.notify_agent_break_limit(
  p_agent_id uuid,
  p_shift_started_at timestamptz,
  p_break_seconds bigint
)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_agent_name text;
begin
  if p_break_seconds <= 3600 then return false; end if;
  insert into public.agent_break_alerts(agent_id, shift_started_at)
  values (p_agent_id, p_shift_started_at)
  on conflict do nothing;
  if not found then return false; end if;

  select full_name into v_agent_name from public.profiles where id = p_agent_id;
  insert into public.notifications(user_id, notification_type, title, message, scheduled_at)
  select p.id, 'agent_break_over_limit', 'Break excedido',
    coalesce(v_agent_name, 'Un agente') || ' superó 60 minutos de Break hoy. Total: '
      || ceil(p_break_seconds / 60.0)::text || ' min.',
    p_shift_started_at
  from public.profiles p where p.role in ('admin', 'supervisor');
  return true;
end;
$$;

create or replace function public.notify_agent_availability_limit(
  p_agent_id uuid,
  p_activity_day_started_at timestamptz,
  p_available_seconds bigint
)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_agent_name text;
begin
  if p_available_seconds < 28800 then return false; end if;
  insert into public.agent_availability_alerts(agent_id, activity_day_started_at)
  values (p_agent_id, p_activity_day_started_at)
  on conflict do nothing;
  if not found then return false; end if;

  select full_name into v_agent_name from public.profiles where id = p_agent_id;
  insert into public.notifications(user_id, notification_type, title, message, scheduled_at)
  select p.id, 'agent_availability_limit', 'Límite de disponibilidad alcanzado',
    coalesce(v_agent_name, 'Un agente') || ' completó 8 horas en Disponible hoy. Cambió a Pausa y ya no recibirá asignaciones por hoy.',
    p_activity_day_started_at
  from public.profiles p where p.role in ('admin', 'supervisor');
  return true;
end;
$$;

create or replace function public.get_agent_activity_status()
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_agent_id uuid := auth.uid();
  v_shift record;
  v_status text;
  v_status_since timestamptz;
  v_break_seconds bigint := 0;
  v_available_seconds bigint := 0;
  v_pause_seconds bigint := 0;
  v_bathroom_seconds bigint := 0;
  v_training_seconds bigint := 0;
  v_feedback_seconds bigint := 0;
  v_weekday smallint;
  v_activity_date date := (now() at time zone 'America/Lima')::date;
  v_schedule_working boolean;
  v_schedule_configured boolean := false;
  v_rest_day boolean := true;
begin
  if v_agent_id is null or public.current_user_role() is distinct from 'agent' then
    raise exception 'Solo un agente autenticado puede consultar su estado.';
  end if;

  update public.agent_activity_events
  set ended_at = greatest(started_at, least(now(), shift_ends_at))
  where agent_id = v_agent_id and ended_at is null
    and (shift_ends_at <= now()
      or shift_started_at <> (((now() at time zone 'America/Lima')::date::timestamp) at time zone 'America/Lima'));

  select * into v_shift from public.agent_shift_window(v_agent_id, now());
  if not found then raise exception 'No se encontró el perfil de agente para registrar su estado.'; end if;

  v_weekday := extract(dow from (now() at time zone 'America/Lima'))::smallint;
  select count(*) = 7 and count(*) filter (where not is_working) = 1
      and count(distinct start_time) filter (where is_working) = 1
      and count(distinct end_time) filter (where is_working) = 1,
    bool_or(weekday = v_weekday and is_working)
  into v_schedule_configured, v_schedule_working
  from public.agent_schedules where agent_id = v_agent_id;
  v_rest_day := not (v_schedule_configured and coalesce(v_schedule_working, false));

  insert into public.agent_activity_events(
    agent_id, status, shift_started_at, shift_ends_at, started_at
  ) values (v_agent_id, 'pause', v_shift.shift_started_at, v_shift.shift_ends_at, now())
  on conflict (agent_id) where ended_at is null do nothing;

  select status, started_at into v_status, v_status_since
  from public.agent_activity_events
  where agent_id = v_agent_id and shift_started_at = v_shift.shift_started_at and ended_at is null
  for update;

  select
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'available'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'break'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'pause'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'bathroom'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'training'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), shift_ends_at) - started_at)))
      filter (where status = 'feedback'), 0))::bigint
  into v_available_seconds, v_break_seconds, v_pause_seconds, v_bathroom_seconds, v_training_seconds, v_feedback_seconds
  from public.agent_activity_events
  where agent_id = v_agent_id
    and (shift_started_at at time zone 'America/Lima')::date = v_activity_date;

  if v_status = 'available' and (v_rest_day or v_available_seconds >= 28800) then
    update public.agent_activity_events
    set ended_at = now()
    where agent_id = v_agent_id and shift_started_at = v_shift.shift_started_at and ended_at is null;
    insert into public.agent_activity_events(
      agent_id, status, shift_started_at, shift_ends_at, started_at
    ) values (v_agent_id, 'pause', v_shift.shift_started_at, v_shift.shift_ends_at, now());
    v_status := 'pause';
    v_status_since := now();
    if v_available_seconds >= 28800 then
      perform public.notify_agent_availability_limit(v_agent_id, v_shift.shift_started_at, v_available_seconds);
    end if;
  end if;

  perform public.notify_agent_break_limit(v_agent_id, v_shift.shift_started_at, v_break_seconds);
  return jsonb_build_object(
    'on_shift', true,
    'schedule_configured', v_schedule_configured,
    'rest_day', v_rest_day,
    'status', v_status,
    'status_since', v_status_since,
    'shift_started_at', v_shift.shift_started_at,
    'shift_ends_at', v_shift.shift_ends_at,
    'break_seconds', v_break_seconds,
    'available_seconds', v_available_seconds,
    'pause_seconds', v_pause_seconds,
    'bathroom_seconds', v_bathroom_seconds,
    'training_seconds', v_training_seconds,
    'feedback_seconds', v_feedback_seconds,
    'break_over_limit', v_break_seconds > 3600,
    'availability_limit_reached', v_available_seconds >= 28800,
    'over_limit', v_break_seconds > 3600 or v_available_seconds >= 28800
  );
end;
$$;

create or replace function public.set_agent_activity_status(p_status text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_agent_id uuid := auth.uid();
  v_current jsonb;
  v_shift_started_at timestamptz;
begin
  if p_status is null or p_status not in ('available', 'break', 'pause', 'bathroom', 'training', 'feedback') then
    raise exception 'El estado seleccionado no es válido.';
  end if;
  if v_agent_id is null or public.current_user_role() is distinct from 'agent' then
    raise exception 'Solo un agente autenticado puede cambiar su estado.';
  end if;

  v_current := public.get_agent_activity_status();
  if p_status = 'available' then
    if not coalesce((v_current->>'schedule_configured')::boolean, false) then
      raise exception 'Administración debe configurar tu día de descanso antes de habilitar Disponible.';
    end if;
    if coalesce((v_current->>'rest_day')::boolean, true) then
      raise exception 'Hoy es tu día de descanso; no puedes marcarte Disponible.';
    end if;
    if coalesce((v_current->>'available_seconds')::bigint, 0) >= 28800 then
      raise exception 'Ya alcanzaste las 8 horas máximas en Disponible por hoy.';
    end if;
  end if;
  if v_current->>'status' = p_status then return v_current; end if;

  v_shift_started_at := (v_current->>'shift_started_at')::timestamptz;
  update public.agent_activity_events
  set ended_at = now()
  where agent_id = v_agent_id and shift_started_at = v_shift_started_at and ended_at is null;

  insert into public.agent_activity_events(
    agent_id, status, shift_started_at, shift_ends_at, started_at
  ) values (
    v_agent_id, p_status, v_shift_started_at,
    (v_current->>'shift_ends_at')::timestamptz, now()
  );
  return public.get_agent_activity_status();
end;
$$;

create or replace function public.process_agent_break_alerts()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_break record;
  v_available record;
  v_weekday smallint := extract(dow from (now() at time zone 'America/Lima'))::smallint;
  v_activity_date date := (now() at time zone 'America/Lima')::date;
  v_day_started_at timestamptz := (((now() at time zone 'America/Lima')::date::timestamp) at time zone 'America/Lima');
  v_schedule_configured boolean;
  v_is_working boolean;
  v_count integer := 0;
begin
  update public.agent_activity_events
  set ended_at = greatest(started_at, least(now(), shift_ends_at))
  where ended_at is null
    and (shift_ends_at <= now() or shift_started_at <> v_day_started_at);

  for v_break in
    select agent_id,
      (((shift_started_at at time zone 'America/Lima')::date::timestamp) at time zone 'America/Lima') as shift_started_at,
      floor(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))))::bigint as break_seconds
    from public.agent_activity_events
    where status = 'break'
      and (shift_started_at at time zone 'America/Lima')::date = v_activity_date
    group by agent_id, (shift_started_at at time zone 'America/Lima')::date
    having sum(extract(epoch from (coalesce(ended_at, now()) - started_at))) > 3600
  loop
    if public.notify_agent_break_limit(v_break.agent_id, v_break.shift_started_at, v_break.break_seconds) then
      v_count := v_count + 1;
    end if;
  end loop;

  for v_available in
    select e.agent_id, v_day_started_at as shift_started_at,
      (((v_activity_date + 1)::timestamp) at time zone 'America/Lima') as shift_ends_at,
      floor(coalesce(sum(extract(epoch from (
        least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at
      ))) filter (where e.status = 'available'), 0))::bigint as available_seconds
    from public.agent_activity_events e
    where (e.shift_started_at at time zone 'America/Lima')::date = v_activity_date
    group by e.agent_id
    having bool_or(e.status = 'available' and e.ended_at is null)
  loop
    select count(*) = 7 and count(*) filter (where not is_working) = 1
        and count(distinct start_time) filter (where is_working) = 1
        and count(distinct end_time) filter (where is_working) = 1,
      bool_or(weekday = v_weekday and is_working)
    into v_schedule_configured, v_is_working
    from public.agent_schedules where agent_id = v_available.agent_id;
    if not (v_schedule_configured and coalesce(v_is_working, false))
      or v_available.available_seconds >= 28800 then
      update public.agent_activity_events
      set ended_at = now()
      where agent_id = v_available.agent_id and ended_at is null and status = 'available';
      if found then
        insert into public.agent_activity_events(
          agent_id, status, shift_started_at, shift_ends_at, started_at
        ) values (
          v_available.agent_id, 'pause', v_available.shift_started_at, v_available.shift_ends_at, now()
        );
        if v_available.available_seconds >= 28800
          and public.notify_agent_availability_limit(
            v_available.agent_id, v_available.shift_started_at, v_available.available_seconds
          ) then
          v_count := v_count + 1;
        end if;
      end if;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.agent_activity_report(
  p_from date default null,
  p_to date default null,
  p_agent_id uuid default null
)
returns table(
  agent_id uuid,
  full_name text,
  shift_started_at timestamptz,
  shift_ends_at timestamptz,
  available_seconds bigint,
  break_seconds bigint,
  pause_seconds bigint,
  bathroom_seconds bigint,
  training_seconds bigint,
  feedback_seconds bigint,
  current_status text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role text := public.current_user_role();
  v_from date;
  v_to date;
begin
  if v_role is null or v_role not in ('admin', 'supervisor', 'quality') then
    raise exception 'Solo administración, supervisión y Calidad pueden consultar el reporte de actividad.';
  end if;
  v_from := coalesce(p_from, p_to, (now() at time zone 'America/Lima')::date);
  v_to := coalesce(p_to, p_from, v_from);
  if v_to < v_from then raise exception 'El rango de fechas no es válido.'; end if;

  return query
  with activity_days as (
    select e.*, (e.shift_started_at at time zone 'America/Lima')::date as activity_date
    from public.agent_activity_events e
    where (e.shift_started_at at time zone 'America/Lima')::date between v_from and v_to
      and (p_agent_id is null or e.agent_id = p_agent_id)
  )
  select e.agent_id, p.full_name,
    ((e.activity_date::timestamp) at time zone 'America/Lima'),
    (((e.activity_date + 1)::timestamp) at time zone 'America/Lima'),
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'available'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'break'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'pause'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'bathroom'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'training'), 0))::bigint,
    floor(coalesce(sum(extract(epoch from (least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at)))
      filter (where e.status = 'feedback'), 0))::bigint,
    coalesce(max(e.status) filter (where e.ended_at is null), 'off_shift')
  from activity_days e
  join public.agents a on a.id = e.agent_id
  join public.profiles p on p.id = e.agent_id
  group by e.agent_id, p.full_name, e.activity_date
  order by e.activity_date desc, p.full_name;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, username, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    left(coalesce(nullif(regexp_replace(split_part(lower(new.email), '@', 1), '[^a-z0-9._-]', '', 'g'), ''), 'user'), 24)
      || '_' || substr(replace(new.id::text, '-', ''), 1, 7),
    coalesce(new.email, ''),
    'agent'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_callback_manager on auth.users;
create trigger on_auth_user_created_callback_manager
  after insert on auth.users for each row execute procedure public.handle_new_auth_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute procedure public.touch_updated_at();
drop trigger if exists callbacks_touch_updated_at on public.callbacks;
create trigger callbacks_touch_updated_at before update on public.callbacks
  for each row execute procedure public.touch_updated_at();
drop trigger if exists schedules_touch_updated_at on public.agent_schedules;
create trigger schedules_touch_updated_at before update on public.agent_schedules
  for each row execute procedure public.touch_updated_at();

create or replace function public.log_callback_changes()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_logs(callback_id, actor_id, action, details)
    values (new.id, auth.uid(), 'callback_created', jsonb_build_object('status', new.status));
  elsif new.status is distinct from old.status then
    insert into public.activity_logs(callback_id, actor_id, action, details)
    values (new.id, auth.uid(), 'status_changed',
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;
drop trigger if exists callbacks_activity_log on public.callbacks;
create trigger callbacks_activity_log after insert or update of status on public.callbacks
  for each row execute procedure public.log_callback_changes();

create or replace function public.assign_callback(p_callback_id uuid, p_agent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_callback public.callbacks%rowtype;
  v_agent_id uuid;
  v_weekday smallint := extract(dow from (now() at time zone 'America/Lima'))::smallint;
  v_activity_date date := (now() at time zone 'America/Lima')::date;
  v_day_started_at timestamptz := (((now() at time zone 'America/Lima')::date::timestamp) at time zone 'America/Lima');
begin
  if coalesce(public.current_user_role(), '') not in ('admin', 'supervisor') then
    raise exception 'No tienes permisos para asignar casos.';
  end if;
  select * into v_callback from public.callbacks where id = p_callback_id for update;
  if not found then raise exception 'El caso no existe.'; end if;
  if v_callback.status in ('completed', 'cancelled', 'unfulfilled') then
    raise exception 'No se puede asignar un caso cerrado.';
  end if;

  if p_agent_id is not null then
    select p_agent_id into v_agent_id
    from public.agents a
    where a.id = p_agent_id and a.is_available
      and exists (
        select 1 from public.agent_schedules s where s.agent_id = a.id
        group by s.agent_id
        having count(*) = 7 and count(*) filter (where not s.is_working) = 1
          and count(distinct s.start_time) filter (where s.is_working) = 1
          and count(distinct s.end_time) filter (where s.is_working) = 1
          and bool_or(s.weekday = v_weekday and s.is_working)
      )
      and exists (
        select 1 from public.agent_activity_events e
        where e.agent_id = a.id and e.ended_at is null and e.status = 'available'
          and e.shift_started_at = v_day_started_at
          and e.shift_ends_at > now()
      )
      and (
        select coalesce(sum(extract(epoch from (
          least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at
        ))) filter (where e.status = 'available'), 0)
        from public.agent_activity_events e
        where e.agent_id = a.id
          and (e.shift_started_at at time zone 'America/Lima')::date = v_activity_date
      ) < 28800;
    if v_agent_id is null then
      raise exception 'El agente no está disponible hoy. Revisa su día de descanso, su estado y el límite de 8 horas.';
    end if;
  else
    select a.id into v_agent_id
    from public.agents a
    where a.is_available
      and exists (
        select 1 from public.agent_schedules s where s.agent_id = a.id
        group by s.agent_id
        having count(*) = 7 and count(*) filter (where not s.is_working) = 1
          and count(distinct s.start_time) filter (where s.is_working) = 1
          and count(distinct s.end_time) filter (where s.is_working) = 1
          and bool_or(s.weekday = v_weekday and s.is_working)
      )
      and exists (
        select 1 from public.agent_activity_events e
        where e.agent_id = a.id and e.ended_at is null and e.status = 'available'
          and e.shift_started_at = v_day_started_at
          and e.shift_ends_at > now()
      )
      and (
        select coalesce(sum(extract(epoch from (
          least(coalesce(e.ended_at, now()), e.shift_ends_at) - e.started_at
        ))) filter (where e.status = 'available'), 0)
        from public.agent_activity_events e
        where e.agent_id = a.id
          and (e.shift_started_at at time zone 'America/Lima')::date = v_activity_date
      ) < 28800
    order by (
      select count(*) from public.callback_assignments ca
      join public.callbacks c on c.id = ca.callback_id
      where ca.agent_id = a.id and ca.active and c.status in ('assigned', 'due_soon', 'overdue', 'in_call', 'rescheduled')
    ), a.id
    limit 1;
  end if;

  update public.callback_assignments set active = false
    where callback_id = p_callback_id and active;
  if v_agent_id is null then
    update public.callbacks set status = 'queued' where id = p_callback_id;
    insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
    select p.id, p_callback_id, 'assignment_queue', 'Caso en cola',
      'No hay agentes disponibles para el caso ' || v_callback.case_number || '.', v_callback.scheduled_at
    from public.profiles p where p.role = 'supervisor'
    on conflict do nothing;
    return jsonb_build_object('status', 'queued', 'agent_id', null);
  end if;

  insert into public.callback_assignments(callback_id, agent_id, assigned_by)
  values (p_callback_id, v_agent_id, auth.uid());
  update public.callbacks set status = 'assigned' where id = p_callback_id;
  insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
  values (v_agent_id, p_callback_id, 'callback_assigned', 'Nuevo caso asignado',
    'Caso ' || v_callback.case_number || ' programado para ' || to_char(v_callback.scheduled_at at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI') || '.',
    v_callback.scheduled_at)
  on conflict do nothing;
  return jsonb_build_object('status', 'assigned', 'agent_id', v_agent_id);
end;
$$;

create or replace function public.start_callback(p_callback_id uuid)
returns public.callbacks language plpgsql security definer set search_path = public
as $$
declare v_callback public.callbacks%rowtype;
begin
  if public.current_user_role() <> 'agent' or not exists (
    select 1 from public.callback_assignments
    where callback_id = p_callback_id and agent_id = auth.uid() and active
  ) then raise exception 'No tienes este caso asignado.'; end if;
  update public.callbacks set status = 'in_call', call_started_at = now()
  where id = p_callback_id and status in ('assigned', 'pending', 'due_soon', 'overdue', 'rescheduled')
  returning * into v_callback;
  if not found then raise exception 'El caso ya no puede iniciarse.'; end if;
  return v_callback;
end;
$$;

create or replace function public.finish_callback(
  p_callback_id uuid, p_outcome text, p_notes text default '', p_reschedule_at timestamptz default null
)
returns public.callbacks language plpgsql security definer set search_path = public
as $$
declare v_callback public.callbacks%rowtype;
begin
  if public.current_user_role() <> 'agent' or not exists (
    select 1 from public.callback_assignments
    where callback_id = p_callback_id and agent_id = auth.uid() and active
  ) then raise exception 'No tienes este caso asignado.'; end if;
  if p_outcome not in ('contacted', 'no_answer', 'wrong_number', 'callback_requested', 'declined', 'other') then
    raise exception 'El resultado indicado no es válido.';
  end if;
  insert into public.callback_attempts(callback_id, agent_id, outcome, notes)
  values (p_callback_id, auth.uid(), p_outcome, coalesce(p_notes, ''));
  update public.callbacks
  set status = 'completed',
      call_finished_at = now(), call_started_at = null
  where id = p_callback_id and status = 'in_call'
  returning * into v_callback;
  if not found then raise exception 'La llamada no está activa.'; end if;
  return v_callback;
end;
$$;

create or replace function public.close_callback(p_callback_id uuid, p_status text)
returns public.callbacks language plpgsql security definer set search_path = public
as $$
declare v_callback public.callbacks%rowtype;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'No tienes permisos para cerrar casos.';
  end if;
  if p_status not in ('unfulfilled', 'cancelled') then
    raise exception 'El estado de cierre no es válido.';
  end if;
  update public.callbacks set status = p_status
  where id = p_callback_id and status not in ('completed', 'cancelled', 'unfulfilled')
  returning * into v_callback;
  if not found then raise exception 'El caso ya está cerrado o no existe.'; end if;
  update public.callback_assignments set active = false where callback_id = p_callback_id and active;
  return v_callback;
end;
$$;

create or replace function public.process_callback_alerts()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_callback record;
  v_count integer := 0;
  v_agent_id uuid;
  v_first_minutes integer := 10;
  v_second_minutes integer := 5;
  v_overdue_minutes integer := 10;
begin
  v_count := public.process_agent_break_alerts();
  select coalesce((value->>'first_minutes')::integer, 10),
         coalesce((value->>'second_minutes')::integer, 5),
         coalesce((value->>'overdue_minutes')::integer, 10)
  into v_first_minutes, v_second_minutes, v_overdue_minutes
  from public.system_settings where key = 'callback_alerts';
  v_first_minutes := coalesce(v_first_minutes, 10);
  v_second_minutes := coalesce(v_second_minutes, 5);
  v_overdue_minutes := coalesce(v_overdue_minutes, 10);
  if v_first_minutes < 2 or v_first_minutes > 120 or v_second_minutes < 1
    or v_second_minutes >= v_first_minutes or v_overdue_minutes < 1 or v_overdue_minutes > 120 then
    raise exception 'La configuración de alertas no es válida.';
  end if;

  for v_callback in
    select c.*, ca.agent_id
    from public.callbacks c
    join public.callback_assignments ca on ca.callback_id = c.id and ca.active
    where c.status in ('assigned', 'due_soon', 'overdue', 'rescheduled')
  loop
    v_agent_id := v_callback.agent_id;
    if v_callback.scheduled_at > now()
      and v_callback.scheduled_at <= now() + make_interval(mins => v_first_minutes)
      and v_callback.scheduled_at > now() + make_interval(mins => v_second_minutes) then
      insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
      values (v_agent_id, v_callback.id, 'reminder_10m', 'Llamada próxima',
        'El caso ' || v_callback.case_number || ' vence en aproximadamente 10 minutos.', v_callback.scheduled_at)
      on conflict do nothing;
      update public.callbacks set status = 'due_soon' where id = v_callback.id and status = 'assigned';
      v_count := v_count + 1;
    elsif v_callback.scheduled_at > now()
      and v_callback.scheduled_at <= now() + make_interval(mins => v_second_minutes) then
      insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
      values (v_agent_id, v_callback.id, 'reminder_5m', 'Recordatorio de llamada',
        'El caso ' || v_callback.case_number || ' vence en 5 minutos o menos.', v_callback.scheduled_at)
      on conflict do nothing;
      update public.callbacks set status = 'due_soon' where id = v_callback.id and status = 'assigned';
      v_count := v_count + 1;
    elsif v_callback.scheduled_at + make_interval(mins => v_overdue_minutes) <= now() then
      update public.callbacks set status = 'overdue'
      where id = v_callback.id and status in ('assigned', 'due_soon', 'rescheduled');
      insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
      values (v_agent_id, v_callback.id, 'callback_overdue_agent', 'Llamada retrasada',
        'El caso ' || v_callback.case_number || ' lleva más de 10 minutos de retraso.', v_callback.scheduled_at)
      on conflict do nothing;
      insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
      select p.id, v_callback.id, 'callback_overdue_supervisor', 'Caso retrasado',
        'El caso ' || v_callback.case_number || ' no se ha iniciado dentro del plazo.', v_callback.scheduled_at
      from public.profiles p where p.role in ('admin', 'supervisor')
      on conflict do nothing;
      v_count := v_count + 1;
    end if;
  end loop;
  for v_callback in
    select c.*, ca.agent_id, s.end_time
    from public.callbacks c
    join public.callback_assignments ca on ca.callback_id = c.id and ca.active
    join public.agent_schedules s on s.agent_id = ca.agent_id
      and s.weekday = extract(dow from now() at time zone 'America/Lima')::integer and s.is_working
    where c.status in ('assigned', 'due_soon', 'overdue', 'rescheduled')
      and (now() at time zone 'America/Lima')::time >= s.end_time
      and (now() at time zone 'America/Lima')::time < s.end_time + interval '1 minute'
  loop
    insert into public.notifications(user_id, callback_id, notification_type, title, message, scheduled_at)
    select p.id, v_callback.id, 'shift_end_pending', 'Casos pendientes al cierre de turno',
      'El agente tiene pendiente el caso ' || v_callback.case_number || ' al terminar su turno.',
      v_callback.scheduled_at
    from public.profiles p where p.role in ('admin', 'supervisor')
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_session_id uuid not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text not null default '' check (end_reason in ('', 'logout', 'pagehide', 'inactive')),
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists user_sessions_one_open_per_client_idx
  on public.user_sessions(user_id, client_session_id) where ended_at is null;
create index if not exists user_sessions_user_started_idx
  on public.user_sessions(user_id, started_at desc);

create or replace function public.start_user_session(p_client_session_id uuid)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_user_id is null or p_client_session_id is null then
    raise exception 'Se requiere una sesión autenticada.';
  end if;
  update public.user_sessions
  set ended_at = last_seen_at, end_reason = 'inactive'
  where user_id = v_user_id and client_session_id = p_client_session_id
    and ended_at is null and last_seen_at < now() - interval '3 minutes';
  insert into public.user_sessions(user_id, client_session_id)
  values (v_user_id, p_client_session_id)
  on conflict (user_id, client_session_id) where ended_at is null
  do update set last_seen_at = now()
  returning id into v_session_id;
  return v_session_id;
end;
$$;

create or replace function public.heartbeat_user_session(p_client_session_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_client_session_id is null then
    raise exception 'Se requiere una sesión autenticada.';
  end if;
  update public.user_sessions set last_seen_at = now()
  where user_id = auth.uid() and client_session_id = p_client_session_id and ended_at is null;
  if not found then raise exception 'La sesión registrada ya no está activa.'; end if;
end;
$$;

create or replace function public.end_user_session(p_client_session_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_client_session_id is null then
    raise exception 'Se requiere una sesión autenticada.';
  end if;
  if p_reason not in ('logout', 'pagehide') then
    raise exception 'El motivo de cierre no es válido.';
  end if;
  update public.user_sessions
  set ended_at = greatest(now(), started_at), last_seen_at = greatest(now(), started_at), end_reason = p_reason
  where user_id = auth.uid() and client_session_id = p_client_session_id and ended_at is null;
end;
$$;

alter table public.profiles enable row level security;
alter table public.agents enable row level security;
alter table public.supervisors enable row level security;
alter table public.callbacks enable row level security;
alter table public.callback_assignments enable row level security;
alter table public.callback_attempts enable row level security;
alter table public.agent_schedules enable row level security;
alter table public.agent_breaks enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_logs enable row level security;
alter table public.system_settings enable row level security;
alter table public.user_sessions enable row level security;
alter table public.agent_activity_events enable row level security;
alter table public.agent_break_alerts enable row level security;
alter table public.agent_availability_alerts enable row level security;

