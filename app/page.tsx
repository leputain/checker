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
import type { AttemptQuestionReviewDto } from '@/lib/attempt-review.ts';
import { APP_RELEASE, releaseAssetPath } from '@/lib/release.ts';
import { BASE_MAX_SCORE } from '@/lib/scoring.ts';
import { BASE_QUESTION_COUNT, TEST_CONFIG } from '@/lib/test-config.ts';

type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type Verdict = 'PASS' | 'REVIEW' | 'FAIL';
type Connectivity = 'checking' | 'online' | 'offline' | 'service-error';
type PretestStep = 'welcome' | 'demo' | 'countdown';
type QuestionContextType = 'text' | 'code' | 'command' | 'log' | 'config';

type CompetencyStat = {
  answeredCount: number;
  correctCount: number;
  accuracy: number;
};

type DifficultyStat = CompetencyStat & {
  difficulty: Difficulty;
};

type ResultBreakdownSection = {
  assignedCount: number;
  presentedCount: number;
  resolvedCount: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  earnedScore: number;
  maxEarnableScore: number;
};

type ResultBreakdown = {
  base: ResultBreakdownSection;
  additional: ResultBreakdownSection;
};

type QuestionView = {
  id: number;
  prompt: string;
  choices: string[];
  difficulty: Difficulty;
  scoreValue: number;
  questionKind: 'base' | 'additional';
  additionalNumber?: number;
  position: number;
  minimumQuestions: number;
  questionDeadlineAt: number;
  totalDeadlineAt: number;
  topic?: string;
  contextType?: QuestionContextType;
  context?: string;
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
  timeoutCount: number;
  averageAnswerSeconds: number;
  baseAnsweredCount: number;
  baseCorrectCount: number;
  additionalAnsweredCount: number;
  additionalCorrectCount: number;
  difficultyStats: DifficultyStat[];
  breakdown?: ResultBreakdown;
  review: AttemptQuestionReviewDto[];
};

type AttemptModel = {
  bankRevision: string;
  scoringVersion: number;
  appVersion: string;
  testConfigId: string;
  testProfileId: string;
  analyticsFactsVersion: number;
  statisticsCompleteness: 'complete' | 'partial';
};

type AttemptPayload = {
  attemptId: string;
  alias: string;
  status: 'active' | 'completed' | 'aborted';
  serverNowMs: number;
  model?: AttemptModel;
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
const DEMO_CORRECT_CHOICE = 1;
const DEMO_CHOICES = [
  'Сразу перейти дальше, не выбирая вариант',
  'Выбрать карточку и нажать «Проверить ответ»',
  'Дождаться окончания времени',
  'Выбрать сразу несколько вариантов',
];

const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};

