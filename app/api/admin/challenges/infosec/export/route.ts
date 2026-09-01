import { securityChallengeAdminReport } from '@/db/security-challenge.ts';
import { adminJson } from '@/lib/admin-analytics.ts';
import {
  ADMIN_NO_STORE_HEADERS,
  adminError,
  guardAdminRequest,
  isGuardFailure,
} from '@/lib/admin-request.ts';

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const guard = await guardAdminRequest(request);
  if (isGuardFailure(guard)) return guard;
  try {
    const format = new URL(request.url).searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') return adminError('invalid_request', 400);
    const report = await securityChallengeAdminReport();
    const safeReport = {
      overview: report.overview,
      attempts: report.attempts,
      difficulties: report.difficulties,
      questions: report.questions,
    };
    if (format === 'json') return adminJson(safeReport, {
      headers: { 'Content-Disposition': 'attachment; filename="security-challenge.json"' },
    });
    const columns = [
      'nickname', 'status', 'completion_reason', 'score', 'correct_count',
      'incorrect_count', 'timeout_count', 'started_at', 'completed_at',
    ] as const;
    const csv = [
      columns.join(';'),
      ...report.attempts.map((attempt) => columns.map((column) => (
        csvCell((attempt as Record<string, unknown>)[column])
      )).join(';')),
    ].join('\r\n');
    return new Response(`\uFEFF${csv}\r\n`, {
      headers: {
        ...ADMIN_NO_STORE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="security-challenge-attempts.csv"',
      },
    });
  } catch {
    console.error('security_challenge_export_failed');
    return adminError('analytics_unavailable', 503);
  }
}
