-- Server-authoritative clocking shared by portal and future mobile RPC adoption.
alter table public.attendance_records add column if not exists clock_in_channel text;
alter table public.attendance_records add column if not exists clock_out_channel text;
alter table public.attendance_records add column if not exists clock_in_selected_office_location_id uuid references public.office_locations(id);
alter table public.attendance_records add column if not exists clock_out_selected_office_location_id uuid references public.office_locations(id);
alter table public.attendance_records add column if not exists clock_in_fallback_reason text;
alter table public.attendance_records add column if not exists clock_out_fallback_reason text;
alter table public.attendance_records add column if not exists clock_in_user_agent text;
alter table public.attendance_records add column if not exists clock_out_user_agent text;

alter table public.attendance_records drop constraint if exists attendance_clock_in_location_status_check;
alter table public.attendance_records add constraint attendance_clock_in_location_status_check check (
  clock_in_location_status is null or clock_in_location_status in (
    'inside_office', 'outside_all_offices', 'location_unavailable', 'low_accuracy',
    'no_offices_configured', 'web_verified', 'web_outside_selected_office', 'web_unverified'
  )
);
alter table public.attendance_records drop constraint if exists attendance_clock_out_location_status_check;
alter table public.attendance_records add constraint attendance_clock_out_location_status_check check (
  clock_out_location_status is null or clock_out_location_status in (
    'inside_office', 'outside_all_offices', 'location_unavailable', 'low_accuracy',
    'no_offices_configured', 'web_verified', 'web_outside_selected_office', 'web_unverified'
  )
);

do $$
begin
  if exists (
    select 1 from public.attendance_records
    group by user_id, work_date having count(*) > 1
  ) then
    raise exception 'Duplicate attendance rows exist for a user/work date. Resolve them before applying web clocking.';
  end if;
end $$;

create unique index if not exists attendance_records_user_work_date_unique
  on public.attendance_records(user_id, work_date);

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  attendance_record_id uuid references public.attendance_records(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('clock_in', 'clock_out', 'rejected')),
  channel text not null check (channel in ('web', 'mobile', 'correction')),
  office_location_id uuid references public.office_locations(id),
  location_status text,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  fallback_reason text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists attendance_events_user_created_idx
  on public.attendance_events(user_id, created_at desc);

alter table public.attendance_events enable row level security;
drop policy if exists "users read own attendance events" on public.attendance_events;
create policy "users read own attendance events" on public.attendance_events
for select to authenticated using (user_id = auth.uid());
grant select on public.attendance_events to authenticated;

