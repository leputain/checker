import { appPath } from '@/lib/app-path.ts';
import type {
  AdminApiErrorCode,
  AdminApiErrorDto,
  AnalyticsCandidatePolicy,
  AnalyticsCohortQuery,
  AnalyticsQualityStatus,
  AnalyticsQuestionKind,
  AnalyticsSampleGate,
} from '@/lib/analytics-contract.ts';

export type AdminFilters = {
  from: string;
  to: string;
  bankRevision: string;
  scoringVersion: string;
  testConfigId: string;
  testProfileId: string;
  appVersion: string;
  topic: string;
  difficulty: string;
  questionKind: AnalyticsQuestionKind;
  qualityStatus: AnalyticsQualityStatus;
  minSample: AnalyticsSampleGate;
  candidatePolicy: AnalyticsCandidatePolicy;
};

function localDateInputValue(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const today = Date.now();

export const DEFAULT_ADMIN_FILTERS: AdminFilters = {
  from: localDateInputValue(today - 29 * 24 * 60 * 60 * 1_000),
  to: localDateInputValue(today),
  bankRevision: '',
  scoringVersion: '',
  testConfigId: '',
  testProfileId: '',
  appVersion: '',
  topic: '',
  difficulty: '',
  questionKind: 'base',
  qualityStatus: 'all',
  minSample: 30,
  candidatePolicy: 'latest',
};

export class AdminRequestError extends Error {
  readonly status: number;
  readonly code: AdminApiErrorCode;

  constructor(status: number, code: AdminApiErrorCode) {
    super(code);
    this.name = 'AdminRequestError';
    this.status = status;
    this.code = code;
  }
}

export function adminErrorMessage(error: unknown) {
  if (!(error instanceof AdminRequestError)) {
    return 'Не удалось связаться с локальным сервером. Повторите попытку.';
  }
  return {
    admin_disabled: 'Раздел аналитики отключён на локальном сервере.',
    invalid_request: 'Проверьте выбранные фильтры и повторите запрос.',
    unauthorized: 'Сессия администратора завершена. Войдите снова.',
    rate_limited: 'Слишком много попыток. Подождите немного и повторите вход.',
    csrf_invalid: 'Защитный токен устарел. Войдите снова.',
    not_found: 'Запрошенные данные больше недоступны.',
    bank_revision_conflict: 'Банк вопросов изменился в другой вкладке. Обновите данные и повторите действие.',
    idempotency_conflict: 'Повтор операции не совпадает с исходным запросом. Обновите страницу.',
    question_has_successor: 'У вопроса уже есть новая редакция. Откройте актуальную версию.',
    question_validation_failed: 'Проверьте текст вопроса, варианты и правильный ответ.',
    question_bank_not_ready: 'Изменение нарушит рабочие квоты теста. Сначала добавьте резервный вопрос.',
    analytics_unavailable: 'Аналитика временно недоступна. Тестирование продолжает работать.',
    analytics_refresh_required: 'Данные аналитики устарели. Обновите их перед просмотром.',
  }[error.code];
}

function isAdminErrorCode(value: unknown): value is AdminApiErrorCode {
  return typeof value === 'string' && [
    'admin_disabled',
    'invalid_request',
    'unauthorized',
    'rate_limited',
    'csrf_invalid',
    'not_found',
    'bank_revision_conflict',
    'idempotency_conflict',
    'question_has_successor',
    'question_validation_failed',
    'question_bank_not_ready',
    'analytics_unavailable',
    'analytics_refresh_required',
  ].includes(value);
}

export async function adminRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const response = await fetch(appPath(path), {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    let code: AdminApiErrorCode = response.status === 401 ? 'unauthorized' : 'analytics_unavailable';
    try {
      const payload = await response.json() as Partial<AdminApiErrorDto>;
      if (isAdminErrorCode(payload.error)) code = payload.error;
    } catch {
      // A proxy may return an HTML error page; keep the safe generic code.
    }
    throw new AdminRequestError(response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function cohortSearchParams(filters: AdminFilters) {
  const query: AnalyticsCohortQuery = {
    questionKind: filters.questionKind,
    qualityStatus: filters.qualityStatus,
    minSample: filters.minSample,
    candidatePolicy: filters.candidatePolicy,
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.bankRevision ? { bankRevision: filters.bankRevision } : {}),
    ...(filters.scoringVersion ? { scoringVersion: Number(filters.scoringVersion) } : {}),
    ...(filters.testConfigId ? { testConfigId: filters.testConfigId } : {}),
    ...(filters.testProfileId ? { testProfileId: filters.testProfileId } : {}),
    ...(filters.appVersion ? { appVersion: filters.appVersion } : {}),
    ...(filters.topic ? { topic: filters.topic } : {}),
    ...(filters.difficulty ? { difficulty: filters.difficulty } : {}),
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

export function analyticsPath(resource: string, filters: AdminFilters) {
  const params = cohortSearchParams(filters);
  return `/api/admin/analytics/${resource}?${params.toString()}`;
}

export function loginPath() {
  return appPath('/admin/login');
}

export function analyticsPagePath() {
  return appPath('/admin/analytics');
}
