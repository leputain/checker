'use client';

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { appPath } from '@/lib/app-path.ts';
import { APP_RELEASE, releaseAssetPath } from '@/lib/release.ts';
import { BASE_MAX_SCORE, BASE_QUESTION_COUNT, TEST_CONFIG } from '@/lib/test-config.ts';

type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type Verdict = 'PASS' | 'REVIEW' | 'FAIL';
type Connectivity = 'checking' | 'online' | 'offline' | 'service-error';

type QuestionView = {
  id: number;
  prompt: string;
  choices: string[];
  difficulty: Difficulty;
  weight: number;
  position: number;
  minimumQuestions: number;
  questionDeadlineAt: number;
  totalDeadlineAt: number;
};

type Result = {
  verdict: Verdict;
  score: number;
  baseMaxScore: number;
  scorePercent: number;
  correctCount: number;
  wrongCount: number;
  answeredCount: number;
  accuracy: number;
  durationSeconds: number;
  completedAt: string;
};

type AttemptPayload = {
  attemptId: string;
  alias: string;
  status: 'active' | 'completed' | 'aborted';
  serverNowMs: number;
  question?: QuestionView;
  result?: Result;
};

type AttemptState = AttemptPayload & { token: string };

type StoredSession =
  | {
      version: 2;
      phase: 'starting';
      startKey: string;
      token: string;
      createdAt: number;
    }
  | {
      version: 2;
      phase: 'active';
      attemptId: string;
      token: string;
      expiresAt: number;
    };

type PendingDelivery = {
  attemptId: string;
  token: string;
  expiresAt: number;
  nextAttemptAt: number;
};

type LeaderboardEntry = {
  alias: string;
  verdict: Verdict;
  score: number;
  baseMaxScore: number;
  accuracy: number;
  wrongCount: number;
  durationSeconds: number;
  completedAt: string;
};

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
};

const STORAGE_KEY = 'candidate-check:active-attempt';
const DELIVERY_STORAGE_KEY = 'candidate-check:pending-telegram-deliveries';
const REQUEST_TIMEOUT_MS = 8_000;
const SESSION_GRACE_MS = 15 * 60 * 1_000;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1_000;

const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};

const verdictLabels: Record<Verdict, string> = {
  PASS: 'Рекомендован',
  REVIEW: 'Нужна проверка',
  FAIL: 'Порог не пройден',
};

const verdictCopy: Record<Verdict, string> = {
  PASS: 'Кандидат прошёл первичный технический фильтр.',
  REVIEW: 'Результат требует дополнительной оценки специалистом.',
  FAIL: 'Минимальный порог технического отбора не достигнут.',
};

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function formatTestDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(timestamp);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredSession;
    if (session.version !== 2 || !session.token) return null;
    return session;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function localSessionExpiry(totalDeadlineAt: number, serverNowMs: number) {
  return Date.now() + Math.max(0, totalDeadlineAt - serverNowMs) + SESSION_GRACE_MS;
}

function responseRetryAfterMs(response: Response) {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (!retryAfter) return 5_000;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : 5_000;
}

function readPendingDeliveries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DELIVERY_STORAGE_KEY) ?? '[]') as PendingDelivery[];
    const now = Date.now();
    return parsed.filter((item) => (
      item.attemptId && item.token && item.expiresAt > now && Number.isFinite(item.nextAttemptAt)
    ));
  } catch {
    return [];
  }
}

function writePendingDeliveries(deliveries: PendingDelivery[]) {
  if (deliveries.length === 0) localStorage.removeItem(DELIVERY_STORAGE_KEY);
  else localStorage.setItem(DELIVERY_STORAGE_KEY, JSON.stringify(deliveries.slice(-8)));
}

function queuePendingDelivery(attemptId: string, token: string, afterMs = 0) {
  const deliveries = readPendingDeliveries();
  const existing = deliveries.find((item) => item.attemptId === attemptId);
  const nextAttemptAt = Date.now() + Math.max(0, afterMs);
  if (existing) {
    existing.token = token;
    existing.expiresAt = Date.now() + DELIVERY_TTL_MS;
    existing.nextAttemptAt = Math.min(existing.nextAttemptAt, nextAttemptAt);
  } else {
    deliveries.push({ attemptId, token, expiresAt: Date.now() + DELIVERY_TTL_MS, nextAttemptAt });
  }
  writePendingDeliveries(deliveries);
}

