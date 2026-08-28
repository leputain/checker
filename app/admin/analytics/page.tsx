'use client';

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AdminSessionDto,
  AnalyticsCohortDto,
  AnalyticsListDto,
  AnalyticsOverviewDto,
  AnalyticsPagedListDto,
  AnalyticsReliability,
  AnalyticsRevisionItemDto,
  AnalyticsRevisionComparisonDto,
  AnalyticsTrendItemDto,
  AnalyticsVerdict,
  CandidateAnalyticsItemDto,
  CandidateDimensionPerformanceDto,
  CandidatePrintDto,
  CreateQuestionReviewDto,
  GroupAnalyticsItemDto,
  QuestionAnalyticsDetailDto,
  QuestionAnalyticsItemDto,
  QuestionKindSplitDto,
  QuestionReviewDecision,
  QuestionReviewDto,
} from '@/lib/analytics-contract.ts';
import { ANALYTICS_SAMPLE_GATES } from '@/lib/analytics-contract.ts';
import { appPath } from '@/lib/app-path.ts';
import { APP_RELEASE } from '@/lib/release.ts';
import { SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID } from '@/lib/test-config.ts';
import {
  AdminRequestError,
  DEFAULT_ADMIN_FILTERS,
  adminErrorMessage,
  adminRequest,
  analyticsPath,
  cohortSearchParams,
  loginPath,
  type AdminFilters,
} from '../admin-client.ts';
import styles from '../admin.module.css';

type AnalyticsTab = 'overview' | 'questions' | 'candidates' | 'topics' | 'difficulty';
type SessionState = 'checking' | 'ready' | 'disabled' | 'unavailable';
type RefreshState = 'idle' | 'required' | 'refreshing' | 'failed';

const tabLabels: Record<AnalyticsTab, string> = {
  overview: 'Обзор',
  questions: 'Вопросы',
  candidates: 'Кандидаты',
  topics: 'Темы',
  difficulty: 'Сложность',
};

const reliabilityLabels: Record<AnalyticsReliability, string> = {
  insufficient: 'Недостаточно данных',
  descriptive: 'Предварительно',
  directional: 'Устойчивый сигнал',
  stable: 'Стабильно',
};

const verdictLabels: Record<AnalyticsVerdict, string> = {
  PASS: 'Рекомендован',
  REVIEW: 'К просмотру',
  FAIL: 'Не рекомендован',
};

const difficultyLabels: Record<string, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};

const reviewDecisionLabels: Record<QuestionReviewDecision, string> = {
  keep: 'Оставить',
  observe: 'Наблюдать',
  disable_requested: 'Запрошено отключение',
  new_revision_required: 'Нужна новая редакция',
};

const qualityWarningLabels: Record<QuestionAnalyticsItemDto['qualityWarnings'][number], string> = {
  insufficient: 'Недостаточно данных',
  too_easy: 'Фактически проще заявленного',
  too_hard: 'Фактически сложнее заявленного',
  high_timeout: 'Высокая доля timeout',
  slow: 'Аномально долгое решение',
  negative_discrimination: 'Негативная дискриминация',
};

const qualityComponentLabels: Record<QuestionAnalyticsItemDto['quality']['components'][number]['key'], string> = {
  difficulty_fit: 'Соответствие сложности',
  timeout_health: 'Timeout',
  timing_consistency: 'Стабильность времени',
  distractor: 'Дистракторы',
  discrimination: 'Дискриминация',
};

function reviewDecisionLabel(value: QuestionReviewDecision) {
  return reviewDecisionLabels[value];
}

function performanceLabel(value: CandidateDimensionPerformanceDto['classification']) {
  return {
    strong: 'Сильная тема',
    normal: 'Нормальный уровень',
    review: 'Зона проверки',
    insufficient: 'Недостаточно данных',
  }[value];
}

function qualityStatusLabel(value: QuestionAnalyticsItemDto['quality']['status']) {
  return {
    good: 'Хороший',
    observe: 'Требует наблюдения',
    review: 'Требует проверки',
    insufficient: 'Недостаточно данных',
    disabled: 'Вопрос отключён',
  }[value];
}

function questionKindLabel(value: QuestionAnalyticsItemDto['kind']) {
  return value === 'base' ? 'основной' : value === 'additional' ? 'дополнительный' : 'все роли';
}

