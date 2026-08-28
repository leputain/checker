import {
  ADMIN_SESSION_TTL_MS,
  InMemoryAdminLoginThrottle,
  adminSessionCookie,
  createAdminSessionToken,
  expiredAdminSessionCookie,
  isSameOriginUnsafeRequest,
  verifyAdminSessionToken,
  verifyAdminPin,
} from '@/lib/admin-auth.ts';
import type { AdminSessionDto } from '@/lib/analytics-contract.ts';
import {
  ADMIN_NO_STORE_HEADERS,
  adminAuthConfig,
  adminError,
  adminSessionForRequest,
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';

const throttle = new InMemoryAdminLoginThrottle();

function secureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:';
}

export async function GET(request: Request) {
  const config = adminAuthConfig();
  if (!config) {
    return Response.json(
      { enabled: false, authenticated: false } satisfies AdminSessionDto,
      { headers: ADMIN_NO_STORE_HEADERS },
    );
  }
  const session = await adminSessionForRequest(request, config);
  return Response.json(
    session
      ? {
          enabled: true,
          authenticated: true,
          expiresAt: new Date(session.expiresAt).toISOString(),
          csrfToken: session.csrfToken,
        }
      : { enabled: true, authenticated: false },
    { headers: ADMIN_NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  if (!isSameOriginUnsafeRequest(request)) return adminError('csrf_invalid', 403);
  const config = adminAuthConfig();
  if (!config) return adminError('admin_disabled', 503);
  const currentDecision = throttle.check();
  if (!currentDecision.allowed) {
    return adminError('rate_limited', 429, {
      'Retry-After': String(currentDecision.retryAfterSeconds),
    });
  }

  let pin = '';
  try {
    const body = await request.json() as { pin?: unknown };
    if (typeof body.pin === 'string') pin = body.pin;
  } catch {
    return adminError('invalid_request', 400);
  }

  if (!(await verifyAdminPin(pin, config))) {
    const decision = throttle.recordFailure();
    return adminError(decision.allowed ? 'unauthorized' : 'rate_limited', decision.allowed ? 401 : 429, {
      ...(decision.allowed ? {} : { 'Retry-After': String(decision.retryAfterSeconds) }),
    });
  }

  throttle.reset();
  const now = Date.now();
  const token = await createAdminSessionToken(config, now);
  const session = await verifyAdminSessionToken(token, config, now);
  if (!session) return adminError('unauthorized', 401);
  return Response.json(
    {
      enabled: true,
      authenticated: true,
      expiresAt: new Date(now + ADMIN_SESSION_TTL_MS).toISOString(),
      csrfToken: session.csrfToken,
    } satisfies AdminSessionDto,
    {
      headers: {
        ...ADMIN_NO_STORE_HEADERS,
        'Set-Cookie': adminSessionCookie(token, now + ADMIN_SESSION_TTL_MS, secureRequest(request)),
      },
    },
  );
}

export async function DELETE(request: Request) {
  const guard = await guardAdminRequest(request, { csrf: true });
  if (isGuardFailure(guard)) return guard;
  return new Response(null, {
    status: 204,
    headers: {
      ...ADMIN_NO_STORE_HEADERS,
      'Set-Cookie': expiredAdminSessionCookie(secureRequest(request)),
    },
  });
}
