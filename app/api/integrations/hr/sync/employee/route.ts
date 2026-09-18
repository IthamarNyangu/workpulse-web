import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type Ref = { source_id: number; code: string | null; name: string; is_active?: boolean } | null;
type EmployeePayload = { source_id:number; employee_no:string; first_name:string; last_name:string; full_name:string; work_email:string|null; hire_date:string|null; termination_date:string|null; is_archived:boolean; department:Ref; job_title:Ref; facility:Ref; employment_status:Ref; supervisor:{source_id:number;employee_no:string}|null; updated_at:string|null };

function authorized(request: NextRequest, expected: string) { const supplied=Buffer.from(request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||''); const wanted=Buffer.from(expected); return supplied.length===wanted.length&&timingSafeEqual(supplied,wanted); }
function active(employee:EmployeePayload) { const status=employee.employment_status?.code?.trim().toUpperCase(); return !employee.is_archived&&!employee.termination_date&&(!status||status==='ACTIVE'); }

export async function POST(request:NextRequest) {
  try {
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY, token=process.env.HR_SYSTEM_SYNC_TOKEN;
    if(!url||!key||!token) throw new Error('HR integration environment variables are incomplete.');
    if(!authorized(request,token)) return NextResponse.json({message:'Invalid HR integration token.'},{status:401});
    const employee=await request.json() as EmployeePayload;
    if(!employee.source_id||!employee.employee_no) return NextResponse.json({message:'A valid HR employee payload is required.'},{status:422});
    const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});

    for (const [table, reference] of [['departments',employee.department],['job_titles',employee.job_title]] as const) {
      if(!reference) continue;
      const {data:bySource,error:readError}=await admin.from(table).select('id').eq('hr_source_id',reference.source_id).maybeSingle(); if(readError) throw readError;
      const existing=bySource||((await admin.from(table).select('id').ilike('name',reference.name).limit(1).maybeSingle()).data);
      const values={name:reference.name,is_active:reference.is_active!==false,hr_source_id:reference.source_id,hr_code:reference.code};
      const result=existing?await admin.from(table).update(values).eq('id',existing.id):await admin.from(table).insert(values); if(result.error) throw result.error;
    }

    const row={source_id:employee.source_id,employee_no:employee.employee_no,first_name:employee.first_name,last_name:employee.last_name,full_name:employee.full_name,work_email:employee.work_email,hire_date:employee.hire_date,termination_date:employee.termination_date,department_source_id:employee.department?.source_id,department_code:employee.department?.code,department_name:employee.department?.name,job_title_source_id:employee.job_title?.source_id,job_title_code:employee.job_title?.code,job_title_name:employee.job_title?.name,facility_source_id:employee.facility?.source_id,facility_code:employee.facility?.code,facility_name:employee.facility?.name,employment_status_source_id:employee.employment_status?.source_id,employment_status_code:employee.employment_status?.code,employment_status_name:employee.employment_status?.name,supervisor_source_id:employee.supervisor?.source_id,supervisor_employee_no:employee.supervisor?.employee_no,is_active:active(employee),source_updated_at:employee.updated_at,synced_at:new Date().toISOString()};
    const {error:upsertError}=await admin.from('hr_directory_employees').upsert(row,{onConflict:'source_id'}); if(upsertError) throw upsertError;
    const {data:profiles,error:profilesError}=await admin.from('profiles').select('id,employee_id,email,hr_employee_source_id'); if(profilesError) throw profilesError;
    const profile=(profiles||[]).find((p)=>p.hr_employee_source_id===employee.source_id||String(p.employee_id).toLowerCase()===employee.employee_no.toLowerCase()||Boolean(employee.work_email&&String(p.email).toLowerCase()===employee.work_email.toLowerCase()));
    if(profile){ const {error}=await admin.from('profiles').update({hr_employee_source_id:employee.source_id,employee_id:employee.employee_no,full_name:employee.full_name,email:employee.work_email||profile.email,department:employee.department?.name||null,job_title:employee.job_title?.name||null,is_active:active(employee)}).eq('id',profile.id); if(error) throw error; }
    return NextResponse.json({synced:true,employee_source_id:employee.source_id,profile_linked:Boolean(profile)});
  } catch(error){ return NextResponse.json({message:error instanceof Error?error.message:'Employee synchronization failed.'},{status:500}); }
}
