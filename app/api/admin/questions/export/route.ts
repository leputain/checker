import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import { QuestionAdminServiceError } from '@/lib/question-admin-service.ts';
import { exportQuestionBank } from '@/lib/question-bank-workflow.ts';

export async function GET(request: Request) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const url = new URL(request.url);
    const topic = url.searchParams.get('topic')?.trim() || null;
    const status = url.searchParams.get('status') ?? 'all';
    if (!['all', 'active', 'inactive'].includes(status)) {
      throw new QuestionAdminServiceError('invalid_request', 400);
    }
    const result = await exportQuestionBank(database(), {
      topic,
      status: status as 'all' | 'active' | 'inactive',
    });
    return questionAdminJson(result, {
      headers: {
        'Content-Disposition': `attachment; filename="question-bank-${result.bankRevision.slice(0, 12)}.json"`,
      },
    });
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_export_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
