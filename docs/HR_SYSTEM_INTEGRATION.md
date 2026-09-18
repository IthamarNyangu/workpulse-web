# People and Culture integration

WorkPulse now imports its employee directory and reporting lines from the local People and Culture system. The integration is deliberately server-to-server: the shared token and Supabase service-role key must never be exposed through `NEXT_PUBLIC_*` variables.

## What is synchronized

- Employee number, name and work email
- Department and job title
- Facility and employment status
- Hire/termination state
- Assigned supervisor

Sensitive HR data such as national IDs, dates of birth, phone numbers, notes and termination comments is not returned by the HR API.

All HR employees are stored in `public.hr_directory_employees`. Existing WorkPulse profiles are matched in this order: HR source ID, employee number, then work email. A match updates directory fields and reporting lines, but does not replace the person's WorkPulse access role.

Employees without an existing Supabase/WorkPulse account remain staged as unlinked directory records. This avoids silently creating unusable authentication accounts before the organisation chooses its invitation or SSO process.

## One-time setup

1. Run `supabase/migrations/20260918120000_hr_directory_integration.sql` in the WorkPulse Supabase project.
   Then run `supabase/migrations/20260918143000_hr_reference_data.sql` to link HR-owned departments and job titles.
2. Generate one long random token and place the same value in both applications.
3. In the People and Culture `.env`, set:

   ```env
   WORKPULSE_SYNC_TOKEN=replace-with-the-shared-random-token
   ```

4. In WorkPulse `.env.local`, set:

   ```env
   SUPABASE_SERVICE_ROLE_KEY=replace-with-the-supabase-service-role-key
   HR_SYSTEM_BASE_URL=http://localhost/HR_Management_System/people-culture-records/public
   HR_SYSTEM_SYNC_TOKEN=replace-with-the-shared-random-token
   ```

   Adjust `HR_SYSTEM_BASE_URL` if WampServer exposes the Laravel project through a virtual host. It must be the URL immediately before `/api/integrations/workpulse/directory`.

5. Clear the Laravel configuration cache after changing its environment:

   ```powershell
   php artisan config:clear
   ```

6. Restart the WorkPulse development server so it reads the new variables.

## Run a synchronization

Send a `POST` request to `/api/integrations/hr/sync` with the signed-in WorkPulse user's Supabase access token:

```text
Authorization: Bearer <supabase-user-access-token>
```

Only users whose WorkPulse role is `admin` or `hr` can start a sync. The response reports received employees, linked profiles, supervisor assignments and unlinked employees. Every run is recorded in `public.hr_directory_sync_runs`.

The HR directory endpoint is:

```text
GET /api/integrations/workpulse/directory?per_page=200&page=1
Authorization: Bearer <shared-sync-token>
```

## Operational notes

- Keep People and Culture as the source of truth for employee organisation data.
- Departments and job titles are synchronized by stable HR source ID. WorkPulse office locations remain managed by WorkPulse because they contain attendance/geofence configuration; HR facilities are retained only as employee-assignment metadata for now.
- Keep WorkPulse/Supabase as the source of truth for login identities and application roles.
- A scheduled sync can call the WorkPulse sync route later; no scheduler is enabled yet.
- After HR users receive WorkPulse accounts, explicitly add the intended people to `public.leave_approvers`. HR employment or an `hr` application role alone does not make someone a leave approver.
