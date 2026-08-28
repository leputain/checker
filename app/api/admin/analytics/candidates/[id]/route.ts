import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { fetchDerivedCandidatePrintReport } from '@/lib/analytics-derived.ts';
import { adminError } from '@/lib/admin-request.ts';

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/u;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!ATTEMPT_ID_PATTERN.test(id)) return adminError('invalid_request', 400);
    const analytics = await loadAdminAnalytics(request);
    if (isAdminAnalyticsFailure(analytics)) return analytics;
    const result = await fetchDerivedCandidatePrintReport(analytics.db, analytics.query, id);
    return result ? adminJson(result) : adminError('not_found', 404);
  } catch {
    console.error('admin_analytics_candidate_detail_failed');
    return adminError('analytics_unavailable', 503);
  }
}
