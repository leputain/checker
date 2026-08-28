export const ADMIN_SESSION_COOKIE = 'cc_admin_session';
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1_000;
export const ADMIN_LOGIN_MAX_FAILURES = 5;

const SESSION_VERSION = 1;
const SESSION_CLOCK_SKEW_MS = 30_000;
const PIN_HASH_BYTES = 32;

export type AdminBindings = {
  ADMIN_CONFIG_STATUS?: string;
  ADMIN_PIN_HASH?: string;
  ADMIN_PIN_SALT?: string;
  ADMIN_PIN_ITERATIONS?: string;
  ADMIN_SESSION_SECRET?: string;
};

export type AdminAuthConfig = {
  pinHash: Uint8Array;
  pinSalt: Uint8Array;
  pinIterations: number;
  sessionSecret: Uint8Array;
};

type AdminSessionPayload = {
  v: number;
  iat: number;
  exp: number;
  csrf: string;
};

export type VerifiedAdminSession = {
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function readAdminAuthConfig(bindings: AdminBindings): AdminAuthConfig | null {
  if (bindings.ADMIN_CONFIG_STATUS !== 'ready') return null;
  const pinHash = bindings.ADMIN_PIN_HASH
    ? base64UrlToBytes(bindings.ADMIN_PIN_HASH)
    : null;
  const pinSalt = bindings.ADMIN_PIN_SALT
    ? base64UrlToBytes(bindings.ADMIN_PIN_SALT)
    : null;
  const sessionSecret = bindings.ADMIN_SESSION_SECRET
    ? base64UrlToBytes(bindings.ADMIN_SESSION_SECRET)
    : null;
  const pinIterations = Number(bindings.ADMIN_PIN_ITERATIONS);
  if (
    pinHash?.length !== PIN_HASH_BYTES ||
    !pinSalt || pinSalt.length < 16 ||
    !sessionSecret || sessionSecret.length < 32 ||
    !Number.isInteger(pinIterations) || pinIterations < 100_000 || pinIterations > 1_000_000
  ) {
    return null;
  }
  return { pinHash, pinSalt, pinIterations, sessionSecret };
}

export async function deriveAdminPinHash(
  pin: string,
  salt: Uint8Array,
  iterations: number,
) {
  const ownedSalt = new Uint8Array(salt);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ownedSalt, iterations },
    key,
    PIN_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function verifyAdminPin(pin: string, config: AdminAuthConfig) {
  if (!/^\d{6,12}$/u.test(pin)) return false;
  const actual = await deriveAdminPinHash(pin, config.pinSalt, config.pinIterations);
  return constantTimeEqual(actual, config.pinHash);
}

async function sessionSignature(payload: string, secret: Uint8Array) {
  const ownedSecret = new Uint8Array(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    ownedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  ));
}

export async function createAdminSessionToken(
  config: AdminAuthConfig,
  now = Date.now(),
  randomBytes?: Uint8Array,
) {
  const csrfBytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(24));
  if (csrfBytes.length < 16) throw new Error('Admin session entropy is insufficient.');
  const payload: AdminSessionPayload = {
    v: SESSION_VERSION,
    iat: now,
    exp: now + ADMIN_SESSION_TTL_MS,
    csrf: bytesToBase64Url(csrfBytes),
  };
  const encodedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await sessionSignature(encodedPayload, config.sessionSecret);
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export async function verifyAdminSessionToken(
  token: string,
  config: AdminAuthConfig,
  now = Date.now(),
): Promise<VerifiedAdminSession | null> {
  const [encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;
  const suppliedSignature = base64UrlToBytes(encodedSignature);
  const payloadBytes = base64UrlToBytes(encodedPayload);
  if (!suppliedSignature || !payloadBytes) return null;
  const expectedSignature = await sessionSignature(encodedPayload, config.sessionSecret);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<AdminSessionPayload>;
    const csrfBytes = typeof payload.csrf === 'string' ? base64UrlToBytes(payload.csrf) : null;
    if (
      payload.v !== SESSION_VERSION ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.iat > now + SESSION_CLOCK_SKEW_MS ||
      payload.exp <= now ||
      payload.exp - payload.iat !== ADMIN_SESSION_TTL_MS ||
      !csrfBytes || csrfBytes.length < 16
    ) {
      return null;
    }
    return { issuedAt: payload.iat, expiresAt: payload.exp, csrfToken: payload.csrf! };
  } catch {
    return null;
  }
}

export function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function adminSessionCookie(token: string, expiresAt: number, secure: boolean) {
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function expiredAdminSessionCookie(secure: boolean) {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function isSameOriginUnsafeRequest(request: Request) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') return false;
  const origin = request.headers.get('Origin');
  if (!origin) return fetchSite === 'same-origin';
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export type AdminLoginThrottleDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface AdminLoginThrottle {
  check(now?: number): AdminLoginThrottleDecision;
  recordFailure(now?: number): AdminLoginThrottleDecision;
  reset(): void;
}

export class InMemoryAdminLoginThrottle implements AdminLoginThrottle {
  private failures = 0;
  private windowStartedAt = 0;
  private lockedUntil = 0;

  check(now = Date.now()): AdminLoginThrottleDecision {
    if (this.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((this.lockedUntil - now) / 1_000)),
      };
    }
    if (this.windowStartedAt && now - this.windowStartedAt >= ADMIN_LOGIN_WINDOW_MS) {
      this.reset();
    } else if (this.lockedUntil) {
      this.reset();
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(now = Date.now()): AdminLoginThrottleDecision {
    const current = this.check(now);
    if (!current.allowed) return current;
    if (!this.windowStartedAt) this.windowStartedAt = now;
    this.failures += 1;
    if (this.failures >= ADMIN_LOGIN_MAX_FAILURES) {
      this.lockedUntil = now + ADMIN_LOGIN_WINDOW_MS;
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(ADMIN_LOGIN_WINDOW_MS / 1_000),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset() {
    this.failures = 0;
    this.windowStartedAt = 0;
    this.lockedUntil = 0;
  }
}
