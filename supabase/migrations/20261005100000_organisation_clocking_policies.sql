-- WorkPulse organisation foundation and tenant-level clocking policy.
-- This is additive: existing RTCZ users and attendance data remain valid.

create extension if not exists pgcrypto;

create table if not exists public.workpulse_organisations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'Africa/Lusaka',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workpulse_organisations_code_check check (code = lower(code) and code ~ '^[a-z0-9][a-z0-9_-]*$')
);

insert into public.workpulse_organisations (code, name, timezone)
values ('rtcz', 'Right to Care Zambia', 'Africa/Lusaka')
on conflict (code) do update
set name = excluded.name,
    timezone = excluded.timezone,
    updated_at = now();

alter table public.profiles
  add column if not exists organisation_id uuid references public.workpulse_organisations(id);

update public.profiles
set organisation_id = (select id from public.workpulse_organisations where code = 'rtcz')
where organisation_id is null;

create index if not exists profiles_organisation_id_idx
  on public.profiles (organisation_id);

create table if not exists public.organisation_clocking_methods (
  organisation_id uuid not null references public.workpulse_organisations(id) on delete cascade,
  method text not null,
  is_enabled boolean not null default false,
  requires_location boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organisation_id, method),
  constraint organisation_clocking_methods_method_check check (method in (
    'mobile_app',
    'personal_device_pwa',
    'web_portal',
    'kiosk_pin',
    'kiosk_qr',
    'kiosk_nfc',
    'field_team',
    'sms_ussd'
  ))
);

