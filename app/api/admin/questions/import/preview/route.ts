import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminBody, questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import { previewQuestionImport } from '@/lib/question-bank-workflow.ts';

export async function POST(request: Request) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await previewQuestionImport(database(), await questionAdminBody(request)));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_import_preview_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
