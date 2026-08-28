import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { fetchDerivedRevisionComparisonReport } from '@/lib/analytics-derived.ts';
import { adminError } from '@/lib/admin-request.ts';

const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const leftValues = url.searchParams.getAll('leftRevision');
    const rightValues = url.searchParams.getAll('rightRevision');
    const left = leftValues[0]?.trim() ?? '';
    const right = rightValues[0]?.trim() ?? '';
    if (
      leftValues.length !== 1
      || rightValues.length !== 1
      || !REVISION_PATTERN.test(left)
      || !REVISION_PATTERN.test(right)
      || left === right
    ) {
      return adminError('invalid_request', 400);
    }
    const context = await loadAdminAnalytics(request, { resolveCurrentRevision: false });
    if (isAdminAnalyticsFailure(context)) return context;
    const known = await context.db.prepare(
      'SELECT hash FROM question_bank_revisions WHERE hash IN (?, ?)',
    ).bind(left, right).all<{ hash: string }>();
    if (new Set(known.results.map((item) => item.hash)).size !== 2) {
      return adminError('not_found', 404);
    }
    return adminJson(await fetchDerivedRevisionComparisonReport(
      context.db,
      context.query,
      left,
      right,
      context.flags.calibration,
    ));
  } catch {
    console.error('admin_analytics_revision_comparison_failed');
    return adminError('analytics_unavailable', 503);
  }
}
