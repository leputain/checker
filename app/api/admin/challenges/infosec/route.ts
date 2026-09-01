import { securityChallengeAdminReport } from '@/db/security-challenge.ts';
import { adminJson } from '@/lib/admin-analytics.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';

export async function GET(request: Request) {
  const guard = await guardAdminRequest(request);
  if (isGuardFailure(guard)) return guard;
  try {
    return adminJson(await securityChallengeAdminReport());
  } catch {
    console.error('security_challenge_admin_report_failed');
    return adminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
