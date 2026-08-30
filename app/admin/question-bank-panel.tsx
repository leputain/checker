'use client';

import {
  type Dispatch,
  FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { appPath } from '@/lib/app-path.ts';
import type {
  QuestionAdminDetailDto as QuestionAdminDetail,
  QuestionAdminDetailResponseDto as QuestionBankDetailDto,
  QuestionAdminItemDto as QuestionAdminItem,
  QuestionAdminListDto as QuestionBankListDto,
  QuestionAdminMutationDto as QuestionBankMutationDto,
  QuestionAdminStatusFilter as QuestionStatus,
  QuestionBankBatchMutationDto as BulkResponse,
  QuestionBankBatchPatchDto as BulkPatch,
  QuestionBankChangeSetDetailDto,
  QuestionBankChangeSetDto as ChangeSetSummary,
  QuestionBankChangeSetListDto as ChangeSetList,
  QuestionBankChangeSetPreviewDto,
  QuestionBankCoverageDto as CoverageResponse,
  QuestionBankHistoryEventDto as QuestionBankHistoryEvent,
  QuestionCategoryDto as CategoryItem,
  QuestionCategoryListDto as CategoryList,
  QuestionImportDraftDto as ImportQuestion,
  QuestionImportPreviewDto as ImportPreview,
  QuestionQualityQueueDto as QualityQueueResponse,
} from '@/lib/question-admin-contract.ts';
import { AdminRequestError, adminErrorMessage } from './admin-client.ts';
import styles from './admin.module.css';

type Difficulty = QuestionAdminItem['difficulty'];
type ContextType = Exclude<QuestionAdminDetail['contextType'], null>;
type EditorMode = 'view' | 'create' | 'revise';
type BankWorkspace = 'questions' | 'categories' | 'transfer' | 'drafts' | 'quality';
const QUESTION_BANK_MUTATION_LIMIT = 250;

const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};

const contextTypeLabels: Record<ContextType, string> = {
  text: 'Текст',
  code: 'Код',
  command: 'Команда',
  log: 'Журнал',
  config: 'Конфигурация',
};

const importActionLabels: Record<ImportPreview['items'][number]['action'], string> = {
  added: 'Будет добавлен',
  revised: 'Новая редакция',
  unchanged: 'Без изменений',
  invalid: 'Ошибка',
};

const importFieldLabels: Record<string, string> = {
  topic: 'категория',
  difficulty: 'сложность',
  prompt: 'текст вопроса',
  contextType: 'тип контекста',
  context: 'контекст',
  choices: 'варианты ответа',
  correctIndex: 'правильный ответ',
  dedupeKey: 'смысловая группа',
  active: 'состояние',
};

function readableDifficultyList(value: string) {
  return value.split(',').map((entry) => {
    const [topic, difficulty] = entry.split('/');
    const label = difficultyLabels[(difficulty ?? topic) as Difficulty] ?? (difficulty ?? topic);
    return difficulty ? `${topic} / ${label}` : label;
  }).join(', ');
}

function readinessMessage(code: string) {
  const exact: Record<string, string> = {
    'legacy:base_plan_infeasible': 'Недостаточно уникальных вопросов, чтобы собрать обязательные 20 вопросов по уровням сложности.',
    'legacy:minimum_remedial_reserve_infeasible': 'Не хватает резерва для дополнительных вопросов после ошибок кандидата.',
    'balanced:topic_difficulty_dedupe_plan_infeasible': 'Невозможно одновременно выполнить квоты категорий и сложности без повторения смысловых групп.',
  };
  if (exact[code]) return exact[code];
  const separator = code.indexOf(':');
  const prefix = separator < 0 ? code : code.slice(0, separator);
  const payload = separator < 0 ? '' : code.slice(separator + 1);
  if (prefix === 'legacy_low_remedial_reserve') {
    return `Малый резерв дополнительных вопросов по сложности: ${readableDifficultyList(payload)}.`;
  }
  if (prefix === 'balanced_low_remedial_reserve') {
    return `Малый резерв в категориях и уровнях: ${readableDifficultyList(payload)}.`;
  }
  if (prefix === 'unexpected_topics') {
    return `Категории без тематической квоты balanced-профиля: ${payload.split(',').join(', ')}.`;
  }
  return code;
}

type QuestionDraft = {
  topic: string;
  difficulty: Difficulty;
  prompt: string;
  contextType: ContextType | '';
  context: string;
  choices: string[];
  correctIndex: number;
  dedupeKey: string;
  active: boolean;
  note: string;
};

type RequestIssue = { message: string; issues: string[] };

class QuestionBankRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: string[];

  constructor(status: number, code: string, issues: string[] = []) {
    super(code);
    this.name = 'QuestionBankRequestError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const emptyDraft = (): QuestionDraft => ({
  topic: '',
  difficulty: 'easy',
  prompt: '',
  contextType: '',
  context: '',
  choices: ['', '', '', ''],
  correctIndex: 0,
  dedupeKey: '',
  active: true,
  note: '',
});

function draftFromQuestion(question: QuestionAdminDetail): QuestionDraft {
  return {
    topic: question.topic,
    difficulty: question.difficulty,
    prompt: question.prompt,
    contextType: question.contextType ?? '',
    context: question.context ?? '',
    choices: [...question.choices],
    correctIndex: question.correctIndex,
    dedupeKey: question.dedupeKey,
    active: question.active,
    note: '',
  };
}

function questionBankError(error: unknown): RequestIssue {
  if (error instanceof QuestionBankRequestError) {
    const message = {
      bank_revision_conflict: 'Банк изменился в другой сессии. Закройте карточку, откройте актуальную редакцию и повторите действие.',
      idempotency_conflict: 'Этот запрос уже использовался с другим содержимым. Измените поле и повторите сохранение.',
      question_has_successor: 'У вопроса уже есть более новая редакция. Откройте её из истории.',
      question_validation_failed: 'Вопрос не прошёл проверку структуры или защиты от дубликатов.',
      question_bank_not_ready: 'Изменение нарушит обязательные пулы банка. Сначала добавьте резервный вопрос.',
      change_set_conflict: 'Черновик или банк уже изменился. Обновите данные и повторите проверку.',
      category_conflict: 'Категория с таким названием уже существует или была объединена. Обновите справочник.',
      import_preview_conflict: 'Банк изменился после предпросмотра. Проверьте файл заново перед публикацией.',
      validation_failed: 'Данные не прошли проверку. Исправьте отмеченные элементы.',
      mutation_too_large: `Превышен размер пакета: за один раз допускается до ${QUESTION_BANK_MUTATION_LIMIT} вопросов или операций.`,
      request_timeout: 'Сервер не ответил за 12 секунд. Проверьте локальное соединение и повторите действие.',
      invalid_request: 'Сервер отклонил изменения. Исправьте отмеченные поля.',
      not_found: 'Вопрос больше не найден в текущем банке.',
    }[error.code] ?? 'Не удалось сохранить изменения банка.';
    return { message, issues: error.issues };
  }
  return { message: adminErrorMessage(error), issues: [] };
}

