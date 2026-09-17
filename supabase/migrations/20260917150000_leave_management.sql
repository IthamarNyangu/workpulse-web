-- WorkPulse leave management (additive; legacy leave columns remain supported).
create extension if not exists pgcrypto;

create table if not exists public.leave_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  legacy_value text not null default 'other',
  default_entitlement_days numeric(8,2) not null default 0 check (default_entitlement_days >= 0),
  requires_reason boolean not null default true,
  is_paid boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.leave_types (code, name, description, legacy_value, default_entitlement_days, requires_reason, sort_order)
values
  ('annual', 'Annual leave', 'Demonstration entitlement; confirm with HR before production use.', 'annual', 24, true, 10),
  ('sick', 'Sick leave', 'Demonstration entitlement; confirm with HR before production use.', 'sick', 10, true, 20),
  ('other', 'Other leave', 'Unpaid or special leave subject to approval.', 'other', 5, true, 90)
on conflict (code) do nothing;

create table if not exists public.leave_eligibility_rules (
  id uuid primary key default gen_random_uuid(),
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  role text,
  department text,
  minimum_service_days integer not null default 0 check (minimum_service_days >= 0),
  annual_entitlement_days numeric(8,2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (annual_entitlement_days is null or annual_entitlement_days >= 0)
);

create table if not exists public.leave_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id),
  leave_year integer not null,
  entitlement_days numeric(8,2) not null default 0 check (entitlement_days >= 0),
  carried_forward_days numeric(8,2) not null default 0 check (carried_forward_days >= 0),
  reserved_days numeric(8,2) not null default 0 check (reserved_days >= 0),
  consumed_days numeric(8,2) not null default 0 check (consumed_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, leave_type_id, leave_year)
);

create table if not exists public.leave_approvers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  approver_role text not null default 'hr_approver' check (approver_role = 'hr_approver'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, approver_role)
);

create table if not exists public.leave_holidays (
  holiday_date date primary key,
  name text not null,
  is_active boolean not null default true
);

alter table public.leave_requests add column if not exists leave_type_id uuid references public.leave_types(id);
alter table public.leave_requests add column if not exists workflow_stage text not null default 'supervisor_pending';
alter table public.leave_requests add column if not exists supervisor_id uuid references public.profiles(id);
alter table public.leave_requests add column if not exists supervisor_reviewed_at timestamptz;
alter table public.leave_requests add column if not exists supervisor_note text;
alter table public.leave_requests add column if not exists hr_approver_id uuid references public.profiles(id);
alter table public.leave_requests add column if not exists hr_reviewed_at timestamptz;
alter table public.leave_requests add column if not exists hr_note text;
alter table public.leave_requests add column if not exists cancelled_at timestamptz;
alter table public.leave_requests add column if not exists cancellation_reason text;
alter table public.leave_requests add column if not exists balance_year integer;
alter table public.leave_requests add column if not exists reserved_days numeric(8,2) not null default 0;

update public.leave_requests r
set leave_type_id = t.id
from public.leave_types t
where r.leave_type_id is null and t.code = r.leave_type;

update public.leave_requests
set workflow_stage = case status when 'approved' then 'approved' when 'rejected' then 'rejected' else 'supervisor_pending' end
where workflow_stage is null or workflow_stage = 'supervisor_pending';

