import assert from 'node:assert/strict';
import {
  ADMIN_LOGIN_MAX_FAILURES,
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  InMemoryAdminLoginThrottle,
  adminSessionCookie,
  cookieValue,
  createAdminSessionToken,
  deriveAdminPinHash,
  expiredAdminSessionCookie,
  isSameOriginUnsafeRequest,
  readAdminAuthConfig,
  verifyAdminPin,
  verifyAdminSessionToken,
} from '../lib/admin-auth.ts';

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

const pin = '483920';
const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const secret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const pinHash = await deriveAdminPinHash(pin, salt, 210_000);
const config = readAdminAuthConfig({
  ADMIN_CONFIG_STATUS: 'ready',
  ADMIN_PIN_HASH: base64Url(pinHash),
  ADMIN_PIN_SALT: base64Url(salt),
  ADMIN_PIN_ITERATIONS: '210000',
  ADMIN_SESSION_SECRET: base64Url(secret),
});

assert.ok(config);
assert.equal(readAdminAuthConfig({ ADMIN_CONFIG_STATUS: 'missing' }), null);
assert.equal(readAdminAuthConfig({
  ADMIN_CONFIG_STATUS: 'ready',
  ADMIN_PIN_HASH: 'bad',
  ADMIN_PIN_SALT: base64Url(salt),
  ADMIN_PIN_ITERATIONS: '210000',
  ADMIN_SESSION_SECRET: base64Url(secret),
}), null);
assert.equal(await verifyAdminPin(pin, config), true);
assert.equal(await verifyAdminPin('483921', config), false);
assert.equal(await verifyAdminPin('123', config), false, 'PIN shorter than four digits is rejected');
assert.equal(await verifyAdminPin('12345x', config), false, 'PIN is numeric only');

const now = Date.UTC(2026, 7, 28, 10, 0, 0);
const token = await createAdminSessionToken(config, now, new Uint8Array(24).fill(7));
const session = await verifyAdminSessionToken(token, config, now + 1_000);
assert.ok(session);
assert.equal(session.expiresAt, now + ADMIN_SESSION_TTL_MS);
assert.equal(await verifyAdminSessionToken(token, config, now + ADMIN_SESSION_TTL_MS), null);
const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
assert.equal(await verifyAdminSessionToken(tampered, config, now), null);

const httpCookie = adminSessionCookie(token, now + ADMIN_SESSION_TTL_MS, false);
assert.match(httpCookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
assert.match(httpCookie, /HttpOnly/u);
assert.match(httpCookie, /SameSite=Strict/u);
assert.doesNotMatch(httpCookie, /; Secure/u);
assert.equal(cookieValue(`x=1; ${httpCookie}`, ADMIN_SESSION_COOKIE), token);
assert.match(adminSessionCookie(token, now + ADMIN_SESSION_TTL_MS, true), /; Secure/u);
assert.match(expiredAdminSessionCookie(false), /Max-Age=0/u);

assert.equal(isSameOriginUnsafeRequest(new Request('http://localhost:3001/api/admin/session', {
  method: 'POST',
  headers: { Origin: 'http://localhost:3001', 'Sec-Fetch-Site': 'same-origin' },
})), true);
assert.equal(isSameOriginUnsafeRequest(new Request('http://localhost:3001/api/admin/session', {
  method: 'POST',
  headers: { Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'cross-site' },
})), false);
assert.equal(isSameOriginUnsafeRequest(new Request('http://localhost:3001/api/admin/session', {
  method: 'POST',
})), false, 'unsafe request without browser origin metadata is rejected');

const throttle = new InMemoryAdminLoginThrottle();
for (let attempt = 1; attempt < ADMIN_LOGIN_MAX_FAILURES; attempt += 1) {
  assert.equal(throttle.recordFailure(now).allowed, true);
}
const locked = throttle.recordFailure(now);
assert.equal(locked.allowed, false);
assert.equal(locked.retryAfterSeconds, ADMIN_LOGIN_WINDOW_MS / 1_000);
assert.equal(throttle.check(now + 60_000).allowed, false);
assert.equal(throttle.check(now + ADMIN_LOGIN_WINDOW_MS).allowed, true);
throttle.recordFailure(now + ADMIN_LOGIN_WINDOW_MS + 1);
throttle.reset();
assert.equal(throttle.check(now + ADMIN_LOGIN_WINDOW_MS + 2).allowed, true);

console.log('Admin authentication tests passed.');
