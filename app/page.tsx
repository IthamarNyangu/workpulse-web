'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ArrowIcon,
  ChartIcon,
  ClipboardIcon,
  GridIcon,
  MarkIcon,
  SearchIcon,
  SettingsIcon,
} from '../components/icons';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import type { ApprovalItem, AttendanceRecord, CorrectionRequest, LeaveRequest, Profile, TeamRow, WorkPulseRole } from '../lib/types';

type Office = { id: string; office_name: string };
type PortalView = 'attendance' | 'approvals' | 'reports' | 'organisation';
type StatusFilter = 'all' | 'attention' | 'on_duty' | 'completed' | 'leave' | 'location';
type AttendanceScope = 'mine' | 'team';
type ApprovalScope = 'pending' | 'reviewed' | 'all';
type ApprovalTypeFilter = 'all' | 'leave' | 'correction';

const roleLabel: Record<WorkPulseRole, string> = {
  employee: 'Employee',
  supervisor: 'Supervisor',
  hr: 'HR',
  admin: 'Administrator',
};

const statusLabel: Record<string, string> = {
  on_duty: 'On duty',
  completed: 'Completed',
  missed_punch: 'Missed clock out',
  absent: 'No clock in',
  on_leave: 'On leave',
  leave_pending: 'Leave pending',
  correction_pending: 'Correction pending',
};

