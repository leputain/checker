import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import { previewQuestionBankChangeSet } from '@/lib/question-bank-workflow.ts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    return questionAdminJson(await previewQuestionBankChangeSet(database(), id));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_set_preview_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
