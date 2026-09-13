'use client';

import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ArrowIcon,
  ChartIcon,
  ClipboardIcon,
  GridIcon,
  MarkIcon,
  SearchIcon,
  ShareIcon,
  SettingsIcon,
} from '../components/icons';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import type { ApprovalItem, AttendanceRecord, CorrectionRequest, LeaveRequest, Profile, TeamRow, WorkPulseRole } from '../lib/types';

type Office = {
  id: string;
  office_name: string;
  province?: string | null;
  district?: string | null;
  radius_m?: number | null;
  is_active?: boolean;
};
type Department = { id: string; name: string; is_active: boolean };
type JobTitle = { id: string; name: string; is_active: boolean };
type OrganisationTab = 'employees' | 'departments' | 'job_titles' | 'offices';
type PortalView = 'attendance' | 'approvals' | 'reports' | 'organisation';
type StatusFilter = 'all' | 'attention' | 'on_duty' | 'completed' | 'leave' | 'location';
type AttendanceScope = 'mine' | 'team';
type ApprovalScope = 'pending' | 'reviewed' | 'all';
type ApprovalTypeFilter = 'all' | 'leave' | 'correction';
type ReportScope = 'mine' | 'team';
type ReportStatusFilter = 'all' | 'completed' | 'on_duty' | 'exception' | 'absent' | 'leave';
type ReportDatePreset = 'custom' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_30_days';
type ReportRow = { profile: Profile; attendance: AttendanceRecord; officeName?: string };

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

function startOfMonthKey(value = new Date()) {
  return dateKey(new Date(value.getFullYear(), value.getMonth(), 1));
}

function endOfMonthKey(value = new Date()) {
  return dateKey(new Date(value.getFullYear(), value.getMonth() + 1, 0));
}

function previousMonthRange(value = new Date()) {
  const firstDayThisMonth = new Date(value.getFullYear(), value.getMonth(), 1);
  return {
    start: dateKey(new Date(value.getFullYear(), value.getMonth() - 1, 1)),
    end: dateKey(new Date(firstDayThisMonth.getTime() - 86_400_000)),
  };
}

function lastThirtyDaysRange(value = new Date()) {
  return {
    start: dateKey(new Date(value.getFullYear(), value.getMonth(), value.getDate() - 29)),
    end: dateKey(value),
  };
}

function yesterdayRange(value = new Date()) {
  const yesterday = new Date(value.getFullYear(), value.getMonth(), value.getDate() - 1);
  const date = dateKey(yesterday);
  return { start: date, end: date };
}

function currentWeekRange(value = new Date()) {
  const day = value.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return {
    start: dateKey(new Date(value.getFullYear(), value.getMonth(), value.getDate() + mondayOffset)),
    end: dateKey(value),
  };
}