async function questionBankRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12_000);
  let response: Response;
  try {
    response = await fetch(appPath(path), {
      ...init,
      signal: controller.signal,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch (error) {
    if (timedOut) throw new QuestionBankRequestError(408, 'request_timeout');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => null) as null | {
    error?: string;
    issues?: unknown;
  };
  if (!response.ok) {
    const code = typeof payload?.error === 'string'
      ? payload.error
      : response.status === 401 ? 'unauthorized' : 'analytics_unavailable';
    const issues = Array.isArray(payload?.issues)
      ? payload.issues.filter((item): item is string => typeof item === 'string')
      : [];
    if (['unauthorized', 'csrf_invalid', 'admin_disabled'].includes(code)) {
      throw new AdminRequestError(response.status, code as 'unauthorized' | 'csrf_invalid' | 'admin_disabled');
    }
    throw new QuestionBankRequestError(response.status, code, issues);
  }
  return payload as T;
}

function timestampLabel(value: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function historyLabel(event: QuestionBankHistoryEvent['eventType']) {
  return {
    created: 'Вопрос создан',
    revised: 'Создана новая редакция',
    activated: 'Вопрос включён',
    deactivated: 'Вопрос выключен',
  }[event];
}

function idempotencyKey(
  reference: { current: { fingerprint: string; key: string } | null },
  fingerprint: string,
) {
  if (reference.current?.fingerprint === fingerprint) return reference.current.key;
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const key = `question-admin:${random}`;
  reference.current = { fingerprint, key };
  return key;
}

export function QuestionBankPanel({
  csrfToken,
  onAdminError,
  initialQuestionId,
  onQuestionClosed,
}: {
  csrfToken: string;
  onAdminError: (error: unknown) => void;
  initialQuestionId?: number | null;
  onQuestionClosed?: () => void;
}) {
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty | ''>('');
  const [status, setStatus] = useState<QuestionStatus>('all');
  const [sortValue, setSortValue] = useState('id:desc');
  const [items, setItems] = useState<QuestionAdminItem[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [bankCounts, setBankCounts] = useState({ total: 0, active: 0, inactive: 0 });
  const [readiness, setReadiness] = useState<QuestionBankListDto['readiness'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentBankRevision, setCurrentBankRevision] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [operationNotice, setOperationNotice] = useState('');
  const [mutationNotice, setMutationNotice] = useState<QuestionBankMutationDto | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [editor, setEditor] = useState<{ mode: EditorMode; id?: number } | null>(null);
  const [workspace, setWorkspace] = useState<BankWorkspace>('questions');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!initialQuestionId || !Number.isInteger(initialQuestionId) || initialQuestionId <= 0) return;
      setWorkspace('questions');
      setEditor({ mode: 'view', id: initialQuestionId });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialQuestionId]);

  const queryString = useMemo(() => {
    const [sort, direction] = sortValue.split(':');
    const params = new URLSearchParams({ limit: '40', status, sort, direction });
    if (query) params.set('q', query);
    if (topic) params.set('topic', topic);
    if (difficulty) params.set('difficulty', difficulty);
    return params.toString();
  }, [difficulty, query, sortValue, status, topic]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const payload = await questionBankRequest<QuestionBankListDto>(
        `/api/admin/questions?${queryString}`,
        { signal },
      );
      setItems(payload.items);
      setTopics(payload.topics);
      setTotalCount(payload.totalCount);
      setBankCounts(payload.bankCounts);
      setReadiness(payload.readiness);
      setNextCursor(payload.nextCursor);
      setCurrentBankRevision(payload.currentBankRevision);
      setSelectedIds((current) => {
        const available = new Set(payload.items.filter((item) => !item.successorId).map((item) => item.id));
        return new Set([...current].filter((id) => available.has(id)));
      });
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setLoading(false);
    }
  }, [onAdminError, queryString]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, reloadRevision]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const payload = await questionBankRequest<QuestionBankListDto>(
        `/api/admin/questions?${queryString}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setItems((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of payload.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setTopics(payload.topics);
      setTotalCount(payload.totalCount);
      setBankCounts(payload.bankCounts);
      setReadiness(payload.readiness);
      setNextCursor(payload.nextCursor);
      setCurrentBankRevision(payload.currentBankRevision);
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(queryDraft.trim());
  }

  function resetFilters() {
    setQueryDraft('');
    setQuery('');
    setTopic('');
    setDifficulty('');
    setStatus('all');
    setSortValue('id:desc');
  }

  function mutationComplete(result: QuestionBankMutationDto, openId?: number) {
    setMutationNotice(result);
    setCurrentBankRevision(result.currentBankRevision);
    setReloadRevision((value) => value + 1);
    if (openId) setEditor({ mode: 'view', id: openId });
    else setEditor(null);
  }

  function operationComplete(revision: string, message?: string) {
    setCurrentBankRevision(revision);
    setError('');
    setSelectedIds(new Set());
    setBulkOpen(false);
    setMutationNotice(null);
    setOperationNotice(message ?? 'Изменения опубликованы. Список и контроль покрытия обновлены.');
    setReloadRevision((value) => value + 1);
  }

  function toggleSelection(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectLoaded() {
    const eligible = items.filter((item) => !item.successorId);
    setSelectedIds((current) => current.size === eligible.length
      ? new Set()
      : new Set(eligible.map((item) => item.id)));
  }

  const hasFilters = Boolean(query || topic || difficulty || status !== 'all' || sortValue !== 'id:desc');
  return (
    <div className={styles.bankStack}>
      <section className={styles.bankSummary} aria-label="Состояние банка вопросов">
        <article><strong>{bankCounts.total}</strong><span>всего редакций</span></article>
        <article><strong>{bankCounts.active}</strong><span>активных вопросов</span></article>
        <article><strong>{bankCounts.inactive}</strong><span>выключено и заменено</span></article>
        <article>
          <strong>{readiness?.ready ? 'Готов' : 'Проверка'}</strong>
          <span>
            {currentBankRevision ? `ревизия ${currentBankRevision.slice(0, 8)}` : 'ревизия не загружена'}
            {readiness?.warnings.length ? ` · предупреждений: ${readiness.warnings.length}` : ''}
          </span>
        </article>
      </section>

      <BankWorkspaceNavigation value={workspace} onChange={setWorkspace} />

      {operationNotice && (
        <div className={styles.bankOperationNotice} role="status" aria-live="polite">
          <span aria-hidden="true">✓</span><strong>{operationNotice}</strong>
          <button type="button" onClick={() => setOperationNotice('')} aria-label="Скрыть уведомление">×</button>
        </div>
      )}

      <section
        id={`bank-panel-${workspace}`}
        role="tabpanel"
        aria-labelledby={`bank-workspace-${workspace}`}
        className={styles.bankWorkspacePanel}
      >

      {workspace === 'categories' && (
        <CategoryManager
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          onAdminError={onAdminError}
          onComplete={operationComplete}
        />
      )}
      {workspace === 'transfer' && (
        <ImportExportPanel
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          topics={topics}
          onAdminError={onAdminError}
          onComplete={operationComplete}
        />
      )}
      {workspace === 'drafts' && (
        <ChangeSetsPanel
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          onAdminError={onAdminError}
          onComplete={operationComplete}
        />
      )}
      {workspace === 'quality' && (
        <BankQualityPanel
          onAdminError={onAdminError}
          onOpenQuestion={(id) => {
            setWorkspace('questions');
            setEditor({ mode: 'view', id });
          }}
        />
      )}

      {workspace === 'questions' && <>

      <form className={styles.bankToolbar} role="search" onSubmit={submitSearch}>
        <label className={styles.bankSearch}>
          <span>Поиск в банке</span>
          <input
            type="search"
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            placeholder="ID, тема, текст или смысловая группа"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Тема</span>
          <select value={topic} onChange={(event) => setTopic(event.target.value)}>
            <option value="">Все темы</option>
            {topics.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>Сложность</span>
          <select value={difficulty} onChange={(event) => setDifficulty(event.target.value as Difficulty | '')}>
            <option value="">Все уровни</option>
            {(Object.keys(difficultyLabels) as Difficulty[]).map((value) => (
              <option value={value} key={value}>{difficultyLabels[value]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Состояние</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as QuestionStatus)}>
            <option value="all">Все вопросы</option>
            <option value="active">Только активные</option>
            <option value="inactive">Только выключенные</option>
          </select>
        </label>
        <label>
          <span>Порядок</span>
          <select value={sortValue} onChange={(event) => setSortValue(event.target.value)}>
            <option value="id:desc">Сначала новые ID</option>
            <option value="id:asc">Сначала старые ID</option>
            <option value="topic:asc">По теме</option>
            <option value="difficulty:asc">По сложности</option>
            <option value="status:desc">Сначала активные</option>
          </select>
        </label>
        <div className={styles.bankToolbarActions}>
          <button className={styles.primaryButton} type="submit">Найти</button>
          {hasFilters && <button className={styles.quietButton} type="button" onClick={resetFilters}>Сбросить</button>}
        </div>
        <button className={styles.bankCreateButton} type="button" disabled={!currentBankRevision || loading} onClick={() => setEditor({ mode: 'create' })}>
          <span aria-hidden="true">＋</span> Новый вопрос
        </button>
      </form>

      {!loading && items.length > 0 && (
        <div className={styles.bankSelectionBar} data-active={selectedIds.size > 0}>
          <label>
            <input
              type="checkbox"
              checked={items.some((item) => !item.successorId) && selectedIds.size === items.filter((item) => !item.successorId).length}
              ref={(input) => { if (input) input.indeterminate = selectedIds.size > 0 && selectedIds.size < items.filter((item) => !item.successorId).length; }}
              onChange={selectLoaded}
            />
            <span>{selectedIds.size ? `Выбрано: ${selectedIds.size}` : `Выбрать загруженные актуальные: ${items.filter((item) => !item.successorId).length}`}</span>
          </label>
          <div>
            {selectedIds.size > 0 && <button className={styles.quietButton} type="button" onClick={() => setSelectedIds(new Set())}>Снять выбор</button>}
            <button className={styles.secondaryButton} type="button" disabled={selectedIds.size === 0} onClick={() => setBulkOpen(true)}>
              Массовое изменение
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className={styles.bankInlineError} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>Повторить</button>
        </div>
      )}
      {mutationNotice && (
        <div className={styles.bankMutationNotice} role="status" aria-live="polite">
          <div>
            <strong>Банк обновлён · вопрос #{mutationNotice.question.id}</strong>
            <span>Новая ревизия {mutationNotice.currentBankRevision.slice(0, 8)} · {mutationNotice.readiness.ready ? 'банк готов к тестированию' : 'нужна проверка готовности'}</span>
            {mutationNotice.readiness.warnings.length > 0 && (
              <small>
                Есть предупреждения о резерве вопросов. Они не блокируют тестирование, но банк стоит пополнить.
              </small>
            )}
          </div>
          <button type="button" onClick={() => setMutationNotice(null)} aria-label="Скрыть уведомление">×</button>
        </div>
      )}

      {loading ? <BankLoading /> : items.length === 0 ? (
        <BankEmpty
          title={hasFilters ? 'Вопросы не найдены' : 'Банк вопросов пуст'}
          message={hasFilters
            ? 'Измените поиск или фильтры — сами вопросы остаются в банке.'
            : 'Создайте первый вопрос. Сервер проверит структуру и готовность банка перед сохранением.'}
          action={!hasFilters ? () => setEditor({ mode: 'create' }) : undefined}
        />
      ) : (
        <div className={styles.bankGrid}>
          {items.map((item) => (
            <article className={styles.bankQuestionCard} key={item.id} data-active={item.active} data-selected={selectedIds.has(item.id)}>
              <header>
                <label className={styles.bankCardSelect}>
                  <input type="checkbox" checked={selectedIds.has(item.id)} disabled={Boolean(item.successorId)} onChange={() => toggleSelection(item.id)} />
                  <span aria-hidden="true" />
                  <b>{item.successorId ? `Вопрос #${item.id} заменён и недоступен для массового изменения` : `Выбрать вопрос #${item.id}`}</b>
                </label>
                <div className={styles.bankQuestionIdentity}>
                  <span>#{item.id}</span>
                  <span>{difficultyLabels[item.difficulty]}</span>
                  <span>{item.topic}</span>
                </div>
                <span className={item.active ? styles.bankActive : styles.bankInactive}>
                  {item.active ? 'Активен' : 'Выключен'}
                </span>
              </header>
              <button
                className={styles.bankQuestionOpen}
                type="button"
                onClick={() => setEditor({ mode: 'view', id: item.id })}
                aria-label={`Открыть вопрос ${item.id}`}
              >
                <strong>{item.prompt || item.promptPreview}</strong>
                {item.context && <pre><code>{item.context}</code></pre>}
              </button>
              {item.choices.length > 0 && (
                <ol className={styles.bankChoicePreview} aria-label="Варианты ответа без указания правильного">
                  {item.choices.map((choice, index) => <li key={`${item.id}-${index}`}><span>{String.fromCharCode(65 + index)}</span>{choice}</li>)}
                </ol>
              )}
              <footer>
                <div>
                  <span>Группа: <b>{item.dedupeKey}</b></span>
                  <span>Использован: <b>{item.usageCount}</b></span>
                  {(item.predecessorId || item.successorId) && <span>Есть история редакций</span>}
                </div>
                <button className={styles.secondaryButton} type="button" onClick={() => setEditor({ mode: 'view', id: item.id })}>
                  Просмотреть
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {nextCursor && !loading && (
        <div className={styles.loadMoreRow}>
          <button className={styles.secondaryButton} type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Загружаем…' : `Показать ещё · сейчас ${items.length} из ${totalCount}`}
          </button>
        </div>
      )}

      </>}
      </section>

      {bulkOpen && (
        <BulkOperationDialog
          questionIds={[...selectedIds]}
          topics={topics}
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          onClose={() => setBulkOpen(false)}
          onAdminError={onAdminError}
          onComplete={operationComplete}
        />
      )}

      {editor && (
        <QuestionBankDialog
          key={`${editor.mode}-${editor.id ?? 'new'}`}
          mode={editor.mode}
          questionId={editor.id}
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          topics={topics}
          onClose={() => { setEditor(null); onQuestionClosed?.(); }}
          onAdminError={onAdminError}
          onComplete={mutationComplete}
          onOpenQuestion={(id) => setEditor({ mode: 'view', id })}
          onChangeMode={(mode, id) => setEditor({ mode, id })}
        />
      )}
    </div>
  );
}