create table if not exists public.organisation_policy_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.workpulse_organisations(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  event_type text not null,
  subject text not null,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create index if not exists organisation_policy_events_org_created_idx
  on public.organisation_policy_events (organisation_id, created_at desc);

with rtcz as (
  select id from public.workpulse_organisations where code = 'rtcz'
), methods(method, is_enabled, requires_location) as (
  values
    ('mobile_app', true, true),
    ('personal_device_pwa', false, true),
    ('web_portal', true, false),
    ('kiosk_pin', false, false),
    ('kiosk_qr', false, false),
    ('kiosk_nfc', false, false),
    ('field_team', false, true),
    ('sms_ussd', false, false)
)
insert into public.organisation_clocking_methods (organisation_id, method, is_enabled, requires_location)
select rtcz.id, methods.method, methods.is_enabled, methods.requires_location
from rtcz cross join methods
on conflict (organisation_id, method) do nothing;

create or replace function public.current_workpulse_organisation_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.organisation_id
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active
  limit 1;
$$;

create or replace function public.current_organisation_clocking_policy()
returns table (
  organisation_id uuid,
  organisation_code text,
  organisation_name text,
  method text,
  is_enabled boolean,
  requires_location boolean,
  settings jsonb,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.code,
    o.name,
    m.method,
    m.is_enabled,
    m.requires_location,
    m.settings,
    m.updated_at
  from public.workpulse_organisations o
  join public.organisation_clocking_methods m on m.organisation_id = o.id
  where o.id = public.current_workpulse_organisation_id()
    and o.is_active
  order by m.method;
$$;

create or replace function public.set_organisation_clocking_method(
  p_method text,
  p_is_enabled boolean,
  p_requires_location boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_organisation uuid;
  v_role text;
  v_previous public.organisation_clocking_methods%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select p.organisation_id, p.role::text
  into v_organisation, v_role
  from public.profiles p
  where p.id = v_actor and p.is_active;

  if v_organisation is null then
    raise exception 'No active WorkPulse organisation is assigned';
  end if;

  if v_role not in ('admin', 'hr') then
    raise exception 'Only HR or administrators can manage clocking methods';
  end if;

  if p_method not in (
    'mobile_app', 'personal_device_pwa', 'web_portal', 'kiosk_pin',
    'kiosk_qr', 'kiosk_nfc', 'field_team', 'sms_ussd'
  ) then
    raise exception 'Unsupported clocking method';
  end if;

  select * into v_previous
  from public.organisation_clocking_methods
  where organisation_id = v_organisation and method = p_method
  for update;

  if p_is_enabled is false
    and coalesce(v_previous.is_enabled, false) is true
    and (select count(*) from public.organisation_clocking_methods where organisation_id = v_organisation and is_enabled) <= 1
  then
    raise exception 'At least one clocking method must remain enabled';
  end if;

  insert into public.organisation_clocking_methods (
    organisation_id, method, is_enabled, requires_location, updated_by, updated_at
  ) values (
    v_organisation, p_method, p_is_enabled, p_requires_location, v_actor, now()
  )
  on conflict (organisation_id, method) do update
  set is_enabled = excluded.is_enabled,
      requires_location = excluded.requires_location,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  insert into public.organisation_policy_events (
    organisation_id, actor_id, event_type, subject, previous_value, new_value
  ) values (
    v_organisation,
    v_actor,
    'clocking_method_updated',
    p_method,
    case when v_previous.organisation_id is null then null else jsonb_build_object(
      'is_enabled', v_previous.is_enabled,
      'requires_location', v_previous.requires_location
    ) end,
    jsonb_build_object(
      'is_enabled', p_is_enabled,
      'requires_location', p_requires_location
    )
  );
end;
$$;

create or replace function public.enforce_attendance_event_clocking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organisation uuid;
  v_method text;
  v_allowed boolean;
begin
  if new.channel = 'correction' then
    return new;
  end if;

  v_method := case new.channel
    when 'web' then 'web_portal'
    when 'mobile' then 'mobile_app'
    else null
  end;

  if v_method is null then
    return new;
  end if;

  select p.organisation_id into v_organisation
  from public.profiles p
  where p.id = new.user_id and p.is_active;

  -- Null is retained as a legacy-safe path while older accounts are migrated.
  if v_organisation is null then
    return new;
  end if;

  select m.is_enabled into v_allowed
  from public.organisation_clocking_methods m
  where m.organisation_id = v_organisation and m.method = v_method;

  if coalesce(v_allowed, false) is false then
    raise exception 'This clocking method is disabled for your organisation';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_attendance_record_clocking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organisation uuid;
  v_channel text;
  v_method text;
  v_allowed boolean;
begin
  -- Service operations and reviewer corrections are governed by their own
  -- authorization paths. This trigger controls employee self-service clocking.
  if auth.uid() is null or auth.uid() <> new.user_id then
    return new;
  end if;

  if tg_op = 'INSERT' and new.clock_in is not null then
    v_channel := coalesce(new.clock_in_channel, 'mobile');
  elsif tg_op = 'UPDATE' and new.clock_in is distinct from old.clock_in then
    v_channel := coalesce(new.clock_in_channel, 'mobile');
  elsif tg_op = 'UPDATE' and new.clock_out is distinct from old.clock_out then
    v_channel := coalesce(new.clock_out_channel, 'mobile');
  else
    return new;
  end if;

  v_method := case v_channel
    when 'web' then 'web_portal'
    when 'mobile' then 'mobile_app'
    else null
  end;

  if v_method is null then
    return new;
  end if;

  select p.organisation_id into v_organisation
  from public.profiles p
  where p.id = new.user_id and p.is_active;

  if v_organisation is null then
    return new;
  end if;

  select m.is_enabled into v_allowed
  from public.organisation_clocking_methods m
  where m.organisation_id = v_organisation and m.method = v_method;

  if coalesce(v_allowed, false) is false then
    raise exception 'This clocking method is disabled for your organisation';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_events_enforce_clocking_policy on public.attendance_events;
create trigger attendance_events_enforce_clocking_policy
before insert on public.attendance_events
for each row execute function public.enforce_attendance_event_clocking_policy();

drop trigger if exists attendance_records_enforce_clocking_policy_insert on public.attendance_records;
create trigger attendance_records_enforce_clocking_policy_insert
before insert on public.attendance_records
for each row execute function public.enforce_attendance_record_clocking_policy();

drop trigger if exists attendance_records_enforce_clocking_policy_update on public.attendance_records;
create trigger attendance_records_enforce_clocking_policy_update
before update of clock_in, clock_out on public.attendance_records
for each row execute function public.enforce_attendance_record_clocking_policy();

alter table public.workpulse_organisations enable row level security;
alter table public.organisation_clocking_methods enable row level security;
alter table public.organisation_policy_events enable row level security;

drop policy if exists workpulse_organisations_select_current on public.workpulse_organisations;
create policy workpulse_organisations_select_current
on public.workpulse_organisations for select to authenticated
using (id = public.current_workpulse_organisation_id());

drop policy if exists organisation_clocking_methods_select_current on public.organisation_clocking_methods;
create policy organisation_clocking_methods_select_current
on public.organisation_clocking_methods for select to authenticated
using (organisation_id = public.current_workpulse_organisation_id());

drop policy if exists organisation_policy_events_select_current on public.organisation_policy_events;
create policy organisation_policy_events_select_current
on public.organisation_policy_events for select to authenticated
using (organisation_id = public.current_workpulse_organisation_id());

revoke all on function public.set_organisation_clocking_method(text, boolean, boolean) from public;
grant execute on function public.current_workpulse_organisation_id() to authenticated;
grant execute on function public.current_organisation_clocking_policy() to authenticated;
grant execute on function public.set_organisation_clocking_method(text, boolean, boolean) to authenticated;