function previousWeekRange(value = new Date()) {
  const day = value.getDay();
  const mondayOffset = day === 0 ? -13 : -6 - day;
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate() + mondayOffset);
  return {
    start: dateKey(start),
    end: dateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)),
  };
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
  const minutes = workMinutes(record);
  if (minutes === null) return '--';
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function workMinutes(record?: AttendanceRecord) {
  if (!record?.clock_in || !record.clock_out || record.status !== 'completed') return null;
  const startedAt = new Date(record.clock_in).getTime();
  const endedAt = new Date(record.clock_out).getTime();
  if (!endedAt || Number.isNaN(startedAt) || Number.isNaN(endedAt)) return null;
  return Math.max(0, Math.floor((endedAt - startedAt) / 60_000));
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

function exportReportCsv(rows: ReportRow[], startDate: string, endDate: string) {
  const escapeCell = (value: string | number | null | undefined) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const heading = [
    'Work date', 'Employee ID', 'Employee', 'Department', 'Status',
    'Clock in', 'Clock out', 'Work hours', 'Office', 'Location status',
  ];
  const data = rows.map((row) => [
    row.attendance.work_date,
    row.profile.employee_id,
    row.profile.full_name,
    row.profile.department || '',
    statusLabel[row.attendance.status] || row.attendance.status,
    formatTime(row.attendance.clock_in),
    formatTime(row.attendance.clock_out),
    workHours(row.attendance),
    row.officeName || '',
    locationStatusLabel(row.attendance.clock_in_location_status),
  ]);
  const csv = [[reportTitle(startDate, endDate)], [], heading, ...data].map((line) => line.map(escapeCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `workpulse_attendance_${startDate}_to_${endDate}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function exportReportPdf(rows: ReportRow[], startDate: string, endDate: string) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;
  const document = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  document.setFontSize(16);
  document.setTextColor(16, 33, 61);
  document.text(reportTitle(startDate, endDate), 40, 42);
  document.setFontSize(9);
  document.setTextColor(78, 93, 117);
  document.text(`${rows.length} attendance record${rows.length === 1 ? '' : 's'}`, 40, 59);
  autoTable(document, {
    startY: 78,
    head: [['Date', 'Employee', 'Department', 'Status', 'Clock in', 'Clock out', 'Completed hours', 'Office']],
    body: rows.map((row) => [
      displayDate(row.attendance.work_date),
      `${row.profile.full_name}\n${row.profile.employee_id}`,
      row.profile.department || 'Unassigned',
      statusLabel[row.attendance.status] || row.attendance.status,
      formatTime(row.attendance.clock_in),
      formatTime(row.attendance.clock_out),
      workHours(row.attendance),
      row.officeName || 'No office',
    ]),
    styles: { fontSize: 8, cellPadding: 6, textColor: [48, 64, 88] },
    headStyles: { fillColor: [16, 94, 66], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 250, 248] },
    margin: { left: 40, right: 40 },
  });
  document.save(`workpulse_attendance_${startDate}_to_${endDate}.pdf`);
}

function reportTitle(startDate: string, endDate: string) {
  return `WorkPulse Attendance Report: ${displayDate(startDate)} - ${displayDate(endDate)}`;
}

function employeePickerLabel(profile: Profile) {
  return [profile.full_name, profile.employee_id, profile.job_title].filter(Boolean).join(' | ');
}

function reportFileStem(profile: Profile, startDate: string, endDate: string) {
  const name = profile.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `workpulse_attendance_${name}_${startDate}_to_${endDate}`;
}

function employeeReportRows(rows: ReportRow[]) {
  return rows.map((row) => [
    displayDate(row.attendance.work_date),
    statusLabel[row.attendance.status] || row.attendance.status,
    formatTime(row.attendance.clock_in),
    formatTime(row.attendance.clock_out),
    workHours(row.attendance),
    row.officeName || 'No office',
  ]);
}

async function exportEmployeeReportXlsx(profile: Profile, rows: ReportRow[], startDate: string, endDate: string) {
  const XLSX = await import('xlsx');
  const heading = reportTitle(startDate, endDate);
  const worksheet = XLSX.utils.aoa_to_sheet([
    [heading],
    [`Employee: ${profile.full_name} (${profile.employee_id})`],
    [`Department: ${profile.department || 'Unassigned'}`],
    [],
    ['Date', 'Status', 'Clock In', 'Clock Out', 'Completed Hours', 'Office'],
    ...employeeReportRows(rows),
  ]);
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 5 } },
  ];
  worksheet['!cols'] = [
    { wch: 31 }, { wch: 22 }, { wch: 13 }, { wch: 13 }, { wch: 19 }, { wch: 29 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance');
  XLSX.writeFile(workbook, `${reportFileStem(profile, startDate, endDate)}.xlsx`);
}

async function exportEmployeeReportPdf(profile: Profile, rows: ReportRow[], startDate: string, endDate: string) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;
  const document = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  document.setFontSize(16);
  document.text(reportTitle(startDate, endDate), 40, 44);
  document.setFontSize(10);
  document.setTextColor(78, 93, 117);
  document.text(`Employee: ${profile.full_name} (${profile.employee_id})`, 40, 65);
  document.text(`Department: ${profile.department || 'Unassigned'}`, 40, 81);
  autoTable(document, {
    startY: 101,
    head: [['Date', 'Status', 'Clock In', 'Clock Out', 'Completed Hours', 'Office']],
    body: employeeReportRows(rows),
    styles: { fontSize: 8, cellPadding: 6, textColor: [36, 51, 77] },
    headStyles: { fillColor: [19, 137, 74], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 248, 246] },
    margin: { left: 40, right: 40 },
  });
  document.save(`${reportFileStem(profile, startDate, endDate)}.pdf`);
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
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportScope, setReportScope] = useState<ReportScope>('team');
  const [reportStartDate, setReportStartDate] = useState(startOfMonthKey());
  const [reportEndDate, setReportEndDate] = useState(dateKey());
  const [reportDatePreset, setReportDatePreset] = useState<ReportDatePreset>('this_month');
  const [reportStatusFilter, setReportStatusFilter] = useState<ReportStatusFilter>('all');
  const [reportDepartmentFilter, setReportDepartmentFilter] = useState('all');
  const [reportEmployeeFilter, setReportEmployeeFilter] = useState('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [organisationProfiles, setOrganisationProfiles] = useState<Profile[]>([]);
  const [organisationDepartments, setOrganisationDepartments] = useState<Department[]>([]);
  const [organisationJobTitles, setOrganisationJobTitles] = useState<JobTitle[]>([]);
  const [organisationOffices, setOrganisationOffices] = useState<Office[]>([]);
  const [organisationLoading, setOrganisationLoading] = useState(false);
  const [organisationError, setOrganisationError] = useState<string | null>(null);

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
        setReportRows([]);
        setReportError(null);
        setOrganisationProfiles([]);
        setOrganisationDepartments([]);
        setOrganisationJobTitles([]);
        setOrganisationOffices([]);
        setOrganisationError(null);
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

  useEffect(() => {
    if (!session?.user || !supabase || activeView !== 'reports' || !profile) return;
    void loadReportData();
  // Report range, scope, and role changes intentionally refresh the report data.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, profile?.id, reportEndDate, reportScope, reportStartDate, roles.join('|'), session?.user.id]);

  useEffect(() => {
    const canManageOrganisation = roles.some((role) => role === 'hr' || role === 'admin');
    if (!session?.user || !supabase || activeView !== 'organisation' || !canManageOrganisation) return;
    void loadOrganisationData();
  // Organisation data is fetched only when this desktop workspace is opened.
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

  async function loadReportData() {
    if (!supabase || !session?.user || !profile) return;
    if (reportStartDate > reportEndDate) {
      setReportRows([]);
      setReportError('Start date must be on or before end date.');
      return;
    }

    setReportLoading(true);
    setReportError(null);
    try {
      const canReviewTeam = roles.some((role) => role === 'supervisor' || role === 'hr' || role === 'admin');
      const hasOrganisationScope = roles.some((role) => role === 'hr' || role === 'admin');
      const shouldLoadTeam = reportScope === 'team' && canReviewTeam;
      let profiles: Profile[] = [];

      if (!shouldLoadTeam) {
        profiles = [profile];
      } else if (hasOrganisationScope) {
        const { data, error: profilesError } = await supabase
          .from('profiles')
          .select('id, employee_id, full_name, email, role, department, job_title, is_active')
          .eq('is_active', true)
          .order('full_name');
        if (profilesError) throw profilesError;
        profiles = (data || []) as Profile[];
      } else {
        const { data: assignments, error: assignmentsError } = await supabase
          .from('employee_supervisor_assignments')
          .select('employee_id')
          .eq('supervisor_id', session.user.id)
          .eq('is_active', true)
          .eq('is_primary', true);
        if (assignmentsError) throw assignmentsError;

        const employeeIds = (assignments || []).map((item) => item.employee_id);
        if (employeeIds.length) {
          const { data, error: profilesError } = await supabase
            .from('profiles')
            .select('id, employee_id, full_name, email, role, department, job_title, is_active')
            .in('id', employeeIds)
            .eq('is_active', true)
            .order('full_name');
          if (profilesError) throw profilesError;
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
              .gte('work_date', reportStartDate)
              .lte('work_date', reportEndDate)
              .in('user_id', visibleIds)
              .order('work_date', { ascending: false })
              .order('clock_in', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        supabase.from('office_locations').select('id, office_name').eq('is_active', true),
      ]);
      if (attendanceResponse.error) throw attendanceResponse.error;
      if (officeResponse.error) throw officeResponse.error;

      const profilesById = new Map(profiles.map((person) => [person.id, person]));
      const officeNames = new Map((officeResponse.data || []).map((office: Office) => [office.id, office.office_name]));
      const rows = (attendanceResponse.data || []).flatMap((record): ReportRow[] => {
        const attendance = record as unknown as AttendanceRecord;
        const employee = profilesById.get(attendance.user_id);
        if (!employee) return [];
        const officeName = officeNames.get(
          attendance.clock_in_verified_office_location_id || attendance.clock_in_nearest_office_location_id || '',
        );
        return [{ profile: employee, attendance, officeName }];
      });
      setReportRows(rows);
    } catch (caught) {
      setReportError(caught instanceof Error ? caught.message : 'WorkPulse could not load the report data.');
    } finally {
      setReportLoading(false);
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

  async function loadOrganisationData() {
    if (!supabase || !session?.user) return;
    setOrganisationLoading(true);
    setOrganisationError(null);
    try {
      const [profilesResponse, departmentsResponse, jobTitlesResponse, officesResponse] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, employee_id, full_name, email, role, department, job_title, is_active')
          .order('full_name'),
        supabase.from('departments').select('id, name, is_active').order('name'),
        supabase.from('job_titles').select('id, name, is_active').order('name'),
        supabase
          .from('office_locations')
          .select('id, office_name, province, district, radius_m, is_active')
          .order('office_name'),
      ]);
      if (profilesResponse.error) throw profilesResponse.error;
      if (departmentsResponse.error) throw departmentsResponse.error;
      if (jobTitlesResponse.error) throw jobTitlesResponse.error;
      if (officesResponse.error) throw officesResponse.error;

      setOrganisationProfiles((profilesResponse.data || []) as Profile[]);
      setOrganisationDepartments((departmentsResponse.data || []) as Department[]);
      setOrganisationJobTitles((jobTitlesResponse.data || []) as JobTitle[]);
      setOrganisationOffices((officesResponse.data || []) as Office[]);
    } catch (caught) {
      setOrganisationError(caught instanceof Error ? caught.message : 'WorkPulse could not load organisation data.');
    } finally {
      setOrganisationLoading(false);
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

  const reportDepartments = useMemo(() => {
    return [...new Set(reportRows.map((row) => row.profile.department).filter(Boolean) as string[])].sort();
  }, [reportRows]);

  const reportEmployees = useMemo(() => {
    const byId = new Map<string, Profile>();
    reportRows.forEach((row) => {
      if (reportDepartmentFilter === 'all' || row.profile.department === reportDepartmentFilter) {
        byId.set(row.profile.id, row.profile);
      }
    });
    return [...byId.values()].sort((left, right) => left.full_name.localeCompare(right.full_name));
  }, [reportDepartmentFilter, reportRows]);

  const filteredReportRows = useMemo(() => {
    return reportRows.filter((row) => {
      const status = row.attendance.status;
      const matchesStatus = reportStatusFilter === 'all'
        || reportStatusFilter === status
        || (reportStatusFilter === 'exception' && ['missed_punch', 'correction_pending'].includes(status))
        || (reportStatusFilter === 'leave' && ['on_leave', 'leave_pending'].includes(status));
      const matchesDepartment = reportDepartmentFilter === 'all' || row.profile.department === reportDepartmentFilter;
      const matchesEmployee = reportEmployeeFilter === 'all' || row.profile.id === reportEmployeeFilter;
      return matchesStatus && matchesDepartment && matchesEmployee;
    });
  }, [reportDepartmentFilter, reportEmployeeFilter, reportRows, reportStatusFilter]);

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
            {sidebarCollapsed ? '>' : '<'}
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Portal navigation">
          <NavItem active={activeView === 'attendance'} icon={<GridIcon />} label="Attendance" onClick={() => setActiveView('attendance')} />
          {canReview && <NavItem active={activeView === 'approvals'} icon={<ClipboardIcon />} label="Approvals" onClick={() => setActiveView('approvals')} />}
          <NavItem active={activeView === 'reports'} icon={<ChartIcon />} label="Reports" onClick={() => setActiveView('reports')} />
          {canManageOrganisation && <NavItem active={activeView === 'organisation'} icon={<SettingsIcon />} label="Organisation" onClick={() => setActiveView('organisation')} />}
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
        ) : activeView === 'reports' ? (
          <ReportsWorkspace
            rows={filteredReportRows}
            loading={reportLoading}
            error={reportError}
            canReview={canReview}
            scope={canReview ? reportScope : 'mine'}
            onScope={setReportScope}
            startDate={reportStartDate}
            endDate={reportEndDate}
            onStartDate={setReportStartDate}
            onEndDate={setReportEndDate}
            datePreset={reportDatePreset}
            onDatePreset={setReportDatePreset}
            statusFilter={reportStatusFilter}
            onStatusFilter={setReportStatusFilter}
            departmentFilter={reportDepartmentFilter}
            onDepartmentFilter={(department) => {
              setReportDepartmentFilter(department);
              setReportEmployeeFilter('all');
            }}
            departments={reportDepartments}
            employeeFilter={reportEmployeeFilter}
            onEmployeeFilter={setReportEmployeeFilter}
            employees={reportEmployees}
          />
        ) : <OrganisationWorkspace
          profiles={organisationProfiles}
          departments={organisationDepartments}
          jobTitles={organisationJobTitles}
          offices={organisationOffices}
          loading={organisationLoading}
          error={organisationError}
        />}
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

type ReportsWorkspaceProps = {
  rows: ReportRow[];
  loading: boolean;
  error: string | null;
  canReview: boolean;
  scope: ReportScope;
  onScope: (scope: ReportScope) => void;
  startDate: string;
  endDate: string;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  datePreset: ReportDatePreset;
  onDatePreset: (value: ReportDatePreset) => void;
  statusFilter: ReportStatusFilter;
  onStatusFilter: (value: ReportStatusFilter) => void;
  departmentFilter: string;
  onDepartmentFilter: (value: string) => void;
  departments: string[];
  employeeFilter: string;
  onEmployeeFilter: (value: string) => void;
  employees: Profile[];
};

function ReportsWorkspace({
  rows,
  loading,
  error,
  canReview,
  scope,
  onScope,
  startDate,
  endDate,
  onStartDate,
  onEndDate,
  datePreset,
  onDatePreset,
  statusFilter,
  onStatusFilter,
  departmentFilter,
  onDepartmentFilter,
  departments,
  employeeFilter,
  onEmployeeFilter,
  employees,
}: ReportsWorkspaceProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  const reportMetrics = useMemo(() => {
    const completed = rows.filter((row) => row.attendance.status === 'completed');
    const workedMinutes = completed.reduce((total, row) => total + (workMinutes(row.attendance) || 0), 0);
    return {
      records: rows.length,
      completed: completed.length,
      exceptions: rows.filter((row) => ['missed_punch', 'correction_pending'].includes(row.attendance.status)).length,
      absent: rows.filter((row) => row.attendance.status === 'absent').length,
      leave: rows.filter((row) => ['on_leave', 'leave_pending'].includes(row.attendance.status)).length,
      hours: `${Math.floor(workedMinutes / 60)}h ${workedMinutes % 60}m`,
    };
  }, [rows]);

  useEffect(() => {
    setCurrentPage(1);
    setExpandedRecordId(null);
  }, [startDate, endDate, statusFilter, departmentFilter, employeeFilter, scope]);

  const selectedEmployee = employees.find((employee) => employee.id === employeeFilter);

  useEffect(() => {
    setEmployeeQuery(selectedEmployee ? employeePickerLabel(selectedEmployee) : '');
  }, [selectedEmployee]);

  useEffect(() => {
    if (!exportOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [exportOpen]);

  const applyRange = (preset: ReportDatePreset, range: { start: string; end: string }) => {
    onDatePreset(preset);
    onStartDate(range.start);
    onEndDate(range.end);
  };

  const changeDatePreset = (preset: ReportDatePreset) => {
    const today = new Date();
    if (preset === 'custom') {
      onDatePreset(preset);
      return;
    }
    if (preset === 'today') return applyRange(preset, { start: dateKey(today), end: dateKey(today) });
    if (preset === 'yesterday') return applyRange(preset, yesterdayRange(today));
    if (preset === 'this_week') return applyRange(preset, currentWeekRange(today));
    if (preset === 'last_week') return applyRange(preset, previousWeekRange(today));
    if (preset === 'this_month') return applyRange(preset, { start: startOfMonthKey(today), end: dateKey(today) });
    if (preset === 'last_month') return applyRange(preset, previousMonthRange(today));
    return applyRange(preset, lastThirtyDaysRange(today));
  };

  const handleEmployeeInput = (value: string) => {
    setEmployeeQuery(value);
    if (!value || value === 'All employees') {
      onEmployeeFilter('all');
      return;
    }
    const selected = employees.find((employee) => employeePickerLabel(employee) === value);
    onEmployeeFilter(selected?.id || 'all');
  };

  const exportFile = async (format: 'csv' | 'pdf') => {
    setExporting(format);
    try {
      if (format === 'csv') exportReportCsv(rows, startDate, endDate);
      else await exportReportPdf(rows, startDate, endDate);
      setExportOpen(false);
    } finally {
      setExporting(null);
    }
  };

  return <div className="page-content">
    <section className="reports-toolbar">
      <div>
        <p className="eyebrow">ATTENDANCE REPORTS</p>
      </div>
      {canReview && <div className="attendance-scope-tabs report-scope-tabs" role="tablist" aria-label="Report scope">
        <button className={scope === 'mine' ? 'active' : ''} role="tab" aria-selected={scope === 'mine'} onClick={() => onScope('mine')}>My records</button>
        <button className={scope === 'team' ? 'active' : ''} role="tab" aria-selected={scope === 'team'} onClick={() => onScope('team')}>Team records</button>
      </div>}
    </section>

    <section className="register-panel report-panel">
      <div className="report-filter-layout">
        <label className="filter-field report-date-field">Date range<select value={datePreset} onChange={(event) => changeDatePreset(event.target.value as ReportDatePreset)}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this_week">This week</option><option value="last_week">Last week</option><option value="this_month">This month</option><option value="last_month">Last month</option><option value="last_30_days">Last 30 days</option><option value="custom">Custom range</option></select></label>
        <label className="filter-field report-date-field">From<input type="date" value={startDate} max={endDate} onChange={(event) => { onDatePreset('custom'); onStartDate(event.target.value); }} /></label>
        <label className="filter-field report-date-field">To<input type="date" value={endDate} min={startDate} onChange={(event) => { onDatePreset('custom'); onEndDate(event.target.value); }} /></label>
        <div className="report-export-menu" ref={exportMenuRef}>
          <button className="report-export" type="button" disabled={!rows.length || exporting !== null} onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen}><ShareIcon size={18} /> {exporting ? 'Preparing...' : 'Export'}</button>
          {exportOpen && <div className="report-export-options"><button type="button" disabled={exporting !== null} onClick={() => void exportFile('csv')}>Export CSV</button><button type="button" disabled={exporting !== null} onClick={() => void exportFile('pdf')}>Export PDF</button></div>}
        </div>
        <label className="filter-field report-select-field report-status-field">Status<select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value as ReportStatusFilter)}><option value="all">All statuses</option><option value="completed">Completed</option><option value="on_duty">On duty</option><option value="exception">Exceptions</option><option value="absent">No clock in</option><option value="leave">On leave</option></select></label>
        <label className="filter-field report-select-field report-department-field">Department<select value={departmentFilter} onChange={(event) => onDepartmentFilter(event.target.value)}><option value="all">All departments</option>{departments.map((department) => <option key={department} value={department}>{department}</option>)}</select></label>
        <label className="filter-field report-select-field employee-filter">Employee<span className="employee-input-wrap"><input list="report-employee-options" value={employeeQuery} onChange={(event) => handleEmployeeInput(event.target.value)} onBlur={() => { if (employeeQuery && !employees.some((employee) => employeePickerLabel(employee) === employeeQuery)) setEmployeeQuery(selectedEmployee ? employeePickerLabel(selectedEmployee) : ''); }} placeholder="All employees" />{employeeQuery && <button className="employee-filter-clear" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setEmployeeQuery(''); onEmployeeFilter('all'); }} aria-label="Clear employee filter" title="Clear employee filter">×</button>}</span><datalist id="report-employee-options"><option value="All employees" />{employees.map((employee) => <option key={employee.id} value={employeePickerLabel(employee)} />)}</datalist></label>
      </div>
      <section className="report-metric-grid">
        <ReportMetric label="Records" value={reportMetrics.records} tone="ink" />
        <ReportMetric label="Completed" value={reportMetrics.completed} tone="green" />
        <ReportMetric label="Exceptions" value={reportMetrics.exceptions} tone="amber" />
        <ReportMetric label="No clock in" value={reportMetrics.absent} tone="red" />
        <ReportMetric label="On leave" value={reportMetrics.leave} tone="purple" />
        <ReportMetric label="Completed hours" value={reportMetrics.hours} tone="blue" />
      </section>
      {loading ? <LoadingState /> : error ? <ErrorState message={error} /> : rows.length === 0 ? <ReportEmptyState /> : <>
        <div className="table-wrap"><table className="report-table"><thead><tr><th>Date</th><th>Employee</th><th>Department</th><th>Status</th><th>Clock in</th><th>Clock out</th><th>Hours</th><th>Office</th><th>Location</th></tr></thead><tbody>{pagedRows.map((row) => <ReportRowItem key={row.attendance.id} row={row} expanded={expandedRecordId === row.attendance.id} onToggle={() => setExpandedRecordId((current) => current === row.attendance.id ? null : row.attendance.id)} />)}</tbody></table></div>
        {rows.length > pageSize && <div className="table-pagination"><span>Page {safePage} of {pageCount}</span><div><button type="button" disabled={safePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>Previous</button><button type="button" disabled={safePage === pageCount} onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))}>Next</button></div></div>}
      </>}
    </section>
  </div>;
}

function ReportMetric({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return <article className={`report-metric ${tone}`}><span>{label}</span><strong>{value}</strong></article>;
}

function ReportRowItem({ row, expanded, onToggle }: { row: ReportRow; expanded: boolean; onToggle: () => void }) {
  const status = row.attendance.status;
  const comment = row.attendance.clock_in_comment || row.attendance.clock_out_comment;
  return <Fragment>
    <tr className="report-row-clickable" tabIndex={0} role="button" aria-expanded={expanded} onClick={onToggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}>
      <td>{displayDate(row.attendance.work_date)}</td>
      <td><div className="employee-cell"><span className="table-avatar">{row.profile.full_name.slice(0, 1)}</span><span><strong>{row.profile.full_name}</strong><small>{row.profile.employee_id}</small></span></div></td>
      <td>{row.profile.department || 'Unassigned'}</td>
      <td><span className={`status ${statusTone(status)}`}>{statusLabel[status] || status}</span></td>
      <td>{formatTime(row.attendance.clock_in)}</td>
      <td>{formatTime(row.attendance.clock_out)}</td>
      <td>{workHours(row.attendance)}</td>
      <td>{row.officeName || 'No office'}</td>
      <td>{locationStatusLabel(row.attendance.clock_in_location_status)}</td>
    </tr>
    {expanded && <tr className="report-inline-detail-row"><td colSpan={9}><div className="report-inline-detail-grid">
      <div><span>Clock-in location</span><strong>{locationStatusLabel(row.attendance.clock_in_location_status)}</strong></div>
      <div><span>Clock-out location</span><strong>{locationStatusLabel(row.attendance.clock_out_location_status)}</strong></div>
      <div><span>Clock-in accuracy</span><strong>{row.attendance.clock_in_accuracy_m ? `${Math.round(row.attendance.clock_in_accuracy_m)} m` : '--'}</strong></div>
      <div><span>Clock-out accuracy</span><strong>{row.attendance.clock_out_accuracy_m ? `${Math.round(row.attendance.clock_out_accuracy_m)} m` : '--'}</strong></div>
      {comment && <div className="report-inline-comment"><span>Attendance comment</span><strong>{comment}</strong></div>}
    </div></td></tr>}
  </Fragment>;
}

function EmployeeReportWorkspace({
  profile,
  rows,
  startDate,
  endDate,
  onBack,
}: {
  profile: Profile;
  rows: ReportRow[];
  startDate: string;
  endDate: string;
  onBack: () => void;
}) {
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);
  const sortedRows = useMemo(() => [...rows].sort((left, right) => left.attendance.work_date.localeCompare(right.attendance.work_date)), [rows]);
  const completedMinutes = sortedRows.reduce((total, row) => total + (workMinutes(row.attendance) || 0), 0);
  const completedCount = sortedRows.filter((row) => row.attendance.status === 'completed').length;

  const exportFile = async (format: 'xlsx' | 'pdf') => {
    setExporting(format);
    try {
      if (format === 'xlsx') await exportEmployeeReportXlsx(profile, sortedRows, startDate, endDate);
      else await exportEmployeeReportPdf(profile, sortedRows, startDate, endDate);
    } finally {
      setExporting(null);
    }
  };

  return <div className="page-content employee-report-view">
    <section className="employee-report-header">
      <div>
        <button type="button" className="back-to-reports" onClick={onBack}>&larr; Back to reports</button>
        <p className="eyebrow">EMPLOYEE ATTENDANCE</p>
        <h2>WorkPulse Attendance Report</h2>
        <p>{displayDate(startDate)} - {displayDate(endDate)}</p>
      </div>
      <div className="employee-report-actions print-hidden">
        <button type="button" className="secondary-button" onClick={() => window.print()}>Print</button>
        <button type="button" className="secondary-button" disabled={exporting !== null} onClick={() => void exportFile('xlsx')}>{exporting === 'xlsx' ? 'Preparing Excel...' : 'Download Excel'}</button>
        <button type="button" className="report-export" disabled={exporting !== null} onClick={() => void exportFile('pdf')}>{exporting === 'pdf' ? 'Preparing PDF...' : 'Download PDF'}</button>
      </div>
    </section>

    <section className="employee-report-profile">
      <div className="employee-report-avatar">{profile.full_name.slice(0, 1)}</div>
      <div><p className="eyebrow">EMPLOYEE</p><h3>{profile.full_name}</h3><p>{profile.employee_id}</p></div>
      <div className="employee-report-meta"><span>Department</span><strong>{profile.department || 'Unassigned'}</strong></div>
      <div className="employee-report-meta"><span>Job title</span><strong>{profile.job_title || 'Not recorded'}</strong></div>
    </section>

    <section className="employee-report-summary">
      <ReportMetric label="Attendance records" value={sortedRows.length} tone="ink" />
      <ReportMetric label="Completed days" value={completedCount} tone="green" />
      <ReportMetric label="Completed hours" value={`${Math.floor(completedMinutes / 60)}h ${completedMinutes % 60}m`} tone="blue" />
      <ReportMetric label="Exceptions" value={sortedRows.filter((row) => ['missed_punch', 'correction_pending'].includes(row.attendance.status)).length} tone="amber" />
    </section>

    <section className="register-panel employee-report-panel">
      <div className="register-head employee-report-head">
        <div><p className="eyebrow">ATTENDANCE RECORDS</p><h2>Daily attendance</h2></div>
        <span>{sortedRows.length} record{sortedRows.length === 1 ? '' : 's'}</span>
      </div>
      {sortedRows.length === 0 ? <ReportEmptyState /> : <div className="table-wrap"><table className="employee-report-table"><thead><tr><th>Date</th><th>Status</th><th>Clock in</th><th>Clock out</th><th>Completed hours</th><th>Office</th><th className="print-hidden"></th></tr></thead><tbody>{sortedRows.map((row) => {
        const isExpanded = expandedRecordId === row.attendance.id;
        const comment = row.attendance.clock_out_comment || row.attendance.clock_in_comment;
        return <Fragment key={row.attendance.id}>
          <tr>
            <td>{displayDate(row.attendance.work_date)}</td>
            <td><span className={`status ${statusTone(row.attendance.status)}`}>{statusLabel[row.attendance.status] || row.attendance.status}</span></td>
            <td>{formatTime(row.attendance.clock_in)}</td>
            <td>{formatTime(row.attendance.clock_out)}</td>
            <td>{workHours(row.attendance)}</td>
            <td>{row.officeName || 'No office'}</td>
            <td className="print-hidden"><button type="button" className="report-details-button" onClick={() => setExpandedRecordId(isExpanded ? null : row.attendance.id)}>{isExpanded ? 'Hide details' : 'View details'}</button></td>
          </tr>
          {isExpanded && <tr className="employee-report-detail-row"><td colSpan={7}>
            <div className="employee-report-detail-grid">
              <div><span>Clock-in location</span><strong>{locationStatusLabel(row.attendance.clock_in_location_status)}</strong></div>
              <div><span>Clock-out location</span><strong>{locationStatusLabel(row.attendance.clock_out_location_status)}</strong></div>
              <div><span>Clock-in distance</span><strong>{distanceLabel(row.attendance.clock_in_distance_m)}</strong></div>
              <div><span>Clock-out distance</span><strong>{distanceLabel(row.attendance.clock_out_distance_m)}</strong></div>
              {comment && <div className="employee-report-comment"><span>Comment</span><strong>{comment}</strong></div>}
            </div>
          </td></tr>}
        </Fragment>;
      })}</tbody></table></div>}
    </section>
  </div>;
}

function ReportEmptyState() { return <div className="state"><strong>No attendance records found</strong><span>Try a broader date range or change the current report filters.</span></div>; }

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

function OrganisationWorkspace({
  profiles,
  departments,
  jobTitles,
  offices,
  loading,
  error,
}: {
  profiles: Profile[];
  departments: Department[];
  jobTitles: JobTitle[];
  offices: Office[];
  loading: boolean;
  error: string | null;
}) {
  const [tab, setTab] = useState<OrganisationTab>('employees');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 10;

  const filteredProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter((person) => [
      person.full_name,
      person.employee_id,
      person.email,
      person.department,
      person.job_title,
      roleLabel[person.role],
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }, [profiles, query]);

  const filteredDepartments = useMemo(() => filterOrganisationItems(departments, query, (item) => [item.name]), [departments, query]);
  const filteredJobTitles = useMemo(() => filterOrganisationItems(jobTitles, query, (item) => [item.name]), [jobTitles, query]);
  const filteredOffices = useMemo(() => filterOrganisationItems(offices, query, (item) => [item.office_name, item.province, item.district]), [offices, query]);
  const selectedItems = tab === 'employees'
    ? filteredProfiles
    : tab === 'departments'
      ? filteredDepartments
      : tab === 'job_titles'
        ? filteredJobTitles
        : filteredOffices;
  const totalPages = Math.max(1, Math.ceil(selectedItems.length / pageSize));
  const visibleItems = selectedItems.slice(page * pageSize, page * pageSize + pageSize);

  useEffect(() => setPage(0), [query, tab]);
  useEffect(() => {
    if (page >= totalPages) setPage(totalPages - 1);
  }, [page, totalPages]);

  const employeeCountForDepartment = (departmentName: string) => profiles.filter((person) => person.department === departmentName).length;
  const employeeCountForTitle = (titleName: string) => profiles.filter((person) => person.job_title === titleName).length;

  return <div className="page-content organisation-page">
    <section className="organisation-hero">
      <div><p className="eyebrow">ORGANISATION</p><h2>People, structure and work sites</h2><p>Review the current WorkPulse organisation setup from one desktop workspace.</p></div>
      <div className="organisation-summary"><span>Active employees</span><strong>{profiles.filter((person) => person.is_active).length}</strong></div>
    </section>
    <section className="metric-grid organisation-metrics">
      <Metric label="Employees" value={profiles.length} tone="blue" />
      <Metric label="Departments" value={departments.filter((department) => department.is_active).length} tone="green" />
      <Metric label="Job titles" value={jobTitles.filter((jobTitle) => jobTitle.is_active).length} tone="purple" />
      <Metric label="Work sites" value={offices.filter((office) => office.is_active !== false).length} tone="amber" />
    </section>
    <section className="register-panel organisation-panel">
      <div className="register-head organisation-head">
        <div><p className="eyebrow">DIRECTORY</p><h2>{organisationTabLabel(tab)}</h2></div>
        <label className="search-box organisation-search"><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={organisationSearchPlaceholder(tab)} aria-label={`Search ${organisationTabLabel(tab).toLowerCase()}`} />{query && <button type="button" className="clear-search" onClick={() => setQuery('')} aria-label="Clear search">x</button>}</label>
      </div>
      <div className="organisation-tabs" role="tablist" aria-label="Organisation data">
        <OrganisationTabButton active={tab === 'employees'} label="Employees" count={profiles.length} onClick={() => setTab('employees')} />
        <OrganisationTabButton active={tab === 'departments'} label="Departments" count={departments.length} onClick={() => setTab('departments')} />
        <OrganisationTabButton active={tab === 'job_titles'} label="Job titles" count={jobTitles.length} onClick={() => setTab('job_titles')} />
        <OrganisationTabButton active={tab === 'offices'} label="Office locations" count={offices.length} onClick={() => setTab('offices')} />
      </div>
      {loading ? <OrganisationLoadingState /> : error ? <OrganisationErrorState message={error} /> : <>
        <div className="table-wrap organisation-table-wrap">
          {tab === 'employees' ? <table><thead><tr><th>Employee</th><th>Department</th><th>Job title</th><th>Access</th><th>Account</th></tr></thead><tbody>{(visibleItems as Profile[]).map((person) => <tr key={person.id}><td><div className="employee-cell"><span className="table-avatar">{person.full_name.slice(0, 1)}</span><span><strong>{person.full_name}</strong><small>{person.employee_id} / {person.email}</small></span></div></td><td>{person.department || 'Unassigned'}</td><td>{person.job_title || 'Not assigned'}</td><td>{roleLabel[person.role]}</td><td><span className={`status ${person.is_active ? 'green' : 'slate'}`}>{person.is_active ? 'Active' : 'Inactive'}</span></td></tr>)}</tbody></table> : null}
          {tab === 'departments' ? <table><thead><tr><th>Department</th><th>Employees</th><th>Status</th></tr></thead><tbody>{(visibleItems as Department[]).map((department) => <tr key={department.id}><td><strong>{department.name}</strong></td><td>{employeeCountForDepartment(department.name)}</td><td><span className={`status ${department.is_active ? 'green' : 'slate'}`}>{department.is_active ? 'Active' : 'Inactive'}</span></td></tr>)}</tbody></table> : null}
          {tab === 'job_titles' ? <table><thead><tr><th>Job title</th><th>Employees</th><th>Status</th></tr></thead><tbody>{(visibleItems as JobTitle[]).map((jobTitle) => <tr key={jobTitle.id}><td><strong>{jobTitle.name}</strong></td><td>{employeeCountForTitle(jobTitle.name)}</td><td><span className={`status ${jobTitle.is_active ? 'green' : 'slate'}`}>{jobTitle.is_active ? 'Active' : 'Inactive'}</span></td></tr>)}</tbody></table> : null}
          {tab === 'offices' ? <table><thead><tr><th>Office location</th><th>Province</th><th>District</th><th>Allowed radius</th><th>Status</th></tr></thead><tbody>{(visibleItems as Office[]).map((office) => <tr key={office.id}><td><strong>{office.office_name}</strong></td><td>{office.province || '--'}</td><td>{office.district || '--'}</td><td>{office.radius_m ? `${Math.round(office.radius_m)} m` : '--'}</td><td><span className={`status ${office.is_active === false ? 'slate' : 'green'}`}>{office.is_active === false ? 'Inactive' : 'Active'}</span></td></tr>)}</tbody></table> : null}
        </div>
        {selectedItems.length === 0 ? <div className="state organisation-empty"><strong>No {organisationTabLabel(tab).toLowerCase()} found</strong><span>Try a different search term.</span></div> : <div className="table-pagination"><span>{selectedItems.length} {organisationTabLabel(tab).toLowerCase()}</span><div><button type="button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button><span>Page {page + 1} of {totalPages}</span><button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}>Next</button></div></div>}
      </>}
    </section>
  </div>;
}

function filterOrganisationItems<T>(items: T[], query: string, values: (item: T) => Array<string | null | undefined>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => values(item).filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
}

function organisationTabLabel(tab: OrganisationTab) {
  return ({ employees: 'Employees', departments: 'Departments', job_titles: 'Job titles', offices: 'Office locations' })[tab];
}

function organisationSearchPlaceholder(tab: OrganisationTab) {
  return ({ employees: 'Search name, ID, email, department or job title', departments: 'Search departments', job_titles: 'Search job titles', offices: 'Search office, province or district' })[tab];
}

function OrganisationTabButton({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return <button type="button" className={`organisation-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active} onClick={onClick}>{label}<span>{count}</span></button>;
}

function OrganisationLoadingState() { return <div className="state"><div className="loader" /><strong>Loading organisation data</strong><span>Applying your HR and administrator access.</span></div>; }
function OrganisationErrorState({ message }: { message: string }) { return <div className="state error"><strong>Unable to load organisation data</strong><span>{message}</span></div>; }

function viewTitle(view: PortalView) {
  return ({ attendance: 'Attendance', approvals: 'Approvals', reports: 'Reports', organisation: 'Organisation' })[view];
}

function LoginScreen({ email, password, error, signingIn, onEmail, onPassword, onSubmit }: { email: string; password: string; error: string | null; signingIn: boolean; onEmail: (value: string) => void; onPassword: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return <main className="login-page"><section className="login-identity"><div className="brand-lockup"><img className="brand-icon" src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></div><p className="eyebrow">SUPERVISION, NOT SPREADSHEETS</p><h1>Attendance control for the people who manage teams.</h1><p>Use the same WorkPulse account as the mobile app. Your browser access is limited to the role and team scope assigned to you.</p><div className="login-note"><MarkIcon size={22} /> Shared Supabase authentication. No separate web password required.</div></section><section className="login-card"><p className="eyebrow">SECURE SIGN IN</p><h2>Welcome to the portal</h2><p>Sign in to review attendance and approvals from your desktop.</p><form onSubmit={onSubmit}><label>Work email<input type="email" autoComplete="email" value={email} onChange={(event) => onEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} required /></label>{error && <p className="login-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={signingIn}>{signingIn ? 'Signing in...' : 'Sign in to WorkPulse'} <ArrowIcon /></button></form></section></main>;
}

function ConfigurationNotice() {
  return <main className="config-page"><div className="config-card"><div className="brand-lockup"><img className="brand-icon" src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></div><h1>Portal configuration required</h1><p>Create `workpulse-web/.env.local` from `.env.local.example`, then add the existing WorkPulse Supabase URL and publishable key.</p></div></main>;
}
