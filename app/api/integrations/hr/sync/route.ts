import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Ref = { source_id: number; code: string | null; name: string; is_active?: boolean } | null;
type HrEmployee = {
  source_id: number; employee_no: string; first_name: string; last_name: string; full_name: string;
  work_email: string | null; hire_date: string | null; termination_date: string | null; is_archived: boolean;
  department: Ref; job_title: Ref; facility: Ref; employment_status: Ref;
  supervisor: { source_id: number; employee_no: string } | null; updated_at: string | null;
};

function isActiveEmployee(employee: HrEmployee) {
  const status = employee.employment_status?.code?.trim().toUpperCase();
  return !employee.is_archived && !employee.termination_date && (!status || status === 'ACTIVE');
}

async function syncReferenceData(
  admin: SupabaseClient<any, 'public', any>,
  table: 'departments' | 'job_titles',
  references: Array<NonNullable<Ref>>,
) {
  const unique = [...new Map(references.map((reference) => [reference.source_id, reference])).values()];
  const { data: rows, error: readError } = await admin.from(table).select('id,name,hr_source_id');
  if (readError) throw readError;
  const existing = (rows || []) as Array<{ id: string; name: string; hr_source_id: number | null }>;
  for (const reference of unique) {
    const match = (existing || []).find((row) => row.hr_source_id === reference.source_id)
      || (existing || []).find((row) => String(row.name).trim().toLowerCase() === reference.name.trim().toLowerCase());
    const values = {
      name: reference.name,
      is_active: reference.is_active !== false,
      hr_source_id: reference.source_id,
      hr_code: reference.code,
    };
    const result = match
      ? await admin.from(table).update(values).eq('id', match.id)
      : await admin.from(table).insert(values);
    if (result.error) throw result.error;
  }
  return unique.length;
}

function config() {
  const values = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    hrUrl: process.env.HR_SYSTEM_BASE_URL?.replace(/\/$/, ''),
    hrToken: process.env.HR_SYSTEM_SYNC_TOKEN,
  };
  if (Object.values(values).some((value) => !value)) throw new Error('HR integration environment variables are incomplete.');
  return values as Record<keyof typeof values, string>;
}

