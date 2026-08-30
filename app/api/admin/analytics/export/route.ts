import {
  isAdminAnalyticsFailure,
  loadAdminAnalytics,
} from '@/lib/admin-analytics.ts';
import type {
  AnalyticsExportFormat,
  AnalyticsExportRowDto,
} from '@/lib/analytics-contract.ts';
import { QUESTION_ANALYTICS_MODEL_VERSION } from '@/lib/analytics-contract.ts';
import { fetchDerivedQuestionListReport } from '@/lib/analytics-derived.ts';
import { semicolonCsv } from '@/lib/analytics-math.ts';
import {
  ADMIN_NO_STORE_HEADERS,
  adminError,
} from '@/lib/admin-request.ts';

function exportRows(items: Awaited<ReturnType<typeof fetchDerivedQuestionListReport>>['items']): AnalyticsExportRowDto[] {
  return items.map((item) => ({
    questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
    questionId: item.questionId,
    topic: item.topic,
    difficulty: item.difficulty,
    kind: item.kind,
    assignedCount: item.assignedCount,
    presentedCount: item.presentedCount,
    outcomeCount: item.outcomeCount,
    sampleSize: item.sampleSize,
    completionRate: item.completionRate,
    successRate: item.successRate,
    timeoutRate: item.timeoutRate,
    averageSeconds: item.averageSeconds,
    medianSeconds: item.medianSeconds,
    minSeconds: item.minSeconds,
    maxSeconds: item.maxSeconds,
    discrimination: item.discrimination,
    qualityScore: item.quality.earned,
    qualityMaxAvailable: item.quality.maxAvailable,
    qualityStatus: item.quality.status,
    qualityWarnings: item.qualityWarnings,
    reliability: item.reliability,
    recommendation: item.recommendation?.code ?? null,
    observedSubmittedCount: item.observed.submittedCount,
    observedCorrectCount: item.observed.correctCount,
    observedIncorrectCount: item.observed.incorrectCount,
    observedTimeoutCount: item.observed.timeoutCount,
    observedPresentationRate: item.observed.presentationRate,
    observedResponseRate: item.observed.responseRate,
    observedSuccessRate: item.observed.successRate,
    observedTimeoutRate: item.observed.timeoutRate,
    sampleStatus: item.sample.status,
    nextSampleGate: item.sample.nextGate,
    signalCodes: item.signals.map((signal) => signal.code),
  }));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const formats = url.searchParams.getAll('format');
    const format = (formats[0] ?? 'csv') as AnalyticsExportFormat;
    if (formats.length > 1 || (format !== 'csv' && format !== 'json')) {
      return adminError('invalid_request', 400);
    }
    const context = await loadAdminAnalytics(request);
    if (isAdminAnalyticsFailure(context)) return context;
    if (!context.flags.analyticsExport) return adminError('not_found', 404);
    const exportQuery = { ...context.query, cursorOffset: 0, limit: Number.MAX_SAFE_INTEGER };
    const report = await fetchDerivedQuestionListReport(
      context.db,
      exportQuery,
      context.flags.calibration,
    );
    const rows = exportRows(report.items);
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      return new Response(JSON.stringify({
        questionAnalyticsModelVersion: report.questionAnalyticsModelVersion,
        cohort: report.cohort,
        rows,
      }), {
        headers: {
          ...ADMIN_NO_STORE_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="candidate-check-analytics-${date}.json"`,
        },
      });
    }
    const csv = semicolonCsv(
      [
        'analytics_model_version', 'question_id', 'topic', 'difficulty', 'kind', 'assigned', 'presented',
        'outcomes', 'completion_rate', 'success_rate', 'timeout_rate', 'avg_seconds',
        'median_seconds', 'min_seconds', 'max_seconds', 'discrimination',
        'quality_score', 'quality_max', 'quality_status', 'quality_warnings',
        'reliability', 'recommendation', 'observed_submitted', 'observed_correct',
        'observed_incorrect', 'observed_timeout', 'observed_presentation_rate',
        'observed_response_rate', 'observed_success_rate', 'observed_timeout_rate',
        'sample_status', 'next_sample_gate', 'signals',
      ],
      rows.map((row) => [
        row.questionAnalyticsModelVersion, row.questionId, row.topic, row.difficulty, row.kind, row.assignedCount,
        row.presentedCount, row.outcomeCount, row.completionRate, row.successRate,
        row.timeoutRate, row.averageSeconds, row.medianSeconds, row.minSeconds,
        row.maxSeconds, row.discrimination, row.qualityScore, row.qualityMaxAvailable,
        row.qualityStatus, row.qualityWarnings.join(','), row.reliability,
        row.recommendation, row.observedSubmittedCount, row.observedCorrectCount,
        row.observedIncorrectCount, row.observedTimeoutCount, row.observedPresentationRate,
        row.observedResponseRate, row.observedSuccessRate, row.observedTimeoutRate,
        row.sampleStatus, row.nextSampleGate, row.signalCodes.join(','),
      ]),
    );
    return new Response(csv, {
      headers: {
        ...ADMIN_NO_STORE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="candidate-check-analytics-${date}.csv"`,
      },
    });
  } catch {
    console.error('admin_analytics_export_failed');
    return adminError('analytics_unavailable', 503);
  }
}
