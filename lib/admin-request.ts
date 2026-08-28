import { env } from 'cloudflare:workers';
import {
  ADMIN_SESSION_COOKIE,
  cookieValue,
  isSameOriginUnsafeRequest,
  readAdminAuthConfig,
  verifyAdminSessionToken,
  type AdminAuthConfig,
  type AdminBindings,
  type VerifiedAdminSession,
} from './admin-auth.ts';
import type { AdminApiErrorCode, AdminApiErrorDto } from './analytics-contract.ts';

export const ADMIN_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie',
} as const;

export function adminAuthConfig(): AdminAuthConfig | null {
  return readAdminAuthConfig(env as unknown as AdminBindings);
}

export function adminError(error: AdminApiErrorCode, status: number, extraHeaders?: HeadersInit) {
  return Response.json(
    { error } satisfies AdminApiErrorDto,
    { status, headers: { ...ADMIN_NO_STORE_HEADERS, ...extraHeaders } },
  );
}

export async function adminSessionForRequest(
  request: Request,
  config = adminAuthConfig(),
): Promise<VerifiedAdminSession | null> {
  if (!config) return null;
  const token = cookieValue(request.headers.get('Cookie'), ADMIN_SESSION_COOKIE);
  return token ? verifyAdminSessionToken(token, config) : null;
}

function csrfMatches(supplied: string | null, expected: string) {
  if (!supplied || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export type AdminGuardSuccess = {
  config: AdminAuthConfig;
  session: VerifiedAdminSession;
};

export async function guardAdminRequest(
  request: Request,
  options: { csrf?: boolean } = {},
): Promise<AdminGuardSuccess | Response> {
  const config = adminAuthConfig();
  if (!config) return adminError('admin_disabled', 503);
  const session = await adminSessionForRequest(request, config);
  if (!session) return adminError('unauthorized', 401);
  if (options.csrf) {
    if (!isSameOriginUnsafeRequest(request)) return adminError('csrf_invalid', 403);
    if (!csrfMatches(request.headers.get('X-CSRF-Token'), session.csrfToken)) {
      return adminError('csrf_invalid', 403);
    }
  }
  return { config, session };
}

export function isGuardFailure(value: AdminGuardSuccess | Response): value is Response {
  return value instanceof Response;
}
