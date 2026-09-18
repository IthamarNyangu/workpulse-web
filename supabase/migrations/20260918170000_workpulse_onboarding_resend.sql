alter table public.workpulse_onboarding_events
  drop constraint if exists workpulse_onboarding_events_action_check;

alter table public.workpulse_onboarding_events
  add constraint workpulse_onboarding_events_action_check
  check (action in ('validated', 'invited', 'resent', 'validation_failed', 'invite_failed', 'resend_failed'));
