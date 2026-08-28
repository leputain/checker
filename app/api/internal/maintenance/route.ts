import { env } from 'cloudflare:workers';
import { maintainTelegramOutbox } from '@/db/telegram-outbox';
import { maintainRuntimeRetention } from '@/db/runtime-retention';
import { database, ensureSchema, sha256Hex } from '@/db/runtime';
import { maintainAnalyticsAggregates } from '@/lib/analytics-aggregate-store.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

async function isAuthorized(request: Request) {
  const suppliedToken = bearerToken(request);
  const expectedToken = env.MAINTENANCE_TOKEN ?? '';
  if (!suppliedToken || !expectedToken) return false;

  const [suppliedHash, expectedHash] = await Promise.all([
    sha256Hex(suppliedToken),
    sha256Hex(expectedToken),
  ]);
  let difference = suppliedHash.length ^ expectedHash.length;
  for (let index = 0; index < Math.max(suppliedHash.length, expectedHash.length); index += 1) {
    difference |= suppliedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return new Response(null, { status: 404, headers: NO_STORE });
  }

  try {
    await ensureSchema();
    await maintainTelegramOutbox();
    await maintainRuntimeRetention();
    if (readFeatureFlags(env).analytics) {
      try {
        const analytics = await maintainAnalyticsAggregates(database());
        if (analytics.status === 'failed') console.error('analytics_auto_refresh_failed');
      } catch {
        // Analytics is an optional background projection. A broken/stale
        // projection must not make the operational maintenance cycle fail.
        console.error('analytics_auto_refresh_failed');
      }
    }
    return new Response(null, { status: 204, headers: NO_STORE });
  } catch {
    console.error('maintenance_failed');
    return new Response(null, { status: 503, headers: NO_STORE });
  }
}
