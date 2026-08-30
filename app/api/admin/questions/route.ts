import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { adminSessionFingerprint } from '@/lib/admin-analytics.ts';
import {
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';
import {
  questionAdminErrorResponse,
  questionAdminJson,
} from '@/lib/question-admin-http.ts';
import {
  createAdminQuestion,
  listAdminQuestions,
  parseQuestionAdminListQuery,
} from '@/lib/question-admin-service.ts';

export async function GET(request: Request) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await listAdminQuestions(
      database(),
      parseQuestionAdminListQuery(request),
    ));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_questions_list_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    let body: Record<string, unknown>;
    try {
      const value = await request.json() as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return questionAdminJson({ error: 'invalid_request' }, { status: 400 });
      }
      body = value as Record<string, unknown>;
    } catch {
      return questionAdminJson({ error: 'invalid_request' }, { status: 400 });
    }
    const result = await createAdminQuestion(
      database(),
      body,
      await adminSessionFingerprint(guard.session.csrfToken),
    );
    return questionAdminJson(result, { status: 201 });
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_create_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
