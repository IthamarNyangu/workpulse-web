alter table public.profiles add column if not exists hr_employee_source_id bigint unique;

create table if not exists public.hr_directory_employees (
  source_id bigint primary key,
  employee_no text not null unique,
  first_name text not null,
  last_name text not null,
  full_name text not null,
  work_email text,
  hire_date date,
  termination_date date,
  department_source_id bigint,
  department_code text,
  department_name text,
  job_title_source_id bigint,
  job_title_code text,
  job_title_name text,
  facility_source_id bigint,
  facility_code text,
  facility_name text,
  employment_status_source_id bigint,
  employment_status_code text,
  employment_status_name text,
  supervisor_source_id bigint,
  supervisor_employee_no text,
  is_active boolean not null default true,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists hr_directory_employees_email_idx on public.hr_directory_employees(lower(work_email));
create index if not exists hr_directory_employees_supervisor_idx on public.hr_directory_employees(supervisor_source_id);

create table if not exists public.hr_directory_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed')),
  received_count integer not null default 0,
  linked_profile_count integer not null default 0,
  supervisor_assignment_count integer not null default 0,
  error_message text,
  initiated_by uuid references public.profiles(id)
);

alter table public.hr_directory_employees enable row level security;
alter table public.hr_directory_sync_runs enable row level security;
revoke all on public.hr_directory_employees, public.hr_directory_sync_runs from anon, authenticated;

comment on table public.hr_directory_employees is 'Non-sensitive directory synchronized from People and Culture.';
comment on column public.profiles.hr_employee_source_id is 'Stable employees.id from People and Culture.';
