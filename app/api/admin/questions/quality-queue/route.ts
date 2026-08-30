import { loadAdminAnalytics, isAdminAnalyticsFailure } from '@/lib/admin-analytics.ts';
import { fetchDerivedQuestionListReport } from '@/lib/analytics-derived.ts';
import { questionAdminJson } from '@/lib/question-admin-http.ts';
import type { QuestionQualityQueueDto } from '@/lib/question-admin-contract.ts';
import { DIFFICULTIES, type Difficulty } from '@/lib/test-config.ts';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    url.searchParams.set('qualityStatus', 'all');
    url.searchParams.set('limit', '100');
    const context = await loadAdminAnalytics(new Request(url, request));
    if (isAdminAnalyticsFailure(context)) return context;
    const report = await fetchDerivedQuestionListReport(
      context.db,
      // The derived layer already materializes the filtered question set before
      // slicing. Request the complete set so a bank larger than one mutation
      // batch cannot silently hide actionable questions from the control queue.
      { ...context.query, cursorOffset: 0, limit: Number.MAX_SAFE_INTEGER },
      context.flags.calibration,
    );
    const items = report.items.filter((item) => item.quality.status !== 'good').map((item) => ({
      questionId: item.questionId,
      topic: item.topic,
      difficulty: (DIFFICULTIES.includes(item.difficulty as Difficulty)
        ? item.difficulty
        : 'easy') as Difficulty,
      qualityStatus: item.quality.status,
      warnings: item.qualityWarnings,
      editorHref: `/admin/analytics?tab=questions&view=bank&questionId=${item.questionId}`,
      analyticsHref: `/admin/analytics?tab=questions&questionId=${item.questionId}`,
    }));
    return questionAdminJson({
      currentBankRevision: context.query.bankRevision ?? '',
      items,
      totalCount: items.length,
    } satisfies QuestionQualityQueueDto);
  } catch {
    console.error('admin_question_quality_queue_failed');
    return questionAdminJson({ error: 'analytics_unavailable' }, { status: 503 });
  }
}
