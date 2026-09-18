create table if not exists public.workpulse_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  hr_employee_source_id bigint not null,
  employee_no text not null,
  work_email text,
  action text not null check (action in ('validated', 'invited', 'validation_failed', 'invite_failed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workpulse_onboarding_employee_idx
  on public.workpulse_onboarding_events(hr_employee_source_id, created_at desc);

alter table public.workpulse_onboarding_events enable row level security;
revoke all on public.workpulse_onboarding_events from anon, authenticated;

comment on table public.workpulse_onboarding_events is 'Server-only audit trail for HR-initiated WorkPulse account onboarding.';
