import {
  resolveSecurityChallengeFeedback,
} from '@/db/security-challenge.ts';
import { adminJson, adminSessionFingerprint } from '@/lib/admin-analytics.ts';
import {
  adminError,
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';
import { readChallengeJson } from '@/lib/security-challenge-http.ts';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await guardAdminRequest(request, { csrf: true });
  if (isGuardFailure(guard)) return guard;
  try {
    const { id } = await context.params;
    const body = await readChallengeJson<{
      status?: 'resolved' | 'rejected';
      resolutionNote?: string;
    }>(request);
    const note = body.resolutionNote?.trim() ?? '';
    if (!['resolved', 'rejected'].includes(body.status ?? '') || note.length > 1_000) {
      return adminError('invalid_request', 400);
    }
    const updated = await resolveSecurityChallengeFeedback({
      id,
      status: body.status as 'resolved' | 'rejected',
      resolutionNote: note,
      adminSessionFingerprint: await adminSessionFingerprint(guard.session.csrfToken),
    });
    return updated ? adminJson({ status: body.status }) : adminError('not_found', 404);
  } catch {
    console.error('security_challenge_feedback_resolution_failed');
    return adminError('analytics_unavailable', 503);
  }
}