function percentage(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

function secondsLabel(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)} сек.`;
}

function durationLabel(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function dateLabel(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(timestamp);
}

function dateTimeLabel(value: string | null) {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function exportHref(format: 'csv' | 'json', filters: AdminFilters) {
  const params = cohortSearchParams(filters);
  params.set('format', format);
  return appPath(`/api/admin/analytics/export?${params.toString()}`);
}

export default function AdminAnalyticsPage() {
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [session, setSession] = useState<AdminSessionDto | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const [draftFilters, setDraftFilters] = useState<AdminFilters>(DEFAULT_ADMIN_FILTERS);
  const [filters, setFilters] = useState<AdminFilters>(DEFAULT_ADMIN_FILTERS);
  const [revisions, setRevisions] = useState<AnalyticsRevisionItemDto[]>([]);
  const [filtersRevision, setFiltersRevision] = useState(0);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');

  useEffect(() => {
    let cancelled = false;
    void adminRequest<AdminSessionDto>('/api/admin/session')
      .then((nextSession) => {
        if (cancelled) return;
        if (!nextSession.enabled) {
          setSessionState('disabled');
          return;
        }
        if (!nextSession.authenticated) {
          window.location.replace(loginPath());
          return;
        }
        setSession(nextSession);
        setSessionState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof AdminRequestError && error.code === 'unauthorized') {
          window.location.replace(loginPath());
          return;
        }
        setSessionState(error instanceof AdminRequestError && error.code === 'admin_disabled'
          ? 'disabled'
          : 'unavailable');
        setSessionError(adminErrorMessage(error));
      });
    return () => { cancelled = true; };
  }, []);

  const handleAdminError = useCallback((error: unknown) => {
    if (
      error instanceof AdminRequestError &&
      (error.code === 'unauthorized' || error.code === 'csrf_invalid')
    ) {
      window.location.replace(loginPath());
      return;
    }
    if (error instanceof AdminRequestError && error.code === 'admin_disabled') {
      setSessionState('disabled');
    }
    if (error instanceof AdminRequestError && error.code === 'analytics_refresh_required') {
      setRefreshState('required');
    }
  }, []);

  useEffect(() => {
    if (sessionState !== 'ready') return;
    const controller = new AbortController();
    const revisionFilters: AdminFilters = {
      ...DEFAULT_ADMIN_FILTERS,
      from: '',
      to: '',
      questionKind: 'all',
      qualityStatus: 'all',
      candidatePolicy: filters.candidatePolicy,
    };
    void adminRequest<AnalyticsListDto<AnalyticsRevisionItemDto>>(
      analyticsPath('revisions', revisionFilters),
      { signal: controller.signal },
    ).then((payload) => setRevisions(payload.items ?? [])).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      handleAdminError(error);
    });
    return () => controller.abort();
  }, [filters.candidatePolicy, filtersRevision, handleAdminError, sessionState]);

  async function refreshAnalytics() {
    if (!session?.csrfToken || refreshState === 'refreshing') return;
    setRefreshState('refreshing');
    setSessionError('');
    try {
      await adminRequest('/api/admin/analytics/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify({ rebuild: true }),
      });
      setRefreshState('idle');
      setFiltersRevision((value) => value + 1);
    } catch (error) {
      handleAdminError(error);
      setRefreshState('failed');
      setSessionError(adminErrorMessage(error));
    }
  }

  async function logout() {
    try {
      await adminRequest<void>('/api/admin/session', {
        method: 'DELETE',
        headers: session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : undefined,
      });
    } finally {
      window.location.replace(loginPath());
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftFilters.from && draftFilters.to && draftFilters.from > draftFilters.to) {
      setSessionError('Начало периода не может быть позже окончания.');
      return;
    }
    setSessionError('');
    setFilters({ ...draftFilters });
    setFiltersRevision((value) => value + 1);
  }

  function resetFilters() {
    setSessionError('');
    setDraftFilters(DEFAULT_ADMIN_FILTERS);
    setFilters(DEFAULT_ADMIN_FILTERS);
    setFiltersRevision((value) => value + 1);
  }

  function moveTab(event: ReactKeyboardEvent<HTMLElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Object.keys(tabLabels) as AnalyticsTab[];
    const current = tabs.indexOf(activeTab);
    const next = event.key === 'Home'
      ? tabs[0]
      : event.key === 'End'
        ? tabs.at(-1)!
        : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    setActiveTab(next);
    window.requestAnimationFrame(() => document.getElementById(`admin-tab-${next}`)?.focus());
  }

  if (sessionState !== 'ready') {
    const title = sessionState === 'checking'
      ? 'Открываем аналитику…'
      : sessionState === 'disabled'
        ? 'Аналитика отключена'
        : 'Аналитика недоступна';
    const message = sessionState === 'checking'
      ? 'Проверяем локальную административную сессию.'
      : sessionState === 'disabled'
        ? 'Сервер запущен без административного раздела. Тестирование кандидатов продолжает работать.'
        : sessionError || 'Не удалось загрузить административный раздел.';
    return <AdminStatePage title={title} message={message} retry={sessionState === 'unavailable'} />;
  }

  return (
    <main className={styles.shell}>
      <header className={styles.adminHeader}>
        <a className={styles.brand} href={appPath('/')} aria-label="Candidate Check — стартовая страница">
          <span className={styles.brandMark} aria-hidden="true" />
          <span>Candidate Check</span>
        </a>
        <div className={styles.headerTitle}>
          <span>Локальная панель</span>
          <strong>Аналитика</strong>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.privateBadge}>Обезличено</span>
          <button className={styles.headerButton} onClick={() => void logout()}>Выйти</button>
        </div>
      </header>

      <div className={styles.adminContent}>
        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Candidate analytics</p>
            <h1>Сигналы для решения, а не BI ради BI.</h1>
            <p>Результаты кандидатов, качество банка и точки для следующего интервью — в одной локальной панели.</p>
          </div>
          <div className={styles.exportGroup} aria-label="Экспорт текущей когорты">
            <span>Экспорт когорты</span>
            <a href={exportHref('csv', filters)} download>CSV</a>
            <a href={exportHref('json', filters)} download>JSON</a>
          </div>
        </section>

        {refreshState !== 'idle' && (
          <section className={styles.refreshBanner} role="status" aria-live="polite">
            <div>
              <strong>{refreshState === 'refreshing' ? 'Обновляем аналитику…' : 'Аналитику нужно обновить'}</strong>
              <p>{refreshState === 'refreshing'
                ? 'Пересчитываем обезличенные агрегаты. Тестирование кандидатов не останавливается.'
                : 'После нового теста отчёты помечены как устаревшие. Запустите безопасный пересчёт.'}</p>
            </div>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={refreshState === 'refreshing'}
              onClick={() => void refreshAnalytics()}
            >
              {refreshState === 'refreshing' ? 'Обновляем…' : 'Обновить аналитику'}
            </button>
          </section>
        )}

        <nav className={styles.tabs} role="tablist" aria-label="Разделы аналитики" onKeyDown={moveTab}>
          {(Object.keys(tabLabels) as AnalyticsTab[]).map((tab) => (
            <button
              key={tab}
              id={`admin-tab-${tab}`}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`admin-panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </nav>

        <FilterBar
          filters={draftFilters}
          revisions={revisions}
          error={sessionError}
          onChange={setDraftFilters}
          onApply={applyFilters}
          onReset={resetFilters}
        />

        <section
          id={`admin-panel-${activeTab}`}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={`admin-tab-${activeTab}`}
        >
          {activeTab === 'overview' && (
            <>
              <OverviewPanel filters={filters} revision={filtersRevision} onAdminError={handleAdminError} />
              <RevisionComparisonPanel
                filters={filters}
                revision={filtersRevision}
                revisions={revisions}
                onAdminError={handleAdminError}
              />
            </>
          )}
          {activeTab === 'questions' && (
            <QuestionsPanel
              filters={filters}
              revision={filtersRevision}
              csrfToken={session?.csrfToken ?? ''}
              onAdminError={handleAdminError}
            />
          )}
          {activeTab === 'candidates' && (
            <CandidatesPanel filters={filters} revision={filtersRevision} onAdminError={handleAdminError} />
          )}
          {activeTab === 'topics' && (
            <GroupsPanel
              title="Аналитика по темам"
              description="Где банк и кандидаты показывают устойчивые сильные или слабые сигналы."
              resource="topics"
              filters={filters}
              revision={filtersRevision}
              onAdminError={handleAdminError}
            />
          )}
          {activeTab === 'difficulty' && (
            <GroupsPanel
              title="Аналитика по сложности"
              description="Сверка заявленной сложности с фактическими ответами и таймаутами."
              resource="difficulty"
              filters={filters}
              revision={filtersRevision}
              onAdminError={handleAdminError}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function FilterBar({
  filters,
  revisions,
  error,
  onChange,
  onApply,
  onReset,
}: {
  filters: AdminFilters;
  revisions: AnalyticsRevisionItemDto[];
  error: string;
  onChange: (filters: AdminFilters) => void;
  onApply: (event: FormEvent<HTMLFormElement>) => void;
  onReset: () => void;
}) {
  return (
    <form className={styles.filterBar} onSubmit={onApply}>
      <div className={styles.filterHeading}>
        <span>Когорта</span>
        <small>Фильтры применяются ко всем вкладкам</small>
      </div>
      <details className={styles.modelFilters}>
        <summary>
          <span>Модель</span>
          <small>Авто · текущая модель сервера</small>
        </summary>
        <div className={styles.modelFilterGrid}>
          <label>
            <span>Версия scoring</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="1000"
              step="1"
              value={filters.scoringVersion}
              onChange={(event) => onChange({ ...filters, scoringVersion: event.target.value })}
              placeholder={String(SCORING_VERSION)}
            />
          </label>
          <label>
            <span>Конфигурация теста</span>
            <input
              value={filters.testConfigId}
              onChange={(event) => onChange({ ...filters, testConfigId: event.target.value.trim() })}
              placeholder={TEST_CONFIG_ID}
              minLength={64}
              maxLength={64}
              pattern="[a-f0-9]{64}"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Профиль теста</span>
            <input
              value={filters.testProfileId}
              onChange={(event) => onChange({ ...filters, testProfileId: event.target.value.trim() })}
              placeholder={TEST_PROFILE_ID}
              maxLength={96}
              pattern="[a-zA-Z0-9._:-]{1,96}"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Версия приложения</span>
            <input
              value={filters.appVersion}
              onChange={(event) => onChange({ ...filters, appVersion: event.target.value.trim() })}
              placeholder={APP_RELEASE}
              maxLength={96}
              pattern="[a-zA-Z0-9._:-]{1,96}"
              spellCheck={false}
            />
          </label>
        </div>
        <p>Пустые поля используют активную модель сервера — включая balanced-профиль при его включении.</p>
      </details>
      <label>
        <span>С даты</span>
        <input
          type="date"
          value={filters.from}
          onChange={(event) => onChange({ ...filters, from: event.target.value })}
        />
      </label>
      <label>
        <span>По дату</span>
        <input
          type="date"
          value={filters.to}
          onChange={(event) => onChange({ ...filters, to: event.target.value })}
        />
      </label>
      <label>
        <span>Ревизия банка</span>
        <select
          value={filters.bankRevision}
          onChange={(event) => onChange({ ...filters, bankRevision: event.target.value })}
        >
          <option value="">Текущая когорта</option>
          {revisions.map((item) => (
            <option value={item.revision} key={item.revision}>
              {item.revision.slice(0, 10)} · {item.attempts}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Тип вопроса</span>
        <select
          value={filters.questionKind}
          onChange={(event) => onChange({
            ...filters,
            questionKind: event.target.value as AdminFilters['questionKind'],
          })}
        >
          <option value="all">Все</option>
          <option value="base">Основные</option>
          <option value="additional">Дополнительные</option>
        </select>
      </label>
      <label>
        <span>Тема</span>
        <input
          value={filters.topic}
          onChange={(event) => onChange({ ...filters, topic: event.target.value })}
          placeholder="Все темы"
        />
      </label>
      <label>
        <span>Сложность</span>
        <select
          value={filters.difficulty}
          onChange={(event) => onChange({ ...filters, difficulty: event.target.value })}
        >
          <option value="">Все уровни</option>
          <option value="easy">Базовый</option>
          <option value="medium">Средний</option>
          <option value="hard">Сложный</option>
          <option value="expert">Экспертный</option>
        </select>
      </label>
      <label>
        <span>Качество</span>
        <select
          value={filters.qualityStatus}
          onChange={(event) => onChange({
            ...filters,
            qualityStatus: event.target.value as AdminFilters['qualityStatus'],
          })}
        >
          <option value="all">Все статусы</option>
          <option value="needs_review">Требует проверки</option>
          <option value="healthy">Без замечаний</option>
          <option value="insufficient">Мало данных</option>
        </select>
      </label>
      <label>
        <span>Мин. выборка</span>
        <select
          value={filters.minSample}
          onChange={(event) => onChange({
            ...filters,
            minSample: Number(event.target.value) as AdminFilters['minSample'],
          })}
        >
          {ANALYTICS_SAMPLE_GATES.map((gate) => <option value={gate} key={gate}>{gate}</option>)}
        </select>
      </label>
      <label>
        <span>Повторные попытки</span>
        <select
          value={filters.candidatePolicy}
          onChange={(event) => onChange({
            ...filters,
            candidatePolicy: event.target.value as AdminFilters['candidatePolicy'],
          })}
        >
          <option value="latest">Последняя кандидата</option>
          <option value="all">Все попытки</option>
        </select>
      </label>
      <div className={styles.filterActions}>
        <button className={styles.primaryButton} type="submit">Применить</button>
        <button className={styles.quietButton} type="button" onClick={onReset}>Сбросить</button>
      </div>
      {error && <p className={styles.filterError} role="alert">{error}</p>}
    </form>
  );
}

function useAdminResource<T>(
  resource: string,
  filters: AdminFilters,
  revision: number,
  onAdminError: (error: unknown) => void,
) {
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestKey = `${resource}:${JSON.stringify(filters)}:${revision}:${reloadRevision}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({
    key: '',
    data: null,
    error: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    void adminRequest<T>(analyticsPath(resource, filters), { signal: controller.signal })
      .then((payload) => setState({ key: requestKey, data: payload, error: '' }))
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        onAdminError(requestError);
        setState({ key: requestKey, data: null, error: adminErrorMessage(requestError) });
      });
    return () => controller.abort();
  }, [filters, onAdminError, requestKey, resource]);

  return {
    data: state.key === requestKey ? state.data : null,
    loading: state.key !== requestKey,
    error: state.key === requestKey ? state.error : '',
    reload: () => setReloadRevision((value) => value + 1),
  };
}

function questionPageKey(item: QuestionAnalyticsItemDto) {
  return `${item.questionId}:${item.kind}`;
}

function candidatePageKey(item: CandidateAnalyticsItemDto) {
  return item.attemptId;
}

function usePagedAdminResource<T>(
  resource: string,
  filters: AdminFilters,
  revision: number,
  onAdminError: (error: unknown) => void,
  itemKey: (item: T) => string,
) {
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestKey = `${resource}:${JSON.stringify(filters)}:${revision}:${reloadRevision}`;
  const [state, setState] = useState<{
    key: string;
    data: AnalyticsPagedListDto<T> | null;
    error: string;
    loadingMore: boolean;
  }>({ key: '', data: null, error: '', loadingMore: false });

  useEffect(() => {
    const controller = new AbortController();
    void adminRequest<AnalyticsPagedListDto<T>>(analyticsPath(resource, filters), {
      signal: controller.signal,
    }).then((payload) => setState({
      key: requestKey,
      data: payload,
      error: '',
      loadingMore: false,
    })).catch((requestError: unknown) => {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      onAdminError(requestError);
      setState({
        key: requestKey,
        data: null,
        error: adminErrorMessage(requestError),
        loadingMore: false,
      });
    });
    return () => controller.abort();
  }, [filters, onAdminError, requestKey, resource]);

  async function loadMore() {
    const current = state.key === requestKey ? state.data : null;
    if (!current?.nextCursor || state.loadingMore) return;
    const params = cohortSearchParams(filters);
    params.set('cursor', current.nextCursor);
    setState((previous) => previous.key === requestKey
      ? { ...previous, loadingMore: true, error: '' }
      : previous);
    try {
      const next = await adminRequest<AnalyticsPagedListDto<T>>(
        `/api/admin/analytics/${resource}?${params.toString()}`,
      );
      setState((previous) => {
        if (previous.key !== requestKey || !previous.data) return previous;
        const merged = new Map(previous.data.items.map((item) => [itemKey(item), item]));
        for (const item of next.items) merged.set(itemKey(item), item);
        return {
          key: requestKey,
          data: { ...next, items: [...merged.values()] },
          error: '',
          loadingMore: false,
        };
      });
    } catch (requestError) {
      onAdminError(requestError);
      setState((previous) => previous.key === requestKey
        ? { ...previous, error: adminErrorMessage(requestError), loadingMore: false }
        : previous);
    }
  }

  return {
    data: state.key === requestKey ? state.data : null,
    loading: state.key !== requestKey,
    loadingMore: state.key === requestKey && state.loadingMore,
    error: state.key === requestKey ? state.error : '',
    reload: () => setReloadRevision((value) => value + 1),
    loadMore,
  };
}

function OverviewPanel({
  filters,
  revision,
  onAdminError,
}: PanelProps) {
  const overview = useAdminResource<AnalyticsOverviewDto>('overview', filters, revision, onAdminError);
  const trends = useAdminResource<AnalyticsListDto<AnalyticsTrendItemDto>>('trends', filters, revision, onAdminError);

  if (overview.loading) return <LoadingState />;
  if (overview.error || !overview.data) {
    return <ErrorState message={overview.error} onRetry={overview.reload} />;
  }

  const data = overview.data;
  const recent = data.last30Days;
  const total = data.allTime;
  const totalVerdicts = Object.values(recent.verdicts).reduce((sum, count) => sum + count, 0);
  return (
    <div className={styles.panelStack}>
      <PanelHeading
        title="Общая картина"
        description="Каждая цифра рассчитана для одной и той же выбранной когорты."
        cohort={data.cohort}
      />
      {total.completedAttempts === 0 ? <EmptyState /> : (
        <>
          <div className={styles.kpiGrid}>
            <MetricCard label="Всего прохождений" value={String(total.completedAttempts)} note="за период хранения" />
            <MetricCard label="Последние 30 дней" value={String(recent.completedAttempts)} note={`${recent.uniqueCandidates} кандидатов`} />
            <MetricCard label="Средний результат" value={recent.meanScore === null ? '—' : `${Math.round(recent.meanScore)} / 100`} note="30 дней" />
            <MetricCard label="Медианный результат" value={recent.medianScore === null ? '—' : `${Math.round(recent.medianScore)} / 100`} note="30 дней" />
            <MetricCard label="Средняя точность" value={percentage(recent.meanAccuracy)} note="30 дней" />
            <MetricCard label="Медианное время" value={recent.medianDurationSeconds === null ? '—' : durationLabel(recent.medianDurationSeconds)} note="30 дней" />
          </div>

          <section className={styles.analyticsCard}>
            <div className={styles.cardHeading}>
              <div><p className={styles.eyebrow}>Shadow rollout</p><h2>Coverage Score</h2></div>
              <span>последние 30 дней</span>
            </div>
            <div className={styles.kpiGrid}>
              <MetricCard label="Сопоставимая выборка" value={String(recent.selectionComparison.sampleSize)} note={`${recent.selectionComparison.eligibleAttempts} legacy-планов`} />
              <MetricCard label="Фактическое покрытие" value={recent.selectionComparison.actualCoverage === null ? '—' : String(recent.selectionComparison.actualCoverage)} note="только парные наблюдения" />
              <MetricCard label="Shadow-покрытие" value={recent.selectionComparison.shadowCoverage === null ? '—' : String(recent.selectionComparison.shadowCoverage)} note="без влияния на тест" />
              <MetricCard label="Дельта shadow" value={signed(recent.selectionComparison.delta)} note="shadow − actual" />
              <MetricCard label="Fallback / нет shadow" value={percentage(recent.selectionComparison.fallbackOrNullRate)} note={`${recent.selectionComparison.fallbackOrNullCount} попыток`} />
            </div>
          </section>

          <div className={styles.splitGrid}>
            <section className={styles.analyticsCard}>
              <div className={styles.cardHeading}>
                <div><p className={styles.eyebrow}>Решения</p><h2>Распределение verdict</h2></div>
                <span>{totalVerdicts}</span>
              </div>
              <div className={styles.barList}>
                {(Object.keys(verdictLabels) as AnalyticsVerdict[]).map((verdict) => {
                  const count = recent.verdicts[verdict];
                  const share = totalVerdicts > 0 ? Math.round((count / totalVerdicts) * 100) : 0;
                  return (
                    <div className={styles.barRow} key={verdict}>
                      <div><span>{verdictLabels[verdict]}</span><strong>{count} · {share}%</strong></div>
                      <span className={styles.barTrack} aria-hidden="true"><i className={styles[`bar${verdict}`]} style={{ width: `${share}%` }} /></span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className={styles.analyticsCard}>
              <div className={styles.cardHeading}>
                <div><p className={styles.eyebrow}>Баллы</p><h2>Распределение результатов</h2></div>
              </div>
              <ScoreHistogram items={recent.scoreHistogram} />
            </section>
          </div>

          <section className={styles.analyticsCard}>
            <div className={styles.cardHeading}>
              <div><p className={styles.eyebrow}>Динамика</p><h2>Последние периоды</h2></div>
            </div>
            {trends.loading ? <LoadingState compact /> : trends.error ? (
              <ErrorState message={trends.error} onRetry={trends.reload} compact />
            ) : !trends.data?.items?.length ? <EmptyState compact /> : (
              <TrendRows items={trends.data.items} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function signed(value: number | null, suffix = '') {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}${suffix}`;
}

function RevisionComparisonPanel({
  filters,
  revision,
  revisions,
  onAdminError,
}: PanelProps & { revisions: AnalyticsRevisionItemDto[] }) {
  const [leftRevision, setLeftRevision] = useState('');
  const [rightRevision, setRightRevision] = useState('');
  const [state, setState] = useState<{
    key: string;
    data: AnalyticsRevisionComparisonDto | null;
    error: string;
  }>({ key: '', data: null, error: '' });

  const availableRevisions = new Set(revisions.map((item) => item.revision));
  const validSelection = availableRevisions.has(leftRevision)
    && availableRevisions.has(rightRevision)
    && leftRevision !== rightRevision;
  const selectedLeft = validSelection ? leftRevision : revisions[1]?.revision ?? '';
  const selectedRight = validSelection ? rightRevision : revisions[0]?.revision ?? '';
  const requestKey = `${selectedLeft}:${selectedRight}:${JSON.stringify(filters)}:${revision}`;
  useEffect(() => {
    if (!selectedLeft || !selectedRight || selectedLeft === selectedRight) return;
    const controller = new AbortController();
    const params = cohortSearchParams(filters);
    params.delete('bankRevision');
    params.set('leftRevision', selectedLeft);
    params.set('rightRevision', selectedRight);
    void adminRequest<AnalyticsRevisionComparisonDto>(
      `/api/admin/analytics/revisions/compare?${params.toString()}`,
      { signal: controller.signal },
    ).then((data) => setState({ key: requestKey, data, error: '' }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        onAdminError(error);
        setState({ key: requestKey, data: null, error: adminErrorMessage(error) });
      });
    return () => controller.abort();
  }, [filters, onAdminError, requestKey, selectedLeft, selectedRight]);

  if (revisions.length < 2) {
    return (
      <section className={styles.analyticsCard}>
        <div className={styles.cardHeading}>
          <div><p className={styles.eyebrow}>A / B</p><h3>Сравнение ревизий</h3></div>
        </div>
        <EmptyState compact />
      </section>
    );
  }
  const data = state.key === requestKey ? state.data : null;
  const loading = state.key !== requestKey;
  const error = state.key === requestKey ? state.error : '';
  const metrics = data ? [
    ['Попытки', data.left.attempts, data.right.attempts, signed(data.deltas.attempts)],
    ['Средний балл', data.left.meanScore, data.right.meanScore, signed(data.deltas.meanScore)],
    ['Медиана балла', data.left.medianScore, data.right.medianScore, signed(data.deltas.medianScore)],
    ['Средняя точность', data.left.meanAccuracy, data.right.meanAccuracy, signed(data.deltas.meanAccuracy, ' п.п.')],
    ['Медиана времени', data.left.medianDurationSeconds, data.right.medianDurationSeconds, signed(data.deltas.medianDurationSeconds, ' с')],
    ['Рекомендованы', data.left.verdicts.PASS, data.right.verdicts.PASS, signed(data.deltas.verdicts.PASS)],
  ] as const : [];

  return (
    <section className={styles.analyticsCard}>
      <div className={styles.cardHeading}>
        <div><p className={styles.eyebrow}>A / B</p><h3>Сравнение ревизий</h3></div>
        <span>Дельта: B − A</span>
      </div>
      <div className={styles.localFilters}>
        <label><span>Ревизия A</span><select value={selectedLeft} onChange={(event) => setLeftRevision(event.target.value)}>{revisions.map((item) => <option key={item.revision} value={item.revision} disabled={item.revision === selectedRight}>{item.revision.slice(0, 10)} · {item.attempts}</option>)}</select></label>
        <label><span>Ревизия B</span><select value={selectedRight} onChange={(event) => setRightRevision(event.target.value)}>{revisions.map((item) => <option key={item.revision} value={item.revision} disabled={item.revision === selectedLeft}>{item.revision.slice(0, 10)} · {item.attempts}</option>)}</select></label>
      </div>
      {loading ? <LoadingState compact /> : error || !data ? (
        <ErrorState message={error} onRetry={() => setState({ key: '', data: null, error: '' })} compact />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead><tr><th>Метрика</th><th>A</th><th>B</th><th>Δ B − A</th></tr></thead>
            <tbody>{metrics.map(([label, left, right, delta]) => <tr key={label}><td data-label="Метрика">{label}</td><td data-label="A">{left ?? '—'}</td><td data-label="B">{right ?? '—'}</td><td data-label="Δ">{delta}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuestionsPanel({
  filters,
  revision,
  csrfToken,
  onAdminError,
}: PanelProps & { csrfToken: string }) {
  const resource = usePagedAdminResource<QuestionAnalyticsItemDto>(
    'questions', filters, revision, onAdminError, questionPageKey,
  );
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState('all');
  const [selected, setSelected] = useState<QuestionAnalyticsItemDto | null>(null);

  const items = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru-RU');
    return (resource.data?.items ?? []).filter((item) => (
      (difficulty === 'all' || item.difficulty === difficulty) &&
      (!query || String(item.questionId).includes(query) || item.topic.toLocaleLowerCase('ru-RU').includes(query))
    ));
  }, [difficulty, resource.data?.items, search]);

  if (resource.loading) return <LoadingState />;
  if (resource.error || !resource.data) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  return (
    <div className={styles.panelStack}>
      <PanelHeading
        title="Качество вопросов"
        description="Выборка, timeout, фактическая сложность и воспроизводимая рекомендация."
        cohort={resource.data.cohort}
      />
      <div className={styles.localFilters}>
        <label>
          <span>Поиск по ID или теме</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Например, Linux или 512" />
        </label>
        <label>
          <span>Сложность</span>
          <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
            <option value="all">Все уровни</option>
            <option value="easy">Базовый</option>
            <option value="medium">Средний</option>
            <option value="hard">Сложный</option>
            <option value="expert">Экспертный</option>
          </select>
        </label>
        <span className={styles.resultCount}>{items.length} вопросов</span>
      </div>
      {items.length === 0 ? <EmptyState /> : (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Вопрос</th><th>Тема</th><th>Уровень</th><th>Показы</th><th>Исходы</th><th>Выборка</th>
                <th>Верно</th><th>Timeout</th><th>Медиана</th><th>Оценка</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.questionId}-${item.kind}`}>
                  <td data-label="Вопрос">
                    <button className={styles.rowLink} onClick={() => setSelected(item)}>#{item.questionId}</button>
                    <small>{questionKindLabel(item.kind)}{item.active ? '' : ' · выключен'}</small>
                  </td>
                  <td data-label="Тема">{item.topic}</td>
                  <td data-label="Уровень">{difficultyLabels[item.difficulty] ?? item.difficulty}</td>
                  <td data-label="Показы">{item.presentedCount}<small>назначено {item.assignedCount}</small></td>
                  <td data-label="Исходы">{item.outcomeCount}<small>{percentage(item.completionRate)} завершено</small></td>
                  <td data-label="Выборка">{item.sampleSize}<small>{reliabilityLabels[item.reliability]}</small></td>
                  <td data-label="Верно">{percentage(item.successRate)}</td>
                  <td data-label="Timeout">{percentage(item.timeoutRate)}</td>
                  <td data-label="Медиана">{secondsLabel(item.medianSeconds)}</td>
                  <td data-label="Оценка"><RecommendationBadge item={item} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resource.data.nextCursor && (
        <div className={styles.loadMoreRow}>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        </div>
      )}
      {selected && (
        <QuestionDetail
          summary={selected}
          filters={filters}
          csrfToken={csrfToken}
          onClose={() => setSelected(null)}
          onAdminError={onAdminError}
        />
      )}
    </div>
  );
}

function CandidatesPanel({ filters, revision, onAdminError }: PanelProps) {
  const resource = usePagedAdminResource<CandidateAnalyticsItemDto>(
    'candidates', filters, revision, onAdminError, candidatePageKey,
  );
  const [verdict, setVerdict] = useState<'all' | AnalyticsVerdict>('all');
  const [selected, setSelected] = useState<CandidateAnalyticsItemDto | null>(null);
  const items = (resource.data?.items ?? []).filter((item) => verdict === 'all' || item.verdict === verdict);

  if (resource.loading) return <LoadingState />;
  if (resource.error || !resource.data) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  return (
    <div className={styles.panelStack}>
      <PanelHeading
        title="Кандидаты"
        description="Обезличенные результаты и профиль для подготовки следующего этапа."
        cohort={resource.data.cohort}
      />
      <div className={styles.localFilters}>
        <label>
          <span>Решение</span>
          <select value={verdict} onChange={(event) => setVerdict(event.target.value as typeof verdict)}>
            <option value="all">Все решения</option>
            <option value="PASS">Рекомендован</option>
            <option value="REVIEW">К просмотру</option>
            <option value="FAIL">Не рекомендован</option>
          </select>
        </label>
        <span className={styles.resultCount}>{items.length} результатов</span>
      </div>
      {items.length === 0 ? <EmptyState /> : (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Кандидат</th><th>Дата</th><th>Результат</th><th>Точность</th>
                <th>Решение</th><th>Основные</th><th>Доп.</th><th>Время</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.attemptId}>
                  <td data-label="Кандидат"><button className={styles.rowLink} onClick={() => setSelected(item)}>{item.alias}</button></td>
                  <td data-label="Дата">{dateLabel(item.completedAt)}</td>
                  <td data-label="Результат"><strong>{item.score} / 100</strong></td>
                  <td data-label="Точность">{item.accuracy}%</td>
                  <td data-label="Решение"><VerdictBadge verdict={item.verdict} /></td>
                  <td data-label="Основные">{item.baseCorrect} / {item.baseAnswered}</td>
                  <td data-label="Доп.">{item.additionalAnswered ? `${item.additionalCorrect} / ${item.additionalAnswered}` : '—'}</td>
                  <td data-label="Время">{durationLabel(item.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resource.data.nextCursor && (
        <div className={styles.loadMoreRow}>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        </div>
      )}
      {selected && (
        <CandidateDetail
          summary={selected}
          filters={filters}
          onClose={() => setSelected(null)}
          onAdminError={onAdminError}
        />
      )}
    </div>
  );
}

function GroupsPanel({
  title,
  description,
  resource,
  filters,
  revision,
  onAdminError,
}: PanelProps & { title: string; description: string; resource: 'topics' | 'difficulty' }) {
  const state = useAdminResource<AnalyticsListDto<GroupAnalyticsItemDto>>(
    resource, filters, revision, onAdminError,
  );
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error} onRetry={state.reload} />;
  const maximumSample = Math.max(1, ...state.data.items.map((item) => item.sampleSize));
  return (
    <div className={styles.panelStack}>
      <PanelHeading title={title} description={description} cohort={state.data.cohort} />
      {state.data.items.length === 0 ? <EmptyState /> : (
        <div className={styles.groupGrid}>
          {state.data.items.map((item) => (
            <article className={styles.groupCard} key={`${item.key}-${item.kind}`}>
              <div className={styles.groupCardTop}>
                <div>
                  <small>{item.kind === 'all' ? 'все вопросы' : item.kind === 'base' ? 'основные' : 'дополнительные'}</small>
                  <h2>{resource === 'difficulty' ? difficultyLabels[item.key] ?? item.key : item.key}</h2>
                </div>
                <ReliabilityBadge reliability={item.reliability} />
              </div>
              <span className={styles.sampleTrack} aria-hidden="true"><i style={{ width: `${(item.sampleSize / maximumSample) * 100}%` }} /></span>
              <div className={styles.groupMetrics}>
                <div><strong>{item.sampleSize}</strong><span>ответов</span></div>
                <div><strong>{percentage(item.successRate)}</strong><span>верно</span></div>
                <div><strong>{percentage(item.timeoutRate)}</strong><span>timeout</span></div>
                <div><strong>{secondsLabel(item.medianSeconds)}</strong><span>медиана</span></div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionDetail({
  summary,
  filters,
  csrfToken,
  onClose,
  onAdminError,
}: {
  summary: QuestionAnalyticsItemDto;
  filters: AdminFilters;
  csrfToken: string;
  onClose: () => void;
  onAdminError: (error: unknown) => void;
}) {
  const detail = useDetailResource<QuestionAnalyticsDetailDto>(
    `questions/${encodeURIComponent(String(summary.questionId))}`,
    filters,
    onAdminError,
  );
  const [decision, setDecision] = useState<QuestionReviewDecision>('observe');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail.data || saving) return;
    if (!csrfToken) {
      setSaveError('Сессия устарела. Войдите снова.');
      return;
    }
    const body: CreateQuestionReviewDto = {
      revision: detail.data.bankRevision,
      decision,
      note: note.trim() || null,
    };
    setSaving(true);
    setSaveError('');
    try {
      await adminRequest<QuestionReviewDto>(
        `/api/admin/analytics/questions/${encodeURIComponent(String(summary.questionId))}/reviews`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(body),
        },
      );
      setNote('');
      detail.reload();
    } catch (error) {
      onAdminError(error);
      setSaveError(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DetailDialog title={`Вопрос #${summary.questionId}`} onClose={onClose}>
      {detail.loading ? <LoadingState compact /> : detail.error || !detail.data ? (
        <ErrorState message={detail.error} onRetry={detail.reload} compact />
      ) : (
        <div className={styles.detailStack}>
          <div className={styles.detailLead}>
            <div className={styles.detailBadges}>
              <span>{difficultyLabels[detail.data.difficulty] ?? detail.data.difficulty}</span>
              <span>{detail.data.topic}</span>
              <span>{questionKindLabel(detail.data.kind)}</span>
              {!detail.data.active && <span className={styles.warningBadge}>Выключен</span>}
            </div>
            <h3>{detail.data.prompt}</h3>
            {detail.data.context && (
              <pre className={styles.contextBlock}><code>{detail.data.context}</code></pre>
            )}
          </div>
          <div className={styles.detailMetrics}>
            <MetricCard label="Назначено" value={String(detail.data.assignedCount)} />
            <MetricCard label="Показано" value={String(detail.data.presentedCount)} />
            <MetricCard label="Исходов" value={String(detail.data.outcomeCount)} note={reliabilityLabels[detail.data.reliability]} />
            <MetricCard label="Ответов" value={String(detail.data.responseCount)} />
            <MetricCard label="Верно" value={percentage(detail.data.successRate)} />
            <MetricCard label="Timeout" value={percentage(detail.data.timeoutRate)} />
            <MetricCard label="Завершено" value={percentage(detail.data.completionRate)} />
            <MetricCard label="Среднее" value={secondsLabel(detail.data.averageSeconds)} />
            <MetricCard label="Медиана" value={secondsLabel(detail.data.medianSeconds)} />
            <MetricCard label="Мин. / макс." value={`${secondsLabel(detail.data.minSeconds)} / ${secondsLabel(detail.data.maxSeconds)}`} />
            <MetricCard label="Дискриминация" value={detail.data.discrimination === null ? '—' : detail.data.discrimination.toFixed(2)} />
          </div>
          <div className={styles.lastUseRow}>
            <span>Последний показ <strong>{dateTimeLabel(detail.data.lastPresentedAt)}</strong></span>
            <span>Последний ответ <strong>{dateTimeLabel(detail.data.lastAnsweredAt)}</strong></span>
          </div>
          <QuestionKindBreakdown base={detail.data.base} additional={detail.data.additional} />
          {detail.data.quality.enabled && <section className={styles.qualityBox}>
            <div className={styles.qualityHeadline}>
              <div><p className={styles.eyebrow}>Question Quality Score</p><h3>{qualityStatusLabel(detail.data.quality.status)}</h3></div>
              <strong>{detail.data.quality.earned} / {detail.data.quality.maxAvailable}</strong>
            </div>
            <div className={styles.qualityComponents}>
              {detail.data.quality.components.map((component) => (
                <div key={component.key}>
                  <div><span>{qualityComponentLabels[component.key]}</span><strong>{component.available ? `${component.earned}/${component.max}` : 'нет данных'}</strong></div>
                  <span className={styles.barTrack} aria-hidden="true"><i style={{ width: component.available && component.max > 0 ? `${(component.earned / component.max) * 100}%` : '0%' }} /></span>
                </div>
              ))}
            </div>
            {detail.data.qualityWarnings.length > 0 && (
              <ul className={styles.qualityWarnings}>
                {detail.data.qualityWarnings.map((warning) => <li key={warning}>{qualityWarningLabels[warning]}</li>)}
              </ul>
            )}
            {detail.data.quality.partial && <small>Индекс рассчитан только по доступным компонентам.</small>}
          </section>}
          {detail.data.recommendation && (
            <section className={styles.recommendationBox}>
              <p className={styles.eyebrow}>Рекомендация</p>
              <h3>{detail.data.recommendation.label}</h3>
              {detail.data.recommendation.reasons.length > 0 && (
                <ul>{detail.data.recommendation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              )}
            </section>
          )}
          <section className={styles.reviewSection}>
            <div className={styles.cardHeading}>
              <div><p className={styles.eyebrow}>Решение администратора</p><h3>Зафиксировать проверку</h3></div>
              <span>{detail.data.bankRevision.slice(0, 10)}</span>
            </div>
            <form className={styles.reviewForm} onSubmit={saveReview}>
              <label>
                <span>Решение</span>
                <select value={decision} onChange={(event) => setDecision(event.target.value as QuestionReviewDecision)}>
                  <option value="keep">Оставить</option>
                  <option value="observe">Наблюдать</option>
                  <option value="disable_requested">Запросить отключение</option>
                  <option value="new_revision_required">Нужна новая редакция</option>
                </select>
              </label>
              <label>
                <span>Комментарий</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={500}
                  placeholder="Коротко зафиксируйте основание решения"
                />
              </label>
              {saveError && <p className={styles.error} role="alert">{saveError}</p>}
              <button className={styles.primaryButton} type="submit" disabled={saving}>
                {saving ? 'Сохраняем…' : 'Сохранить решение'}
              </button>
            </form>
            {detail.data.reviewHistory.length > 0 && (
              <ol className={styles.reviewHistory}>
                {detail.data.reviewHistory.map((review) => (
                  <li key={review.id}>
                    <div><strong>{reviewDecisionLabel(review.decision)}</strong><time dateTime={review.createdAt}>{dateLabel(review.createdAt)}</time></div>
                    {review.note && <p>{review.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Варианты</p><h3>Распределение ответов</h3></div><span>{detail.data.responseCount}</span></div>
            {detail.data.choices.length === 0 ? <EmptyState compact /> : (
              <ol className={styles.choiceStats}>
                {detail.data.choices.map((choice) => (
                  <li key={choice.canonicalIndex}>
                    <span className={styles.choiceIndex}>{String.fromCharCode(65 + choice.canonicalIndex)}</span>
                    <div><strong>Вариант {String.fromCharCode(65 + choice.canonicalIndex)}</strong><small>{choice.selectedCount} выборов · {percentage(choice.selectedRate)}</small></div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </DetailDialog>
  );
}

function CandidateDetail({
  summary,
  filters,
  onClose,
  onAdminError,
}: {
  summary: CandidateAnalyticsItemDto;
  filters: AdminFilters;
  onClose: () => void;
  onAdminError: (error: unknown) => void;
}) {
  const detail = useDetailResource<CandidatePrintDto>(
    `candidates/${encodeURIComponent(summary.attemptId)}`,
    filters,
    onAdminError,
  );

  function downloadReport() {
    if (!detail.data) return;
    const payload = JSON.stringify(detail.data, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `candidate-${summary.attemptId.slice(-8)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return (
    <DetailDialog title={summary.alias} onClose={onClose} printSurface>
      {detail.loading ? <LoadingState compact /> : detail.error || !detail.data ? (
        <ErrorState message={detail.error} onRetry={detail.reload} compact />
      ) : (
        <div className={styles.detailStack}>
          <div className={styles.candidateHero}>
            <div>
              <p className={styles.eyebrow}>Отчёт кандидата</p>
              <h3>{detail.data.score} / 100 баллов</h3>
              <VerdictBadge verdict={detail.data.verdict} />
            </div>
            <div className={styles.detailActions} data-print-hidden>
              <button className={styles.secondaryButton} onClick={() => window.print()}>Печать</button>
              <button className={styles.secondaryButton} onClick={downloadReport}>JSON</button>
            </div>
          </div>
          <div className={styles.detailMetrics}>
            <MetricCard label="Точность" value={`${detail.data.accuracy}%`} />
            <MetricCard label="Основные" value={`${detail.data.baseCorrect} / ${detail.data.baseAnswered}`} />
            <MetricCard label="Дополнительные" value={detail.data.additionalAnswered ? `${detail.data.additionalCorrect} / ${detail.data.additionalAnswered}` : 'не задавались'} />
            <MetricCard label="Timeout" value={String(detail.data.timeoutCount)} />
            <MetricCard label="Время" value={durationLabel(detail.data.durationSeconds)} />
            <MetricCard label="Дата" value={dateLabel(detail.data.completedAt)} />
          </div>
          {detail.data.statisticsCompleteness === 'partial' && (
            <p className={styles.partialNotice}>Профиль частичный: часть исторических фактов недоступна в новой модели аналитики.</p>
          )}
          <ProfileTable title="Темы" rows={detail.data.topics} />
          <ProfileTable
            title="Сложность"
            rows={detail.data.difficulties.map((item) => ({
              ...item,
              key: difficultyLabels[item.key] ?? item.key,
            }))}
          />
          <section className={styles.interviewSection}>
            <div className={styles.cardHeading}>
              <div><p className={styles.eyebrow}>Следующий этап</p><h3>Что проверить на интервью</h3></div>
            </div>
            {detail.data.interviewerRecommendations.length === 0 ? <EmptyState compact /> : (
              <ol className={styles.interviewList}>
                {detail.data.interviewerRecommendations.map((item) => (
                  <li key={`${item.code}-${item.title}`}>
                    <span className={`${styles.badge} ${item.priority === 'high' ? styles.warningBadge : item.priority === 'medium' ? styles.neutralBadge : styles.goodBadge}`}>
                      {item.priority === 'high' ? 'Важно' : item.priority === 'medium' ? 'Проверить' : 'Дополнительно'}
                    </span>
                    <div><strong>{item.title}</strong><p>{item.evidence}</p></div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <p className={styles.generatedAt}>Сформировано {dateLabel(detail.data.generatedAt)} · данные обезличены</p>
        </div>
      )}
    </DetailDialog>
  );
}

function ProfileTable({
  title,
  rows,
}: {
  title: string;
  rows: CandidateDimensionPerformanceDto[];
}) {
  return (
    <section>
      <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Профиль</p><h3>{title}</h3></div></div>
      {rows.length === 0 ? <EmptyState compact /> : (
        <div className={styles.profileRows}>
          {rows.map((row) => (
            <div key={row.key}>
              <div>
                <strong>{row.key}</strong>
                <span>{performanceLabel(row.classification)} · {row.base.correct} из {row.base.resolved} · {percentage(row.base.accuracy)}</span>
              </div>
              <span className={styles.barTrack} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, row.base.accuracy ?? 0))}%` }} /></span>
              <small>
                Основные: {row.base.earned}/{row.base.max} баллов
                {row.additional.presented > 0 ? ` · дополнительные: ${row.additional.correct}/${row.additional.resolved}` : ''}
              </small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function QuestionKindBreakdown({
  base,
  additional,
}: {
  base: QuestionKindSplitDto;
  additional: QuestionKindSplitDto;
}) {
  const rows = [
    { label: 'Основной', data: base },
    { label: 'Дополнительный', data: additional },
  ];
  return (
    <section>
      <div className={styles.cardHeading}>
        <div><p className={styles.eyebrow}>Роли вопроса</p><h3>Основной и дополнительный</h3></div>
      </div>
      <div className={styles.kindBreakdown}>
        {rows.map((row) => (
          <article key={row.label}>
            <div><strong>{row.label}</strong><span>{percentage(row.data.successRate)} верно</span></div>
            <dl>
              <div><dt>Назначено</dt><dd>{row.data.assigned}</dd></div>
              <div><dt>Показано</dt><dd>{row.data.presented}</dd></div>
              <div><dt>Исходов</dt><dd>{row.data.resolved}</dd></div>
              <div><dt>Верно</dt><dd>{row.data.correct}</dd></div>
              <div><dt>Неверно</dt><dd>{row.data.incorrect}</dd></div>
              <div><dt>Timeout</dt><dd>{row.data.timedOut}</dd></div>
              <div><dt>Баллы</dt><dd>{row.data.earned} / {row.data.max}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function useDetailResource<T>(
  resource: string,
  filters: AdminFilters,
  onAdminError: (error: unknown) => void,
) {
  const [revision, setRevision] = useState(0);
  const requestKey = `${resource}:${JSON.stringify(filters)}:${revision}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({
    key: '',
    data: null,
    error: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    void adminRequest<T>(analyticsPath(resource, filters), { signal: controller.signal })
      .then((payload) => setState({ key: requestKey, data: payload, error: '' }))
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        onAdminError(requestError);
        setState({ key: requestKey, data: null, error: adminErrorMessage(requestError) });
      });
    return () => controller.abort();
  }, [filters, onAdminError, requestKey, resource]);
  return {
    data: state.key === requestKey ? state.data : null,
    loading: state.key !== requestKey,
    error: state.key === requestKey ? state.error : '',
    reload: () => setRevision((value) => value + 1),
  };
}

function DetailDialog({
  title,
  onClose,
  children,
  printSurface = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  printSurface?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className={styles.detailBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className={`${styles.detailDialog} ${printSurface ? styles.printSurface : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-detail-title"
        tabIndex={-1}
      >
        <header className={styles.detailHeader}>
          <h2 id="admin-detail-title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" data-print-hidden>×</button>
        </header>
        <div className={styles.detailBody}>{children}</div>
      </section>
    </div>
  );
}

function PanelHeading({
  title,
  description,
  cohort,
}: {
  title: string;
  description: string;
  cohort: AnalyticsCohortDto;
}) {
  return (
    <div className={styles.panelHeading}>
      <div><p className={styles.eyebrow}>Аналитика</p><h2>{title}</h2><p>{description}</p></div>
      <div className={styles.cohortMeta}>
        <span>{cohort.eligibleAttempts} попыток</span>
        <span>{cohort.eligibleAnswers} ответов</span>
        <small>обновлено {dateLabel(cohort.generatedAt)}</small>
      </div>
      {(cohort.warnings.length > 0 || cohort.statisticsCompleteness === 'partial' || !cohort.calibrationEnabled) && (
        <ul className={styles.warningList}>
          {cohort.statisticsCompleteness === 'partial' && <li>Часть исторических фактов доступна только как нижняя граница.</li>}
          {!cohort.calibrationEnabled && <li>Калибровка выключена: показатели носят описательный характер.</li>}
          {cohort.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return <article className={styles.metricCard}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

function ScoreHistogram({ items }: { items: Array<{ from: number; to: number; count: number }> }) {
  const maximum = Math.max(1, ...items.map((item) => item.count));
  if (items.length === 0) return <EmptyState compact />;
  return (
    <div className={styles.histogram} aria-label="Распределение результатов по баллам">
      {items.map((item) => (
        <div key={`${item.from}-${item.to}`}>
          <span>{item.from}–{item.to}</span>
          <span className={styles.barTrack} aria-hidden="true">
            <i style={{ width: `${(item.count / maximum) * 100}%` }} />
          </span>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function TrendRows({ items }: { items: AnalyticsTrendItemDto[] }) {
  const [view, setView] = useState<'summary' | 'topics' | 'difficulty'>('summary');
  const maximum = Math.max(1, ...items.map((item) => item.attempts));
  const visibleItems = items.slice(-12);
  return (
    <div className={styles.trendSurface}>
      <div className={styles.trendViewSwitcher} role="group" aria-label="Разрез динамики">
        {([
          ['summary', 'Итоги'],
          ['topics', 'Темы'],
          ['difficulty', 'Сложность'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'summary' ? (
        <div className={styles.trendRows}>
          {visibleItems.map((item) => (
            <div key={item.date}>
              <time dateTime={item.date}>{dateLabel(item.date)}</time>
              <span className={styles.sampleTrack} aria-hidden="true"><i style={{ width: `${(item.attempts / maximum) * 100}%` }} /></span>
              <strong>{item.attempts}</strong>
              <span className={styles.trendScore}>ср. {item.averageScore ?? '—'} · med {item.medianScore ?? '—'}</span>
              <span className={styles.trendMeta}>
                PASS {percentage(item.passRate)} · P/R/F {item.verdicts.PASS}/{item.verdicts.REVIEW}/{item.verdicts.FAIL}
                {' · '}med {item.medianDurationSeconds === null ? '—' : durationLabel(item.medianDurationSeconds)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.trendDimensionRows}>
          {visibleItems.map((item) => {
            const dimensions = view === 'topics' ? item.topics : item.difficulties;
            return (
              <section key={`${view}-${item.date}`}>
                <header>
                  <time dateTime={item.date}>{dateLabel(item.date)}</time>
                  <span>{item.attempts} попыток</span>
                </header>
                {dimensions.length === 0 ? (
                  <span className={styles.trendDimensionEmpty}>Нет точных исходов</span>
                ) : (
                  <div>
                    {dimensions.toSorted((left, right) => left.key.localeCompare(right.key, 'ru')).map((dimension) => (
                      <article key={dimension.key}>
                        <strong>{view === 'difficulty' ? difficultyLabels[dimension.key] ?? dimension.key : dimension.key}</strong>
                        <span>{dimension.outcomeCount} исходов</span>
                        <span>успех {percentage(dimension.successRate)}</span>
                        <span>таймауты {percentage(dimension.timeoutRate)}</span>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecommendationBadge({ item }: { item: QuestionAnalyticsItemDto }) {
  if (!item.recommendation) {
    return <span className={`${styles.badge} ${styles.neutralBadge}`}>только recovery</span>;
  }
  const tone = item.recommendation.code === 'keep'
    ? styles.goodBadge
    : item.recommendation.code === 'collect_more_data'
      ? styles.neutralBadge
      : styles.warningBadge;
  return <span className={`${styles.badge} ${tone}`}>{item.recommendation.label}</span>;
}

function ReliabilityBadge({ reliability }: { reliability: AnalyticsReliability }) {
  return <span className={`${styles.badge} ${reliability === 'insufficient' ? styles.neutralBadge : styles.goodBadge}`}>{reliabilityLabels[reliability]}</span>;
}

function VerdictBadge({ verdict }: { verdict: AnalyticsVerdict }) {
  return <span className={`${styles.badge} ${styles[`verdict${verdict}`]}`}>{verdictLabels[verdict]}</span>;
}

function LoadingState({ compact = false }: { compact?: boolean }) {
  return <div className={`${styles.loadingState} ${compact ? styles.compactState : ''}`} role="status"><i aria-hidden="true" />Загружаем данные…</div>;
}

function ErrorState({ message, onRetry, compact = false }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div className={`${styles.errorState} ${compact ? styles.compactState : ''}`} role="alert">
      <strong>Данные временно недоступны</strong>
      <p>{message || 'Повторите запрос.'}</p>
      <button className={styles.secondaryButton} onClick={onRetry}>Повторить</button>
    </div>
  );
}

function EmptyState({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`${styles.emptyState} ${compact ? styles.compactState : ''}`}>
      <span aria-hidden="true">◇</span>
      <strong>Недостаточно данных</strong>
      <p>Измените фильтры или дождитесь накопления выборки.</p>
    </div>
  );
}

function AdminStatePage({ title, message, retry }: { title: string; message: string; retry: boolean }) {
  return (
    <main className={`${styles.shell} ${styles.loginShell}`}>
      <section className={styles.loginCard}>
        <a className={styles.brand} href={appPath('/')}><span className={styles.brandMark} aria-hidden="true" /><span>Candidate Check</span></a>
        <p className={styles.eyebrow}>Локальная аналитика</p>
        <h1>{title}</h1>
        <p className={styles.stateMessage}>{message}</p>
        <div className={styles.inlineActions}>
          {retry && <button className={styles.secondaryButton} onClick={() => window.location.reload()}>Повторить</button>}
          <a className={styles.textLink} href={appPath('/')}>На стартовую</a>
        </div>
      </section>
    </main>
  );
}

type PanelProps = {
  filters: AdminFilters;
  revision: number;
  onAdminError: (error: unknown) => void;
};
