-- Web and mobile users must always be able to reload their own attendance.
-- Reviewer/team visibility remains governed by the existing scoped policies.
alter table public.attendance_records enable row level security;

drop policy if exists "attendance_select_own" on public.attendance_records;

create policy "attendance_select_own"
on public.attendance_records
for select
to authenticated
using (auth.uid() = user_id);

grant select on public.attendance_records to authenticated;
