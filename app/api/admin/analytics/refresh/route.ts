import { env } from 'cloudflare:workers';
import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { rebuildAnalyticsAggregates } from '@/lib/analytics-aggregate-store.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import {
  adminError,
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';

export async function POST(request: Request) {
  try {
    const guard = await guardAdminRequest(request, { csrf: true });
    if (isGuardFailure(guard)) return guard;
    if (!readFeatureFlags(env).analytics) return adminError('analytics_unavailable', 503);
    try {
      const body = await request.json() as { rebuild?: unknown };
      if (body.rebuild !== undefined && typeof body.rebuild !== 'boolean') {
        return adminError('invalid_request', 400);
      }
      if (body.rebuild === false) return adminError('invalid_request', 400);
    } catch {
      return adminError('invalid_request', 400);
    }
    const context = await loadAdminAnalytics(request, { allowStaleAggregates: true });
    if (isAdminAnalyticsFailure(context)) return context;
    const rebuilt = await rebuildAnalyticsAggregates(context.db);
    return adminJson({
      generation: rebuilt.generation,
      durationMs: rebuilt.durationMs,
      rows: rebuilt.rows,
      refreshed: ['overview', 'questions', 'candidates', 'topics', 'difficulty', 'trends', 'revisions'],
    });
  } catch {
    console.error('admin_analytics_refresh_failed');
    return adminError('analytics_unavailable', 503);
  }
}
