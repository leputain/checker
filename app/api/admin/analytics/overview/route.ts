import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { fetchDerivedOverviewReport } from '@/lib/analytics-derived.ts';
import { adminError } from '@/lib/admin-request.ts';

export async function GET(request: Request) {
  try {
    const context = await loadAdminAnalytics(request);
    if (isAdminAnalyticsFailure(context)) return context;
    return adminJson(await fetchDerivedOverviewReport(
      context.db,
      context.query,
      Date.now(),
      context.flags.calibration,
    ));
  } catch {
    console.error('admin_analytics_overview_failed');
    return adminError('analytics_unavailable', 503);
  }
}
