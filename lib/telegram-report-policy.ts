export const TELEGRAM_REPORT_MODES = ['summary', 'progress_errors', 'all_answers'] as const;

export type TelegramReportMode = typeof TELEGRAM_REPORT_MODES[number];

export function normalizeTelegramReportMode(value?: string): TelegramReportMode {
  const normalized = value?.trim().toLowerCase();
  return TELEGRAM_REPORT_MODES.includes(normalized as TelegramReportMode)
    ? normalized as TelegramReportMode
    : 'progress_errors';
}

export function telegramReportPolicy(mode: TelegramReportMode) {
  return {
    createProgressCard: mode !== 'summary',
    sendAnswer: (correct: boolean) => mode === 'all_answers' || !correct,
  };
}
