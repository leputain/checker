import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime.ts';
import { guardAdminRequest, isGuardFailure } from '@/lib/admin-request.ts';
import {
  questionAdminBody,
  questionAdminErrorResponse,
  questionAdminJson,
} from '@/lib/question-admin-http.ts';
import {
  createQuestionCategory,
  listQuestionCategories,
} from '@/lib/question-bank-workflow.ts';

export async function GET(request: Request) {
  try {
    const guard = await guardAdminRequest(request);
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(await listQuestionCategories(database()));
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_categories_list_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    await ensureSchema();
    await ensureQuestionBankReady();
    return questionAdminJson(
      await createQuestionCategory(database(), await questionAdminBody(request)),
      { status: 201 },
    );
  } catch (error) {
    const expected = questionAdminErrorResponse(error);
    if (expected) return expected;
    console.error('admin_question_category_create_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
