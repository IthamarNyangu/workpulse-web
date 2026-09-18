alter table public.departments add column if not exists hr_source_id bigint unique;
alter table public.departments add column if not exists hr_code text;

alter table public.job_titles add column if not exists hr_source_id bigint unique;
alter table public.job_titles add column if not exists hr_code text;

comment on column public.departments.hr_source_id is 'Stable departments.id from People and Culture.';
comment on column public.job_titles.hr_source_id is 'Stable job_titles.id from People and Culture.';