create or replace function public.web_clock_attendance(
  p_action text,
  p_selected_office_id uuid,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy_m double precision default null,
  p_fallback_reason text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := now();
  v_work_date date := (now() at time zone 'Africa/Lusaka')::date;
  v_profile public.profiles%rowtype;
  v_record public.attendance_records%rowtype;
  v_record_exists boolean := false;
  v_office public.office_locations%rowtype;
  v_distance double precision;
  v_location_status text;
  v_verified_office uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_action not in ('clock_in','clock_out') then raise exception 'Invalid clock action'; end if;
  if p_selected_office_id is null then raise exception 'Select an office'; end if;
  select * into v_profile from public.profiles where id=v_user and is_active;
  if not found then raise exception 'Your WorkPulse profile is inactive or unavailable'; end if;
  select * into v_office from public.office_locations where id=p_selected_office_id and is_active;
  if not found then raise exception 'The selected office is unavailable'; end if;
  if (p_latitude is null) <> (p_longitude is null) then raise exception 'Both latitude and longitude are required'; end if;
  if p_latitude is null and nullif(btrim(p_fallback_reason),'') is null then raise exception 'Explain why location could not be verified'; end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text || ':' || v_work_date::text));
  select * into v_record from public.attendance_records where user_id=v_user and work_date=v_work_date for update;
  v_record_exists := found;

  if p_latitude is not null then
    v_distance := 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_latitude-v_office.latitude)/2),2) +
      cos(radians(v_office.latitude))*cos(radians(p_latitude))*power(sin(radians(p_longitude-v_office.longitude)/2),2)
    ));
    if v_distance <= v_office.radius_m then v_location_status := 'web_verified'; v_verified_office := v_office.id;
    else v_location_status := 'web_outside_selected_office'; end if;
  else
    v_location_status := 'web_unverified';
  end if;

  if p_action='clock_in' then
    if exists(select 1 from public.leave_requests where user_id=v_user and start_date<=v_work_date and end_date>=v_work_date and (workflow_stage in ('supervisor_pending','hr_pending','approved') or status in ('pending','approved'))) then
      raise exception 'You cannot clock in while leave is pending or approved for today';
    end if;
    if v_record_exists and v_record.clock_in is not null then raise exception 'You are already clocked in for today'; end if;
    if v_record_exists then raise exception 'An attendance record already exists for today and cannot be clocked in'; end if;
    insert into public.attendance_records(user_id,employee_id,work_date,clock_in,status,clock_in_lat,clock_in_lng,clock_in_accuracy_m,clock_in_inside_geofence,clock_in_verified_office_location_id,clock_in_nearest_office_location_id,clock_in_distance_m,clock_in_geofence_radius_m,clock_in_location_status,clock_in_channel,clock_in_selected_office_location_id,clock_in_fallback_reason,clock_in_user_agent)
    values(v_user,v_profile.employee_id,v_work_date,v_now,'on_duty',p_latitude,p_longitude,p_accuracy_m,v_verified_office is not null,v_verified_office,v_office.id,v_distance,v_office.radius_m,v_location_status,'web',v_office.id,nullif(btrim(p_fallback_reason),''),left(p_user_agent,500)) returning * into v_record;
  else
    if not v_record_exists or v_record.clock_in is null then raise exception 'No open attendance record was found for today'; end if;
    if v_record.clock_out is not null then raise exception 'You are already clocked out for today'; end if;
    update public.attendance_records set clock_out=v_now,status='completed',clock_out_lat=p_latitude,clock_out_lng=p_longitude,clock_out_accuracy_m=p_accuracy_m,clock_out_inside_geofence=v_verified_office is not null,clock_out_verified_office_location_id=v_verified_office,clock_out_nearest_office_location_id=v_office.id,clock_out_distance_m=v_distance,clock_out_geofence_radius_m=v_office.radius_m,clock_out_location_status=v_location_status,clock_out_channel='web',clock_out_selected_office_location_id=v_office.id,clock_out_fallback_reason=nullif(btrim(p_fallback_reason),''),clock_out_user_agent=left(p_user_agent,500),updated_at=v_now where id=v_record.id returning * into v_record;
  end if;

  insert into public.attendance_events(attendance_record_id,user_id,event_type,channel,office_location_id,location_status,latitude,longitude,accuracy_m,fallback_reason,user_agent,metadata)
  values(v_record.id,v_user,p_action,'web',v_office.id,v_location_status,p_latitude,p_longitude,p_accuracy_m,nullif(btrim(p_fallback_reason),''),left(p_user_agent,500),jsonb_build_object('distance_m',v_distance,'office_radius_m',v_office.radius_m));
  return jsonb_build_object('ok',true,'record',to_jsonb(v_record));
exception when others then
  if v_user is not null then
    insert into public.attendance_events(user_id,event_type,channel,office_location_id,latitude,longitude,accuracy_m,fallback_reason,user_agent,metadata)
    values(v_user,'rejected','web',p_selected_office_id,p_latitude,p_longitude,p_accuracy_m,nullif(btrim(p_fallback_reason),''),left(p_user_agent,500),jsonb_build_object('action',p_action,'error',sqlerrm));
  end if;
  return jsonb_build_object('ok',false,'message',sqlerrm);
end; $$;

revoke execute on function public.web_clock_attendance(text,uuid,double precision,double precision,double precision,text,text) from public;
grant execute on function public.web_clock_attendance(text,uuid,double precision,double precision,double precision,text,text) to authenticated;
