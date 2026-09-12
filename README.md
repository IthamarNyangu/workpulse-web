# WorkPulse Web Portal

The desktop portal shares the existing WorkPulse Supabase project, authentication
accounts, and Row Level Security policies with the Flutter mobile app.

## Local setup

1. Copy `.env.local.example` to `.env.local`.
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the
   same project URL and publishable/anon key used by the mobile app.
3. Run `npm install`.
4. Run `npm run dev` and open `http://localhost:3000`.

Use the same WorkPulse account credentials as the mobile app. Do not place a
Supabase service-role key in this project.

## Current MVP foundation

- Supabase sign-in and sign-out
- Effective multi-role detection
- Role-aware portal shell
- Supervisor/HR/Admin team attendance dashboard
- Direct-report visibility for supervisors, enforced by existing Supabase RLS

Approval, reports, and organisation routes are intentionally shown as upcoming
sections while their desktop workflows are built next.