const workspaceLabels: Record<BankWorkspace, { title: string; description: string }> = {
  questions: { title: 'Вопросы', description: 'Поиск, просмотр и точечные редакции' },
  categories: { title: 'Категории', description: 'Состав, переименование и объединение' },
  transfer: { title: 'Импорт и экспорт', description: 'Проверка файла до публикации' },
  drafts: { title: 'Черновики', description: 'Пакеты изменений и единая ревизия' },
  quality: { title: 'Контроль', description: 'Покрытие и очередь качества' },
};

function BankWorkspaceNavigation({ value, onChange }: {
  value: BankWorkspace;
  onChange: (value: BankWorkspace) => void;
}) {
  const tabs = Object.keys(workspaceLabels) as BankWorkspace[];
  function move(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(value);
    const next = event.key === 'Home'
      ? tabs[0]
      : event.key === 'End'
        ? tabs.at(-1)!
        : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    onChange(next);
    window.requestAnimationFrame(() => document.getElementById(`bank-workspace-${next}`)?.focus());
  }
  return (
    <div className={styles.bankWorkspaceNav} role="tablist" aria-label="Разделы банка вопросов" onKeyDown={move}>
      {tabs.map((tab) => (
        <button
          id={`bank-workspace-${tab}`}
          key={tab}
          type="button"
          role="tab"
          aria-selected={value === tab}
          aria-controls={`bank-panel-${tab}`}
          tabIndex={value === tab ? 0 : -1}
          onClick={() => onChange(tab)}
        >
          <strong>{workspaceLabels[tab].title}</strong>
          <span>{workspaceLabels[tab].description}</span>
        </button>
      ))}
    </div>
  );
}