export async function POST(request: NextRequest) {
  let runId: string | null = null;
  try {
    const env = config();
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
    const userClient = createClient(env.supabaseUrl, env.anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const [{ data: auth, error: authError }, { data: roles, error: rolesError }] = await Promise.all([userClient.auth.getUser(authorization.slice(7)), userClient.rpc('current_user_roles')]);
    if (authError || rolesError || !auth.user) return NextResponse.json({ message: 'Invalid WorkPulse session.' }, { status: 401 });
    if (!((roles as string[] | null) || []).some((role) => role === 'admin' || role === 'hr')) return NextResponse.json({ message: 'HR or administrator access required.' }, { status: 403 });

    const admin = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: run, error: runError } = await admin.from('hr_directory_sync_runs').insert({ initiated_by: auth.user.id }).select('id').single();
    if (runError) throw runError;
    runId = run.id;

    const employees: HrEmployee[] = [];
    let page = 1, lastPage = 1;
    do {
      const response = await fetch(`${env.hrUrl}/api/integrations/workpulse/directory?per_page=200&page=${page}`, { headers: { Authorization: `Bearer ${env.hrToken}`, Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`HR directory returned HTTP ${response.status}.`);
      const payload = await response.json() as { data: HrEmployee[]; meta: { last_page: number } };
      employees.push(...payload.data); lastPage = payload.meta.last_page; page += 1;
    } while (page <= lastPage);

    const departmentsSynced = await syncReferenceData(admin, 'departments', employees.flatMap((employee) => employee.department ? [employee.department] : []));
    const jobTitlesSynced = await syncReferenceData(admin, 'job_titles', employees.flatMap((employee) => employee.job_title ? [employee.job_title] : []));

    const rows = employees.map((e) => ({
      source_id:e.source_id, employee_no:e.employee_no, first_name:e.first_name, last_name:e.last_name, full_name:e.full_name,
      work_email:e.work_email, hire_date:e.hire_date, termination_date:e.termination_date,
      department_source_id:e.department?.source_id, department_code:e.department?.code, department_name:e.department?.name,
      job_title_source_id:e.job_title?.source_id, job_title_code:e.job_title?.code, job_title_name:e.job_title?.name,
      facility_source_id:e.facility?.source_id, facility_code:e.facility?.code, facility_name:e.facility?.name,
      employment_status_source_id:e.employment_status?.source_id, employment_status_code:e.employment_status?.code, employment_status_name:e.employment_status?.name,
      supervisor_source_id:e.supervisor?.source_id, supervisor_employee_no:e.supervisor?.employee_no,
      is_active:isActiveEmployee(e), source_updated_at:e.updated_at, synced_at:new Date().toISOString(),
    }));
    if (rows.length) { const { error } = await admin.from('hr_directory_employees').upsert(rows, { onConflict:'source_id' }); if (error) throw error; }

    const { data: profiles, error: profilesError } = await admin.from('profiles').select('id,employee_id,email,hr_employee_source_id');
    if (profilesError) throw profilesError;
    const linked = new Map<number,string>();
    for (const profile of profiles || []) {
      const employee = employees.find((e) => e.source_id === profile.hr_employee_source_id || e.employee_no.toLowerCase() === String(profile.employee_id || '').toLowerCase() || Boolean(e.work_email && e.work_email.toLowerCase() === String(profile.email || '').toLowerCase()));
      if (!employee) continue;
      const { error } = await admin.from('profiles').update({ hr_employee_source_id:employee.source_id, employee_id:employee.employee_no, full_name:employee.full_name, email:employee.work_email || profile.email, department:employee.department?.name || null, job_title:employee.job_title?.name || null, is_active:isActiveEmployee(employee) }).eq('id',profile.id);
      if (error) throw error;
      linked.set(employee.source_id, profile.id);
    }

    let assignments = 0;
    for (const employee of employees) {
      const employeeId = linked.get(employee.source_id), supervisorId = employee.supervisor ? linked.get(employee.supervisor.source_id) : undefined;
      if (!employeeId) continue;
      const { error: deactivateError } = await admin.from('employee_supervisor_assignments').update({ is_active:false }).eq('employee_id',employeeId).eq('is_primary',true);
      if (deactivateError) throw deactivateError;
      if (!supervisorId || supervisorId === employeeId) continue;
      const { data: existing, error: existingError } = await admin.from('employee_supervisor_assignments').select('id').eq('employee_id',employeeId).eq('supervisor_id',supervisorId).maybeSingle();
      if (existingError) throw existingError;
      const result = existing
        ? await admin.from('employee_supervisor_assignments').update({ is_primary:true, is_active:true }).eq('id',existing.id)
        : await admin.from('employee_supervisor_assignments').insert({ employee_id:employeeId, supervisor_id:supervisorId, is_primary:true, is_active:true });
      const { error } = result;
      if (error) throw error;
      assignments += 1;
    }

    await admin.from('hr_directory_sync_runs').update({ status:'completed', completed_at:new Date().toISOString(), received_count:employees.length, linked_profile_count:linked.size, supervisor_assignment_count:assignments }).eq('id',runId);
    const activeEmployees = employees.filter(isActiveEmployee);
    const activeUnlinked = activeEmployees.filter((employee) => !linked.has(employee.source_id)).length;
    return NextResponse.json({
      received: employees.length,
      active_employees: activeEmployees.length,
      inactive_employees: employees.length - activeEmployees.length,
      linked_profiles: linked.size,
      supervisor_assignments: assignments,
      unlinked_employees: employees.length - linked.size,
      active_unlinked_employees: activeUnlinked,
      departments_synced: departmentsSynced,
      job_titles_synced: jobTitlesSynced,
    });
  } catch (error) {
    if (runId) try { const env=config(); await createClient(env.supabaseUrl,env.serviceKey).from('hr_directory_sync_runs').update({ status:'failed',completed_at:new Date().toISOString(),error_message:error instanceof Error?error.message:'Unknown sync error' }).eq('id',runId); } catch { /* keep original error */ }
    return NextResponse.json({ message:error instanceof Error?error.message:'HR directory sync failed.' },{ status:500 });
  }
}
