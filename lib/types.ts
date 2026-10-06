export type WorkPulseRole = 'employee' | 'supervisor' | 'hr' | 'admin';

export type ClockingMethod =
  | 'mobile_app'
  | 'personal_device_pwa'
  | 'web_portal'
  | 'kiosk_pin'
  | 'kiosk_qr'
  | 'kiosk_nfc'
  | 'field_team'
  | 'sms_ussd';

export type OrganisationClockingMethod = {
  organisation_id: string;
  organisation_code: string;
  organisation_name: string;
  method: ClockingMethod;
  is_enabled: boolean;
  requires_location: boolean;
  settings: Record<string, unknown>;
  updated_at: string;
};

export type Profile = {
  id: string;
  employee_id: string;
  full_name: string;
  email: string;
  role: WorkPulseRole;
  department: string | null;
  job_title: string | null;
  is_active: boolean;
  organisation_id?: string | null;
};

export type AttendanceStatus =
  | 'on_duty'
  | 'completed'
  | 'missed_punch'
  | 'absent'
  | 'on_leave'
  | 'leave_pending'
  | 'correction_pending';

export type AttendanceRecord = {
  id: string;
  user_id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: AttendanceStatus;
  clock_in_comment?: string | null;
  clock_out_comment?: string | null;
  clock_in_accuracy_m?: number | null;
  clock_out_accuracy_m?: number | null;
  clock_in_distance_m?: number | null;
  clock_out_distance_m?: number | null;
  clock_in_geofence_radius_m?: number | null;
  clock_out_geofence_radius_m?: number | null;
  clock_in_location_status: string | null;
  clock_out_location_status?: string | null;
  clock_in_verified_office_location_id: string | null;
  clock_out_verified_office_location_id?: string | null;
  clock_in_nearest_office_location_id?: string | null;
  clock_out_nearest_office_location_id?: string | null;
  clock_in_channel?: 'mobile' | 'web' | string | null;
  clock_out_channel?: 'mobile' | 'web' | string | null;
  clock_in_selected_office_location_id?: string | null;
  clock_out_selected_office_location_id?: string | null;
  clock_in_fallback_reason?: string | null;
  clock_out_fallback_reason?: string | null;
  clock_in_user_agent?: string | null;
  clock_out_user_agent?: string | null;
};

export type AttendanceOffice = {
  id: string;
  office_name: string;
  province?: string | null;
  district?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radius_m?: number | null;
  is_active?: boolean;
};

export type WebClockAction = 'clock_in' | 'clock_out';

export type WebClockInput = {
  action: WebClockAction;
  selectedOfficeId: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  fallbackReason?: string | null;
};

export type WebClockResult = {
  ok: boolean;
  record?: AttendanceRecord;
  message?: string;
};

export type TeamRow = {
  profile: Profile;
  attendance?: AttendanceRecord;
  officeName?: string;
  clockInOfficeName?: string;
  clockOutOfficeName?: string;
};

export type RequestStatus = 'pending' | 'approved' | 'rejected';
export type LeaveWorkflowStage = 'supervisor_pending' | 'hr_pending' | 'approved' | 'rejected' | 'cancelled';

export type LeaveType = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  legacy_value: string;
  default_entitlement_days: number;
  requires_reason: boolean;
  is_paid: boolean;
  is_active: boolean;
};

export type LeaveBalance = {
  id: string;
  user_id: string;
  leave_type_id: string;
  leave_year: number;
  entitlement_days: number;
  carried_forward_days: number;
  reserved_days: number;
  consumed_days: number;
  leave_type?: LeaveType;
};

export type LeaveRequestEvent = {
  id: string;
  leave_request_id: string;
  actor_id: string | null;
  event_type: string;
  from_stage: string | null;
  to_stage: string | null;
  note: string | null;
  created_at: string;
};

export type LeaveRequest = {
  id: string;
  user_id: string;
  leave_type: string;
  leave_type_id?: string | null;
  start_date: string;
  end_date: string;
  duration_days: number;
  reason: string | null;
  status: RequestStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  workflow_stage?: LeaveWorkflowStage;
  supervisor_id?: string | null;
  supervisor_reviewed_at?: string | null;
  supervisor_note?: string | null;
  hr_approver_id?: string | null;
  hr_reviewed_at?: string | null;
  hr_note?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  overdue_notified_at?: string | null;
  escalated_at?: string | null;
  supervisor_locked_at?: string | null;
  balance_year?: number | null;
  reserved_days?: number;
  leave_type_record?: LeaveType;
  supervisor?: Pick<Profile, 'id' | 'full_name'> | null;
  hr_approver?: Pick<Profile, 'id' | 'full_name'> | null;
  events?: LeaveRequestEvent[];
  created_at: string;
  updated_at: string;
};

export type CorrectionRequest = {
  id: string;
  user_id: string;
  attendance_record_id: string | null;
  work_date: string;
  correction_type: 'clock_in' | 'clock_out' | 'both';
  corrected_clock_in: string | null;
  corrected_clock_out: string | null;
  reason: string;
  status: RequestStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalItem = {
  id: string;
  kind: 'leave' | 'correction';
  requester: Pick<Profile, 'id' | 'employee_id' | 'full_name' | 'department' | 'job_title'>;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
  leave?: LeaveRequest;
  correction?: CorrectionRequest;
  attendance?: Pick<AttendanceRecord, 'id' | 'clock_in' | 'clock_out' | 'status'> | null;
};
