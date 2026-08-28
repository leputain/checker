import { env } from 'cloudflare:workers';
import { database, ensureSchema } from '@/db/runtime';
import {
  adminJson,
  adminSessionFingerprint,
} from '@/lib/admin-analytics.ts';
import type {
  CreateQuestionReviewDto,
  QuestionReviewDecision,
} from '@/lib/analytics-contract.ts';
import { insertQuestionReview } from '@/lib/analytics-repository.ts';
import {
  adminError,
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';

const DECISIONS = new Set<QuestionReviewDecision>([
  'keep',
  'observe',
  'disable_requested',
  'new_revision_required',
]);
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    if (!readFeatureFlags(env).analytics) return adminError('analytics_unavailable', 503);
    const { id } = await context.params;
    const questionId = Number(id);
    if (!Number.isInteger(questionId) || questionId <= 0) return adminError('invalid_request', 400);
    let body: Partial<CreateQuestionReviewDto>;
    try {
      body = await request.json() as Partial<CreateQuestionReviewDto>;
    } catch {
      return adminError('invalid_request', 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim() : null;
    if (
      typeof body.revision !== 'string' ||
      !REVISION_PATTERN.test(body.revision) ||
      typeof body.decision !== 'string' ||
      !DECISIONS.has(body.decision as QuestionReviewDecision) ||
      (body.note !== undefined && body.note !== null && typeof body.note !== 'string') ||
      (note?.length ?? 0) > 500
    ) {
      return adminError('invalid_request', 400);
    }
    await ensureSchema();
    const review = await insertQuestionReview(
      database(),
      questionId,
      {
        revision: body.revision,
        decision: body.decision as QuestionReviewDecision,
        note: note || null,
      },
      await adminSessionFingerprint(guard.session.csrfToken),
    );
    if (!review) return adminError('not_found', 404);
    return adminJson(review, { status: 201 });
  } catch {
    console.error('admin_question_review_failed');
    return adminError('analytics_unavailable', 503);
  }
}
