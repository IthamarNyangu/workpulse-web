-- Keep late leave requests reviewable while making overdue ownership explicit.
alter table public.leave_requests
  add column if not exists overdue_notified_at timestamptz,
  add column if not exists escalated_at timestamptz,
  add column if not exists supervisor_locked_at timestamptz;

create or replace function public.leave_add_working_days(p_date date, p_days integer)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when p_days <= 0 then p_date
    else (
      select day::date
      from generate_series(p_date + 1, p_date + greatest(p_days * 3, 14), interval '1 day') day
      where extract(isodow from day) < 6
        and not exists (
          select 1 from public.leave_holidays holiday
          where holiday.holiday_date = day::date and holiday.is_active
        )
      order by day
      offset p_days - 1
      limit 1
    )
  end;
$$;

create or replace function public.leave_request_timing(
  p_start_date date,
  p_end_date date,
  p_as_of date default current_date
)
returns table (
  is_overdue boolean,
  escalation_date date,
  supervisor_lock_date date,
  is_escalated boolean,
  is_supervisor_locked boolean
)
language sql
stable
set search_path = public
as $$
  select
    p_as_of >= p_start_date,
    public.leave_add_working_days(p_end_date, 3),
    public.leave_add_working_days(p_end_date, 10),
    p_as_of >= public.leave_add_working_days(p_end_date, 3),
    p_as_of >= public.leave_add_working_days(p_end_date, 10);
$$;

create or replace function public.process_overdue_leave_requests(p_as_of date default current_date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.leave_requests%rowtype;
  hr_recipient uuid;
  reminder_count integer := 0;
  recipient uuid;
  event_name text;
begin
  for request_row in
    select * from public.leave_requests
    where status = 'pending'
      and workflow_stage in ('supervisor_pending', 'hr_pending')
      and start_date <= p_as_of
  loop
    select approver.user_id into hr_recipient
    from public.leave_approvers approver
    where approver.is_active and approver.user_id <> request_row.user_id
    order by approver.created_at
    limit 1;

    if p_as_of >= public.leave_add_working_days(request_row.end_date, 10)
       and request_row.supervisor_locked_at is null then
      update public.leave_requests
      set supervisor_locked_at = now(), updated_at = now()
      where id = request_row.id;
      insert into public.leave_request_events
        (leave_request_id, event_type, from_stage, to_stage, metadata)
      values
        (request_row.id, 'supervisor_locked', request_row.workflow_stage,
         request_row.workflow_stage, jsonb_build_object('effective_date', p_as_of));
    end if;

    if p_as_of >= public.leave_add_working_days(request_row.end_date, 3)
       and request_row.escalated_at is null then
      update public.leave_requests
      set escalated_at = now(), updated_at = now()
      where id = request_row.id;
      insert into public.leave_request_events
        (leave_request_id, event_type, from_stage, to_stage, metadata)
      values
        (request_row.id, 'escalated', request_row.workflow_stage,
         request_row.workflow_stage, jsonb_build_object('effective_date', p_as_of));
    end if;

    recipient := case
      when p_as_of >= public.leave_add_working_days(request_row.end_date, 3)
        then hr_recipient
      when request_row.workflow_stage = 'supervisor_pending'
        then request_row.supervisor_id
      else hr_recipient
    end;
    event_name := 'leave.overdue.' || request_row.id::text || '.' || p_as_of::text;

    if recipient is not null and not exists (
      select 1 from public.notification_outbox outbox
      where outbox.event_key = event_name and outbox.recipient_user_id = recipient
    ) then
      insert into public.notification_outbox
        (event_key, recipient_user_id, subject, template_key, payload, status)
      values
        (event_name, recipient, 'Overdue leave request requires review',
         'leave_overdue_review',
         jsonb_build_object(
           'leave_request_id', request_row.id,
           'start_date', request_row.start_date,
           'end_date', request_row.end_date,
           'supervisor_locked', p_as_of >= public.leave_add_working_days(request_row.end_date, 10)
         ), 'pending');
      reminder_count := reminder_count + 1;
    end if;

    -- The notifications table is installed by the mobile notification module.
    -- Dynamic SQL keeps this migration deployable in web-only environments too.
    if to_regclass('public.notifications') is not null then
      execute $notification$
        insert into public.notifications
          (user_id,event_key,type,title,message,action_label,navigation_target,leave_request_id,metadata)
        values ($1,$2,'general_info',$3,$4,'Review Leave','leave_details',$5,$6)
        on conflict (user_id,event_key) do nothing
      $notification$ using
        recipient,
        event_name,
        'Overdue Leave Approval',
        'A leave request is overdue and requires a decision.',
        request_row.id,
        jsonb_build_object('role','approver','reminder_date',p_as_of);

      execute $notification$
        insert into public.notifications
          (user_id,event_key,type,title,message,action_label,navigation_target,leave_request_id,metadata)
        values ($1,$2,'leave_update',$3,$4,'View Leave Request','leave_details',$5,$6)
        on conflict (user_id,event_key) do nothing
      $notification$ using
        request_row.user_id,
        'leave.overdue.requester.' || request_row.id::text || '.' || p_as_of::text,
        'Leave Approval Overdue',
        case when p_as_of >= public.leave_add_working_days(request_row.end_date, 3)
          then 'Your leave request has been escalated to HR for a decision.'
          else 'Your leave request is still awaiting approval.' end,
        request_row.id,
        jsonb_build_object('role','requester','reminder_date',p_as_of);
    end if;

    if request_row.overdue_notified_at is null then
      update public.leave_requests set overdue_notified_at = now(), updated_at = now()
      where id = request_row.id;
    end if;
  end loop;
  return reminder_count;
end;
$$;

-- Review entry point with overdue escalation and supervisor lock enforcement.
create or replace function public.review_leave_request(p_request_id uuid, p_decision text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_next text;
  v_hr uuid;
  v_is_hr boolean;
  v_escalated boolean;
  v_locked boolean;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  if p_decision='rejected' and nullif(btrim(p_note),'') is null then raise exception 'A rejection reason is required'; end if;

  select * into v_request from public.leave_requests where id=p_request_id for update;
  if not found or v_request.workflow_stage not in ('supervisor_pending','hr_pending') then raise exception 'Request is not awaiting review'; end if;
  if v_request.user_id=v_actor then raise exception 'Users cannot approve their own leave'; end if;

  v_is_hr := public.is_leave_hr_approver(v_actor);
  v_escalated := current_date >= public.leave_add_working_days(v_request.end_date, 3);
  v_locked := current_date >= public.leave_add_working_days(v_request.end_date, 10);

  if v_request.workflow_stage='supervisor_pending' then
    if v_actor=v_request.supervisor_id and v_locked then
      raise exception 'This overdue request now requires HR or admin review';
    end if;
    if v_actor<>v_request.supervisor_id and not (v_is_hr and v_escalated) then
      raise exception 'Only the assigned supervisor can review this request';
    end if;
  elsif not v_is_hr then
    raise exception 'HR approver access required';
  end if;

  if p_decision='rejected' then
    v_next := 'rejected';
    update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),updated_at=now()
    where user_id=v_request.user_id and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
    update public.leave_requests set status='rejected',workflow_stage=v_next,reserved_days=0,reviewed_by=v_actor,
      reviewed_at=now(),reviewer_note=p_note,
      supervisor_reviewed_at=case when v_actor=v_request.supervisor_id then now() else supervisor_reviewed_at end,
      supervisor_note=case when v_actor=v_request.supervisor_id then p_note else supervisor_note end,
      hr_approver_id=case when v_is_hr then v_actor else hr_approver_id end,
      hr_reviewed_at=case when v_is_hr then now() else hr_reviewed_at end,
      hr_note=case when v_is_hr then p_note else hr_note end,updated_at=now()
    where id=p_request_id;
  elsif v_request.workflow_stage='supervisor_pending' and not v_is_hr then
    select a.user_id into v_hr from public.leave_approvers a
    where a.is_active and a.user_id<>v_request.user_id order by a.created_at limit 1;
    if v_hr is null then raise exception 'No HR approver is configured'; end if;
    v_next := 'hr_pending';
    update public.leave_requests set workflow_stage=v_next,supervisor_reviewed_at=now(),
      supervisor_note=nullif(btrim(p_note),''),updated_at=now() where id=p_request_id;
  else
    v_next := 'approved';
    update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),
      consumed_days=consumed_days+v_request.reserved_days,updated_at=now()
    where user_id=v_request.user_id and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
    update public.leave_requests set status='approved',workflow_stage=v_next,reserved_days=0,reviewed_by=v_actor,
      reviewed_at=now(),reviewer_note=nullif(btrim(p_note),''),hr_approver_id=v_actor,
      hr_reviewed_at=now(),hr_note=nullif(btrim(p_note),''),updated_at=now() where id=p_request_id;
  end if;

  insert into public.leave_request_events(leave_request_id,actor_id,event_type,from_stage,to_stage,note)
  values(p_request_id,v_actor,case when p_decision='rejected' then 'rejected' else 'approved' end,
    v_request.workflow_stage,v_next,nullif(btrim(p_note),''));
  return v_next;
