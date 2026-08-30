import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import {
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';
import {
  questionAdminErrorResponse,
  questionAdminJson,
} from '@/lib/question-admin-http.ts';
import {
  getAdminQuestionHistory,
  QuestionAdminServiceError,
} from '@/lib/question-admin-service.ts';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    const parsedId = Number(id);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      throw new QuestionAdminServiceError('invalid_request', 400);
    }
    return questionAdminJson(await getAdminQuestionHistory(database(), parsedId));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_history_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
