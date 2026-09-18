grant select on public.hr_directory_employees to authenticated;
grant select on public.hr_directory_sync_runs to authenticated;

drop policy if exists "hr and admins read hr directory" on public.hr_directory_employees;
create policy "hr and admins read hr directory"
on public.hr_directory_employees for select to authenticated
using (exists (
  select 1 from public.profiles
  where id = auth.uid() and role in ('hr', 'admin')
));

drop policy if exists "hr and admins read hr sync runs" on public.hr_directory_sync_runs;
create policy "hr and admins read hr sync runs"
on public.hr_directory_sync_runs for select to authenticated
using (exists (
  select 1 from public.profiles
  where id = auth.uid() and role in ('hr', 'admin')
));
