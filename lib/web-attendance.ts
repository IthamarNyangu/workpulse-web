import type { AttendanceRecord, WebClockInput, WebClockResult } from './types';
import { supabase } from './supabase';

export const webAttendanceSelect = [
  'id', 'user_id', 'work_date', 'clock_in', 'clock_out', 'status',
  'clock_in_comment', 'clock_out_comment',
  'clock_in_accuracy_m', 'clock_out_accuracy_m',
  'clock_in_distance_m', 'clock_out_distance_m',
  'clock_in_geofence_radius_m', 'clock_out_geofence_radius_m',
  'clock_in_location_status', 'clock_out_location_status',
  'clock_in_verified_office_location_id', 'clock_out_verified_office_location_id',
  'clock_in_nearest_office_location_id', 'clock_out_nearest_office_location_id',
  'clock_in_channel', 'clock_out_channel',
  'clock_in_selected_office_location_id', 'clock_out_selected_office_location_id',
  'clock_in_fallback_reason', 'clock_out_fallback_reason',
].join(', ');

export async function submitWebClock(input: WebClockInput): Promise<WebClockResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };

  const { data, error } = await supabase.rpc('web_clock_attendance', {
    p_action: input.action,
    p_selected_office_id: input.selectedOfficeId,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_accuracy_m: input.accuracyM ?? null,
    p_fallback_reason: input.fallbackReason?.trim() || null,
    p_user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent,
  });

  if (error) return { ok: false, message: error.message };
  const result = data as WebClockResult | null;
  if (!result) return { ok: false, message: 'WorkPulse did not return a clocking result.' };
  return result.record
    ? { ...result, record: result.record as AttendanceRecord }
    : result;
}
