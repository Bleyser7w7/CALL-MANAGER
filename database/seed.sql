insert into public.system_settings(key, value)
values
  ('timezone', '"America/Lima"'::jsonb),
  ('callback_alerts', '{"first_minutes":10,"second_minutes":5,"overdue_minutes":10}'::jsonb)
on conflict (key) do nothing;