function mutationRevision(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object' && 'currentBankRevision' in payload) {
    const value = (payload as { currentBankRevision?: unknown }).currentBankRevision;
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

function CategoryManager({ csrfToken, currentBankRevision, onAdminError, onComplete }: {
  csrfToken: string;
  currentBankRevision: string;
  onAdminError: (error: unknown) => void;
  onComplete: (revision: string, message?: string) => void;
}) {
  const [data, setData] = useState<CategoryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<CategoryItem | null>(null);
  const [editName, setEditName] = useState('');
  const [mergeSource, setMergeSource] = useState<CategoryItem | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const mutationRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await questionBankRequest<CategoryList>('/api/admin/questions/categories'));
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setLoading(false);
    }
  }, [onAdminError]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(path: string, method: 'POST' | 'PUT', body: Record<string, unknown>, notice: string) {
    if (saving) return;
    setSaving(true);
    setError('');
    const revision = data?.currentBankRevision || currentBankRevision;
    const fingerprint = JSON.stringify({ path, body, revision });
    try {
      const result = await questionBankRequest<unknown>(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          ...body,
          expectedBankRevision: revision,
          idempotencyKey: idempotencyKey(mutationRef, fingerprint),
        }),
      });
      mutationRef.current = null;
      setNewName('');
      setEditing(null);
      setMergeSource(null);
      setMergeTarget('');
      onComplete(mutationRevision(result, revision), notice);
      await load();
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <BankLoading />;
  if (!data) return <BankError error={{ message: error || 'Не удалось загрузить категории.', issues: [] }} />;
  const activeTotal = data.items.reduce((sum, item) => sum + item.activeQuestionCount, 0);
  return (
    <section className={styles.bankOperationWorkspace} aria-labelledby="category-manager-title">
      <header className={styles.bankOperationHeading}>
        <div><p className={styles.eyebrow}>Справочник</p><h3 id="category-manager-title">Категории вопросов</h3><p>Переименование и объединение выполняются одной ревизией, с сохранением истории старых вопросов.</p></div>
        <span>{data.items.length} категорий · {activeTotal} активных</span>
      </header>
      <form className={styles.bankInlineForm} onSubmit={(event) => {
        event.preventDefault();
        const name = newName.trim();
        if (name) void mutate('/api/admin/questions/categories', 'POST', { name }, `Категория «${name}» создана.`);
      }}>
        <label><span>Новая категория</span><input value={newName} maxLength={80} onChange={(event) => setNewName(event.target.value)} placeholder="Например, Виртуализация" /></label>
        <button className={styles.primaryButton} type="submit" disabled={saving || !newName.trim()}>Добавить</button>
      </form>
      {error && <div className={styles.bankInlineError} role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Обновить</button></div>}
      <div className={styles.categoryGrid}>
        {data.items.map((item) => {
          const total = item.activeQuestionCount + item.inactiveQuestionCount;
          return (
            <article key={item.id} className={styles.categoryCard}>
              <header><div><strong>{item.name}</strong><span>{item.activeQuestionCount} активных актуальных вопросов · {item.inactiveQuestionCount} выключенных актуальных редакций</span>{!item.active && <em>Объединена · архивная категория</em>}</div><b>{total}</b></header>
              <dl>
                {(Object.keys(difficultyLabels) as Difficulty[]).map((difficulty) => (
                  <div key={difficulty}><dt>{difficultyLabels[difficulty]}</dt><dd>{item.difficultyCounts[difficulty] ?? 0}</dd></div>
                ))}
              </dl>
              {editing?.id === item.id ? (
                <form className={styles.categoryEditForm} onSubmit={(event) => {
                  event.preventDefault();
                  const name = editName.trim();
                  if (name && name !== item.name) void mutate(`/api/admin/questions/categories/${item.id}`, 'PUT', { name, expectedCategoryName: item.name, note: 'Переименование категории из панели' }, `Категория переименована в «${name}».`);
                }}>
                  <label><span>Новое название</span><input value={editName} maxLength={80} onChange={(event) => setEditName(event.target.value)} /></label>
                  <div><button className={styles.primaryButton} type="submit" disabled={saving || !editName.trim() || editName.trim() === item.name}>Сохранить</button><button className={styles.quietButton} type="button" onClick={() => setEditing(null)}>Отмена</button></div>
                </form>
              ) : mergeSource?.id === item.id ? (
                <form className={styles.categoryEditForm} onSubmit={(event) => {
                  event.preventDefault();
                  if (mergeTarget) void mutate(`/api/admin/questions/categories/${item.id}/merge`, 'POST', { targetCategoryId: Number(mergeTarget), expectedCategoryName: item.name, note: 'Объединение категорий из панели' }, `Категория «${item.name}» объединена.`);
                }}>
                  <label><span>Объединить с</span><select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Выберите категорию</option>{data.items.filter((candidate) => candidate.id !== item.id && candidate.active).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
                  <p>Все актуальные вопросы получат новые редакции в выбранной категории. Отменить публикацию задним числом нельзя.</p>
                  <div><button className={styles.dangerButton} type="submit" disabled={saving || !mergeTarget}>Объединить</button><button className={styles.quietButton} type="button" onClick={() => setMergeSource(null)}>Отмена</button></div>
                </form>
              ) : (
                <footer><button className={styles.secondaryButton} type="button" disabled={!item.active} onClick={() => { setEditing(item); setEditName(item.name); }}>Переименовать</button><button className={styles.quietButton} type="button" disabled={!item.active || data.items.filter((candidate) => candidate.active).length < 2} onClick={() => setMergeSource(item)}>Объединить</button></footer>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BulkOperationDialog({ questionIds, topics, csrfToken, currentBankRevision, onClose, onAdminError, onComplete }: {
  questionIds: number[];
  topics: string[];
  csrfToken: string;
  currentBankRevision: string;
  onClose: () => void;
  onAdminError: (error: unknown) => void;
  onComplete: (revision: string, message?: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [field, setField] = useState<'topic' | 'difficulty' | 'active'>('topic');
  const [topic, setTopic] = useState(topics[0] ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [active, setActive] = useState(true);
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<ChangeSetSummary[]>([]);
  const [draftTarget, setDraftTarget] = useState('new');
  const mutationRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const patch: BulkPatch = field === 'topic' ? { topic } : field === 'difficulty' ? { difficulty } : { active };
  const valueLabel = field === 'topic' ? topic : field === 'difficulty' ? difficultyLabels[difficulty] : active ? 'Включить' : 'Выключить';

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void questionBankRequest<ChangeSetList>('/api/admin/questions/change-sets', { signal: controller.signal })
      .then((result) => setDrafts(result.items.filter((item) => item.status === 'draft')))
      .catch((requestError: unknown) => {
        if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) onAdminError(requestError);
      });
    return () => controller.abort();
  }, [onAdminError]);

  async function apply(mode: 'publish' | 'draft') {
    setSaving(true);
    setError('');
    const fingerprint = JSON.stringify({ mode, questionIds, patch, currentBankRevision, note });
    try {
      if (mode === 'publish') {
        const result = await questionBankRequest<BulkResponse>('/api/admin/questions/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ questionIds, patch, note: note.trim() || undefined, expectedBankRevision: currentBankRevision, idempotencyKey: idempotencyKey(mutationRef, fingerprint) }),
        });
        mutationRef.current = null;
        onComplete(result.currentBankRevision, `Изменено вопросов: ${result.changedCount}. Опубликована одна новая ревизия.`);
      } else {
        let changeSetId = draftTarget;
        let title = drafts.find((item) => item.id === draftTarget)?.title ?? '';
        let existingOperations: QuestionBankChangeSetDetailDto['operations'] = [];
        let expectedChangeSetUpdatedAt = 0;
        if (draftTarget === 'new') {
          const createFingerprint = JSON.stringify({ action: 'create-change-set', questionIds, patch, currentBankRevision, note });
          const created = await questionBankRequest<QuestionBankChangeSetDetailDto>('/api/admin/questions/change-sets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({
              title: `Пакет для ${questionIds.length} вопросов`,
              note: note.trim() || undefined,
              expectedBankRevision: currentBankRevision,
              idempotencyKey: idempotencyKey(mutationRef, createFingerprint),
            }),
          });
          mutationRef.current = null;
          changeSetId = created.changeSet.id;
          title = created.changeSet.title;
          existingOperations = created.operations;
          expectedChangeSetUpdatedAt = created.changeSet.updatedAt;
          setDraftTarget(created.changeSet.id);
          setDrafts((current) => current.some((item) => item.id === created.changeSet.id)
            ? current
            : [created.changeSet, ...current]);
        } else {
          const existing = await questionBankRequest<QuestionBankChangeSetDetailDto>(`/api/admin/questions/change-sets/${encodeURIComponent(changeSetId)}`);
          existingOperations = existing.operations;
          expectedChangeSetUpdatedAt = existing.changeSet.updatedAt;
        }
        const merged = new Map(existingOperations.map((operation) => [operation.questionId, { questionId: operation.questionId, patch: operation.patch }]));
        for (const questionId of questionIds) merged.set(questionId, { questionId, patch });
        const operations = [...merged.values()];
        if (operations.length > QUESTION_BANK_MUTATION_LIMIT) {
          throw new QuestionBankRequestError(413, 'mutation_too_large', [`В одном черновике допускается не более ${QUESTION_BANK_MUTATION_LIMIT} операций.`]);
        }
        const updateFingerprint = JSON.stringify({ action: 'update-change-set', changeSetId, operations, currentBankRevision, expectedChangeSetUpdatedAt });
        await questionBankRequest(`/api/admin/questions/change-sets/${encodeURIComponent(changeSetId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ operations, expectedBankRevision: currentBankRevision, expectedChangeSetUpdatedAt, idempotencyKey: idempotencyKey(mutationRef, updateFingerprint) }),
        });
        mutationRef.current = null;
        onComplete(currentBankRevision, `Изменения добавлены в черновик «${title}». Проверьте его в разделе «Черновики».`);
      }
      onClose();
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.detailBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section ref={dialogRef} className={`${styles.detailDialog} ${styles.bulkDialog}`} role="dialog" aria-modal="true" aria-labelledby="bulk-title" aria-describedby="bulk-description" tabIndex={-1} onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); return; }
        if (event.key !== 'Tab' || !dialogRef.current) return;
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
        const first = focusable[0]; const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <header className={styles.detailHeader}><div><span className={styles.dialogEyebrow}>Пакетное действие</span><h2 id="bulk-title">Изменить {questionIds.length} вопросов</h2></div><button type="button" disabled={saving} onClick={onClose} aria-label="Закрыть">×</button></header>
        <div className={styles.detailBody} id="bulk-description">
          {step === 'edit' ? <div className={styles.bulkForm}>
            <fieldset><legend>Что изменить</legend>
              <label><input type="radio" checked={field === 'topic'} onChange={() => setField('topic')} /><span>Категорию</span></label>
              <label><input type="radio" checked={field === 'difficulty'} onChange={() => setField('difficulty')} /><span>Сложность</span></label>
              <label><input type="radio" checked={field === 'active'} onChange={() => setField('active')} /><span>Состояние</span></label>
            </fieldset>
            {field === 'topic' && <label><span>Новая категория</span><select value={topic} onChange={(event) => setTopic(event.target.value)}>{topics.map((item) => <option key={item}>{item}</option>)}</select></label>}
            {field === 'difficulty' && <label><span>Новая сложность</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value as Difficulty)}>{(Object.keys(difficultyLabels) as Difficulty[]).map((item) => <option key={item} value={item}>{difficultyLabels[item]}</option>)}</select></label>}
            {field === 'active' && <label><span>Новое состояние</span><select value={active ? 'active' : 'inactive'} onChange={(event) => setActive(event.target.value === 'active')}><option value="active">Включить в тест</option><option value="inactive">Выключить из теста</option></select></label>}
            <label><span>Комментарий к аудиту</span><textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Почему выполняется изменение" /></label>
            <div className={styles.bankEditorFooter}><button className={styles.quietButton} type="button" onClick={onClose}>Отмена</button><button className={styles.primaryButton} type="button" disabled={field === 'topic' && !topic} onClick={() => setStep('confirm')}>Проверить пакет</button></div>
          </div> : <div className={styles.bulkReview}>
            <span aria-hidden="true">{questionIds.length}</span><h3>Проверьте изменение</h3>
            <dl><div><dt>Вопросов</dt><dd>{questionIds.length}</dd></div><div><dt>{field === 'topic' ? 'Категория' : field === 'difficulty' ? 'Сложность' : 'Состояние'}</dt><dd>{valueLabel}</dd></div><div><dt>Результат</dt><dd>{field === 'active' ? 'Изменится состав текущего банка' : 'Будут созданы новые редакции вопросов'}</dd></div></dl>
            <p>Можно сохранить пакет как черновик для повторной проверки или сразу опубликовать одной атомарной ревизией.</p>
            <label className={styles.bulkDraftTarget}><span>Куда сохранить черновик</span><select value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)}><option value="new">Создать новый пакет</option>{drafts.map((draft) => <option key={draft.id} value={draft.id}>Добавить в «{draft.title}» · сейчас {draft.operationCount}</option>)}</select><small>При добавлении в существующий пакет операции для тех же вопросов будут заменены.</small></label>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.bankEditorFooter}><button className={styles.quietButton} type="button" disabled={saving} onClick={() => setStep('edit')}>Назад</button><button className={styles.secondaryButton} type="button" disabled={saving} onClick={() => void apply('draft')}>Сохранить черновик</button><button className={styles.primaryButton} type="button" disabled={saving} onClick={() => void apply('publish')}>{saving ? 'Сохраняем…' : 'Опубликовать'}</button></div>
          </div>}
        </div>
      </section>
    </div>
  );
}

function ImportExportPanel({ csrfToken, currentBankRevision, topics, onAdminError, onComplete }: {
  csrfToken: string;
  currentBankRevision: string;
  topics: string[];
  onAdminError: (error: unknown) => void;
  onComplete: (revision: string, message?: string) => void;
}) {
  const [questions, setQuestions] = useState<ImportQuestion[]>([]);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [exportTopic, setExportTopic] = useState('');
  const [exportStatus, setExportStatus] = useState<QuestionStatus>('active');
  const applyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetImportFile() {
    setQuestions([]);
    setPreview(null);
    setFileName('');
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function readFile(file: File | null) {
    setPreview(null);
    setQuestions([]);
    setError('');
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > 2_000_000) {
      setError(`Файл больше 2 МБ. Разделите импорт на пакеты до ${QUESTION_BANK_MUTATION_LIMIT} вопросов.`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && 'questions' in parsed
          ? (parsed as { questions?: unknown }).questions
          : null;
      if (!Array.isArray(records)) throw new Error('invalid_shape');
      if (records.length === 0) throw new Error('empty');
      if (records.length > QUESTION_BANK_MUTATION_LIMIT) throw new Error('too_many');
      setQuestions(records as ImportQuestion[]);
    } catch (fileError) {
      const message = fileError instanceof Error && fileError.message === 'too_many'
        ? `В одном пакете допускается не более ${QUESTION_BANK_MUTATION_LIMIT} вопросов.`
        : fileError instanceof Error && fileError.message === 'empty'
          ? 'В файле нет вопросов.'
          : 'Не удалось прочитать JSON. Ожидается массив вопросов или объект с полем questions.';
      setError(message);
    }
  }

  async function requestPreview() {
    if (!questions.length || previewing) return;
    setPreviewing(true);
    setError('');
    try {
      setPreview(await questionBankRequest<ImportPreview>('/api/admin/questions/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ questions, expectedBankRevision: currentBankRevision }),
      }));
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function applyImport() {
    if (!preview || preview.summary.invalid > 0 || applying) return;
    setApplying(true);
    setError('');
    const fingerprint = JSON.stringify({ questions, previewToken: preview.previewToken, currentBankRevision });
    try {
      const result = await questionBankRequest<BulkResponse>('/api/admin/questions/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          questions,
          previewToken: preview.previewToken,
          expectedBankRevision: currentBankRevision,
          idempotencyKey: idempotencyKey(applyRef, fingerprint),
          note: `Импорт из файла ${fileName}`,
        }),
      });
      applyRef.current = null;
      onComplete(result.currentBankRevision, `Импорт завершён: добавлено ${preview.summary.added}, обновлено ${preview.summary.revised}, без изменений ${preview.summary.unchanged}.`);
      resetImportFile();
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError).message);
    } finally {
      setApplying(false);
    }
  }

  const exportParams = new URLSearchParams({ status: exportStatus });
  if (exportTopic) exportParams.set('topic', exportTopic);
  return (
    <section className={styles.transferGrid} aria-label="Импорт и экспорт банка">
      <article className={styles.bankOperationWorkspace}>
        <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Импорт</p><h3>Проверить пакет до публикации</h3><p>Сначала сервер покажет точный diff. Пока вы не нажмёте «Применить», банк не изменится. Новые категории создаются отдельно в справочнике.</p></div><span>до {QUESTION_BANK_MUTATION_LIMIT} вопросов</span></header>
        <label className={styles.fileDrop} data-loaded={questions.length > 0}>
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={(event) => void readFile(event.target.files?.[0] ?? null)} />
          <span aria-hidden="true">{questions.length ? '✓' : '↓'}</span>
          <strong>{fileName || 'Выберите JSON-файл'}</strong>
          <small>{questions.length ? `Прочитано записей: ${questions.length}` : 'Массив вопросов или экспорт Candidate Check'}</small>
        </label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {questions.length > 0 && !preview && <button className={styles.primaryButton} type="button" disabled={previewing} onClick={() => void requestPreview()}>{previewing ? 'Проверяем…' : 'Проверить изменения'}</button>}
        {preview && <div className={styles.importDiff}>
          <header><div><p className={styles.eyebrow}>Предпросмотр</p><h4>{preview.summary.invalid ? 'Нужно исправить файл' : 'Пакет готов к публикации'}</h4></div><span className={preview.readiness?.ready ? styles.bankActive : styles.bankInactive}>{preview.readiness?.ready ? 'Банк готов' : 'Есть ограничения'}</span></header>
          <dl><div><dt>Новые</dt><dd>{preview.summary.added}</dd></div><div><dt>Новые редакции</dt><dd>{preview.summary.revised}</dd></div><div><dt>Без изменений</dt><dd>{preview.summary.unchanged}</dd></div><div><dt>Ошибки</dt><dd>{preview.summary.invalid}</dd></div></dl>
          <details className={styles.importItemDetails} open>
            <summary>
              <span>Изменения и ошибки</span>
              <b>{preview.items.filter((item) => item.action !== 'unchanged').length}</b>
            </summary>
            <ol>
              {preview.items.filter((item) => item.action !== 'unchanged').map((item) => (
                <li key={item.sourceIndex} data-action={item.action}>
                  <header>
                    <strong>Строка {item.sourceIndex + 1}{item.sourceId === null ? '' : ` · ID ${item.sourceId}`}</strong>
                    <span>{importActionLabels[item.action]}</span>
                  </header>
                  {item.changedFields.length > 0 && (
                    <p><b>Изменятся:</b> {item.changedFields.map((field) => importFieldLabels[field] ?? field).join(', ')}</p>
                  )}
                  {item.issues.length > 0 && <ul>{item.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                </li>
              ))}
            </ol>
          </details>
          {preview.summary.unchanged > 0 && (
            <details className={styles.importUnchangedDetails}>
              <summary><span>Без изменений</span><b>{preview.summary.unchanged}</b></summary>
              <p>Эти записи полностью совпадают с актуальными редакциями и при публикации будут пропущены.</p>
            </details>
          )}
          {preview.summary.invalid > 0 && <p className={styles.importHint}>Если в файле указана неизвестная категория, сначала создайте её в разделе «Категории», затем повторите проверку. Импорт не создаёт категории автоматически.</p>}
          <div><button className={styles.quietButton} type="button" disabled={applying} onClick={resetImportFile}>Выбрать другой файл</button><button className={styles.primaryButton} type="button" disabled={applying || preview.summary.invalid > 0 || !preview.readiness?.ready} onClick={() => void applyImport()}>{applying ? 'Публикуем…' : 'Применить одной ревизией'}</button></div>
        </div>}
      </article>
      <article className={styles.bankOperationWorkspace}>
        <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Экспорт</p><h3>Выгрузить актуальный банк</h3><p>Файл подходит для резервной копии, проверки и последующего импорта.</p></div><span>JSON · schema v1</span></header>
        <div className={styles.exportControls}>
          <label><span>Категория</span><select value={exportTopic} onChange={(event) => setExportTopic(event.target.value)}><option value="">Все категории</option>{topics.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Состояние</span><select value={exportStatus} onChange={(event) => setExportStatus(event.target.value as QuestionStatus)}><option value="active">Только активные актуальные вопросы</option><option value="inactive">Только выключенные актуальные редакции</option><option value="all">Все актуальные редакции</option></select></label>
          <a className={styles.primaryButton} href={appPath(`/api/admin/questions/export?${exportParams.toString()}`)} download>Скачать JSON</a>
        </div>
        <aside className={styles.exportNote}><span aria-hidden="true">i</span><p><strong>Что попадёт в файл</strong>Текст, варианты, правильный ответ, категория, сложность и смысловая группа. Персональные результаты кандидатов не экспортируются.</p></aside>
      </article>
    </section>
  );
}

function ChangeSetsPanel({ csrfToken, currentBankRevision, onAdminError, onComplete }: {
  csrfToken: string;
  currentBankRevision: string;
  onAdminError: (error: unknown) => void;
  onComplete: (revision: string, message?: string) => void;
}) {
  const [data, setData] = useState<ChangeSetList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuestionBankChangeSetDetailDto | null>(null);
  const [preview, setPreview] = useState<QuestionBankChangeSetPreviewDto | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mutationRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await questionBankRequest<ChangeSetList>('/api/admin/questions/change-sets')); }
    catch (requestError) { onAdminError(requestError); setError(questionBankError(requestError).message); }
    finally { setLoading(false); }
  }, [onAdminError]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void questionBankRequest<QuestionBankChangeSetDetailDto>(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((result) => { setDetail(result); setPreview(null); })
      .catch((requestError: unknown) => { if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) { onAdminError(requestError); setError(questionBankError(requestError).message); } });
    return () => controller.abort();
  }, [onAdminError, selected]);

  function chooseDraft(id: string) {
    setSelected(id);
    setDetail(null);
    setPreview(null);
    setConfirmDelete(false);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true); setError('');
    const fingerprint = JSON.stringify({ title, note, currentBankRevision });
    try {
      const result = await questionBankRequest<QuestionBankChangeSetDetailDto>('/api/admin/questions/change-sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title: title.trim(), note: note.trim() || undefined, expectedBankRevision: currentBankRevision, idempotencyKey: idempotencyKey(mutationRef, fingerprint) }),
      });
      mutationRef.current = null; setTitle(''); setNote(''); setSelected(result.changeSet.id); setDetail(result); setPreview(null); await load();
    } catch (requestError) { onAdminError(requestError); setError(questionBankError(requestError).message); }
    finally { setSaving(false); }
  }

  async function previewDraft() {
    if (!selected || saving) return;
    setSaving(true); setError('');
    try { setPreview(await questionBankRequest<QuestionBankChangeSetPreviewDto>(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}/preview`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } })); }
    catch (requestError) { onAdminError(requestError); setError(questionBankError(requestError).message); }
    finally { setSaving(false); }
  }

  async function handleDraftMutationError(requestError: unknown) {
    onAdminError(requestError);
    const issue = questionBankError(requestError);
    if (
      selected
      && requestError instanceof QuestionBankRequestError
      && requestError.code === 'change_set_conflict'
    ) {
      mutationRef.current = null;
      try {
        const latest = await questionBankRequest<QuestionBankChangeSetDetailDto>(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}`);
        setDetail(latest);
        setPreview(null);
        await load();
        setError(`${issue.message} Показана актуальная версия черновика.`);
        return;
      } catch (refreshError) {
        onAdminError(refreshError);
      }
    }
    setError(issue.message);
  }

  async function removeDraftOperation(questionId: number) {
    if (!selected || !detail || saving || detail.changeSet.status !== 'draft') return;
    const operations = detail.operations
      .filter((operation) => operation.questionId !== questionId)
      .map((operation) => ({ questionId: operation.questionId, patch: operation.patch }));
    setSaving(true); setError('');
    const expectedChangeSetUpdatedAt = detail.changeSet.updatedAt;
    const fingerprint = JSON.stringify({ action: 'remove-operation', selected, questionId, operations, currentBankRevision, expectedChangeSetUpdatedAt });
    try {
      const result = await questionBankRequest<QuestionBankChangeSetDetailDto>(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ operations, expectedBankRevision: currentBankRevision, expectedChangeSetUpdatedAt, idempotencyKey: idempotencyKey(mutationRef, fingerprint) }),
      });
      mutationRef.current = null; setDetail(result); setPreview(null); await load();
    } catch (requestError) { await handleDraftMutationError(requestError); }
    finally { setSaving(false); }
  }

  async function publishDraft() {
    if (!selected || !preview || saving) return;
    setSaving(true); setError('');
    const expectedChangeSetUpdatedAt = preview.changeSet.updatedAt;
    const fingerprint = JSON.stringify({ selected, currentBankRevision, expectedChangeSetUpdatedAt, operations: preview.operations });
    try {
      const result = await questionBankRequest<BulkResponse>(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ expectedBankRevision: currentBankRevision, expectedChangeSetUpdatedAt, idempotencyKey: idempotencyKey(mutationRef, fingerprint) }),
      });
      mutationRef.current = null; setSelected(null); setPreview(null); await load();
      onComplete(result.currentBankRevision, `Черновик опубликован: изменено ${result.changedCount}, без изменений ${result.unchangedCount}.`);
    } catch (requestError) { await handleDraftMutationError(requestError); }
    finally { setSaving(false); }
  }

  async function discardDraft() {
    if (!selected || !detail || saving) return;
    setSaving(true); setError('');
    const expectedBankRevision = detail.currentBankRevision || currentBankRevision;
    const expectedChangeSetUpdatedAt = detail.changeSet.updatedAt;
    const fingerprint = JSON.stringify({ action: 'discard-change-set', selected, expectedBankRevision, expectedChangeSetUpdatedAt });
    try {
      await questionBankRequest(`/api/admin/questions/change-sets/${encodeURIComponent(selected)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          expectedBankRevision,
          expectedChangeSetUpdatedAt,
          idempotencyKey: idempotencyKey(mutationRef, fingerprint),
        }),
      });
      mutationRef.current = null;
      setSelected(null); setPreview(null); setConfirmDelete(false); await load();
    } catch (requestError) { await handleDraftMutationError(requestError); }
    finally { setSaving(false); }
  }

  if (loading) return <BankLoading />;
  return (
    <section className={styles.draftWorkspace}>
      <aside className={styles.bankOperationWorkspace}>
        <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Пакеты</p><h3>Черновики изменений</h3><p>Публикуйте связанные изменения одной ревизией.</p></div><span>{data?.items.filter((item) => item.status === 'draft').length ?? 0} активных</span></header>
        <form className={styles.draftCreateForm} onSubmit={create}><label><span>Название пакета</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Пересмотр Linux" /></label><label><span>Комментарий</span><textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Цель изменений" /></label><button className={styles.primaryButton} type="submit" disabled={saving || !title.trim()}>Создать пустой черновик</button></form>
        <nav className={styles.draftList} aria-label="Черновики банка">{data?.items.length ? data.items.map((item) => <button key={item.id} type="button" data-active={selected === item.id} onClick={() => chooseDraft(item.id)}><span><strong>{item.title}</strong><small>{item.operationCount} изменений · {item.status === 'draft' ? 'черновик' : item.status === 'published' ? 'опубликован' : 'отменён'}</small></span><b aria-hidden="true">→</b></button>) : <p>Черновиков пока нет. Выберите вопросы и сохраните массовое изменение как пакет.</p>}</nav>
      </aside>
      <article className={styles.bankOperationWorkspace}>
        {!selected ? <BankEmpty title="Выберите черновик" message="Здесь появятся операции, проверка готовности и кнопка атомарной публикации." /> : !detail ? <BankLoading compact /> : <>
          <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Черновик</p><h3>{detail.changeSet.title}</h3><p>{detail.changeSet.note || 'Без комментария'}</p></div><span>{detail.operations.length} операций</span></header>
          {detail.operations.length === 0 ? <BankEmpty compact title="Пакет пуст" message="Добавьте операции через массовое изменение вопросов или удалите черновик." /> : <ol className={styles.draftOperations}>{detail.operations.map((operation) => <li key={operation.id}><strong>Вопрос #{operation.questionId}</strong><span>{operation.patch.topic ? `Категория → ${operation.patch.topic}` : operation.patch.difficulty ? `Сложность → ${difficultyLabels[operation.patch.difficulty]}` : operation.patch.active === true ? 'Включить' : 'Выключить'}</span>{detail.changeSet.status === 'draft' && <button type="button" disabled={saving} onClick={() => void removeDraftOperation(operation.questionId)} aria-label={`Удалить изменение вопроса ${operation.questionId}`}>×</button>}</li>)}</ol>}
          {preview && <div className={styles.draftPreview}><header><strong>{preview.readiness.ready ? 'Готов к публикации' : 'Публикация заблокирована'}</strong><span>{preview.changedCount} изменится · {preview.unchangedCount} без изменений</span></header><p>{preview.coverage.ready ? 'Покрытие банка сохранено.' : 'После изменений возникнет дефицит вопросов. Исправьте пакет.'}</p>{preview.readiness.issues.length > 0 && <ul>{preview.readiness.issues.map((issue) => <li key={issue}>{readinessMessage(issue)}</li>)}</ul>}{preview.readiness.warnings.length > 0 && <ul>{preview.readiness.warnings.map((warning) => <li key={warning}>{readinessMessage(warning)}</li>)}</ul>}</div>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          {confirmDelete && <div className={styles.draftDeleteConfirm} role="alert"><span>Удалить черновик без публикации?</span><button className={styles.dangerButton} type="button" disabled={saving} onClick={() => void discardDraft()}>Да, удалить</button><button className={styles.quietButton} type="button" disabled={saving} onClick={() => setConfirmDelete(false)}>Отмена</button></div>}
          <div className={styles.draftActions}><button className={styles.dangerButton} type="button" disabled={saving || detail.changeSet.status !== 'draft'} onClick={() => setConfirmDelete(true)}>Удалить</button><button className={styles.secondaryButton} type="button" disabled={saving || detail.operations.length === 0 || detail.changeSet.status !== 'draft'} onClick={() => void previewDraft()}>{saving ? 'Проверяем…' : 'Проверить пакет'}</button><button className={styles.primaryButton} type="button" disabled={saving || !preview?.readiness.ready || detail.changeSet.status !== 'draft'} onClick={() => void publishDraft()}>Опубликовать</button></div>
        </>}
      </article>
    </section>
  );
}

const qualityWarningText: Record<string, string> = {
  insufficient: 'Недостаточно данных для вывода',
  too_easy: 'Вопрос заметно проще заявленного',
  too_hard: 'Вопрос заметно сложнее заявленного',
  high_timeout: 'Высокая доля тайм-аутов',
  slow: 'Ответ занимает аномально много времени',
  negative_discrimination: 'Вопрос хуже разделяет уровень кандидатов',
};

function BankQualityPanel({ onAdminError, onOpenQuestion }: {
  onAdminError: (error: unknown) => void;
  onOpenQuestion: (id: number) => void;
}) {
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [queue, setQueue] = useState<QualityQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextCoverage, nextQueue] = await Promise.all([
        questionBankRequest<CoverageResponse>('/api/admin/questions/coverage'),
        questionBankRequest<QualityQueueResponse>('/api/admin/questions/quality-queue'),
      ]);
      setCoverage(nextCoverage); setQueue(nextQueue);
    } catch (requestError) { onAdminError(requestError); setError(questionBankError(requestError).message); }
    finally { setLoading(false); }
  }, [onAdminError]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  if (loading) return <BankLoading />;
  if (error || !coverage || !queue) return <BankError error={{ message: error || 'Не удалось загрузить контроль банка.', issues: [] }} />;
  const actionableQueue = queue.items.filter((item) => item.qualityStatus === 'review' || item.qualityStatus === 'observe');
  const waitingForData = queue.items.filter((item) => item.qualityStatus === 'insufficient').length;
  const disabledCount = queue.items.filter((item) => item.qualityStatus === 'disabled').length;
  const coverageMessages = [...new Set([...coverage.issues, ...coverage.warnings])];
  return (
    <div className={styles.qualityWorkspace}>
      <section className={styles.bankOperationWorkspace}>
        <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Покрытие</p><h3>Хватает ли вопросов для теста</h3><p>Матрица показывает активный резерв каждой категории и сложности.</p></div><span className={coverage.ready ? styles.bankActive : styles.bankInactive}>{coverage.ready ? 'Банк готов' : 'Есть дефицит'}</span></header>
        {coverageMessages.length > 0 && (
          <div className={styles.coverageCallout} data-ready={coverage.ready} role="status">
            <strong>{coverage.ready ? 'Что стоит улучшить' : 'Почему банк не готов'}</strong>
            <ul>{coverageMessages.map((message) => <li key={message}>{readinessMessage(message)}</li>)}</ul>
          </div>
        )}
        <div className={styles.coverageTableWrap}>
          <table className={styles.coverageTable}>
            <thead><tr><th>Категория</th>{(Object.keys(difficultyLabels) as Difficulty[]).map((item) => <th key={item}>{difficultyLabels[item]}</th>)}<th>Всего</th><th>Состояние</th></tr></thead>
            <tbody>{coverage.categories.map((item) => {
              const unused = item.requiredTotal === 0 || (item.status as string) === 'unused';
              const statusLabel = unused ? 'Без тематической квоты' : item.status === 'enough' ? 'Достаточно' : 'Дефицит';
              const explanation = item.deficits.length > 0
                ? item.deficits.join(' · ')
                : unused
                  ? 'Для категории нет обязательной квоты в сбалансированном профиле; обычный селектор по-прежнему может выбрать её вопросы.'
                  : null;
              return (
                <tr key={item.categoryId} data-status={unused ? 'unused' : item.status}>
                  <td data-label="Категория"><strong>{item.name}</strong></td>
                  {(Object.keys(difficultyLabels) as Difficulty[]).map((difficulty) => <td key={difficulty} data-label={difficultyLabels[difficulty]}>{item.counts[difficulty]}</td>)}
                  <td data-label="Всего">{item.counts.total}</td>
                  <td data-label="Состояние">
                    <span className={unused ? styles.coverageNeutral : item.status === 'enough' ? styles.bankActive : styles.bankInactive}>{statusLabel}</span>
                    {explanation && <small>{explanation}</small>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
      <section className={styles.bankOperationWorkspace}>
        <header className={styles.bankOperationHeading}><div><p className={styles.eyebrow}>Очередь качества</p><h3>Что проверить в первую очередь</h3><p>Причины сформированы по фактическим ответам; решение всегда остаётся за администратором.</p></div><span>{actionableQueue.length} требуют решения · {waitingForData} ждут выборки</span></header>
        {(waitingForData > 0 || disabledCount > 0) && <div className={styles.qualityQueueSummary}><span>{waitingForData} вопросов ждут данных</span>{disabledCount > 0 && <span>{disabledCount} выключено</span>}</div>}
        {actionableQueue.length === 0 ? <BankEmpty compact title="Нет вопросов, требующих решения" message={waitingForData ? 'Наблюдения накапливаются. Вопросы с малой выборкой не перегружают рабочую очередь.' : 'По текущей выборке вопросы не требуют действий администратора.'} /> : <ol className={styles.qualityQueue}>{actionableQueue.map((item) => <li key={item.questionId}><div><span className={item.qualityStatus === 'review' ? styles.bankInactive : styles.qualityQueueObserve}>{item.qualityStatus === 'review' ? 'Проверить' : 'Наблюдать'}</span><strong>Вопрос #{item.questionId}</strong><small>{item.topic} · {difficultyLabels[item.difficulty] ?? item.difficulty}</small></div><ul>{item.warnings.map((warning) => <li key={warning}>{qualityWarningText[warning] ?? warning}</li>)}</ul><div className={styles.qualityQueueActions}><a className={styles.secondaryButton} href={appPath(item.analyticsHref)}>Аналитика</a><a className={styles.primaryButton} href={appPath(item.editorHref)} onClick={(event) => { event.preventDefault(); onOpenQuestion(item.questionId); }}>Открыть вопрос</a></div></li>)}</ol>}
      </section>
    </div>
  );
}

function QuestionBankDialog({
  mode,
  questionId,
  csrfToken,
  currentBankRevision,
  topics,
  onClose,
  onAdminError,
  onComplete,
  onOpenQuestion,
  onChangeMode,
}: {
  mode: EditorMode;
  questionId?: number;
  csrfToken: string;
  currentBankRevision: string;
  topics: string[];
  onClose: () => void;
  onAdminError: (error: unknown) => void;
  onComplete: (result: QuestionBankMutationDto, openId?: number) => void;
  onOpenQuestion: (id: number) => void;
  onChangeMode: (mode: EditorMode, id?: number) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const confirmDiscardRef = useRef(false);
  const [detail, setDetail] = useState<QuestionBankDetailDto | null>(null);
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [initialDraftSnapshot, setInitialDraftSnapshot] = useState(() => JSON.stringify(emptyDraft()));
  const [loading, setLoading] = useState(mode !== 'create');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<RequestIssue>({ message: '', issues: [] });
  const discardActionRef = useRef<() => void>(onClose);
  const saveMutationRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const toggleMutationRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const isEditing = mode === 'create' || mode === 'revise';
  const draftChanged = isEditing && JSON.stringify(draft) !== initialDraftSnapshot;

  const requestExit = useCallback((action: () => void) => {
    if (draftChanged && !saving) {
      discardActionRef.current = action;
      setConfirmDiscard(true);
      return;
    }
    action();
  }, [draftChanged, saving]);

  useEffect(() => { closeRef.current = () => requestExit(onClose); }, [onClose, requestExit]);
  useEffect(() => { confirmDiscardRef.current = confirmDiscard; }, [confirmDiscard]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmDiscardRef.current) {
          setConfirmDiscard(false);
          return;
        }
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusScope = confirmDiscardRef.current && discardDialogRef.current
        ? discardDialogRef.current
        : dialogRef.current;
      const focusable = [...focusScope.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === focusScope)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (mode === 'create') {
      return;
    }
    if (!questionId) return;
    const controller = new AbortController();
    void questionBankRequest<QuestionBankDetailDto>(`/api/admin/questions/${questionId}`, { signal: controller.signal })
      .then((payload) => {
        const nextDraft = draftFromQuestion(payload.question);
        setDetail(payload);
        setDraft(nextDraft);
        setInitialDraftSnapshot(JSON.stringify(nextDraft));
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        onAdminError(requestError);
        setError(questionBankError(requestError));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [mode, onAdminError, questionId]);

  function setChoice(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      choices: current.choices.map((choice, choiceIndex) => choiceIndex === index ? value : choice),
    }));
  }

  function addChoice() {
    setDraft((current) => current.choices.length >= 5
      ? current
      : { ...current, choices: [...current.choices, ''] });
  }

  function removeChoice(index: number) {
    setDraft((current) => {
      if (current.choices.length <= 2) return current;
      const choices = current.choices.filter((_, choiceIndex) => choiceIndex !== index);
      const correctIndex = current.correctIndex === index
        ? 0
        : current.correctIndex > index ? current.correctIndex - 1 : current.correctIndex;
      return { ...current, choices, correctIndex };
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError({ message: '', issues: [] });
    const draftBody = {
      topic: draft.topic.trim(),
      difficulty: draft.difficulty,
      prompt: draft.prompt.trim(),
      contextType: draft.contextType || null,
      context: draft.contextType ? draft.context : null,
      choices: draft.choices.map((choice) => choice.trim()),
      correctIndex: draft.correctIndex,
      dedupeKey: draft.dedupeKey.trim().toLowerCase(),
      active: draft.active,
      note: draft.note.trim() || undefined,
      expectedBankRevision: detail?.currentBankRevision || currentBankRevision,
    };
    const fingerprint = JSON.stringify({ mode, questionId, draftBody });
    const body = {
      ...draftBody,
      idempotencyKey: idempotencyKey(saveMutationRef, fingerprint),
    };
    try {
      const result = await questionBankRequest<QuestionBankMutationDto>(
        mode === 'create' ? '/api/admin/questions' : `/api/admin/questions/${questionId}`,
        {
          method: mode === 'create' ? 'POST' : 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(body),
        },
      );
      saveMutationRef.current = null;
      onComplete(result, result.question.id);
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    if (!detail || toggling) return;
    setToggling(true);
    setError({ message: '', issues: [] });
    try {
      const result = await questionBankRequest<QuestionBankMutationDto>(
        `/api/admin/questions/${detail.question.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            active: !detail.question.active,
            note: `${detail.question.active ? 'Выключен' : 'Включён'} администратором из панели`,
            expectedBankRevision: detail.currentBankRevision,
            idempotencyKey: idempotencyKey(
              toggleMutationRef,
              JSON.stringify({
                id: detail.question.id,
                active: !detail.question.active,
                revision: detail.currentBankRevision,
              }),
            ),
          }),
        },
      );
      toggleMutationRef.current = null;
      setConfirmToggle(false);
      onComplete(result, result.question.id);
    } catch (requestError) {
      onAdminError(requestError);
      setError(questionBankError(requestError));
    } finally {
      setToggling(false);
    }
  }

  const title = mode === 'create'
    ? 'Новый вопрос'
    : mode === 'revise'
      ? `Новая редакция #${questionId}`
      : `Вопрос #${questionId}`;

  return (
    <div className={styles.detailBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestExit(onClose);
    }}>
      <section
        ref={dialogRef}
        className={`${styles.detailDialog} ${styles.bankDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-bank-dialog-title"
        tabIndex={-1}
      >
        <header className={styles.detailHeader}>
          <div>
            <span className={styles.dialogEyebrow}>{isEditing ? 'Редактор банка' : 'Карточка банка'}</span>
            <h2 id="question-bank-dialog-title">{title}</h2>
          </div>
          <button type="button" onClick={() => requestExit(onClose)} aria-label="Закрыть">×</button>
        </header>
        <div className={styles.detailBody}>
          {loading ? <BankLoading compact /> : error.message && !detail && mode !== 'create' ? (
            <BankError error={error} />
          ) : isEditing ? (
            <QuestionEditor
              draft={draft}
              mode={mode}
              source={detail?.question ?? null}
              topics={topics}
              saving={saving}
              error={error}
              onChange={setDraft}
              onSetChoice={setChoice}
              onAddChoice={addChoice}
              onRemoveChoice={removeChoice}
              onSubmit={save}
              onCancel={() => requestExit(() => mode === 'revise' && questionId ? onChangeMode('view', questionId) : onClose())}
            />
          ) : detail ? (
            <QuestionViewer
              detail={detail}
              confirmToggle={confirmToggle}
              toggling={toggling}
              error={error}
              onRevise={() => onChangeMode('revise', detail.question.id)}
              onAskToggle={() => setConfirmToggle(true)}
              onCancelToggle={() => setConfirmToggle(false)}
              onToggle={() => void toggle()}
              onOpenQuestion={onOpenQuestion}
            />
          ) : <BankError error={error} />}
        </div>
        {confirmDiscard && (
          <div ref={discardDialogRef} className={styles.bankDiscardOverlay} role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description">
            <div>
              <span aria-hidden="true">!</span>
              <h3 id="discard-title">Отменить несохранённые изменения?</h3>
              <p id="discard-description">Введённые данные не были сохранены в банке вопросов.</p>
              <div>
                <button className={styles.dangerButton} type="button" onClick={() => {
                  setConfirmDiscard(false);
                  discardActionRef.current();
                }}>Отменить изменения</button>
                <button className={styles.secondaryButton} type="button" autoFocus onClick={() => setConfirmDiscard(false)}>Продолжить редактирование</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function QuestionViewer({
  detail,
  confirmToggle,
  toggling,
  error,
  onRevise,
  onAskToggle,
  onCancelToggle,
  onToggle,
  onOpenQuestion,
}: {
  detail: QuestionBankDetailDto;
  confirmToggle: boolean;
  toggling: boolean;
  error: RequestIssue;
  onRevise: () => void;
  onAskToggle: () => void;
  onCancelToggle: () => void;
  onToggle: () => void;
  onOpenQuestion: (id: number) => void;
}) {
  const { question } = detail;
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmToggle) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      confirmRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, [confirmToggle]);
  const versionIndex = Math.max(0, detail.lineage.findIndex((item) => item.id === question.id)) + 1;
  return (
    <div className={styles.bankDetailStack}>
      <section className={styles.bankDetailLead}>
        <div className={styles.bankQuestionIdentity}>
          <span>#{question.id}</span>
          <span>{difficultyLabels[question.difficulty]}</span>
          <span>{question.topic}</span>
          <span>редакция {versionIndex} из {Math.max(1, detail.lineage.length)}</span>
          <span>{question.active ? 'активен' : 'выключен'}</span>
        </div>
        <h3>{question.prompt}</h3>
        {question.context && <pre><code>{question.context}</code></pre>}
        <ol className={styles.bankEditorChoices} aria-label="Варианты ответа и ключ">
          {question.choices.map((choice, index) => (
            <li className={index === question.correctIndex ? styles.bankCorrectChoice : ''} key={`${question.id}-${index}`}>
              <span>{String.fromCharCode(65 + index)}</span>
              <strong>{choice}</strong>
              {index === question.correctIndex && <small>Правильный ответ</small>}
            </li>
          ))}
        </ol>
      </section>

      <dl className={styles.bankMetadata}>
        <div><dt>Смысловая группа</dt><dd>{question.dedupeKey}</dd></div>
        <div><dt>Внутренний вес</dt><dd>{question.weight}</dd></div>
        <div><dt>Использований</dt><dd>{question.usageCount}</dd></div>
        <div><dt>Хеш содержимого</dt><dd>{question.contentHash.slice(0, 12)}</dd></div>
        <div><dt>Ревизия банка</dt><dd>{detail.currentBankRevision.slice(0, 12)}</dd></div>
      </dl>

      <section className={styles.bankActionsCard}>
        <div>
          <h3>Управление вопросом</h3>
          <p>Текст, тема и сложность меняются только новой редакцией. Историческая аналитика сохранит прежний ID.</p>
        </div>
        <div className={styles.bankActionButtons}>
          {!question.successorId && <button className={styles.primaryButton} type="button" onClick={onRevise}>Создать новую редакцию</button>}
          <button className={styles.secondaryButton} type="button" onClick={onAskToggle}>
            {question.active ? 'Выключить вопрос' : 'Включить вопрос'}
          </button>
        </div>
        {question.successorId && (
          <p className={styles.bankNotice}>У этого вопроса уже есть редакция #{question.successorId}. Исправлять нужно актуальную версию.</p>
        )}
        {confirmToggle && (
          <div
            ref={confirmRef}
            className={styles.bankConfirm}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bank-toggle-title"
            aria-describedby="bank-toggle-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCancelToggle();
                return;
              }
              if (event.key !== 'Tab' || !confirmRef.current) return;
              const buttons = [...confirmRef.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
              const first = buttons[0];
              const last = buttons.at(-1);
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div>
              <strong id="bank-toggle-title">{question.active ? 'Выключить вопрос?' : 'Вернуть вопрос в тест?'}</strong>
              <p id="bank-toggle-description">{question.active
                ? 'Новые тесты перестанут выбирать этот вопрос. История ответов и аналитика сохранятся.'
                : 'Вопрос снова станет доступен для новых тестов после проверки готовности банка.'}</p>
            </div>
            <button className={question.active ? styles.dangerButton : styles.primaryButton} type="button" disabled={toggling} onClick={onToggle}>
              {toggling ? 'Сохраняем…' : question.active ? 'Да, выключить' : 'Да, включить'}
            </button>
            <button className={styles.quietButton} type="button" disabled={toggling} onClick={onCancelToggle}>Отмена</button>
          </div>
        )}
        {error.message && <BankError error={error} compact />}
      </section>

      <section className={styles.bankHistorySection}>
        <header><div><span className={styles.dialogEyebrow}>Аудит</span><h3>История редакций</h3></div><span>{detail.history.length} событий</span></header>
        {detail.lineage.length > 1 && (
          <nav className={styles.bankLineage} aria-label="Цепочка редакций">
            {detail.lineage.map((item, index) => (
              <span key={item.id}>
                {index > 0 && <i aria-hidden="true">→</i>}
                <button type="button" aria-current={item.id === question.id ? 'page' : undefined} onClick={() => onOpenQuestion(item.id)}>#{item.id}</button>
              </span>
            ))}
          </nav>
        )}
        {detail.history.length === 0 ? (
          <p className={styles.bankNotice}>Для этой редакции пока нет событий аудита.</p>
        ) : (
          <ol className={styles.bankHistory}>
            {detail.history.map((event) => (
              <li key={event.id}>
                <span aria-hidden="true" />
                <div>
                  <strong>{historyLabel(event.eventType)}</strong>
                  <small>{timestampLabel(event.createdAt)} · вопрос #{event.questionId} · ревизия {event.bankRevision.slice(0, 8)}</small>
                  {event.note && <p>{event.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function QuestionEditor({
  draft,
  mode,
  source,
  topics,
  saving,
  error,
  onChange,
  onSetChoice,
  onAddChoice,
  onRemoveChoice,
  onSubmit,
  onCancel,
}: {
  draft: QuestionDraft;
  mode: 'create' | 'revise';
  source: QuestionAdminDetail | null;
  topics: string[];
  saving: boolean;
  error: RequestIssue;
  onChange: Dispatch<SetStateAction<QuestionDraft>>;
  onSetChoice: (index: number, value: string) => void;
  onAddChoice: () => void;
  onRemoveChoice: (index: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form className={styles.bankEditor} onSubmit={onSubmit}>
      {mode === 'revise' && source && (
        <div className={styles.bankRevisionWarning} role="note">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Будет создан новый вопрос с новым ID</strong>
            <p>Редакция #{source.id} останется в истории и будет выключена. Это сохраняет достоверность уже собранной аналитики.</p>
          </div>
        </div>
      )}

      <section className={styles.bankEditorSection}>
        <header><span>01</span><div><h3>Классификация</h3><p>Тема определяет квоту, сложность — вес и пул выбора.</p></div></header>
        <div className={styles.bankEditorGrid}>
          <label>
            <span>Категория</span>
            <select
              value={draft.topic}
              onChange={(event) => {
                const value = event.target.value;
                onChange((current) => ({ ...current, topic: value }));
              }}
              required
            >
              <option value="">Выберите категорию</option>
              {draft.topic && !topics.includes(draft.topic) && <option value={draft.topic} disabled>{draft.topic} · недоступна</option>}
              {topics.map((topic) => <option value={topic} key={topic}>{topic}</option>)}
            </select>
            <small>Новую категорию сначала добавьте в разделе «Категории».</small>
          </label>
          <label>
            <span>Сложность</span>
            <select value={draft.difficulty} onChange={(event) => {
              const value = event.target.value as Difficulty;
              onChange((current) => ({ ...current, difficulty: value }));
            }}>
              {(Object.keys(difficultyLabels) as Difficulty[]).map((value) => <option value={value} key={value}>{difficultyLabels[value]}</option>)}
            </select>
          </label>
          <label className={styles.bankWideField}>
            <span>Смысловая группа</span>
            <input
              value={draft.dedupeKey}
              onChange={(event) => {
                const value = event.target.value;
                onChange((current) => ({ ...current, dedupeKey: value }));
              }}
              required
              maxLength={80}
              pattern="[a-zA-Z0-9][a-zA-Z0-9:_-]*"
              placeholder="network:dns-basics"
              spellCheck={false}
            />
            <small>Латиница, цифры, «:», «_», «-». Вопросы об одном понятии получают одинаковую группу.</small>
          </label>
        </div>
      </section>

      <section className={styles.bankEditorSection}>
        <header><span>02</span><div><h3>Формулировка</h3><p>Короткий однозначный вопрос без подсказки в вариантах.</p></div></header>
        <label>
          <span>Текст вопроса</span>
          <textarea
            value={draft.prompt}
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({ ...current, prompt: value }));
            }}
            required
            maxLength={280}
            rows={4}
          />
          <small>{draft.prompt.length} / 280</small>
        </label>
        <div className={styles.bankEditorGrid}>
          <label>
            <span>Дополнительный контекст</span>
            <select
              value={draft.contextType}
              onChange={(event) => {
                const value = event.target.value as ContextType | '';
                onChange((current) => ({
                  ...current,
                  contextType: value,
                  context: value ? current.context : '',
                }));
              }}
            >
              <option value="">Не нужен</option>
              {(Object.keys(contextTypeLabels) as ContextType[]).map((value) => <option value={value} key={value}>{contextTypeLabels[value]}</option>)}
            </select>
          </label>
          {draft.contextType && (
            <label className={styles.bankWideField}>
              <span>{contextTypeLabels[draft.contextType]}</span>
              <textarea
                value={draft.context}
                onChange={(event) => {
                  const value = event.target.value;
                  onChange((current) => ({ ...current, context: value }));
                }}
                required
                maxLength={2000}
                rows={7}
                spellCheck={draft.contextType === 'text'}
              />
              <small>{draft.context.length} / 2000</small>
            </label>
          )}
        </div>
      </section>

      <fieldset className={styles.bankEditorSection}>
        <legend><span>03</span><span><b>Варианты ответа</b><small>Выберите правильный ответ. В обычном списке банка эта отметка скрыта.</small></span></legend>
        <div className={styles.bankChoiceEditor}>
          {draft.choices.map((choice, index) => (
            <div key={index} data-correct={draft.correctIndex === index}>
              <label className={styles.bankCorrectRadio}>
                <input
                  type="radio"
                  name="correctIndex"
                  checked={draft.correctIndex === index}
                  onChange={() => onChange((current) => ({ ...current, correctIndex: index }))}
                />
                <span>{String.fromCharCode(65 + index)}</span>
                <small>{draft.correctIndex === index ? 'Правильный' : 'Выбрать'}</small>
              </label>
              <input
                value={choice}
                onChange={(event) => onSetChoice(index, event.target.value)}
                required
                maxLength={160}
                aria-label={`Вариант ${String.fromCharCode(65 + index)}`}
              />
              <button type="button" disabled={draft.choices.length <= 2} onClick={() => onRemoveChoice(index)} aria-label={`Удалить ответ ${String.fromCharCode(65 + index)}`}>×</button>
            </div>
          ))}
        </div>
        {draft.choices.length < 5 && <button className={styles.bankAddChoice} type="button" onClick={onAddChoice}>＋ Добавить вариант</button>}
      </fieldset>

      <section className={styles.bankEditorSection}>
        <header><span>04</span><div><h3>Публикация в банке</h3><p>Сервер проверит дубликаты, пулы сложности и remedial-резерв.</p></div></header>
        <label className={styles.bankSwitch}>
          <input type="checkbox" checked={draft.active} onChange={(event) => {
            const checked = event.target.checked;
            onChange((current) => ({ ...current, active: checked }));
          }} />
          <span aria-hidden="true" />
          <div><strong>Активный вопрос</strong><small>Доступен новым тестам сразу после сохранения.</small></div>
        </label>
        <label>
          <span>Комментарий к изменению</span>
          <textarea
            value={draft.note}
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({ ...current, note: value }));
            }}
            maxLength={500}
            rows={3}
            placeholder={mode === 'revise' ? 'Что исправлено и почему' : 'Зачем добавлен вопрос'}
          />
        </label>
      </section>

      {error.message && <BankError error={error} />}
      <footer className={styles.bankEditorFooter}>
        <button className={styles.quietButton} type="button" disabled={saving} onClick={onCancel}>Отмена</button>
        <button className={styles.primaryButton} type="submit" disabled={saving}>
          {saving ? 'Проверяем и сохраняем…' : mode === 'revise' ? 'Создать новую редакцию' : 'Создать вопрос'}
        </button>
      </footer>
    </form>
  );
}

function BankError({ error, compact = false }: { error: RequestIssue; compact?: boolean }) {
  return (
    <div className={`${styles.bankFormError} ${compact ? styles.bankFormErrorCompact : ''}`} role="alert">
      <strong>{error.message || 'Не удалось загрузить вопрос.'}</strong>
      {error.issues.length > 0 && <ul>{error.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    </div>
  );
}

function BankLoading({ compact = false }: { compact?: boolean }) {
  return <div className={`${styles.loadingState} ${compact ? styles.compactState : ''}`} role="status"><i aria-hidden="true" />Загружаем банк…</div>;
}

function BankEmpty({
  title,
  message,
  action,
  compact = false,
}: {
  title: string;
  message: string;
  action?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`${styles.emptyState} ${compact ? styles.compactState : ''}`}>
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{message}</p>
      {action && <button className={styles.primaryButton} type="button" onClick={action}>Создать вопрос</button>}
    </div>
  );
}
