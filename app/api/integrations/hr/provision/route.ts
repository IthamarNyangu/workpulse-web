import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type ProvisionRequest = {
  employee_source_id?: number;
  action?: 'validate' | 'invite';
};

function environment() {
  const values = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    integrationToken: process.env.HR_SYSTEM_SYNC_TOKEN,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  };
  if (!values.supabaseUrl || !values.serviceKey || !values.integrationToken) {
    throw new Error('WorkPulse onboarding environment variables are incomplete.');
  }
  return values as Record<keyof typeof values, string>;
}

function authorized(request: NextRequest, expected: string) {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function GET(request: NextRequest) {
  try {
    const env = environment();
    if (!authorized(request, env.integrationToken)) {
      return NextResponse.json({ message: 'Invalid HR integration token.' }, { status: 401 });
    }
    const sourceId = Number(request.nextUrl.searchParams.get('employee_source_id'));
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return NextResponse.json({ message: 'A valid employee_source_id is required.' }, { status: 422 });
    }

    const admin = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const [{ data: employee, error: employeeError }, { data: profile, error: profileError }, { data: latestEvent, error: eventError }] = await Promise.all([
      admin.from('hr_directory_employees').select('source_id,employee_no,full_name,work_email,is_active').eq('source_id', sourceId).maybeSingle(),
      admin.from('profiles').select('id,email,is_active').eq('hr_employee_source_id', sourceId).maybeSingle(),
      admin.from('workpulse_onboarding_events').select('action,details,created_at').eq('hr_employee_source_id', sourceId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (employeeError || profileError || eventError) throw employeeError || profileError || eventError;
    if (!employee) return NextResponse.json({ message: 'Employee has not been synchronized from HR.' }, { status: 404 });

    let status = employee.is_active ? 'not_enabled' : 'ineligible';
    let lastSignInAt: string | null = null;
    if (profile) {
      const { data: authUser, error: authError } = await admin.auth.admin.getUserById(profile.id);
      if (authError) throw authError;
      lastSignInAt = authUser.user?.last_sign_in_at || null;
      status = !profile.is_active ? 'deactivated' : lastSignInAt ? 'active' : 'invitation_pending';
    } else if (latestEvent?.action === 'invite_failed') {
      status = 'invitation_failed';
    } else if (latestEvent?.action === 'validated') {
      status = 'ready';
    }

    return NextResponse.json({
      status,
      employee_source_id: sourceId,
      profile_id: profile?.id || null,
      account_email: profile?.email || null,
      last_sign_in_at: lastSignInAt,
      latest_event: latestEvent || null,
    });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'WorkPulse account status could not be loaded.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const env = environment();
    if (!authorized(request, env.integrationToken)) {
      return NextResponse.json({ message: 'Invalid HR integration token.' }, { status: 401 });
    }

    const body = await request.json() as ProvisionRequest;
    const sourceId = Number(body.employee_source_id);
    const action = body.action || 'validate';
    if (!Number.isInteger(sourceId) || sourceId <= 0 || !['validate', 'invite'].includes(action)) {
      return NextResponse.json({ message: 'A valid employee_source_id and action are required.' }, { status: 422 });
    }

    const admin = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: employee, error: employeeError } = await admin
      .from('hr_directory_employees')
      .select('source_id,employee_no,full_name,work_email,department_name,job_title_name,is_active')
      .eq('source_id', sourceId)
      .maybeSingle();
    if (employeeError) throw employeeError;
    if (!employee) return NextResponse.json({ message: 'Employee has not been synchronized from HR.' }, { status: 404 });

    const missing: string[] = [];
    if (!employee.is_active) missing.push('active employment status');
    if (!employee.employee_no?.trim()) missing.push('employee number');
    if (!employee.full_name?.trim()) missing.push('employee name');
    if (!employee.work_email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.work_email)) missing.push('valid work email');
    if (!employee.department_name?.trim()) missing.push('department');
    if (!employee.job_title_name?.trim()) missing.push('job title');

    const { data: sourceProfile, error: sourceProfileError } = await admin
      .from('profiles')
      .select('id,email,employee_id,is_active')
      .eq('hr_employee_source_id', sourceId)
      .maybeSingle();
    if (sourceProfileError) throw sourceProfileError;
    const employeeNumberLookup = sourceProfile ? { data: null, error: null } : await admin
      .from('profiles').select('id,email,employee_id,is_active').ilike('employee_id', employee.employee_no).limit(1).maybeSingle();
    if (employeeNumberLookup.error) throw employeeNumberLookup.error;
    const emailLookup = sourceProfile || employeeNumberLookup.data || !employee.work_email ? { data: null, error: null } : await admin
      .from('profiles').select('id,email,employee_id,is_active').ilike('email', employee.work_email).limit(1).maybeSingle();
    if (emailLookup.error) throw emailLookup.error;
    const existingProfile = sourceProfile || employeeNumberLookup.data || emailLookup.data;
    if (existingProfile) {
      return NextResponse.json({ ready: false, existing_account: true, profile_id: existingProfile.id, message: 'This employee already has a WorkPulse account.' }, { status: 409 });
    }

    if (missing.length) {
      await admin.from('workpulse_onboarding_events').insert({ hr_employee_source_id: sourceId, employee_no: employee.employee_no, work_email: employee.work_email, action: 'validation_failed', details: { missing } });
      return NextResponse.json({ ready: false, missing, message: `Complete the following HR information: ${missing.join(', ')}.` }, { status: 422 });
    }

    if (action === 'validate') {
      await admin.from('workpulse_onboarding_events').insert({ hr_employee_source_id: sourceId, employee_no: employee.employee_no, work_email: employee.work_email, action: 'validated' });
      return NextResponse.json({ ready: true, employee: { source_id: sourceId, employee_no: employee.employee_no, full_name: employee.full_name, work_email: employee.work_email }, message: 'Employee is ready for WorkPulse onboarding.' });
    }

    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(employee.work_email, {
      redirectTo: env.appUrl,
      data: { full_name: employee.full_name, employee_id: employee.employee_no, hr_employee_source_id: sourceId },
    });
    if (inviteError || !invitation.user) {
      await admin.from('workpulse_onboarding_events').insert({ hr_employee_source_id: sourceId, employee_no: employee.employee_no, work_email: employee.work_email, action: 'invite_failed', details: { message: inviteError?.message || 'Supabase did not return a user.' } });
      throw inviteError || new Error('Supabase did not return an invited user.');
    }

    const { error: upsertError } = await admin.from('profiles').upsert({
      id: invitation.user.id,
      hr_employee_source_id: sourceId,
      employee_id: employee.employee_no,
      full_name: employee.full_name,
      email: employee.work_email,
      department: employee.department_name,
      job_title: employee.job_title_name,
      role: 'employee',
      is_active: true,
    }, { onConflict: 'id' });
    if (upsertError) throw upsertError;

    await admin.from('workpulse_onboarding_events').insert({ hr_employee_source_id: sourceId, employee_no: employee.employee_no, work_email: employee.work_email, action: 'invited', details: { user_id: invitation.user.id } });
    return NextResponse.json({ ready: true, invited: true, user_id: invitation.user.id, message: 'WorkPulse invitation created.' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'WorkPulse onboarding failed.' }, { status: 500 });
  }
}
