import { securityChallengeAdminAttemptDetail } from '@/db/security-challenge.ts';
import { adminJson } from '@/lib/admin-analytics.ts';
import { adminError, guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { CHALLENGE_ATTEMPT_ID_PATTERN } from '@/lib/security-challenge-http.ts';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await guardAdminRequest(request);
  if (isGuardFailure(guard)) return guard;
  try {
    const { id } = await context.params;
    if (!CHALLENGE_ATTEMPT_ID_PATTERN.test(id)) return adminError('invalid_request', 400);
    const detail = await securityChallengeAdminAttemptDetail(id);
    return detail ? adminJson(detail) : adminError('not_found', 404);
  } catch {
    console.error('security_challenge_admin_attempt_failed');
    return adminError('analytics_unavailable', 503);
  }
}
