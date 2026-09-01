export const SECURITY_CHALLENGE_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export const CHALLENGE_START_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const CHALLENGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const CHALLENGE_ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/iu;

export function challengeBearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function readChallengeJson<T>(request: Request, maximumBytes = 16_384) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error('body_too_large');
  return JSON.parse(text || '{}') as T;
}

export function challengeJson(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { ...SECURITY_CHALLENGE_NO_STORE_HEADERS, ...init.headers },
  });
}
