import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import { questionBankCoverage } from '@/lib/question-bank-workflow.ts';

export async function GET(request: Request) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await questionBankCoverage(database()));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_coverage_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