function dateKey(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function formatTime(value: string | null | undefined) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

function statusTone(status?: string) {
  if (status === 'completed') return 'green';
  if (status === 'on_duty') return 'blue';
  if (status === 'on_leave' || status === 'leave_pending') return 'purple';
  if (status === 'missed_punch' || status === 'correction_pending') return 'amber';
  if (status === 'absent') return 'red';
  return 'slate';
}

function effectiveStatus(row: TeamRow) {
  return row.attendance?.status || 'absent';
}

function workHours(record?: AttendanceRecord) {
  if (!record?.clock_in || !record.clock_out || record.status !== 'completed') return '--';
  const startedAt = new Date(record.clock_in).getTime();
  const endedAt = new Date(record.clock_out).getTime();
  if (!endedAt || Number.isNaN(startedAt) || Number.isNaN(endedAt)) return '--';
  const minutes = Math.max(0, Math.floor((endedAt - startedAt) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function locationStatusLabel(status?: string | null) {
  switch (status) {
    case 'inside_office':
      return 'Verified location';
    case 'outside_all_offices':
      return 'Outside approved offices';
    case 'location_unavailable':
      return 'Location unavailable';
    case 'low_accuracy':
      return 'Low GPS accuracy';
    case 'no_offices_configured':
      return 'No approved offices configured';
    default:
      return 'No location captured';
  }
}

function distanceLabel(value?: number | null) {
  if (value === null || value === undefined) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function requestTypeLabel(item: ApprovalItem) {
  if (item.kind === 'leave') return 'Leave request';
  const type = item.correction?.correction_type;
  return type === 'both' ? 'Clock in and out correction' : type === 'clock_in' ? 'Clock in correction' : 'Clock out correction';
}

function leaveTypeLabel(type?: string) {
  return type === 'annual' ? 'Annual leave' : type === 'sick' ? 'Sick leave' : 'Other leave';
}

function requestStatusTone(status: string) {
  return status === 'approved' ? 'green' : status === 'rejected' ? 'red' : 'amber';
}

export default function PortalPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<WorkPulseRole[]>([]);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [selectedDate, setSelectedDate] = useState(dateKey());
  const [activeView, setActiveView] = useState<PortalView>('attendance');
  const [attendanceScope, setAttendanceScope] = useState<AttendanceScope>('team');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [selectedRow, setSelectedRow] = useState<TeamRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [approvalItems, setApprovalItems] = useState<ApprovalItem[]>([]);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalScope, setApprovalScope] = useState<ApprovalScope>('pending');
  const [approvalTypeFilter, setApprovalTypeFilter] = useState<ApprovalTypeFilter>('all');
  const [approvalDepartmentFilter, setApprovalDepartmentFilter] = useState('all');
  const [approvalSearch, setApprovalSearch] = useState('');
  const [selectedApproval, setSelectedApproval] = useState<ApprovalItem | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setSessionReady(true);
      if (!nextSession) {
        setPortalReady(false);
        setProfile(null);
        setRoles([]);
        setTeam([]);
        setApprovalItems([]);
        setSelectedApproval(null);
      }
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user || !supabase) {
      setProfile(null);
      setTeam([]);
      setLoading(false);
      setPortalReady(false);
      return;
    }
    void loadPortalData();
  // selectedDate intentionally refreshes the team register.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendanceScope, session?.user.id, selectedDate]);

  useEffect(() => {
    const canReviewRequests = roles.some((role) => role === 'supervisor' || role === 'hr' || role === 'admin');
    if (!session?.user || !supabase || activeView !== 'approvals' || !canReviewRequests) {
      if (!canReviewRequests) setApprovalItems([]);
      return;
    }
    void loadApprovalData();
  // Access role changes are an intentional refresh trigger for the approval inbox.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, roles.join('|'), session?.user.id]);

  async function loadPortalData() {
    if (!supabase || !session?.user) return;
    setLoading(true);
    setError(null);
    try {
      const [{ data: currentProfile, error: profileError }, { data: roleRows, error: rolesError }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, employee_id, full_name, email, role, department, job_title, is_active')
          .eq('id', session.user.id)
          .single(),
        supabase.rpc('current_user_roles'),
      ]);
      if (profileError) throw profileError;
      if (rolesError) throw rolesError;

      const resolvedProfile = currentProfile as Profile;
      const resolvedRoles = ((roleRows as WorkPulseRole[] | null) || [resolvedProfile.role]).filter(Boolean);
      setProfile(resolvedProfile);
      setRoles(resolvedRoles);

      const canReviewTeam = resolvedRoles.some((role) => role === 'supervisor' || role === 'hr' || role === 'admin');
      const hasOrganisationScope = resolvedRoles.some((role) => role === 'hr' || role === 'admin');
      const shouldLoadTeam = attendanceScope === 'team' && canReviewTeam;
      let profiles: Profile[] = [];

      if (!shouldLoadTeam) {
        profiles = [resolvedProfile];
      } else if (hasOrganisationScope) {
        const { data, error: teamError } = await supabase
          .from('profiles')
          .select('id, employee_id, full_name, email, role, department, job_title, is_active')
          .eq('is_active', true)
          .order('full_name');
        if (teamError) throw teamError;
        profiles = (data || []) as Profile[];
      } else if (resolvedRoles.includes('supervisor')) {
        const { data: assignments, error: assignmentsError } = await supabase
          .from('employee_supervisor_assignments')
          .select('employee_id')
          .eq('supervisor_id', session.user.id)
          .eq('is_active', true)
          .eq('is_primary', true);
        if (assignmentsError) throw assignmentsError;

        const employeeIds = (assignments || []).map((item) => item.employee_id);
        if (employeeIds.length) {
          const { data, error: teamError } = await supabase
            .from('profiles')
            .select('id, employee_id, full_name, email, role, department, job_title, is_active')
            .in('id', employeeIds)
            .eq('is_active', true)
            .order('full_name');
          if (teamError) throw teamError;
          profiles = (data || []) as Profile[];
        }
      }

      const visibleIds = profiles.map((person) => person.id);
      const [attendanceResponse, officeResponse] = await Promise.all([
        visibleIds.length
          ? supabase
              .from('attendance_records')
              .select([
                'id', 'user_id', 'work_date', 'clock_in', 'clock_out', 'status',
                'clock_in_comment', 'clock_out_comment',
                'clock_in_accuracy_m', 'clock_out_accuracy_m',
                'clock_in_distance_m', 'clock_out_distance_m',
                'clock_in_geofence_radius_m', 'clock_out_geofence_radius_m',
                'clock_in_location_status', 'clock_out_location_status',
                'clock_in_verified_office_location_id', 'clock_out_verified_office_location_id',
                'clock_in_nearest_office_location_id', 'clock_out_nearest_office_location_id',
              ].join(', '))
              .eq('work_date', selectedDate)
              .in('user_id', visibleIds)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('office_locations').select('id, office_name').eq('is_active', true),
      ]);
      if (attendanceResponse.error) throw attendanceResponse.error;
      if (officeResponse.error) throw officeResponse.error;

      const attendanceByUser = new Map(
        (attendanceResponse.data || []).map((record) => {
          const attendanceRecord = record as unknown as AttendanceRecord;
          return [attendanceRecord.user_id, attendanceRecord];
        }),
      );
      const officeNames = new Map(
        (officeResponse.data || []).map((office: Office) => [office.id, office.office_name]),
      );

      setTeam(profiles.map((person) => {
        const attendance = attendanceByUser.get(person.id);
        const clockInOfficeName = officeNames.get(
          attendance?.clock_in_verified_office_location_id || attendance?.clock_in_nearest_office_location_id || '',
        );
        const clockOutOfficeName = officeNames.get(
          attendance?.clock_out_verified_office_location_id || attendance?.clock_out_nearest_office_location_id || '',
        );
        return {
          profile: person,
          attendance,
          officeName: clockInOfficeName,
          clockInOfficeName,
          clockOutOfficeName,
        };
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'WorkPulse could not load the portal data.');
    } finally {
      setLoading(false);
      setPortalReady(true);
    }
  }

  async function loadApprovalData() {
    if (!supabase || !session?.user) return;
    setApprovalLoading(true);
    setApprovalError(null);
    try {
      const [leaveResponse, correctionResponse] = await Promise.all([
        supabase
          .from('leave_requests')
          .select('id, user_id, leave_type, start_date, end_date, duration_days, reason, status, reviewed_by, reviewed_at, reviewer_note, created_at, updated_at')
          .order('created_at', { ascending: false }),
        supabase
          .from('correction_requests')
          .select('id, user_id, attendance_record_id, work_date, correction_type, corrected_clock_in, corrected_clock_out, reason, status, reviewed_by, reviewed_at, reviewer_note, created_at, updated_at')
          .order('created_at', { ascending: false }),
      ]);
      if (leaveResponse.error) throw leaveResponse.error;
      if (correctionResponse.error) throw correctionResponse.error;

      const leaves = ((leaveResponse.data || []) as unknown as LeaveRequest[])
        .filter((request) => request.user_id !== session.user.id);
      const corrections = ((correctionResponse.data || []) as unknown as CorrectionRequest[])
        .filter((request) => request.user_id !== session.user.id);
      const requesterIds = [...new Set([...leaves, ...corrections].map((request) => request.user_id))];
      const attendanceIds = [...new Set(corrections.map((request) => request.attendance_record_id).filter((id): id is string => Boolean(id)))];
      const [profilesResponse, attendanceResponse] = await Promise.all([
        requesterIds.length
          ? supabase.from('profiles').select('id, employee_id, full_name, email, role, department, job_title, is_active').in('id', requesterIds)
          : Promise.resolve({ data: [], error: null }),
        attendanceIds.length
          ? supabase.from('attendance_records').select('id, clock_in, clock_out, status').in('id', attendanceIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (profilesResponse.error) throw profilesResponse.error;
      if (attendanceResponse.error) throw attendanceResponse.error;

      const profilesById = new Map(((profilesResponse.data || []) as unknown as Profile[]).map((person) => [person.id, person]));
      const attendanceById = new Map(((attendanceResponse.data || []) as unknown as Pick<AttendanceRecord, 'id' | 'clock_in' | 'clock_out' | 'status'>[]).map((record) => [record.id, record]));
      const items: ApprovalItem[] = [
        ...leaves.flatMap((leave): ApprovalItem[] => {
          const requester = profilesById.get(leave.user_id);
          return requester ? [{
            id: leave.id,
            kind: 'leave',
            requester,
            status: leave.status,
            created_at: leave.created_at,
            updated_at: leave.updated_at,
            leave,
          }] : [];
        }),
        ...corrections.flatMap((correction): ApprovalItem[] => {
          const requester = profilesById.get(correction.user_id);
          return requester ? [{
            id: correction.id,
            kind: 'correction',
            requester,
            status: correction.status,
            created_at: correction.created_at,
            updated_at: correction.updated_at,
            correction,
            attendance: correction.attendance_record_id ? attendanceById.get(correction.attendance_record_id) || null : null,
          }] : [];
        }),
      ];

      const rank = (status: string) => status === 'pending' ? 0 : 1;
      items.sort((left, right) => rank(left.status) - rank(right.status) || new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());
      setApprovalItems(items);
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : 'WorkPulse could not load approval requests.');
    } finally {
      setApprovalLoading(false);
    }
  }

  async function handleApprovalDecision(item: ApprovalItem, decision: 'approved' | 'rejected', reviewerNote: string) {
    if (!supabase || !profile || item.status !== 'pending') return false;
    if (decision === 'rejected' && !reviewerNote.trim()) return false;
    setApprovalError(null);
    try {
      const reviewPayload = {
        status: decision,
        reviewed_by: profile.id,
        reviewed_at: new Date().toISOString(),
        reviewer_note: reviewerNote.trim() || null,
      };
      if (item.kind === 'leave') {
        const { error: updateError } = await supabase.from('leave_requests').update(reviewPayload).eq('id', item.id).eq('status', 'pending');
        if (updateError) throw updateError;
      } else {
        const correction = item.correction;
        if (!correction) throw new Error('This correction request is missing its correction details.');
        if (decision === 'approved' && correction.attendance_record_id && item.attendance) {
          const nextClockIn = correction.corrected_clock_in || item.attendance.clock_in;
          const nextClockOut = correction.corrected_clock_out || item.attendance.clock_out;
          const workDateIsPast = correction.work_date < dateKey();
          const nextStatus = nextClockIn && nextClockOut ? 'completed' : nextClockIn ? (workDateIsPast ? 'missed_punch' : 'on_duty') : (workDateIsPast ? 'absent' : 'on_duty');
          const { error: attendanceUpdateError } = await supabase
            .from('attendance_records')
            .update({ clock_in: nextClockIn, clock_out: nextClockOut, status: nextStatus })
            .eq('id', correction.attendance_record_id);
          if (attendanceUpdateError) throw attendanceUpdateError;
        }
        const { error: updateError } = await supabase.from('correction_requests').update(reviewPayload).eq('id', item.id).eq('status', 'pending');
        if (updateError) throw updateError;

        if (decision === 'rejected' && correction.attendance_record_id) {
          const { data: remaining, error: remainingError } = await supabase
            .from('correction_requests')
            .select('id')
            .eq('attendance_record_id', correction.attendance_record_id)
            .eq('status', 'pending');
          if (remainingError) throw remainingError;
          if (!(remaining || []).length) {
            const { data: currentAttendance, error: attendanceError } = await supabase
              .from('attendance_records')
              .select('id, work_date, clock_in, clock_out')
              .eq('id', correction.attendance_record_id)
              .maybeSingle();
            if (attendanceError) throw attendanceError;
            if (currentAttendance) {
              const pastDate = currentAttendance.work_date < dateKey();
              const nextStatus = currentAttendance.clock_in && currentAttendance.clock_out
                ? 'completed'
                : currentAttendance.clock_in ? (pastDate ? 'missed_punch' : 'on_duty')
                : (pastDate ? 'absent' : 'on_duty');
              const { error: statusError } = await supabase.from('attendance_records').update({ status: nextStatus }).eq('id', currentAttendance.id);
              if (statusError) throw statusError;
            }
          }
        }
      }
      setSelectedApproval(null);
      await Promise.all([loadApprovalData(), loadPortalData()]);
      return true;
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : 'Unable to update this approval request.');
      return false;
    }
  }

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase || signingIn) return;
    setSigningIn(true);
    setLoginError(null);
    try {
      const result = await Promise.race([
        supabase.auth.signInWithPassword({ email: loginEmail.trim(), password }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('The sign-in request timed out.')), 12_000);
        }),
      ]);

      if (result.error) {
        setLoginError('Unable to sign in. Check your work email and password, then try again.');
      } else if (!result.data.session) {
        setLoginError('Your account signed in but no portal session was created. Please try again.');
      }
    } catch {
      setLoginError('WorkPulse could not reach Supabase. Check your internet connection, then try again.');
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSignOut() {
    if (supabase) await supabase.auth.signOut();
  }

  const departments = useMemo(() => {
    return [...new Set(team.map((row) => row.profile.department).filter(Boolean) as string[])].sort();
  }, [team]);

  const filteredTeam = useMemo(() => {
    const query = search.trim().toLowerCase();
    return team.filter((row) => {
      const status = effectiveStatus(row);
      const matchesQuery = !query || [
        row.profile.full_name,
        row.profile.employee_id,
        row.profile.department,
        row.profile.job_title,
        statusLabel[status],
        row.officeName,
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
      const matchesDepartment = departmentFilter === 'all' || row.profile.department === departmentFilter;
      const matchesStatus = statusFilter === 'all'
        || (statusFilter === 'attention' && ['absent', 'missed_punch', 'correction_pending'].includes(status))
        || (statusFilter === 'leave' && ['on_leave', 'leave_pending'].includes(status))
        || (statusFilter === 'location' && row.attendance?.clock_in_location_status === 'outside_all_offices')
        || statusFilter === status;
      return matchesQuery && matchesDepartment && matchesStatus;
    });
  }, [departmentFilter, search, statusFilter, team]);

  const metrics = useMemo(() => {
    const records = team.map((row) => row.attendance);
    return {
      employees: team.length,
      clockedIn: records.filter((record) => record?.clock_in).length,
      completed: records.filter((record) => record?.status === 'completed').length,
      exceptions: records.filter((record) => record && ['missed_punch', 'correction_pending'].includes(record.status)).length,
      absent: records.filter((record) => record?.status === 'absent').length,
      leave: records.filter((record) => record && ['on_leave', 'leave_pending'].includes(record.status)).length,
    };
  }, [team]);

  const approvalDepartments = useMemo(() => {
    return [...new Set(approvalItems.map((item) => item.requester.department).filter(Boolean) as string[])].sort();
  }, [approvalItems]);

  const filteredApprovals = useMemo(() => {
    const query = approvalSearch.trim().toLowerCase();
    return approvalItems.filter((item) => {
      const matchesScope = approvalScope === 'all' || (approvalScope === 'pending' ? item.status === 'pending' : item.status !== 'pending');
      const matchesType = approvalTypeFilter === 'all' || item.kind === approvalTypeFilter;
      const matchesDepartment = approvalDepartmentFilter === 'all' || item.requester.department === approvalDepartmentFilter;
      const matchesQuery = !query || [
        item.requester.full_name,
        item.requester.employee_id,
        item.requester.department,
        requestTypeLabel(item),
        item.kind === 'leave' ? leaveTypeLabel(item.leave?.leave_type) : item.correction?.work_date,
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
      return matchesScope && matchesType && matchesDepartment && matchesQuery;
    });
  }, [approvalDepartmentFilter, approvalItems, approvalScope, approvalSearch, approvalTypeFilter]);

  if (!isSupabaseConfigured) return <ConfigurationNotice />;
  if (!sessionReady) return <main className="session-loading" aria-label="Restoring WorkPulse session"><div className="loader" /></main>;
  if (!session) {
    return <LoginScreen
      email={loginEmail}
      password={password}
      error={loginError}
      signingIn={signingIn}
      onEmail={setLoginEmail}
      onPassword={setPassword}
      onSubmit={handleSignIn}
    />;
  }

  const canManageOrganisation = roles.some((role) => role === 'hr' || role === 'admin');
  const canReview = roles.some((role) => role === 'supervisor' || role === 'hr' || role === 'admin');
  const resolvedAttendanceScope: AttendanceScope = canReview && attendanceScope === 'team' ? 'team' : 'mine';

  if (!portalReady) return <main className="session-loading" aria-label="Loading WorkPulse access"><div className="loader" /></main>;

  return (
    <main className={`portal-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <div className="brand-lockup"><img className="brand-icon" src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Portal navigation">
          <NavItem active={activeView === 'attendance'} icon={<GridIcon />} label="Attendance" onClick={() => setActiveView('attendance')} />
          {canReview && <NavItem active={activeView === 'approvals'} icon={<ClipboardIcon />} label="Approvals" onClick={() => setActiveView('approvals')} />}
          <NavItem active={activeView === 'reports'} icon={<ChartIcon />} label="Reports" badge="Soon" onClick={() => setActiveView('reports')} />
          {canManageOrganisation && <NavItem active={activeView === 'organisation'} icon={<SettingsIcon />} label="Organisation" badge="Soon" onClick={() => setActiveView('organisation')} />}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-chip"><span className="avatar">{profile?.full_name.slice(0, 1)}</span><span><strong>{profile?.full_name}</strong><small>{roles.map((role) => roleLabel[role]).join(' / ')}</small></span></div>
          <button className="signout" onClick={handleSignOut} title="Sign out"><span className="signout-label">Sign out</span><ArrowIcon size={16} /></button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">WORKPULSE PORTAL</p><h1>{viewTitle(activeView)}</h1></div>
          <div className="topbar-right"><span className="today-label">{displayDate(selectedDate)}</span><button className="date-button" onClick={() => setSelectedDate(dateKey())}>Go to today</button></div>
        </header>
        {activeView === 'attendance' ? (
          <AttendanceWorkspace
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
            metrics={metrics}
            rows={filteredTeam}
            totalRows={team.length}
            search={search}
            onSearch={setSearch}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            departmentFilter={departmentFilter}
            onDepartmentFilter={setDepartmentFilter}
            departments={departments}
            loading={loading}
            error={error}
            canReview={canReview}
            attendanceScope={resolvedAttendanceScope}
            onAttendanceScope={setAttendanceScope}
            onViewRow={setSelectedRow}
          />
        ) : activeView === 'approvals' ? (
          <ApprovalsWorkspace
            items={filteredApprovals}
            loading={approvalLoading}
            error={approvalError}
            scope={approvalScope}
            onScope={setApprovalScope}
            typeFilter={approvalTypeFilter}
            onTypeFilter={setApprovalTypeFilter}
            departmentFilter={approvalDepartmentFilter}
            onDepartmentFilter={setApprovalDepartmentFilter}
            search={approvalSearch}
            onSearch={setApprovalSearch}
            departments={approvalDepartments}
            onSelect={setSelectedApproval}
          />
        ) : <ComingSoon view={activeView} />}
      </section>
      {selectedRow && <AttendanceDetails row={selectedRow} onClose={() => setSelectedRow(null)} />}
      {selectedApproval && <ApprovalDetails item={selectedApproval} onClose={() => setSelectedApproval(null)} onDecision={handleApprovalDecision} />}
    </main>
  );
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: ReactNode; label: string; badge?: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} title={label}><span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>{badge && <em>{badge}</em>}</button>;
}

type AttendanceWorkspaceProps = {
  selectedDate: string;
  onDateChange: (date: string) => void;
  metrics: Record<string, number>;
  rows: TeamRow[];
  totalRows: number;
  search: string;
  onSearch: (value: string) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (value: StatusFilter) => void;
  departmentFilter: string;
  onDepartmentFilter: (value: string) => void;
  departments: string[];
  loading: boolean;
  error: string | null;
  canReview: boolean;
  attendanceScope: AttendanceScope;
  onAttendanceScope: (scope: AttendanceScope) => void;
  onViewRow: (row: TeamRow) => void;
};

function AttendanceWorkspace({
  selectedDate,
  onDateChange,
  metrics,
  rows,
  totalRows,
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  departmentFilter,
  onDepartmentFilter,
  departments,
  loading,
  error,
  canReview,
  attendanceScope,
  onAttendanceScope,
  onViewRow,
}: AttendanceWorkspaceProps) {
  const date = new Date(`${selectedDate}T12:00:00`);
  const moveDate = (days: number) => onDateChange(dateKey(new Date(date.getTime() + days * 86_400_000)));
  const statusFilters: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All records' },
    { value: 'attention', label: 'Needs attention' },
    { value: 'on_duty', label: 'On duty' },
    { value: 'completed', label: 'Completed' },
    { value: 'leave', label: 'On leave' },
    { value: 'location', label: 'Location exceptions' },
  ];
  const pageSize = 10;
  const [currentPage, setCurrentPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDate, search, statusFilter, departmentFilter]);

  return <div className="page-content">
    <section className="date-toolbar">
      <div>
        <p className="eyebrow">ATTENDANCE VIEW</p>
        <div className="attendance-scope-tabs" role="tablist" aria-label="Attendance view">
          <button className={attendanceScope === 'mine' ? 'active' : ''} role="tab" aria-selected={attendanceScope === 'mine'} onClick={() => onAttendanceScope('mine')}>My attendance</button>
          {canReview && <button className={attendanceScope === 'team' ? 'active' : ''} role="tab" aria-selected={attendanceScope === 'team'} onClick={() => onAttendanceScope('team')}>Team attendance</button>}
        </div>
      </div>
      <div className="date-control">
        <button onClick={() => moveDate(-1)} aria-label="Previous day">&lsaquo;</button>
        <div><strong>{displayDate(selectedDate)}</strong><input aria-label="Select date" type="date" value={selectedDate} onChange={(event) => onDateChange(event.target.value)} /></div>
        <button onClick={() => moveDate(1)} aria-label="Next day">&rsaquo;</button>
      </div>
    </section>

    <section className="metric-grid">
      <Metric label="Employees" value={metrics.employees} tone="ink" />
      <Metric label="Clocked in" value={metrics.clockedIn} tone="blue" />
      <Metric label="Completed" value={metrics.completed} tone="green" />
      <Metric label="Exceptions" value={metrics.exceptions} tone="amber" />
      <Metric label="No clock in" value={metrics.absent} tone="red" />
      <Metric label="On leave" value={metrics.leave} tone="purple" />
    </section>

    <section className="register-panel">
      <div className="register-head">
        <div><p className="eyebrow">DAILY REGISTER</p><h2>{rows.length} of {totalRows} employees</h2></div>
        <label className="search-box"><SearchIcon size={20} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search employee, department, office or status" /></label>
      </div>
      <div className="register-filters">
        <label className="filter-field">Status<select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value as StatusFilter)}>{statusFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label>
        <label className="filter-field">Department<select value={departmentFilter} onChange={(event) => onDepartmentFilter(event.target.value)}><option value="all">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select></label>
      </div>
      {loading ? <LoadingState /> : error ? <ErrorState message={error} /> : rows.length === 0 ? <EmptyState /> : <><div className="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Clock in</th><th>Clock out</th><th>Hours</th><th>Verified office</th><th></th></tr></thead><tbody>{pagedRows.map((row) => <AttendanceRow key={row.profile.id} row={row} onView={() => onViewRow(row)} />)}</tbody></table></div>{rows.length > pageSize && <div className="table-pagination"><span>Page {safePage} of {pageCount}</span><div><button type="button" disabled={safePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</button><button type="button" disabled={safePage === pageCount} onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))}>Next</button></div></div>}</>}
    </section>
  </div>;
}

type ApprovalsWorkspaceProps = {
  items: ApprovalItem[];
  loading: boolean;
  error: string | null;
  scope: ApprovalScope;
  onScope: (scope: ApprovalScope) => void;
  typeFilter: ApprovalTypeFilter;
  onTypeFilter: (filter: ApprovalTypeFilter) => void;
  departmentFilter: string;
  onDepartmentFilter: (department: string) => void;
  search: string;
  onSearch: (value: string) => void;
  departments: string[];
  onSelect: (item: ApprovalItem) => void;
};

function ApprovalsWorkspace({
  items,
  loading,
  error,
  scope,
  onScope,
  typeFilter,
  onTypeFilter,
  departmentFilter,
  onDepartmentFilter,
  search,
  onSearch,
  departments,
  onSelect,
}: ApprovalsWorkspaceProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const pagedItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pendingCount = items.filter((item) => item.status === 'pending').length;

  useEffect(() => {
    setCurrentPage(1);
  }, [scope, typeFilter, departmentFilter, search]);

  return <div className="page-content">
    <section className="approvals-toolbar">
      <div>
        <p className="eyebrow">REVIEW INBOX</p>
        <h2>{pendingCount} pending approval{pendingCount === 1 ? '' : 's'}</h2>
        <p>Review leave and attendance corrections assigned to your WorkPulse scope.</p>
      </div>
    </section>

    <section className="register-panel approval-panel">
      <div className="register-head">
        <div><p className="eyebrow">REQUESTS</p><h2>Review requests</h2></div>
        <label className="search-box"><SearchIcon size={20} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search employee, ID, department or request" /></label>
      </div>
      <div className="approval-filters">
        <div className="approval-filter-group">
          <span>Show</span>
          <div className="filter-chips" role="group" aria-label="Approval status">
            {([
              ['pending', 'Pending'],
              ['reviewed', 'Reviewed'],
              ['all', 'All'],
            ] as const).map(([value, label]) => <button key={value} type="button" className={`filter-chip ${scope === value ? 'active' : ''}`} onClick={() => onScope(value)}>{label}</button>)}
          </div>
        </div>
        <div className="approval-selects">
          <label className="filter-field">Request type<select value={typeFilter} onChange={(event) => onTypeFilter(event.target.value as ApprovalTypeFilter)}><option value="all">All request types</option><option value="leave">Leave requests</option><option value="correction">Attendance corrections</option></select></label>
          <label className="filter-field">Department<select value={departmentFilter} onChange={(event) => onDepartmentFilter(event.target.value)}><option value="all">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select></label>
        </div>
      </div>
      {loading ? <ApprovalLoadingState /> : error ? <ApprovalErrorState message={error} /> : items.length === 0 ? <ApprovalEmptyState /> : <>
        <div className="table-wrap"><table className="approval-table"><thead><tr><th>Employee</th><th>Request</th><th>Details</th><th>Department</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>{pagedItems.map((item) => <ApprovalRow key={`${item.kind}-${item.id}`} item={item} onView={() => onSelect(item)} />)}</tbody></table></div>
        {items.length > pageSize && <div className="table-pagination"><span>Page {safePage} of {pageCount}</span><div><button type="button" disabled={safePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</button><button type="button" disabled={safePage === pageCount} onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))}>Next</button></div></div>}
      </>}
    </section>
  </div>;
}

function ApprovalRow({ item, onView }: { item: ApprovalItem; onView: () => void }) {
  const detail = item.kind === 'leave'
    ? `${leaveTypeLabel(item.leave?.leave_type)} / ${displayDate(item.leave?.start_date || '')}${item.leave?.end_date && item.leave.end_date !== item.leave.start_date ? ` - ${displayDate(item.leave.end_date)}` : ''}`
    : `Affected date: ${displayDate(item.correction?.work_date || '')}`;
  return <tr>
    <td><div className="employee-cell"><span className="table-avatar">{item.requester.full_name.slice(0, 1)}</span><span><strong>{item.requester.full_name}</strong><small>{item.requester.employee_id}</small></span></div></td>
    <td><strong className="request-type">{requestTypeLabel(item)}</strong></td>
    <td className="request-detail">{detail}</td>
    <td>{item.requester.department || 'Unassigned'}</td>
    <td><span className={`status ${requestStatusTone(item.status)}`}>{item.status === 'pending' ? 'Pending review' : item.status === 'approved' ? 'Approved' : 'Rejected'}</span></td>
    <td>{formatDateTime(item.created_at)}</td>
    <td><button className="row-action" aria-label={`View ${requestTypeLabel(item)} for ${item.requester.full_name}`} onClick={onView}>View <ArrowIcon size={15} /></button></td>
  </tr>;
}

function ApprovalDetails({ item, onClose, onDecision }: { item: ApprovalItem; onClose: () => void; onDecision: (item: ApprovalItem, decision: 'approved' | 'rejected', reviewerNote: string) => Promise<boolean> }) {
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [reviewerNote, setReviewerNote] = useState('');
  const [processing, setProcessing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const isLeave = item.kind === 'leave';
  const request = isLeave ? item.leave : item.correction;

  async function submitDecision() {
    if (!decision) return;
    if (decision === 'rejected' && !reviewerNote.trim()) {
      setFormError('A reason is required when rejecting a request.');
      return;
    }
    setProcessing(true);
    setFormError(null);
    const succeeded = await onDecision(item, decision, reviewerNote);
    if (!succeeded) {
      setFormError('Unable to save this decision. Confirm your access and try again.');
      setProcessing(false);
    }
  }

  return <div className="detail-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="detail-drawer approval-drawer" role="dialog" aria-modal="true" aria-label="Approval request details" onMouseDown={(event) => event.stopPropagation()}>
      <div className="detail-drawer-head"><div><p className="eyebrow">{isLeave ? 'LEAVE APPROVAL' : 'CORRECTION APPROVAL'}</p><h2>{item.requester.full_name}</h2><p>{item.requester.employee_id} / {item.requester.department || 'Unassigned department'}</p></div><button className="close-button" aria-label="Close approval details" onClick={onClose}>x</button></div>
      <div className="detail-status-line"><span className={`status ${requestStatusTone(item.status)}`}>{item.status === 'pending' ? 'Pending review' : item.status === 'approved' ? 'Approved' : 'Rejected'}</span><span>Submitted {formatDateTime(item.created_at)}</span></div>
      {isLeave && item.leave ? <>
        <section className="detail-section"><h3>Leave request</h3><div className="detail-grid"><DetailPair label="Leave type" value={leaveTypeLabel(item.leave.leave_type)} /><DetailPair label="Duration" value={`${item.leave.duration_days} day${item.leave.duration_days === 1 ? '' : 's'}`} /><DetailPair label="Start date" value={displayDate(item.leave.start_date)} /><DetailPair label="End date" value={displayDate(item.leave.end_date)} /></div></section>
        <RequestNote label="Employee reason" value={item.leave.reason || 'No reason provided.'} />
      </> : item.correction ? <>
        <section className="detail-section"><h3>Attendance correction</h3><div className="detail-grid"><DetailPair label="Affected date" value={displayDate(item.correction.work_date)} /><DetailPair label="Correction type" value={requestTypeLabel(item).replace(' correction', '')} /><DetailPair label="Original clock in" value={formatTime(item.attendance?.clock_in)} /><DetailPair label="Original clock out" value={formatTime(item.attendance?.clock_out)} /><DetailPair label="Corrected clock in" value={formatTime(item.correction.corrected_clock_in)} /><DetailPair label="Corrected clock out" value={formatTime(item.correction.corrected_clock_out)} /></div></section>
        <RequestNote label="Employee reason" value={item.correction.reason} />
      </> : null}
      {item.status !== 'pending' && <RequestNote label={item.status === 'rejected' ? 'Reason for rejection' : 'Reviewer note'} value={(request?.reviewer_note || 'No reviewer note provided.')} tone={item.status === 'rejected' ? 'red' : 'green'} />}
      {item.status === 'pending' && <section className="detail-section decision-section">
        {!decision ? <div className="decision-actions"><button className="approve-button" onClick={() => setDecision('approved')}>Approve request</button><button className="reject-button" onClick={() => setDecision('rejected')}>Reject request</button></div> : <div className="decision-form"><h3>{decision === 'approved' ? 'Approve this request?' : 'Reject this request?'}</h3><p>{decision === 'approved' ? 'This decision will update the employee request immediately.' : 'Provide a clear reason for the employee before rejecting this request.'}</p><label>Reviewer note{decision === 'rejected' ? ' (required)' : ' (optional)'}<textarea autoFocus={decision === 'rejected'} value={reviewerNote} onChange={(event) => setReviewerNote(event.target.value)} placeholder={decision === 'rejected' ? 'Explain why this request cannot be approved.' : 'Add an optional note for the employee.'} /></label>{formError && <p className="decision-error" role="alert">{formError}</p>}<div className="decision-actions"><button className="secondary-button" disabled={processing} onClick={() => { setDecision(null); setFormError(null); }}>Cancel</button><button className={decision === 'approved' ? 'approve-button' : 'reject-button'} disabled={processing} onClick={() => void submitDecision()}>{processing ? 'Saving decision...' : decision === 'approved' ? 'Confirm approval' : 'Confirm rejection'}</button></div></div>}
      </section>}
    </aside>
  </div>;
}

function RequestNote({ label, value, tone = 'blue' }: { label: string; value: string; tone?: 'blue' | 'green' | 'red' }) {
  return <section className={`detail-section request-note ${tone}`}><h3>{label}</h3><p>{value}</p></section>;
}

function ApprovalLoadingState() { return <div className="state"><div className="loader" /><strong>Loading approval requests</strong><span>Applying your reviewer scope.</span></div>; }
function ApprovalErrorState({ message }: { message: string }) { return <div className="state error"><strong>Unable to load approvals</strong><span>{message}</span></div>; }
function ApprovalEmptyState() { return <div className="state"><strong>No approval requests found</strong><span>There are no requests matching the current inbox filters.</span></div>; }

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></article>;
}

function AttendanceRow({ row, onView }: { row: TeamRow; onView: () => void }) {
  const attendance = row.attendance;
  const status = effectiveStatus(row);
  const officeLabel = row.officeName || (attendance?.clock_in_location_status === 'outside_all_offices' ? 'Location exception' : '--');
  return <tr>
    <td><div className="employee-cell"><span className="table-avatar">{row.profile.full_name.slice(0, 1)}</span><span><strong>{row.profile.full_name}</strong><small>{row.profile.employee_id} / {row.profile.job_title || 'No job title'}</small></span></div></td>
    <td>{row.profile.department || 'Unassigned'}</td>
    <td><span className={`status ${statusTone(status)}`}>{statusLabel[status]}</span></td>
    <td>{formatTime(attendance?.clock_in)}</td>
    <td>{formatTime(attendance?.clock_out)}</td>
    <td>{workHours(attendance)}</td>
    <td>{officeLabel}</td>
    <td><button className="row-action" aria-label={`View ${row.profile.full_name}`} onClick={onView}>View <ArrowIcon size={15} /></button></td>
  </tr>;
}

function AttendanceDetails({ row, onClose }: { row: TeamRow; onClose: () => void }) {
  const attendance = row.attendance;
  const status = effectiveStatus(row);
  return <div className="detail-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Attendance details" onMouseDown={(event) => event.stopPropagation()}>
      <div className="detail-drawer-head"><div><p className="eyebrow">ATTENDANCE DETAILS</p><h2>{row.profile.full_name}</h2><p>{row.profile.employee_id} / {row.profile.department || 'Unassigned department'}</p></div><button className="close-button" aria-label="Close attendance details" onClick={onClose}>x</button></div>
      <div className="detail-status-line"><span className={`status ${statusTone(status)}`}>{statusLabel[status]}</span><span>{attendance?.work_date ? displayDate(attendance.work_date) : 'No attendance date'}</span></div>
      <section className="detail-section"><h3>Attendance</h3><div className="detail-grid"><DetailPair label="Clock in" value={formatTime(attendance?.clock_in)} /><DetailPair label="Clock out" value={formatTime(attendance?.clock_out)} /><DetailPair label="Work hours" value={workHours(attendance)} /><DetailPair label="Job title" value={row.profile.job_title || 'Not assigned'} /></div></section>
      <LocationDetails title="Clock in location" status={attendance?.clock_in_location_status} office={row.clockInOfficeName} accuracy={attendance?.clock_in_accuracy_m} distance={attendance?.clock_in_distance_m} radius={attendance?.clock_in_geofence_radius_m} />
      <LocationDetails title="Clock out location" status={attendance?.clock_out_location_status} office={row.clockOutOfficeName} accuracy={attendance?.clock_out_accuracy_m} distance={attendance?.clock_out_distance_m} radius={attendance?.clock_out_geofence_radius_m} />
      {(attendance?.clock_in_comment || attendance?.clock_out_comment) && <section className="detail-section"><h3>Attendance comments</h3>{attendance.clock_in_comment && <div className="detail-note"><strong>Clock in</strong><p>{attendance.clock_in_comment}</p></div>}{attendance.clock_out_comment && <div className="detail-note"><strong>Clock out</strong><p>{attendance.clock_out_comment}</p></div>}</section>}
    </aside>
  </div>;
}

function LocationDetails({ title, status, office, accuracy, distance, radius }: { title: string; status?: string | null; office?: string; accuracy?: number | null; distance?: number | null; radius?: number | null }) {
  const hasLocation = Boolean(status || office || accuracy !== null && accuracy !== undefined || distance !== null && distance !== undefined);
  return <section className="detail-section"><h3>{title}</h3>{hasLocation ? <div className="detail-grid"><DetailPair label="Status" value={locationStatusLabel(status)} /><DetailPair label="Office" value={office || 'No office matched'} /><DetailPair label="GPS accuracy" value={accuracy === null || accuracy === undefined ? '--' : `${Math.round(accuracy)} m`} /><DetailPair label="Distance from office" value={distanceLabel(distance)} /><DetailPair label="Allowed radius" value={radius === null || radius === undefined ? '--' : `${Math.round(radius)} m`} /></div> : <p className="detail-empty">No location information was captured.</p>}</section>;
}

function DetailPair({ label, value }: { label: string; value: string }) {
  return <div className="detail-pair"><span>{label}</span><strong>{value}</strong></div>;
}

function LoadingState() { return <div className="state"><div className="loader" /><strong>Loading permitted attendance records</strong><span>Applying your WorkPulse access scope.</span></div>; }
function ErrorState({ message }: { message: string }) { return <div className="state error"><strong>Unable to load attendance</strong><span>{message}</span></div>; }
function EmptyState() { return <div className="state"><strong>No team records found</strong><span>Try a different date or remove the current filter.</span></div>; }

function ComingSoon({ view }: { view: PortalView }) {
  return <div className="page-content"><section className="coming-soon"><p className="eyebrow">NEXT WEB MILESTONE</p><h2>{viewTitle(view)}</h2><p>This section is reserved in the web shell. The next implementation increment will add the working desktop flow while retaining the existing mobile functionality.</p></section></div>;
}

function viewTitle(view: PortalView) {
  return ({ attendance: 'Attendance', approvals: 'Approvals', reports: 'Reports', organisation: 'Organisation' })[view];
}

function LoginScreen({ email, password, error, signingIn, onEmail, onPassword, onSubmit }: { email: string; password: string; error: string | null; signingIn: boolean; onEmail: (value: string) => void; onPassword: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return <main className="login-page"><section className="login-identity"><div className="brand-lockup"><img className="brand-icon" src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></div><p className="eyebrow">SUPERVISION, NOT SPREADSHEETS</p><h1>Attendance control for the people who manage teams.</h1><p>Use the same WorkPulse account as the mobile app. Your browser access is limited to the role and team scope assigned to you.</p><div className="login-note"><MarkIcon size={22} /> Shared Supabase authentication. No separate web password required.</div></section><section className="login-card"><p className="eyebrow">SECURE SIGN IN</p><h2>Welcome to the portal</h2><p>Sign in to review attendance and approvals from your desktop.</p><form onSubmit={onSubmit}><label>Work email<input type="email" autoComplete="email" value={email} onChange={(event) => onEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} required /></label>{error && <p className="login-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={signingIn}>{signingIn ? 'Signing in...' : 'Sign in to WorkPulse'} <ArrowIcon /></button></form></section></main>;
}

function ConfigurationNotice() {
  return <main className="config-page"><div className="config-card"><div className="brand-lockup"><img className="brand-icon" src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></div><h1>Portal configuration required</h1><p>Create `workpulse-web/.env.local` from `.env.local.example`, then add the existing WorkPulse Supabase URL and publishable key.</p></div></main>;
}
