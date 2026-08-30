import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { adminSessionFingerprint } from '@/lib/admin-analytics.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminBody, questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import {
  createQuestionBankChangeSet,
  listQuestionBankChangeSets,
} from '@/lib/question-bank-workflow.ts';

export async function GET(request: Request) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await listQuestionBankChangeSets(database()));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_sets_list_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await createQuestionBankChangeSet(
      database(),
      await questionAdminBody(request),
      await adminSessionFingerprint(guard.session.csrfToken),
    ), { status: 201 });
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_set_create_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
