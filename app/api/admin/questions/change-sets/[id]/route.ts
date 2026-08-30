import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import { questionAdminBody, questionAdminErrorResponse, questionAdminJson } from '@/lib/question-admin-http.ts';
import {
  discardQuestionBankChangeSet,
  getQuestionBankChangeSet,
  replaceQuestionBankChangeSetOperations,
} from '@/lib/question-bank-workflow.ts';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    return questionAdminJson(await getQuestionBankChangeSet(database(), id));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_set_detail_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    return questionAdminJson(await replaceQuestionBankChangeSetOperations(
      database(), id, await questionAdminBody(request),
    ));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_set_update_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    const { id } = await context.params;
    return questionAdminJson(await discardQuestionBankChangeSet(
      database(), id, await questionAdminBody(request),
    ));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_change_set_discard_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