function updatePendingDelivery(attemptId: string, retryAfterMs: number | null) {
  const deliveries = readPendingDeliveries();
  const existing = deliveries.find((item) => item.attemptId === attemptId);
  if (!existing) return;
  if (retryAfterMs === null) {
    writePendingDeliveries(deliveries.filter((item) => item.attemptId !== attemptId));
    return;
  }
  existing.nextAttemptAt = Date.now() + Math.max(1_000, retryAfterMs);
  writePendingDeliveries(deliveries);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

class RequestError extends Error {
  retryable: boolean;
  status: number;

  constructor(message: string, retryable: boolean, status = 0) {
    super(message);
    this.name = 'RequestError';
    this.retryable = retryable;
    this.status = status;
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  retries = 0,
): Promise<T> {
  let lastError: Error = new Error('Не удалось выполнить запрос');
  for (let attemptNumber = 0; attemptNumber <= retries; attemptNumber += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(input, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as T & { error?: string };
      if (response.ok) return data;
      const error = new RequestError(
        data.error || 'Сервер временно недоступен',
        response.status >= 500 || response.status === 408 || response.status === 429,
        response.status,
      );
      if (!error.retryable) throw error;
      lastError = error;
    } catch (caught) {
      if (caught instanceof RequestError && !caught.retryable) throw caught;
      lastError = caught instanceof Error && caught.name !== 'AbortError'
        ? caught
        : new Error('Сервер не ответил вовремя. Проверьте соединение.');
    } finally {
      window.clearTimeout(timeout);
    }
    if (attemptNumber < retries) await delay(350 * 2 ** attemptNumber);
  }
  throw lastError;
}

export default function Home() {
  const [name, setName] = useState('');
  const [attempt, setAttempt] = useState<AttemptState | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [notice, setNotice] = useState('');
  const [connectivity, setConnectivity] = useState<Connectivity>('checking');
  const submittingRef = useRef(false);
  const timeoutBackoffUntilRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const flushingRef = useRef(false);
  const leaderboardButtonRef = useRef<HTMLButtonElement>(null);
  const abortButtonRef = useRef<HTMLButtonElement>(null);
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusedQuestionIdRef = useRef<number | null>(null);

  const question = attempt?.question;
  const questionId = question?.id ?? null;
  const totalLeft = question ? Math.ceil((question.totalDeadlineAt - now) / 1_000) : 0;
  const questionLeft = question ? Math.ceil((question.questionDeadlineAt - now) / 1_000) : 0;
  const timeProgress = question
    ? Math.min(100, Math.max(0, ((TEST_CONFIG.totalTimeSeconds - totalLeft) / TEST_CONFIG.totalTimeSeconds) * 100))
    : 0;

  const applyServerTime = useCallback((serverNowMs: number) => {
    const offset = serverNowMs - Date.now();
    setClockOffsetMs(offset);
    setNow(Date.now() + offset);
  }, []);

  const triggerNotificationFlush = useCallback((attemptId?: string, token?: string, afterMs = 0) => {
    if (attemptId && token) queuePendingDelivery(attemptId, token, afterMs);
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    async function flushOnce() {
      const deliveries = readPendingDeliveries().sort((left, right) => (
        left.nextAttemptAt - right.nextAttemptAt
      ));
      const next = deliveries[0];
      if (!next) return;
      if (flushingRef.current || !navigator.onLine) {
        flushTimerRef.current = window.setTimeout(() => void flushOnce(), 5_000);
        return;
      }
      const waitMs = next.nextAttemptAt - Date.now();
      if (waitMs > 0) {
        flushTimerRef.current = window.setTimeout(() => void flushOnce(), waitMs);
        return;
      }
      flushingRef.current = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 6_000);
      try {
        const response = await fetch(appPath(`/api/attempts/${next.attemptId}/notifications/flush`), {
          method: 'POST',
          headers: { Authorization: `Bearer ${next.token}` },
          cache: 'no-store',
          keepalive: true,
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({})) as {
          pending?: boolean;
          retryAfterMs?: number | null;
        };
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          updatePendingDelivery(
            next.attemptId,
            retryable
              ? Math.min(3_600_000, Math.max(1_000, data.retryAfterMs ?? responseRetryAfterMs(response)))
              : null,
          );
        } else if (data.pending === true) {
          updatePendingDelivery(
            next.attemptId,
            Math.min(3_600_000, Math.max(1_000, data.retryAfterMs ?? 5_000)),
          );
        } else if (data.pending === false) {
          updatePendingDelivery(next.attemptId, null);
        } else {
          updatePendingDelivery(next.attemptId, 5_000);
        }
      } catch {
        updatePendingDelivery(next.attemptId, 5_000);
      } finally {
        window.clearTimeout(timeout);
        flushingRef.current = false;
        const remaining = readPendingDeliveries();
        if (remaining.length > 0) {
          const nextWake = Math.max(0, Math.min(...remaining.map((item) => item.nextAttemptAt)) - Date.now());
          flushTimerRef.current = window.setTimeout(() => void flushOnce(), nextWake);
        }
      }
    }
    flushTimerRef.current = window.setTimeout(() => void flushOnce(), afterMs);
  }, []);

  const checkReadiness = useCallback(async () => {
    if (!navigator.onLine) {
      setConnectivity('offline');
      return false;
    }
    setConnectivity('checking');
    try {
      await requestJson<{ status: string }>(appPath('/api/health/ready'), {}, 1);
      setConnectivity('online');
      return true;
    } catch {
      setConnectivity(navigator.onLine ? 'service-error' : 'offline');
      return false;
    }
  }, []);

  useEffect(() => {
    const restore = async () => {
      setRestoreFailed(false);
      try {
        const session = readStoredSession();
        if (!session) return;
        if (session.phase === 'starting') {
          if (Date.now() - session.createdAt > SESSION_GRACE_MS) {
            clearStoredSession();
            return;
          }
          const data = await requestJson<AttemptPayload>(appPath('/api/attempts'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': session.startKey,
            },
            body: JSON.stringify({ startKey: session.startKey, token: session.token }),
          }, 2);
          applyServerTime(data.serverNowMs);
          triggerNotificationFlush(data.attemptId, session.token);
          if (data.status === 'aborted') {
            clearStoredSession();
            setAttempt(null);
            setNotice('Предыдущий тест был прерван. Можно начать новый.');
            return;
          }
          const restored = { ...data, token: session.token };
          setAttempt(restored);
          if (data.question) {
            writeStoredSession({
              version: 2,
              phase: 'active',
              attemptId: data.attemptId,
              token: session.token,
              expiresAt: localSessionExpiry(data.question.totalDeadlineAt, data.serverNowMs),
            });
          } else if (data.status === 'completed') clearStoredSession();
          return;
        }

        const data = await requestJson<AttemptPayload>(appPath(`/api/attempts/${session.attemptId}`), {
          headers: { Authorization: `Bearer ${session.token}` },
        }, 2);
        applyServerTime(data.serverNowMs);
        triggerNotificationFlush(data.attemptId, session.token);
        if (data.status === 'aborted') {
          clearStoredSession();
          setAttempt(null);
          setNotice('Предыдущий тест был прерван. Можно начать новый.');
        } else {
          setAttempt({ ...data, token: session.token });
          if (data.status === 'completed') clearStoredSession();
        }
      } catch (caught) {
        if (caught instanceof RequestError && caught.status === 404) {
          clearStoredSession();
        } else {
          setError('Не удалось восстановить попытку. Проверьте соединение и обновите страницу.');
          setRestoreFailed(true);
        }
      } finally {
        setRestoring(false);
      }
    };
    void restore();
  }, [applyServerTime, restoreRevision, triggerNotificationFlush]);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => {
      void checkReadiness();
      if (readPendingDeliveries().length > 0) triggerNotificationFlush();
    }, 0);
    const onOffline = () => setConnectivity('offline');
    const onOnline = () => {
      void checkReadiness();
      if (readPendingDeliveries().length > 0) triggerNotificationFlush();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearTimeout(initialCheck);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [checkReadiness, triggerNotificationFlush]);

  useEffect(() => {
    if (!question) return;
    const timer = window.setInterval(() => setNow(Date.now() + clockOffsetMs), 250);
    return () => window.clearInterval(timer);
  }, [clockOffsetMs, question]);

  useEffect(() => {
    if (questionId === null) {
      lastFocusedQuestionIdRef.current = null;
      return;
    }
    const previousQuestionId = lastFocusedQuestionIdRef.current;
    lastFocusedQuestionIdRef.current = questionId;
    if (previousQuestionId === null || previousQuestionId === questionId) return;
    const frame = window.requestAnimationFrame(() => {
      questionHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [questionId]);

  const syncAttempt = useCallback(async () => {
    if (!attempt || !navigator.onLine) return;
    try {
      const data = await requestJson<AttemptPayload>(appPath(`/api/attempts/${attempt.attemptId}`), {
        headers: { Authorization: `Bearer ${attempt.token}` },
      }, 1);
      applyServerTime(data.serverNowMs);
      triggerNotificationFlush(data.attemptId, attempt.token);
      if (data.status === 'aborted') {
        clearStoredSession();
        setAttempt(null);
        setNotice('Тест прерван. Можно начать новый.');
      } else {
        setAttempt({ ...data, token: attempt.token });
        setSelectedChoice(null);
        if (data.status === 'completed') clearStoredSession();
      }
    } catch {
      // Существующая попытка остаётся локально и восстановится при следующем reconnect.
    }
  }, [applyServerTime, attempt, triggerNotificationFlush]);

  const submitAnswer = useCallback(async (choiceIndex: number | null, timeout = false) => {
    if (!attempt?.question || submittingRef.current || !navigator.onLine) return;
    submittingRef.current = true;
    setBusy(true);
    setTransitioning(timeout);
    setError('');
    try {
      const data = await requestJson<AttemptPayload>(appPath(`/api/attempts/${attempt.attemptId}/answer`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${attempt.token}`,
        },
        body: JSON.stringify({ questionId: attempt.question.id, choiceIndex }),
      }, 2);
      applyServerTime(data.serverNowMs);
      timeoutBackoffUntilRef.current = 0;
      triggerNotificationFlush(data.attemptId, attempt.token);
      if (data.status === 'aborted') {
        clearStoredSession();
        setAttempt(null);
        setNotice('Тест прерван. Можно начать новый.');
      } else {
        setAttempt({ ...data, token: attempt.token });
        setSelectedChoice(null);
        if (data.status === 'completed') clearStoredSession();
      }
    } catch (caught) {
      if (caught instanceof RequestError && caught.status === 404) {
        clearStoredSession();
        setAttempt(null);
        setError('Попытка больше недоступна. Начните новый тест.');
      } else if (caught instanceof RequestError && caught.status === 409 && timeout) {
        timeoutBackoffUntilRef.current = Date.now() + 1_000;
        await syncAttempt();
      } else if (timeout) {
        timeoutBackoffUntilRef.current = Date.now() + 2_000;
        setError('Связь нестабильна. Попытка сохранена, повторяем синхронизацию…');
      } else {
        setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
      }
    } finally {
      submittingRef.current = false;
      setBusy(false);
      setTransitioning(false);
    }
  }, [applyServerTime, attempt, syncAttempt, triggerNotificationFlush]);

  useEffect(() => {
    if (!question || busy || connectivity === 'offline') return;
    const deadline = Math.min(question.questionDeadlineAt, question.totalDeadlineAt);
    const nextAttemptAt = Math.max(
      deadline - clockOffsetMs + 100,
      timeoutBackoffUntilRef.current,
    );
    const timeout = window.setTimeout(
      () => void submitAnswer(null, true),
      Math.max(0, nextAttemptAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [busy, clockOffsetMs, connectivity, question, submitAnswer]);

  useEffect(() => {
    const syncAfterResume = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now() + clockOffsetMs);
      void syncAttempt();
    };
    document.addEventListener('visibilitychange', syncAfterResume);
    window.addEventListener('pageshow', syncAfterResume);
    return () => {
      document.removeEventListener('visibilitychange', syncAfterResume);
      window.removeEventListener('pageshow', syncAfterResume);
    };
  }, [clockOffsetMs, syncAttempt]);

  useEffect(() => {
    if (!question) return;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || wakeLockRef.current) return;
      const wakeLock = (navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
      }).wakeLock;
      if (!wakeLock) return;
      try {
        const sentinel = await wakeLock.request('screen');
        if (cancelled) await sentinel.release();
        else wakeLockRef.current = sentinel;
      } catch {
        // Wake Lock — улучшение, а не условие прохождения теста.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        wakeLockRef.current = null;
        void acquire();
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release();
    };
  }, [question]);

  useEffect(() => () => {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  async function startTest(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) {
      setError('Введите имя — хотя бы 2 символа.');
      return;
    }
    if (!(await checkReadiness())) {
      setError('Сервис пока не готов. Проверьте сеть или обратитесь к администратору.');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const stored = readStoredSession();
      const pending = stored?.phase === 'starting' && Date.now() - stored.createdAt < SESSION_GRACE_MS
        ? stored
        : {
            version: 2 as const,
            phase: 'starting' as const,
            startKey: crypto.randomUUID(),
            token: randomToken(),
            createdAt: Date.now(),
          };
      writeStoredSession(pending);
      const data = await requestJson<AttemptPayload>(appPath('/api/attempts'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.startKey,
        },
        body: JSON.stringify({ name: cleanName, startKey: pending.startKey, token: pending.token }),
      }, 2);
      if (data.status === 'aborted') {
        clearStoredSession();
        setNotice('Предыдущий запуск был прерван. Начните тест ещё раз.');
        return;
      }
      if (!data.question) throw new Error('Сервер не вернул первый вопрос.');
      const nextAttempt = { ...data, token: pending.token };
      writeStoredSession({
        version: 2,
        phase: 'active',
        attemptId: data.attemptId,
        token: pending.token,
        expiresAt: localSessionExpiry(data.question.totalDeadlineAt, data.serverNowMs),
      });
      setAttempt(nextAttempt);
      applyServerTime(data.serverNowMs);
      triggerNotificationFlush(data.attemptId, pending.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
    } finally {
      setBusy(false);
    }
  }

  async function abortTest() {
    if (!attempt || attempt.status !== 'active' || aborting || !navigator.onLine) return;
    submittingRef.current = true;
    setAborting(true);
    setBusy(true);
    setError('');
    try {
      const data = await requestJson<AttemptPayload>(
        appPath(`/api/attempts/${attempt.attemptId}/abort`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${attempt.token}` },
        },
        2,
      );
      applyServerTime(data.serverNowMs);
      triggerNotificationFlush(data.attemptId, attempt.token);
      setShowAbortConfirm(false);
      clearStoredSession();
      setSelectedChoice(null);
      if (data.status === 'aborted') {
        setAttempt(null);
        setName('');
        setNotice('Тест прерван. Результат не добавлен в рейтинг.');
      } else {
        setAttempt({ ...data, token: attempt.token });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось прервать тест.');
    } finally {
      submittingRef.current = false;
      setAborting(false);
      setBusy(false);
    }
  }

  function resetToStart() {
    clearStoredSession();
    setAttempt(null);
    setName('');
    setError('');
    setNotice('');
  }

  const connectivityBanner = connectivity === 'online' ? null : (
    <ConnectivityBanner state={connectivity} active={Boolean(question)} />
  );

  if (restoring) {
    return (
      <main className="app-shell loading-shell">
        {connectivityBanner}
        <div className="brand-mark" aria-hidden="true" />
        <p>Восстанавливаем попытку…</p>
      </main>
    );
  }

  if (restoreFailed) {
    return (
      <main className="app-shell loading-shell recovery-shell">
        {connectivityBanner}
        <div className="brand-mark" aria-hidden="true" />
        <h1>Попытка сохранена</h1>
        <p>{error}</p>
        <button
          className="primary-button"
          onClick={() => {
            setError('');
            setRestoring(true);
            setRestoreRevision((value) => value + 1);
          }}
        >
          Повторить подключение
        </button>
      </main>
    );
  }

  if (attempt?.status === 'completed' && attempt.result) {
    const result = attempt.result;
    return (
      <main className="app-shell result-shell">
        {connectivityBanner}
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
        <section
          className={`result-card glass-card verdict-${result.verdict.toLowerCase()}`}
          aria-hidden={showLeaderboard || undefined}
          inert={showLeaderboard || undefined}
        >
          <div className="result-topline">
            <span className="verdict-badge">
              <i aria-hidden="true" />
              {verdictLabels[result.verdict]}
            </span>
            <div className="result-mascot" aria-hidden="true" />
          </div>
          <div className="result-hero">
            <div
              className="score-ring"
              role="img"
              aria-label={`${result.scorePercent}%: ${result.score} из ${result.baseMaxScore} баллов`}
              style={{ '--score': `${result.scorePercent * 3.6}deg` } as React.CSSProperties}
            >
              <div>
                <strong>{result.scorePercent}%</strong>
                <span>{result.score} из {result.baseMaxScore} баллов</span>
              </div>
            </div>
            <div className="result-summary">
              <p className="eyebrow">Итоговая оценка</p>
              <h1>Результат готов.</h1>
              <p className="verdict-copy">{verdictCopy[result.verdict]}</p>
              <p className="muted result-copy">
                Верно {result.correctCount} из {result.answeredCount}. Правильные ответы не раскрываются.
              </p>
            </div>
          </div>
          <div className="stats-grid result-stats">
            <div><strong>{result.accuracy}%</strong><span>точность</span></div>
            <div><strong>{result.correctCount}</strong><span>верных</span></div>
            <div><strong>{result.wrongCount}</strong><span>ошибок</span></div>
            <div><strong>{result.answeredCount}</strong><span>вопросов</span></div>
            <div><strong>{formatTime(result.durationSeconds)}</strong><span>время</span></div>
            <div className="result-stat-date">
              <strong><time dateTime={result.completedAt}>{formatTestDate(result.completedAt)}</time></strong>
              <span>дата теста</span>
            </div>
          </div>
          <div className="result-actions">
            <button
              ref={leaderboardButtonRef}
              className="primary-button"
              onClick={() => setShowLeaderboard(true)}
            >
              Таблица лидеров
            </button>
            <button className="ghost-button" onClick={resetToStart}>На стартовую</button>
          </div>
          <p className="result-privacy"><span aria-hidden="true">◆</span> Банк ответов остаётся закрытым</p>
        </section>
        {showLeaderboard && (
          <Leaderboard
            onClose={() => setShowLeaderboard(false)}
            returnFocusRef={leaderboardButtonRef}
          />
        )}
      </main>
    );
  }

  if (question) {
    return (
      <>
        <main
          className="app-shell quiz-shell"
          aria-hidden={showAbortConfirm || undefined}
          inert={showAbortConfirm || undefined}
        >
          {connectivityBanner}
          <div className="ambient ambient-one" />
          <header className="quiz-header">
            <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Candidate Check</span></div>
            <div className="quiz-header-actions">
              <button
                ref={abortButtonRef}
                className="abort-button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setShowAbortConfirm(true);
                }}
              >
                Прервать
              </button>
              <div className="timer-group" aria-label="Оставшееся время">
                <TimerDial kind="question" label="Вопрос" seconds={questionLeft} maximum={TEST_CONFIG.questionTimeSeconds} />
                <TimerDial kind="total" label="Весь тест" seconds={totalLeft} maximum={TEST_CONFIG.totalTimeSeconds} />
              </div>
            </div>
          </header>
          <section className="quiz-stage">
            <div className="quiz-meta">
              <span className={`difficulty difficulty-${question.difficulty}`}>
                {difficultyLabels[question.difficulty]} · {question.weight} балл(а)
              </span>
              <span>Вопрос {question.position} · минимум {question.minimumQuestions}</span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Использованное общее время"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(timeProgress)}
            >
              <span style={{ width: `${timeProgress}%` }} />
            </div>
            <article key={question.id} className="question-card glass-card motion-card">
              <p className="eyebrow">Выберите один ответ</p>
              <h1 ref={questionHeadingRef} tabIndex={-1}>{question.prompt}</h1>
              <fieldset className="answers" disabled={busy}>
                <legend className="sr-only">Варианты ответа</legend>
                {question.choices.map((choice, index) => (
                  <label
                    key={`${index}-${choice}`}
                    className={selectedChoice === index ? 'answer selected' : 'answer'}
                  >
                    <input
                      type="radio"
                      name={`question-${question.id}`}
                      value={index}
                      checked={selectedChoice === index}
                      onChange={() => setSelectedChoice(index)}
                    />
                    <span className="answer-letter">{String.fromCharCode(65 + index)}</span>
                    <span>{choice}</span>
                    <span className="answer-dot" aria-hidden="true" />
                  </label>
                ))}
              </fieldset>
              <div className="question-footer">
                <p>{transitioning ? 'Проверяем время…' : 'Ответ нельзя изменить после отправки.'}</p>
                <button
                  className="primary-button"
                  disabled={selectedChoice === null || busy || connectivity === 'offline'}
                  onClick={() => void submitAnswer(selectedChoice)}
                >
                  {transitioning ? 'Следующий вопрос…' : busy ? 'Сохраняем…' : 'Ответить'}
                </button>
              </div>
            </article>
            {error && <p className="error-message" role="alert">{error}</p>}
            <TimerAnnouncement seconds={questionLeft} />
          </section>
        </main>
        {showAbortConfirm && (
          <AbortDialog
            busy={aborting}
            error={error}
            offline={connectivity === 'offline'}
            onCancel={() => {
              setError('');
              setShowAbortConfirm(false);
            }}
            onConfirm={() => void abortTest()}
            returnFocusRef={abortButtonRef}
          />
        )}
      </>
    );
  }

  return (
    <main className="app-shell welcome-shell">
      {connectivityBanner}
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header
        className="site-header"
        aria-hidden={showLeaderboard || undefined}
        inert={showLeaderboard || undefined}
      >
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Candidate Check</span><span className="release-tag">v{APP_RELEASE}</span></div>
        <div className="header-actions">
          <button
            ref={leaderboardButtonRef}
            className="text-button"
            type="button"
            onClick={() => setShowLeaderboard(true)}
          >
            Таблица лидеров
          </button>
          <StatusChip state={connectivity} />
        </div>
      </header>
      <section
        className="welcome-grid"
        aria-hidden={showLeaderboard || undefined}
        inert={showLeaderboard || undefined}
      >
        <div className="welcome-copy">
          <p className="eyebrow"><span className="live-dot" /> Технический тест</p>
          <h1>Candidate Check</h1>
          <p className="lead">
            Сети, Linux, Windows и Active Directory, информационная безопасность.
          </p>
          <div className="rules-row">
            <span><strong>{formatTime(TEST_CONFIG.totalTimeSeconds)}</strong> на весь тест</span>
            <span><strong>{formatTime(TEST_CONFIG.questionTimeSeconds)}</strong> на вопрос</span>
            <span><strong>{BASE_QUESTION_COUNT}+</strong> вопросов</span>
            <span><strong>{BASE_MAX_SCORE}</strong> баллов</span>
          </div>
        </div>
        {/* Nginx serves this versioned asset directly; image optimization would route it back through the Vinext runtime. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="welcome-mascot"
          src={releaseAssetPath('/assets/brand/checker-mascot-v1.webp')}
          alt=""
          aria-hidden="true"
        />
        <form className="start-card glass-card" onSubmit={startTest}>
          <p className="eyebrow">Начало теста</p>
          <h2>Введите имя</h2>
          <p className="muted">После старта включатся таймеры. Вернуться к предыдущему вопросу нельзя.</p>
          <label htmlFor="candidate-name">Имя и фамилия</label>
          <input
            id="candidate-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="name"
            placeholder="Например, Анна Петрова"
          />
          {error && <p className="error-message" role="alert">{error}</p>}
          <button
            className="primary-button full-button"
            disabled={busy || connectivity !== 'online'}
            type="submit"
          >
            {busy ? 'Готовим вопросы…' : connectivity === 'checking' ? 'Проверяем готовность…' : 'Начать тест'}
            <span aria-hidden="true">→</span>
          </button>
          <p className="privacy-note">
            Имя, ответы и итог доступны только проверяющим.
          </p>
          {notice && <p className="notice-message" role="status">{notice}</p>}
        </form>
      </section>
      {showLeaderboard && (
        <Leaderboard
          onClose={() => setShowLeaderboard(false)}
          returnFocusRef={leaderboardButtonRef}
        />
      )}
    </main>
  );
}

function TimerDial({
  kind,
  label,
  seconds,
  maximum,
}: {
  kind: 'question' | 'total';
  label: string;
  seconds: number;
  maximum: number;
}) {
  const remaining = Math.min(maximum, Math.max(0, seconds));
  const degrees = (remaining / maximum) * 360;
  const warningAt = kind === 'question' ? 15 : 60;
  const criticalAt = kind === 'question' ? 10 : 30;
  const urgency = remaining <= criticalAt ? 'critical' : remaining <= warningAt ? 'warning' : 'normal';
  return (
    <div
      className={`timer-dial timer-${kind} timer-${urgency}`}
      style={{ '--timer-progress': `${degrees}deg` } as React.CSSProperties}
      role="timer"
      aria-label={`${label}: ${formatTime(remaining)}. ${urgency === 'critical' ? 'Время заканчивается.' : ''}`}
    >
      <div className="timer-dial-face">
        <span>{label}</span>
        <strong>{formatTime(remaining)}</strong>
        {kind === 'question' && urgency !== 'normal' && (
          <small>{urgency === 'critical' ? 'Срочно' : 'Мало времени'}</small>
        )}
      </div>
    </div>
  );
}

function TimerAnnouncement({ seconds }: { seconds: number }) {
  const message = seconds === 15
    ? 'На вопрос осталось 15 секунд.'
    : seconds === 10
      ? 'На вопрос осталось 10 секунд.'
      : seconds === 5
        ? 'На вопрос осталось 5 секунд.'
        : seconds === 0
          ? 'Время вопроса закончилось.'
          : '';
  return <span className="sr-only" aria-live="polite">{message}</span>;
}

function StatusChip({ state }: { state: Connectivity }) {
  const copy = {
    checking: 'Проверяем систему',
    online: 'Система готова',
    offline: 'Нет сети',
    'service-error': 'Нужна проверка',
  }[state];
  return <span className={`status-chip status-${state}`}><i aria-hidden="true" />{copy}</span>;
}

function ConnectivityBanner({ state, active }: { state: Connectivity; active: boolean }) {
  const message = state === 'offline'
    ? active
      ? 'Нет связи. Серверный таймер продолжает идти; ответ отправится после восстановления сети.'
      : 'Нет связи с локальным сервером.'
    : state === 'service-error'
      ? active
        ? 'Новые тесты временно недоступны. Текущую попытку можно продолжить.'
        : 'Сервис пока не готов. Обратитесь к администратору.'
      : 'Проверяем соединение с локальным сервером…';
  return <div className={`connectivity-banner connectivity-${state}`} role="status">{message}</div>;
}

function useDialog(
  onClose: () => void,
  returnFocusRef: { current: HTMLElement | null } | null = null,
) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    const appShell = dialog?.closest<HTMLElement>('.app-shell') ?? null;
    const previousOverflow = appShell?.style.overflow ?? '';
    if (appShell) appShell.style.overflow = 'hidden';
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (appShell) appShell.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [onClose, returnFocusRef]);
  return dialogRef;
}

function AbortDialog({
  busy,
  error,
  offline,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  busy: boolean;
  error: string;
  offline: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const close = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  const dialogRef = useDialog(close, returnFocusRef);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="leaderboard-card glass-card abort-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="abort-title"
        aria-describedby="abort-description"
        tabIndex={-1}
      >
        <p className="eyebrow">Завершение попытки</p>
        <h2 id="abort-title">Прервать тест?</h2>
        <p id="abort-description" className="muted">
          Продолжить эту попытку будет нельзя. Незавершённый результат не попадёт в рейтинг.
        </p>
        {offline && <p className="error-message" role="status">Для прерывания нужно восстановить соединение.</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={close}>Продолжить тест</button>
          <button className="danger-button" disabled={busy || offline} onClick={onConfirm}>
            {busy ? 'Прерываем…' : 'Да, прервать'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Leaderboard({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const dialogRef = useDialog(onClose, returnFocusRef);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const data = await requestJson<{ entries: LeaderboardEntry[] }>(appPath('/api/leaderboard'), {}, 1);
        if (!cancelled) setEntries(data.entries);
      } catch {
        if (!cancelled) setError('Не удалось загрузить рейтинг.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [revision]);

  function closeOnBackdrop(event: ReactKeyboardEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={closeOnBackdrop}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') closeOnBackdrop(event);
      }}
    >
      <section
        ref={dialogRef}
        className="leaderboard-card glass-card wide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leaderboard-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div><p className="eyebrow">Лучшие результаты</p><h2 id="leaderboard-title">Таблица лидеров</h2></div>
          <button className="close-button" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        {loading ? (
          <p className="empty-state" role="status">Загружаем результаты…</p>
        ) : error ? (
          <div className="modal-error" role="alert">
            <p>{error}</p>
            <button className="ghost-button" onClick={() => setRevision((value) => value + 1)}>Повторить</button>
          </div>
        ) : entries.length === 0 ? (
          <p className="empty-state">Пока здесь пусто. Первый результат задаст планку.</p>
        ) : (
          <ol className="leader-list">
            {entries.map((entry, index) => (
              <li className={entry.verdict === 'FAIL' ? 'leader-fail' : ''} key={`${entry.alias}-${entry.completedAt}`}>
                <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                <span className="leader-name">
                  <strong>{entry.alias}</strong>
                  <small>
                    <time dateTime={entry.completedAt}>{formatTestDate(entry.completedAt)}</time>
                    <span aria-hidden="true"> · </span>{formatTime(entry.durationSeconds)}
                  </small>
                </span>
                <span className={`mini-verdict mini-${entry.verdict.toLowerCase()}`}>{verdictLabels[entry.verdict]}</span>
                <strong className="leader-score">{entry.score}/{entry.baseMaxScore}</strong>
                <span className="leader-metric">{entry.accuracy}%<small>точность</small></span>
                <span className="leader-metric">{entry.wrongCount}<small>ошибок</small></span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
