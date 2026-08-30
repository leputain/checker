import { ADMIN_NO_STORE_HEADERS } from './admin-request.ts';
import { QuestionAdminServiceError } from './question-admin-service.ts';

export function questionAdminJson(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { ...ADMIN_NO_STORE_HEADERS, ...init.headers },
  });
}

export function questionAdminErrorResponse(error: unknown) {
  if (!(error instanceof QuestionAdminServiceError)) return null;
  return questionAdminJson(
    {
      error: error.code,
      ...(error.issues?.length ? { issues: error.issues } : {}),
    },
    { status: error.status },
  );
}
