import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { fetchDerivedQuestionListReport } from '@/lib/analytics-derived.ts';
import { adminError } from '@/lib/admin-request.ts';

export async function GET(request: Request) {
  try {
    const context = await loadAdminAnalytics(request);
    if (isAdminAnalyticsFailure(context)) return context;
    return adminJson(await fetchDerivedQuestionListReport(
      context.db,
      context.query,
      context.flags.calibration,
    ));
  } catch {
    console.error('admin_analytics_questions_failed');
    return adminError('analytics_unavailable', 503);
  }
}
