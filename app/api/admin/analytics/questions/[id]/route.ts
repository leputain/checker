import {
  adminJson,
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import { fetchQuestionReviews } from '@/lib/analytics-repository.ts';
import { fetchDerivedQuestionDetailReport } from '@/lib/analytics-derived.ts';
import { adminError } from '@/lib/admin-request.ts';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const questionId = Number(id);
    if (!Number.isInteger(questionId) || questionId <= 0) return adminError('invalid_request', 400);
    const analytics = await loadAdminAnalytics(request);
    if (isAdminAnalyticsFailure(analytics)) return analytics;
    const detail = await fetchDerivedQuestionDetailReport(
      analytics.db,
      analytics.query,
      questionId,
      analytics.flags.calibration,
    );
    if (!detail) return adminError('not_found', 404);
    const reviewHistory = await fetchQuestionReviews(analytics.db, questionId);
    return adminJson({ ...detail, reviewHistory });
  } catch {
    console.error('admin_analytics_question_detail_failed');
    return adminError('analytics_unavailable', 503);
  }
}
