import { env } from 'cloudflare:workers';
import { database, ensureQuestionBankReady, ensureSchema } from '@/db/runtime';
import { readFeatureFlags, type CandidateCheckFeatureFlags } from './feature-flags.ts';
import { cachedAnalyticsReport } from './analytics-cache.ts';
import { analyticsAggregateState } from './analytics-aggregate-store.ts';
import {
  applyCurrentModelDefaults,
  AnalyticsQueryError,
  parseAnalyticsQuery,
  type ParsedAnalyticsQuery,
} from './analytics-query.ts';
import { resolveCurrentBankRevision } from './analytics-repository.ts';
import {
  ADMIN_NO_STORE_HEADERS,
  adminError,
  guardAdminRequest,
  isGuardFailure,
} from './admin-request.ts';

export type AdminAnalyticsContext = {
  db: D1Database;
  query: ParsedAnalyticsQuery;
  flags: CandidateCheckFeatureFlags;
};

export function adminJson(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { ...ADMIN_NO_STORE_HEADERS, ...init.headers },
  });
}

export async function loadAdminAnalytics(
  request: Request,
  options: { resolveCurrentRevision?: boolean; allowStaleAggregates?: boolean } = {},
): Promise<AdminAnalyticsContext | Response> {
  const guard = await guardAdminRequest(request);
  if (isGuardFailure(guard)) return guard;
  const flags = readFeatureFlags(env);
  if (!flags.analytics) return adminError('analytics_unavailable', 503);
  let query: ParsedAnalyticsQuery;
  try {
    const url = new URL(request.url);
    query = applyCurrentModelDefaults(
      parseAnalyticsQuery(url),
      url,
      flags.balancedSelection,
    );
  } catch (error) {
    if (error instanceof AnalyticsQueryError) return adminError('invalid_request', 400);
    throw error;
  }

  await ensureSchema();
  const db = database();
  if (options.resolveCurrentRevision !== false && !query.bankRevision) {
    const currentRevision = await ensureQuestionBankReady();
    query = { ...query, bankRevision: currentRevision };
  } else if (options.resolveCurrentRevision !== false) {
    const resolved = await resolveCurrentBankRevision(db, query);
    if (!resolved) return adminError('analytics_unavailable', 503);
    query = resolved;
  }
  if (!options.allowStaleAggregates) {
    const state = await analyticsAggregateState(db);
    if (!state.ready) return adminError('analytics_refresh_required', 409);
  }
  return { db, query, flags };
}

export function isAdminAnalyticsFailure(
  value: AdminAnalyticsContext | Response,
): value is Response {
  return value instanceof Response;
}

export async function cachedAdminAnalytics<T>(
  context: AdminAnalyticsContext,
  reportType: string,
  producer: () => Promise<T>,
  variant = '',
) {
  const result = await cachedAnalyticsReport(
    context.db,
    reportType,
    context.query,
    producer,
    {
      variant: [variant, `calibration:${context.flags.calibration ? 1 : 0}`]
        .filter(Boolean).join('|'),
    },
  );
  return result.value;
}

export async function adminSessionFingerprint(csrfToken: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(csrfToken),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
