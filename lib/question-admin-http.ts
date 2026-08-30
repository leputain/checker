import { ADMIN_NO_STORE_HEADERS } from './admin-request.ts';
import { QuestionAdminServiceError } from './question-admin-service.ts';

const MAX_ADMIN_JSON_BYTES = 2_000_000;

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

export async function questionAdminBody(request: Request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_ADMIN_JSON_BYTES) {
    throw new QuestionAdminServiceError('mutation_too_large', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_ADMIN_JSON_BYTES) {
    throw new QuestionAdminServiceError('mutation_too_large', 413);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
}
