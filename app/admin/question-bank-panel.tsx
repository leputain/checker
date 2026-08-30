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
  QuestionBankHistoryEventDto as QuestionBankHistoryEvent,
} from '@/lib/question-admin-contract.ts';
import { AdminRequestError, adminErrorMessage } from './admin-client.ts';
import styles from './admin.module.css';

type Difficulty = QuestionAdminItem['difficulty'];
type ContextType = Exclude<QuestionAdminDetail['contextType'], null>;
type EditorMode = 'view' | 'create' | 'revise';

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
}: {
  csrfToken: string;
  onAdminError: (error: unknown) => void;
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
  const [mutationNotice, setMutationNotice] = useState<QuestionBankMutationDto | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [editor, setEditor] = useState<{ mode: EditorMode; id?: number } | null>(null);

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
            <article className={styles.bankQuestionCard} key={item.id} data-active={item.active}>
              <header>
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

      {editor && (
        <QuestionBankDialog
          key={`${editor.mode}-${editor.id ?? 'new'}`}
          mode={editor.mode}
          questionId={editor.id}
          csrfToken={csrfToken}
          currentBankRevision={currentBankRevision}
          topics={topics}
          onClose={() => setEditor(null)}
          onAdminError={onAdminError}
          onComplete={mutationComplete}
          onOpenQuestion={(id) => setEditor({ mode: 'view', id })}
          onChangeMode={(mode, id) => setEditor({ mode, id })}
        />
      )}
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
            <span>Тема</span>
            <input
              list="question-bank-topics"
              value={draft.topic}
              onChange={(event) => {
                const value = event.target.value;
                onChange((current) => ({ ...current, topic: value }));
              }}
              required
              maxLength={80}
              placeholder="Например, Сети"
            />
            <datalist id="question-bank-topics">{topics.map((topic) => <option value={topic} key={topic} />)}</datalist>
            <small>{draft.topic.length} / 80</small>
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
}: {
  title: string;
  message: string;
  action?: () => void;
}) {
  return (
    <div className={styles.emptyState}>
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{message}</p>
      {action && <button className={styles.primaryButton} type="button" onClick={action}>Создать вопрос</button>}
    </div>
  );
}
