export type WorkPulseRole = 'employee' | 'supervisor' | 'hr' | 'admin';

export type Profile = {
  id: string;
  employee_id: string;
  full_name: string;
  email: string;
  role: WorkPulseRole;
  department: string | null;
  job_title: string | null;
  is_active: boolean;
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
};

export type TeamRow = {
  profile: Profile;
  attendance?: AttendanceRecord;
  officeName?: string;
  clockInOfficeName?: string;
  clockOutOfficeName?: string;
};

export type RequestStatus = 'pending' | 'approved' | 'rejected';

export type LeaveRequest = {
  id: string;
  user_id: string;
  leave_type: 'annual' | 'sick' | 'other';
  start_date: string;
  end_date: string;
  duration_days: number;
  reason: string | null;
  status: RequestStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
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