create table if not exists public.leave_request_events (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references public.leave_requests(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  event_type text not null,
  from_stage text,
  to_stage text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  recipient_user_id uuid references public.profiles(id),
  recipient_email text,
  subject text not null,
  template_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed','disabled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists leave_requests_workflow_stage_idx on public.leave_requests(workflow_stage, created_at desc);
create index if not exists leave_request_events_request_idx on public.leave_request_events(leave_request_id, created_at);
create index if not exists notification_outbox_status_idx on public.notification_outbox(status, available_at);

create or replace function public.leave_working_days(p_start date, p_end date)
returns integer language sql stable set search_path = public as $$
  select case when p_end < p_start then 0 else count(*)::integer end
  from generate_series(p_start, p_end, interval '1 day') d
  where extract(isodow from d) < 6
    and not exists (select 1 from public.leave_holidays h where h.holiday_date = d::date and h.is_active);
$$;

create or replace function public.is_leave_hr_approver(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.leave_approvers a where a.user_id = p_user_id and a.approver_role = 'hr_approver' and a.is_active);
$$;

create or replace function public.submit_leave_request(p_leave_type_id uuid, p_start_date date, p_end_date date, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid(); v_type public.leave_types%rowtype; v_days integer; v_year integer;
  v_supervisor uuid; v_balance public.leave_balances%rowtype; v_request uuid; v_entitlement numeric(8,2);
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then raise exception 'Invalid leave date range'; end if;
  if extract(year from p_start_date) <> extract(year from p_end_date) then raise exception 'A request cannot span leave years'; end if;
  select * into v_type from public.leave_types where id = p_leave_type_id and is_active;
  if not found then raise exception 'Leave type is unavailable'; end if;
  if v_type.requires_reason and nullif(btrim(p_reason), '') is null then raise exception 'A reason is required'; end if;
  if exists(select 1 from public.leave_eligibility_rules e join public.profiles p on p.id=v_user join auth.users u on u.id=v_user where e.leave_type_id=v_type.id and e.is_active and (e.role is null or e.role=p.role) and (e.department is null or e.department=p.department) and (current_date-u.created_at::date) < e.minimum_service_days) then raise exception 'You are not eligible for this leave type'; end if;
  select employee_supervisor_assignments.supervisor_id into v_supervisor from public.employee_supervisor_assignments where employee_id=v_user and is_active and is_primary limit 1;
  if v_supervisor is null then raise exception 'No assigned supervisor is configured'; end if;
  if v_supervisor = v_user then raise exception 'Users cannot approve their own leave'; end if;
  v_days := public.leave_working_days(p_start_date,p_end_date); v_year := extract(year from p_start_date);
  if v_days <= 0 then raise exception 'The request contains no working days'; end if;
  select coalesce((select e.annual_entitlement_days from public.leave_eligibility_rules e join public.profiles p on p.id=v_user where e.leave_type_id=v_type.id and e.is_active and (e.role is null or e.role=p.role) and (e.department is null or e.department=p.department) order by (e.role is not null)::int+(e.department is not null)::int desc limit 1),v_type.default_entitlement_days) into v_entitlement;
  insert into public.leave_balances(user_id,leave_type_id,leave_year,entitlement_days) values(v_user,v_type.id,v_year,v_entitlement) on conflict(user_id,leave_type_id,leave_year) do nothing;
  select * into v_balance from public.leave_balances where user_id=v_user and leave_type_id=v_type.id and leave_year=v_year for update;
  if v_balance.entitlement_days+v_balance.carried_forward_days-v_balance.consumed_days-v_balance.reserved_days < v_days then raise exception 'Insufficient leave balance'; end if;
  if exists(select 1 from public.leave_requests where user_id=v_user and workflow_stage in ('supervisor_pending','hr_pending','approved') and daterange(start_date,end_date,'[]') && daterange(p_start_date,p_end_date,'[]')) then raise exception 'Leave dates overlap an active request'; end if;
  insert into public.leave_requests(user_id,leave_type,leave_type_id,start_date,end_date,duration_days,reason,status,workflow_stage,supervisor_id,balance_year,reserved_days)
  values(v_user,v_type.legacy_value,v_type.id,p_start_date,p_end_date,v_days,nullif(btrim(p_reason),''),'pending','supervisor_pending',v_supervisor,v_year,v_days) returning id into v_request;
  update public.leave_balances set reserved_days=reserved_days+v_days,updated_at=now() where id=v_balance.id;
  insert into public.leave_request_events(leave_request_id,actor_id,event_type,to_stage,metadata) values(v_request,v_user,'submitted','supervisor_pending',jsonb_build_object('working_days',v_days));
  insert into public.notification_outbox(event_key,recipient_user_id,subject,template_key,payload,status) values('leave.submitted',v_supervisor,'Leave request awaiting review','leave_supervisor_review',jsonb_build_object('leave_request_id',v_request),'disabled');
  return v_request;
end; $$;

create or replace function public.review_leave_request(p_request_id uuid, p_decision text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_actor uuid:=auth.uid(); v_request public.leave_requests%rowtype; v_next text; v_hr uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  if p_decision='rejected' and nullif(btrim(p_note),'') is null then raise exception 'A rejection reason is required'; end if;
  select * into v_request from public.leave_requests where id=p_request_id for update;
  if not found or v_request.workflow_stage not in ('supervisor_pending','hr_pending') then raise exception 'Request is not awaiting review'; end if;
  if v_request.user_id=v_actor then raise exception 'Users cannot approve their own leave'; end if;
  if v_request.workflow_stage='supervisor_pending' and v_request.supervisor_id<>v_actor then raise exception 'Only the assigned supervisor can review this request'; end if;
  if v_request.workflow_stage='hr_pending' and not public.is_leave_hr_approver(v_actor) then raise exception 'HR approver access required'; end if;
  if p_decision='rejected' then
    v_next:='rejected';
    update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),updated_at=now() where user_id=v_request.user_id and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
    update public.leave_requests set status='rejected',workflow_stage=v_next,reserved_days=0,reviewed_by=v_actor,reviewed_at=now(),reviewer_note=p_note,
      supervisor_reviewed_at=case when workflow_stage='supervisor_pending' then now() else supervisor_reviewed_at end, supervisor_note=case when workflow_stage='supervisor_pending' then p_note else supervisor_note end,
      hr_approver_id=case when workflow_stage='hr_pending' then v_actor else hr_approver_id end,hr_reviewed_at=case when workflow_stage='hr_pending' then now() else hr_reviewed_at end,hr_note=case when workflow_stage='hr_pending' then p_note else hr_note end,updated_at=now() where id=p_request_id;
  elsif v_request.workflow_stage='supervisor_pending' then
    select a.user_id into v_hr from public.leave_approvers a where a.is_active and a.user_id<>v_request.user_id order by a.created_at limit 1;
    if v_hr is null then raise exception 'No HR approver is configured'; end if;
    v_next:='hr_pending';
    update public.leave_requests set workflow_stage=v_next,supervisor_reviewed_at=now(),supervisor_note=nullif(btrim(p_note),''),updated_at=now() where id=p_request_id;
    insert into public.notification_outbox(event_key,recipient_user_id,subject,template_key,payload,status) values('leave.supervisor_approved',v_hr,'Leave request awaiting HR approval','leave_hr_review',jsonb_build_object('leave_request_id',p_request_id),'disabled');
  else
    v_next:='approved';
    update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),consumed_days=consumed_days+v_request.reserved_days,updated_at=now() where user_id=v_request.user_id and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
    update public.leave_requests set status='approved',workflow_stage=v_next,reserved_days=0,reviewed_by=v_actor,reviewed_at=now(),reviewer_note=nullif(btrim(p_note),''),hr_approver_id=v_actor,hr_reviewed_at=now(),hr_note=nullif(btrim(p_note),''),updated_at=now() where id=p_request_id;
  end if;
  insert into public.leave_request_events(leave_request_id,actor_id,event_type,from_stage,to_stage,note) values(p_request_id,v_actor,case when p_decision='rejected' then 'rejected' else 'approved' end,v_request.workflow_stage,v_next,nullif(btrim(p_note),''));
  insert into public.notification_outbox(event_key,recipient_user_id,subject,template_key,payload,status) values('leave.'||v_next,v_request.user_id,'Your leave request was updated','leave_request_update',jsonb_build_object('leave_request_id',p_request_id,'stage',v_next),'disabled');
  return v_next;
end; $$;

create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid:=auth.uid(); v_request public.leave_requests%rowtype;
begin
  select * into v_request from public.leave_requests where id=p_request_id and user_id=v_user for update;
  if not found or v_request.workflow_stage not in ('supervisor_pending','hr_pending') then raise exception 'Only pending requests can be cancelled'; end if;
  update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),updated_at=now() where user_id=v_user and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
  -- Keep legacy status compatible with installations whose check constraint only permits pending/approved/rejected.
  update public.leave_requests set status='rejected',workflow_stage='cancelled',reserved_days=0,cancelled_at=now(),cancellation_reason=nullif(btrim(p_reason),''),updated_at=now() where id=p_request_id;
  insert into public.leave_request_events(leave_request_id,actor_id,event_type,from_stage,to_stage,note) values(p_request_id,v_user,'cancelled',v_request.workflow_stage,'cancelled',nullif(btrim(p_reason),''));
end; $$;

alter table public.leave_types enable row level security;
alter table public.leave_eligibility_rules enable row level security;
alter table public.leave_balances enable row level security;
alter table public.leave_approvers enable row level security;
alter table public.leave_holidays enable row level security;
alter table public.leave_request_events enable row level security;
alter table public.notification_outbox enable row level security;

drop policy if exists "authenticated read leave types" on public.leave_types;
create policy "authenticated read leave types" on public.leave_types for select to authenticated using (true);
drop policy if exists "users read own leave balances" on public.leave_balances;
create policy "users read own leave balances" on public.leave_balances for select to authenticated using (user_id=auth.uid());
drop policy if exists "users read visible leave events" on public.leave_request_events;
create policy "users read visible leave events" on public.leave_request_events for select to authenticated using (exists(select 1 from public.leave_requests r where r.id=leave_request_id and (r.user_id=auth.uid() or r.supervisor_id=auth.uid() or public.is_leave_hr_approver(auth.uid()))));
drop policy if exists "leave workflow participants read requests" on public.leave_requests;
create policy "leave workflow participants read requests" on public.leave_requests for select to authenticated using (user_id=auth.uid() or supervisor_id=auth.uid() or public.is_leave_hr_approver(auth.uid()));
drop policy if exists "hr manages leave approvers" on public.leave_approvers;
create policy "hr manages leave approvers" on public.leave_approvers for all to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('hr','admin'))) with check (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('hr','admin')));
grant select on public.leave_types,public.leave_balances,public.leave_request_events to authenticated;
revoke execute on function public.is_leave_hr_approver(uuid),public.submit_leave_request(uuid,date,date,text),public.review_leave_request(uuid,text,text),public.cancel_leave_request(uuid,text) from public;
grant execute on function public.leave_working_days(date,date),public.is_leave_hr_approver(uuid),public.submit_leave_request(uuid,date,date,text),public.review_leave_request(uuid,text,text),public.cancel_leave_request(uuid,text) to authenticated;
revoke all on public.notification_outbox from authenticated;
