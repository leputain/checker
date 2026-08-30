import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { adminSessionFingerprint } from '@/lib/admin-analytics.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import {
  questionAdminBody,
  questionAdminErrorResponse,
  questionAdminJson,
} from '@/lib/question-admin-http.ts';
import { QuestionAdminServiceError } from '@/lib/question-admin-service.ts';
import { mergeQuestionCategory } from '@/lib/question-bank-workflow.ts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    const parsedId = Number(id);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      throw new QuestionAdminServiceError('invalid_request', 400);
    }
    return questionAdminJson(await mergeQuestionCategory(
      database(),
      parsedId,
      await questionAdminBody(request),
      await adminSessionFingerprint(guard.session.csrfToken),
    ));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_category_merge_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