const verdictLabels: Record<Verdict, string> = {
  PASS: 'Рекомендован',
  REVIEW: 'К просмотру',
  FAIL: 'Не рекомендован',
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

function formatPoints(points: number) {
  const lastTwo = points % 100;
  const last = points % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${points} баллов`;
  if (last === 1) return `${points} балл`;
  if (last >= 2 && last <= 4) return `${points} балла`;
  return `${points} баллов`;
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
  code?: string;

  constructor(message: string, retryable: boolean, status = 0, code?: string) {
    super(message);
    this.name = 'RequestError';
    this.retryable = retryable;
    this.status = status;
    this.code = code;
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
      const data = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
      if (response.ok) return data;
      const error = new RequestError(
        data.error || 'Сервер временно недоступен',
        response.status >= 500 || response.status === 408 || response.status === 429,
        response.status,
        data.code,
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
  const [pretestStep, setPretestStep] = useState<PretestStep>('welcome');
  const [demoSelectedChoice, setDemoSelectedChoice] = useState<number | null>(null);
  const [demoResult, setDemoResult] = useState<'idle' | 'incorrect' | 'correct'>('idle');
  const [countdown, setCountdown] = useState(3);
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
  const startRequestRef = useRef(false);

  const question = attempt?.question;
  const questionId = question?.id ?? null;
  const totalLeft = question ? Math.ceil((question.totalDeadlineAt - now) / 1_000) : 0;
  const questionLeft = question ? Math.ceil((question.questionDeadlineAt - now) / 1_000) : 0;
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

  const resetUnsupportedAttempt = useCallback(() => {
    clearStoredSession();
    setAttempt(null);
    setName('');
    setSelectedChoice(null);
    setShowAbortConfirm(false);
    setPretestStep('welcome');
    setRestoreFailed(false);
    setError('');
    setNotice('Тест обновлён. Начните новую попытку.');
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
            setPretestStep('welcome');
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
          setPretestStep('welcome');
          setNotice('Предыдущий тест был прерван. Можно начать новый.');
        } else {
          setAttempt({ ...data, token: session.token });
          if (data.status === 'completed') clearStoredSession();
        }
      } catch (caught) {
        if (caught instanceof RequestError && caught.code === 'attempt_version_unsupported') {
          resetUnsupportedAttempt();
        } else if (caught instanceof RequestError && caught.status === 404) {
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
  }, [applyServerTime, resetUnsupportedAttempt, restoreRevision, triggerNotificationFlush]);

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
    if (previousQuestionId === questionId) return;
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
        setPretestStep('welcome');
        setShowAbortConfirm(false);
        setNotice('Тест прерван. Можно начать новый.');
      } else {
        const sameQuestion = data.status === 'active'
          && data.question?.id === attempt.question?.id;
        setAttempt({ ...data, token: attempt.token });
        if (!sameQuestion) {
          setSelectedChoice(null);
          setShowAbortConfirm(false);
        }
        if (data.status === 'completed') clearStoredSession();
      }
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === 'attempt_version_unsupported') {
        resetUnsupportedAttempt();
      }
      // Иначе существующая попытка остаётся локально и восстановится при reconnect.
    }
  }, [applyServerTime, attempt, resetUnsupportedAttempt, triggerNotificationFlush]);

  const submitAnswer = useCallback(async (choiceIndex: number | null, timeout = false) => {
    if (!attempt?.question || submittingRef.current || !navigator.onLine) return;
    submittingRef.current = true;
    if (timeout) setShowAbortConfirm(false);
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
      if (data.status !== 'active' || data.question?.id !== attempt.question.id) {
        setShowAbortConfirm(false);
      }
      if (data.status === 'aborted') {
        clearStoredSession();
        setAttempt(null);
        setPretestStep('welcome');
        setNotice('Тест прерван. Можно начать новый.');
      } else {
        setAttempt({ ...data, token: attempt.token });
        setSelectedChoice(null);
        if (data.status === 'completed') clearStoredSession();
      }
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === 'attempt_version_unsupported') {
        resetUnsupportedAttempt();
      } else if (caught instanceof RequestError && caught.status === 404) {
        clearStoredSession();
        setAttempt(null);
        setPretestStep('welcome');
        setShowAbortConfirm(false);
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
  }, [applyServerTime, attempt, resetUnsupportedAttempt, syncAttempt, triggerNotificationFlush]);

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

  function openDemo(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) {
      setError('Введите имя — хотя бы 2 символа.');
      return;
    }
    setName(cleanName);
    setDemoSelectedChoice(null);
    setDemoResult('idle');
    setError('');
    setNotice('');
    setPretestStep('demo');
  }

  const createAttempt = useCallback(async () => {
    if (startRequestRef.current) return;
    startRequestRef.current = true;
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
        body: JSON.stringify({ name, startKey: pending.startKey, token: pending.token }),
      }, 2);
      if (data.status === 'aborted') {
        clearStoredSession();
        setNotice('Предыдущий запуск был прерван. Начните тест ещё раз.');
        setDemoResult('correct');
        setPretestStep('demo');
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
      setPretestStep('welcome');
      applyServerTime(data.serverNowMs);
      triggerNotificationFlush(data.attemptId, pending.token);
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === 'attempt_version_unsupported') {
        resetUnsupportedAttempt();
        return;
      }
      setPretestStep('demo');
      setDemoResult('correct');
      setError(
        caught instanceof Error
          ? `${caught.message} Имя сохранено — попробуйте начать ещё раз.`
          : 'Не удалось начать тест. Имя сохранено — попробуйте ещё раз.',
      );
    } finally {
      startRequestRef.current = false;
      setBusy(false);
    }
  }, [applyServerTime, name, resetUnsupportedAttempt, triggerNotificationFlush]);

  useEffect(() => {
    if (pretestStep !== 'countdown') return;
    const timer = window.setTimeout(() => {
      if (countdown > 1) setCountdown((value) => value - 1);
      else void createAttempt();
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown, createAttempt, pretestStep]);

  function checkDemoAnswer() {
    if (demoSelectedChoice === null) return;
    setDemoResult(demoSelectedChoice === DEMO_CORRECT_CHOICE ? 'correct' : 'incorrect');
  }

  async function startCountdown() {
    if (demoResult !== 'correct' || startRequestRef.current) return;
    startRequestRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (!(await checkReadiness())) {
        setError('Сервис пока не готов. Проверьте сеть или обратитесь к администратору.');
        return;
      }
      setCountdown(3);
      setPretestStep('countdown');
    } finally {
      startRequestRef.current = false;
      setBusy(false);
    }
  }

  const closeAbortDialog = useCallback(() => {
    setError('');
    setShowAbortConfirm(false);
  }, []);

  async function abortTest() {
    if (
      !attempt
      || attempt.status !== 'active'
      || aborting
      || submittingRef.current
      || !navigator.onLine
    ) return;
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
        setPretestStep('welcome');
        setNotice('Тест прерван. Результат не добавлен в рейтинг.');
      } else {
        setAttempt({ ...data, token: attempt.token });
      }
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === 'attempt_version_unsupported') {
        resetUnsupportedAttempt();
      } else {
        setError(caught instanceof Error ? caught.message : 'Не удалось прервать тест.');
      }
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
    setPretestStep('welcome');
    setDemoSelectedChoice(null);
    setDemoResult('idle');
    setCountdown(3);
    setShowAbortConfirm(false);
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
              aria-label={`${result.score} из ${result.baseMaxScore} баллов`}
              style={{ '--score': `${result.scorePercent * 3.6}deg` } as React.CSSProperties}
            >
              <div>
                <strong>{result.score} / {result.baseMaxScore}</strong>
                <span>баллов</span>
              </div>
            </div>
            <div className="result-summary">
              <p className="eyebrow">Итоговая оценка</p>
              <h1>Результат готов.</h1>
              <p className="verdict-copy">{verdictCopy[result.verdict]}</p>
              <p className="muted result-copy">
                Верно {result.correctCount} из {result.answeredCount}. Ошибки можно разобрать ниже.
              </p>
            </div>
          </div>
          <div className="stats-grid result-stats">
            <div><strong>{result.correctCount} из {result.answeredCount}</strong><span>верно</span></div>
            <div><strong>{result.baseCorrectCount} из {result.baseAnsweredCount}</strong><span>основные вопросы</span></div>
            <div>
              <strong className={result.additionalAnsweredCount === 0 ? 'stat-text' : undefined}>
                {result.additionalAnsweredCount === 0
                  ? 'не задавались'
                  : `${result.additionalCorrectCount} из ${result.additionalAnsweredCount}`}
              </strong>
              <span>дополнительные</span>
            </div>
            <div><strong>{result.accuracy}%</strong><span>точность</span></div>
            <div><strong>{result.timeoutCount ?? 0}</strong><span>таймаутов</span></div>
            <div><strong>{Math.round(result.averageAnswerSeconds ?? 0)} сек.</strong><span>средний ответ</span></div>
            <div><strong>{formatTime(result.durationSeconds)}</strong><span>время</span></div>
            <div className="result-stat-date">
              <strong><time dateTime={result.completedAt}>{formatTestDate(result.completedAt)}</time></strong>
              <span>дата теста</span>
            </div>
          </div>
          <CompetencyProfile
            difficultyStats={result.difficultyStats ?? []}
          />
          <CandidateErrorReview items={result.review ?? []} />
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
          <p className="result-privacy"><span aria-hidden="true">◆</span> Разбор доступен только после завершения теста</p>
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
                <TimerDial label="Вопрос" seconds={questionLeft} maximum={TEST_CONFIG.questionTimeSeconds} />
                <TotalTimer seconds={totalLeft} maximum={TEST_CONFIG.totalTimeSeconds} />
              </div>
            </div>
          </header>
          <section className="quiz-stage">
            <div className="quiz-meta">
              <span className="question-tags">
                <span className={`difficulty difficulty-${question.difficulty}`}>
                  {difficultyLabels[question.difficulty]} · {formatPoints(question.scoreValue)}
                </span>
                {question.questionKind === 'additional' && (
                  <span className="additional-chip">
                    Дополнительный вопрос{question.additionalNumber ? ` ${question.additionalNumber}` : ''}
                  </span>
                )}
                {question.topic && <span className="topic-chip">{question.topic}</span>}
              </span>
              <span>Вопрос {question.position} · минимум {question.minimumQuestions}</span>
            </div>
            <article key={question.id} className="question-card glass-card motion-card">
              <p className="eyebrow">Выберите один ответ</p>
              <h1 ref={questionHeadingRef} tabIndex={-1}>{question.prompt}</h1>
              {question.context && (
                <QuestionContext type={question.contextType ?? 'text'} value={question.context} />
              )}
              <AnswerCards
                choices={question.choices}
                selectedChoice={selectedChoice}
                onSelect={setSelectedChoice}
                name={`question-${question.id}`}
                disabled={busy}
              />
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
            busy={busy || aborting}
            error={error}
            offline={connectivity === 'offline'}
            onCancel={closeAbortDialog}
            onConfirm={() => void abortTest()}
            returnFocusRef={abortButtonRef}
          />
        )}
      </>
    );
  }

  if (pretestStep === 'countdown') {
    return (
      <main className="app-shell countdown-shell">
        {connectivityBanner}
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
        <section className="countdown-card glass-card" role="status" aria-live="assertive" aria-label="До начала теста">
          <span className="brand-mark countdown-brand" aria-hidden="true" />
          <p className="eyebrow">До начала теста</p>
          <strong className="countdown-number" key={countdown}>{countdown}</strong>
          <p>{busy ? 'Открываем первый вопрос…' : 'Сосредоточьтесь. Таймер включится после отсчёта.'}</p>
        </section>
      </main>
    );
  }

  if (pretestStep === 'demo') {
    return (
      <main className="app-shell demo-shell">
        {connectivityBanner}
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
        <header className="site-header demo-header">
          <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Candidate Check</span></div>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setError('');
              setPretestStep('welcome');
            }}
          >
            Назад
          </button>
        </header>
        <section className="demo-stage">
          <div className="demo-intro">
            <p className="eyebrow">Без таймеров и без баллов</p>
            <h1>Пробный вопрос</h1>
            <p className="muted">Выберите одну карточку и подтвердите ответ. В настоящем тесте всё работает точно так же.</p>
          </div>
          <article className={`question-card demo-question-card demo-${demoResult} glass-card motion-card`}>
            <p className="eyebrow">Тренировка</p>
            <h2>Как правильно отправить выбранный вариант?</h2>
            <AnswerCards
              choices={DEMO_CHOICES}
              selectedChoice={demoSelectedChoice}
              onSelect={(index) => {
                setDemoSelectedChoice(index);
                if (demoResult !== 'correct') setDemoResult('idle');
                setError('');
              }}
              name="demo-question"
              disabled={demoResult === 'correct' || busy}
            />
            <div className="question-footer demo-footer">
              <div className="demo-feedback" aria-live="polite">
                {demoResult === 'incorrect' && <p className="demo-incorrect">Попробуйте ещё раз: сначала выберите карточку, затем подтвердите выбор.</p>}
                {demoResult === 'correct' && <p className="demo-correct">Готово. Теперь можно запускать тест с таймерами.</p>}
                {demoResult === 'idle' && <p>Этот вопрос не влияет на результат.</p>}
                {notice && <p className="notice-message" role="status">{notice}</p>}
                {error && <p className="error-message" role="alert">{error}</p>}
              </div>
              {demoResult === 'correct' ? (
                <button
                  className="primary-button demo-action"
                  type="button"
                  disabled={busy}
                  onClick={() => void startCountdown()}
                >
                  {busy ? 'Проверяем готовность…' : 'Начать настоящий тест'}
                </button>
              ) : (
                <button
                  className="primary-button demo-action"
                  type="button"
                  disabled={demoSelectedChoice === null || busy}
                  onClick={checkDemoAnswer}
                >
                  Проверить ответ
                </button>
              )}
            </div>
          </article>
        </section>
      </main>
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
          <a
            className="admin-entry-link"
            href={appPath('/admin/login')}
            aria-label="Войти в административную панель"
          >
            <span className="admin-entry-long">Администратору</span>
            <span className="admin-entry-short" aria-hidden="true">Админ</span>
          </a>
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
        <form className="start-card glass-card" onSubmit={openDemo}>
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
            disabled={busy}
            type="submit"
          >
            Продолжить
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

function AnswerCards({
  choices,
  selectedChoice,
  onSelect,
  name,
  disabled = false,
}: {
  choices: string[];
  selectedChoice: number | null;
  onSelect: (index: number) => void;
  name: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="answers" disabled={disabled}>
      <legend className="sr-only">Варианты ответа</legend>
      {choices.map((choice, index) => (
        <label
          key={`${index}-${choice}`}
          className={selectedChoice === index ? 'answer selected' : 'answer'}
          data-selected={selectedChoice === index || undefined}
        >
          <input
            type="radio"
            name={name}
            value={index}
            checked={selectedChoice === index}
            onChange={() => onSelect(index)}
          />
          <span className="answer-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
          <span className="answer-copy">{choice}</span>
          <span className="answer-dot" aria-hidden="true" />
        </label>
      ))}
    </fieldset>
  );
}

function QuestionContext({ type, value }: { type: QuestionContextType; value: string }) {
  const labels: Record<QuestionContextType, string> = {
    text: 'Контекст',
    code: 'Код',
    command: 'Команда',
    log: 'Фрагмент журнала',
    config: 'Конфигурация',
  };
  if (type === 'text') {
    return (
      <aside className="question-context context-text" aria-label={labels[type]}>
        <span>{labels[type]}</span>
        <p>{value}</p>
      </aside>
    );
  }
  return (
    <aside className={`question-context context-${type}`} aria-label={labels[type]}>
      <span>{labels[type]}</span>
      <pre><code>{value}</code></pre>
    </aside>
  );
}

function CandidateErrorReview({ items }: { items: AttemptQuestionReviewDto[] }) {
  return (
    <section className="error-review" aria-labelledby="error-review-title">
      <div className="profile-heading">
        <div>
          <p className="eyebrow">Разбор после теста</p>
          <h2 id="error-review-title">Ошибки и правильные ответы</h2>
        </div>
        <p>{items.length === 0 ? 'Ошибок нет' : `${items.length} ${items.length === 1 ? 'вопрос' : 'вопросов'}`}</p>
      </div>
      {items.length === 0 ? (
        <div className="error-review-empty">
          <strong>Все показанные вопросы решены верно.</strong>
          <span>Дополнительный разбор не требуется.</span>
        </div>
      ) : (
        <div className="error-review-list">
          {items.map((item) => (
            <details className="error-review-card" key={`${item.ordinal}-${item.questionId}`}>
              <summary>
                <span className="error-review-number">{String(item.ordinal).padStart(2, '0')}</span>
                <span>
                  <small>{item.status === 'timeout' ? 'Тайм-аут' : 'Неверный ответ'} · {item.topic}</small>
                  <strong>{item.prompt}</strong>
                </span>
                <i aria-hidden="true">⌄</i>
              </summary>
              <div className="error-review-body">
                {item.context && (
                  <QuestionContext type={item.contextType ?? 'text'} value={item.context} />
                )}
                <dl className="error-review-answers">
                  <div data-tone="wrong">
                    <dt>Ваш ответ</dt>
                    <dd>{item.status === 'timeout' ? 'Время истекло' : item.selectedAnswer ?? 'Ответ не сохранён'}</dd>
                  </div>
                  <div data-tone="correct">
                    <dt>Правильный ответ</dt>
                    <dd>{item.correctAnswer}</dd>
                  </div>
                </dl>
                <div className="error-review-explanation">
                  <strong>Пояснение</strong>
                  <p>{item.explanation}</p>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function TimerDial({
  label,
  seconds,
  maximum,
}: {
  label: string;
  seconds: number;
  maximum: number;
}) {
  const remaining = Math.min(maximum, Math.max(0, seconds));
  const degrees = (remaining / maximum) * 360;
  const warningAt = 15;
  const criticalAt = 10;
  const urgency = remaining <= criticalAt ? 'critical' : remaining <= warningAt ? 'warning' : 'normal';
  return (
    <div
      className={`timer-dial timer-question timer-${urgency}`}
      style={{ '--timer-progress': `${degrees}deg` } as React.CSSProperties}
      role="timer"
      aria-label={`${label}: ${formatTime(remaining)}. ${urgency === 'critical' ? 'Время заканчивается.' : ''}`}
    >
      <div className="timer-dial-face">
        <span>{label}</span>
        <strong>{formatTime(remaining)}</strong>
        {urgency !== 'normal' && (
          <small>{urgency === 'critical' ? 'Последние 10 секунд' : 'Осталось мало времени'}</small>
        )}
      </div>
    </div>
  );
}

function TotalTimer({ seconds, maximum }: { seconds: number; maximum: number }) {
  const remaining = Math.min(maximum, Math.max(0, seconds));
  const progress = maximum > 0 ? remaining / maximum : 0;
  return (
    <div className="total-timer" role="timer" aria-label={`Весь тест: ${formatTime(remaining)}`}>
      <span>Весь тест</span>
      <strong>{formatTime(remaining)}</strong>
      <span className="total-timer-track" aria-hidden="true">
        <i style={{ transform: `scaleX(${progress})` }} />
      </span>
    </div>
  );
}

function CompetencyProfile({
  difficultyStats,
}: {
  difficultyStats: DifficultyStat[];
}) {
  const difficultyOrder: Difficulty[] = ['easy', 'medium', 'hard', 'expert'];
  return (
    <section className="competency-profile" aria-labelledby="competency-profile-title">
      <div className="profile-heading">
        <div>
          <p className="eyebrow">Профиль результата</p>
          <h2 id="competency-profile-title">Компетенции</h2>
        </div>
        <p>Подробный разбор ошибок — ниже</p>
      </div>
      <div className="profile-columns profile-columns-private">
        <div className="profile-section">
          <h3>По сложности</h3>
          <div className="skill-bars">
            {difficultyOrder.map((difficulty) => {
              const stat = difficultyStats.find((item) => item.difficulty === difficulty);
              const accuracy = stat ? Math.max(0, Math.min(100, stat.accuracy)) : 0;
              return (
                <div className="skill-row" key={difficulty}>
                  <div>
                    <span>{difficultyLabels[difficulty]}</span>
                    <strong>{stat ? `${accuracy}% · ${stat.correctCount}/${stat.answeredCount}` : '—'}</strong>
                  </div>
                  <span
                    className="skill-track"
                    role="progressbar"
                    aria-label={`${difficultyLabels[difficulty]}: ${stat ? `${accuracy}%` : 'нет данных'}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={stat ? accuracy : undefined}
                  >
                    <i style={{ width: `${accuracy}%` }} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
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
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
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
        onCloseRef.current();
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
  }, [returnFocusRef]);
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
  const [period, setPeriod] = useState<'today' | 'all'>('today');
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
        const data = await requestJson<{ entries: LeaderboardEntry[]; period: 'today' | 'all' }>(
          appPath(`/api/leaderboard?period=${period}`),
          {},
          1,
        );
        if (!cancelled) setEntries(data.entries);
      } catch {
        if (!cancelled) setError('Не удалось загрузить рейтинг.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [period, revision]);

  function closeOnBackdrop(event: ReactKeyboardEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  function movePeriodTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextPeriod = period === 'today' ? 'all' : 'today';
    setPeriod(nextPeriod);
    window.requestAnimationFrame(() => {
      document.getElementById(`leaderboard-tab-${nextPeriod}`)?.focus();
    });
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
        <div
          className="leaderboard-tabs"
          role="tablist"
          aria-label="Период рейтинга"
          onKeyDown={movePeriodTab}
        >
          <button
            id="leaderboard-tab-today"
            role="tab"
            aria-selected={period === 'today'}
            aria-controls="leaderboard-panel"
            tabIndex={period === 'today' ? 0 : -1}
            onClick={() => setPeriod('today')}
          >
            Сегодня
          </button>
          <button
            id="leaderboard-tab-all"
            role="tab"
            aria-selected={period === 'all'}
            aria-controls="leaderboard-panel"
            tabIndex={period === 'all' ? 0 : -1}
            onClick={() => setPeriod('all')}
          >
            Все
          </button>
        </div>
        <div
          id="leaderboard-panel"
          className="leaderboard-panel"
          role="tabpanel"
          aria-labelledby={`leaderboard-tab-${period}`}
        >
          {loading ? (
            <p className="empty-state" role="status">Загружаем результаты…</p>
          ) : error ? (
            <div className="modal-error" role="alert">
              <p>{error}</p>
              <button className="ghost-button" onClick={() => setRevision((value) => value + 1)}>Повторить</button>
            </div>
          ) : entries.length === 0 ? (
            <p className="empty-state">За выбранный период результатов пока нет.</p>
          ) : (
            <>
              <ol className="leader-podium" aria-label="Первые три места">
                {entries.slice(0, 3).map((entry, index) => (
                  <li
                    className={`podium-card podium-place-${index + 1} ${entry.verdict === 'FAIL' ? 'leader-fail' : ''}`}
                    key={`${entry.alias}-${entry.completedAt}`}
                  >
                    {index === 0 && <span className="leader-winner-mascot" aria-hidden="true" />}
                    <span className="podium-rank">{index + 1}</span>
                    <strong className="podium-name">{entry.alias}</strong>
                    <strong className="podium-score">{entry.score}/{entry.baseMaxScore}</strong>
                    <span className={`mini-verdict mini-${entry.verdict.toLowerCase()}`}>{verdictLabels[entry.verdict]}</span>
                    <small>
                      <time dateTime={entry.completedAt}>{formatTestDate(entry.completedAt)}</time>
                      <span aria-hidden="true"> · </span>{formatTime(entry.durationSeconds)}
                    </small>
                    <span className="podium-accuracy">Точность {entry.accuracy}%</span>
                  </li>
                ))}
              </ol>
              {entries.length > 3 && (
                <ol className="leader-list" start={4} aria-label="Остальные результаты">
                  {entries.slice(3).map((entry, index) => (
                    <li className={entry.verdict === 'FAIL' ? 'leader-fail' : ''} key={`${entry.alias}-${entry.completedAt}`}>
                      <span className="rank">{String(index + 4).padStart(2, '0')}</span>
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
            </>
          )}
        </div>
      </section>
    </div>
  );
}
