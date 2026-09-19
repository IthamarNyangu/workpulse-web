-- Preserve the mobile location statuses while allowing audited web clocking outcomes.
alter table public.attendance_records
  drop constraint if exists attendance_clock_in_location_status_check;

alter table public.attendance_records
  add constraint attendance_clock_in_location_status_check check (
    clock_in_location_status is null or clock_in_location_status in (
      'inside_office',
      'outside_all_offices',
      'location_unavailable',
      'low_accuracy',
      'no_offices_configured',
      'web_verified',
      'web_outside_selected_office',
      'web_unverified'
    )
  );

alter table public.attendance_records
  drop constraint if exists attendance_clock_out_location_status_check;

alter table public.attendance_records
  add constraint attendance_clock_out_location_status_check check (
    clock_out_location_status is null or clock_out_location_status in (
      'inside_office',
      'outside_all_offices',
      'location_unavailable',
      'low_accuracy',
      'no_offices_configured',
      'web_verified',
      'web_outside_selected_office',
      'web_unverified'
    )
  );
