import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { adminSessionFingerprint } from '@/lib/admin-analytics.ts';
import {
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';
import {
  questionAdminBody,
  questionAdminErrorResponse,
  questionAdminJson,
} from '@/lib/question-admin-http.ts';
import {
  getAdminQuestion,
  QuestionAdminServiceError,
  reviseAdminQuestion,
  toggleAdminQuestion,
} from '@/lib/question-admin-service.ts';

function questionId(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  return id;
}

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
    return questionAdminJson(await getAdminQuestion(database(), questionId(id)));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_detail_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    const result = await reviseAdminQuestion(
      database(),
      questionId(id),
      await questionAdminBody(request),
      await adminSessionFingerprint(guard.session.csrfToken),
    );
    return questionAdminJson(result, { status: 201 });
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_revise_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    return questionAdminJson(await toggleAdminQuestion(
      database(),
      questionId(id),
      await questionAdminBody(request),
      await adminSessionFingerprint(guard.session.csrfToken),
    ));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_toggle_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