end;
$$;

-- A requester may cancel normally only before leave begins. In-period changes
-- must remain auditable and be resolved by an approver rather than deleted.
create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid:=auth.uid(); v_request public.leave_requests%rowtype;
begin
  select * into v_request from public.leave_requests where id=p_request_id and user_id=v_user for update;
  if not found or v_request.workflow_stage not in ('supervisor_pending','hr_pending') then raise exception 'Only pending requests can be cancelled'; end if;
  if current_date >= v_request.start_date then raise exception 'Leave that has started must be withdrawn through HR'; end if;
  update public.leave_balances set reserved_days=greatest(0,reserved_days-v_request.reserved_days),updated_at=now()
  where user_id=v_user and leave_type_id=v_request.leave_type_id and leave_year=v_request.balance_year;
  update public.leave_requests set status='rejected',workflow_stage='cancelled',reserved_days=0,
    cancelled_at=now(),cancellation_reason=nullif(btrim(p_reason),''),updated_at=now() where id=p_request_id;
  insert into public.leave_request_events(leave_request_id,actor_id,event_type,from_stage,to_stage,note)
  values(p_request_id,v_user,'cancelled',v_request.workflow_stage,'cancelled',nullif(btrim(p_reason),''));
end;
$$;

revoke execute on function public.process_overdue_leave_requests(date) from public;
grant execute on function public.leave_add_working_days(date,integer), public.leave_request_timing(date,date,date) to authenticated;

-- Supabase projects with pg_cron enabled get the daily processor automatically.
-- Other deployments can invoke the same function once daily with a service role.
do $$
declare job_exists boolean := false;
begin
  if to_regnamespace('cron') is not null then
    execute 'select exists(select 1 from cron.job where jobname = $1)'
      into job_exists using 'workpulse-overdue-leave';
    if not job_exists then
      execute $schedule$
        select cron.schedule(
          'workpulse-overdue-leave',
          '15 4 * * *',
          'select public.process_overdue_leave_requests(current_date)'
        )
      $schedule$;
    end if;
  end if;
exception when insufficient_privilege then
  raise notice 'pg_cron schedule skipped; invoke process_overdue_leave_requests daily with a service role';
end;
$$;
