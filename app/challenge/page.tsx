'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { appPath } from '@/lib/app-path.ts';
import styles from './challenge.module.css';

type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type ChallengeQuestion = {
  id: number;
  ordinal: number;
  prompt: string;
  difficulty: Difficulty;
  choices: string[];
  contextType?: 'text' | 'code' | 'command' | 'log' | 'config';
  context?: string;
  questionDeadlineAt: number;
  totalDeadlineAt: number;
};
type ChallengeResult = {
  score: number;
  scoreUnits: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  resolvedCount: number;
  eligibleForLeaderboard: boolean;
  completionReason: 'manual' | 'total_timeout' | 'pool_exhausted';
  durationSeconds: number;
  completedAt: string;
};
type ChallengePayload = {
  attemptId: string;
  nickname: string;
  status: 'active' | 'completed';
  serverNowMs: number;
  resolvedCount?: number;
  question?: ChallengeQuestion;
  result?: ChallengeResult;
};
type StoredSession =
  | { version: 1; phase: 'starting'; nickname: string; startKey: string; token: string; createdAt: number }
  | { version: 1; phase: 'active'; attemptId: string; token: string; expiresAt: number };
type ReviewItem = {
  eventId: number;
  questionId: number;
  ordinal: number;
  prompt: string;
  difficulty: Difficulty;
  contextType?: string;
  context?: string;
  choices: string[];
  selectedIndex: number | null;
  correctIndex: number | null;
  outcome: 'correct' | 'incorrect' | 'timeout' | 'manual_unanswered';
  scoreDelta: number;
  elapsedSeconds: number | null;
};
type LeaderboardEntry = {
  rank: number;
  nickname: string;
  score: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  completedAt: string;
};

const STORAGE_KEY = 'candidate-check:security-challenge-attempt';
const REQUEST_TIMEOUT_MS = 8_000;
const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый', medium: 'Средний', hard: 'Сложный', expert: 'Экспертный',
};
const outcomeLabels: Record<ReviewItem['outcome'], string> = {
  correct: 'Верно', incorrect: 'Ошибка', timeout: 'Тайм-аут', manual_unanswered: 'Не учитывался',
};
const demoChoices = [
  'Отключить журналирование, чтобы скрыть атаку',
  'Изолировать узел, сохранить артефакты и начать проверку',
  'Сразу переустановить систему без фиксации данных',
  'Опубликовать индикаторы в открытом чате',
];

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function scoreLabel(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

async function challengeRequest<T>(path: string, token?: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await fetch(appPath(path), {
      ...init, headers, signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || 'Запрос не выполнен.');
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

function saveSession(payload: ChallengePayload, token: string) {
  if (payload.status !== 'active' || !payload.question) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const session: StoredSession = {
    version: 1,
    phase: 'active',
    attemptId: payload.attemptId,
    token,
    expiresAt: payload.question.totalDeadlineAt + 15 * 60 * 1_000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as StoredSession | null;
    if (!value || value.version !== 1) return null;
    if (value.phase === 'active' && value.expiresAt < Date.now()) return null;
    if (value.phase === 'starting' && value.createdAt + 15 * 60 * 1_000 < Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

export default function SecurityChallengePage() {
  const [phase, setPhase] = useState<'loading' | 'intro' | 'demo' | 'countdown' | 'active' | 'completed' | 'disabled'>('loading');
  const [nickname, setNickname] = useState('');
  const [demoChoice, setDemoChoice] = useState<number | null>(null);
  const [demoPassed, setDemoPassed] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [attempt, setAttempt] = useState<(ChallengePayload & { token: string }) | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverOffset, setServerOffset] = useState(0);
  const [clock, setClock] = useState(0);
  const [finishConfirm, setFinishConfirm] = useState(false);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const timeoutQuestionRef = useRef<number | null>(null);

  const acceptPayload = useCallback((payload: ChallengePayload, token: string) => {
    setAttempt({ ...payload, token });
    setServerOffset(payload.serverNowMs - Date.now());
    setSelectedChoice(null);
    setFinishConfirm(false);
    saveSession(payload, token);
    setPhase(payload.status === 'completed' ? 'completed' : 'active');
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const payload = await challengeRequest<{ entries: LeaderboardEntry[] }>(
        '/api/challenges/infosec/leaderboard?period=all',
      );
      setLeaderboard(payload.entries);
    } catch {
      setLeaderboard([]);
    }
  }, []);

  const startAttempt = useCallback(async () => {
    setBusy(true);
    setError('');
    const stored = readSession();
    const pending = stored?.phase === 'starting' && stored.nickname === nickname
      ? stored
      : {
          version: 1 as const,
          phase: 'starting' as const,
          nickname,
          startKey: crypto.randomUUID(),
          token: createToken(),
          createdAt: Date.now(),
        };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    try {
      const payload = await challengeRequest<ChallengePayload>('/api/challenges/infosec/attempts', undefined, {
        method: 'POST',
        body: JSON.stringify({ nickname, startKey: pending.startKey, token: pending.token }),
      });
      acceptPayload(payload, pending.token);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось начать челлендж.');
      setPhase('demo');
    } finally {
      setBusy(false);
    }
  }, [acceptPayload, nickname]);

  useEffect(() => {
    let cancelled = false;
    void challengeRequest<{ enabled: boolean; ready?: boolean }>('/api/challenges/infosec/config')
      .then(async (config) => {
        if (cancelled) return;
        if (!config.enabled || !config.ready) {
          setPhase('disabled');
          return;
        }
        const stored = readSession();
        if (!stored) {
          setPhase('intro');
          void loadLeaderboard();
          return;
        }
        try {
          const payload = stored.phase === 'starting'
            ? await challengeRequest<ChallengePayload>('/api/challenges/infosec/attempts', undefined, {
                method: 'POST',
                body: JSON.stringify({
                  nickname: stored.nickname,
                  startKey: stored.startKey,
                  token: stored.token,
                }),
              })
            : await challengeRequest<ChallengePayload>(
                `/api/challenges/infosec/attempts/${stored.attemptId}`,
                stored.token,
              );
          if (!cancelled) acceptPayload(payload, stored.token);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
          if (!cancelled) setPhase('intro');
        }
      })
      .catch(() => { if (!cancelled) setPhase('disabled'); });
    return () => { cancelled = true; };
  }, [acceptPayload, loadLeaderboard]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(0);
        void startAttempt();
      } else {
        setCountdown((value) => value - 1);
      }
    }, 850);
    return () => window.clearTimeout(timer);
  }, [countdown, phase, startAttempt]);

  const questionRemaining = attempt?.question
    ? (attempt.question.questionDeadlineAt - (clock + serverOffset)) / 1_000
    : 0;
  const totalRemaining = attempt?.question
    ? (attempt.question.totalDeadlineAt - (clock + serverOffset)) / 1_000
    : 0;

  const submitAnswer = useCallback(async (choiceIndex: number | null) => {
    if (!attempt?.question || busy) return;
    setBusy(true);
    setError('');
    try {
      const payload = await challengeRequest<ChallengePayload>(
        `/api/challenges/infosec/attempts/${attempt.attemptId}/answer`,
        attempt.token,
        {
          method: 'POST',
          body: JSON.stringify({ questionId: attempt.question.id, choiceIndex }),
        },
      );
      timeoutQuestionRef.current = null;
      acceptPayload(payload, attempt.token);
      if (payload.status === 'completed') void loadLeaderboard();
    } catch (requestError) {
      if (choiceIndex === null) timeoutQuestionRef.current = null;
      setError(requestError instanceof Error ? requestError.message : 'Не удалось сохранить ответ.');
    } finally {
      setBusy(false);
    }
  }, [acceptPayload, attempt, busy, loadLeaderboard]);

  useEffect(() => {
    if (phase !== 'active' || !attempt?.question || busy) return;
    if (questionRemaining > 0 && totalRemaining > 0) return;
    if (timeoutQuestionRef.current === attempt.question.id) return;
    timeoutQuestionRef.current = attempt.question.id;
    void submitAnswer(null);
  }, [attempt?.question, busy, phase, questionRemaining, submitAnswer, totalRemaining]);

  useEffect(() => {
    if (phase !== 'completed' || !attempt) return;
    void challengeRequest<{ items: ReviewItem[] }>(
      `/api/challenges/infosec/attempts/${attempt.attemptId}/review`,
      attempt.token,
    ).then((payload) => setReview(payload.items)).catch(() => setReview([]));
    void challengeRequest<{ entries: LeaderboardEntry[] }>(
      '/api/challenges/infosec/leaderboard?period=all',
    ).then((payload) => setLeaderboard(payload.entries)).catch(() => setLeaderboard([]));
  }, [attempt, phase]);

  function openDemo(event: FormEvent) {
    event.preventDefault();
    const normalized = nickname.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if ([...normalized].length < 2 || [...normalized].length > 32) {
      setError('Ник должен содержать от 2 до 32 символов.');
      return;
    }
    setNickname(normalized);
    setError('');
    setPhase('demo');
  }

  function checkDemo() {
    if (demoChoice === 1) setDemoPassed(true);
    else setError('Не совсем. При инциденте сначала ограничиваем ущерб и сохраняем артефакты.');
  }

  async function finishAttempt() {
    if (!attempt || busy) return;
    setBusy(true);
    setError('');
    try {
      const payload = await challengeRequest<ChallengePayload>(
        `/api/challenges/infosec/attempts/${attempt.attemptId}/finish`,
        attempt.token,
        { method: 'POST', body: '{}' },
      );
      acceptPayload(payload, attempt.token);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось завершить челлендж.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
    setAttempt(null);
    setReview([]);
    setDemoChoice(null);
    setDemoPassed(false);
    setError('');
    setPhase('intro');
  }

  if (phase === 'loading') return <StatePage title="Готовим полигон" copy="Проверяем ИБ-пул и активную попытку…" />;
  if (phase === 'disabled') return <StatePage title="Челлендж пока закрыт" copy="Режим выключен или банк вопросов не готов." back />;
  if (phase === 'countdown') return <StatePage title={countdown > 0 ? String(countdown) : 'Старт'} copy="Пятнадцать минут начинаются после запуска попытки." />;

  if (phase === 'demo') {
    return (
      <ChallengeShell>
        <section className={styles.demoCard}>
          <p className={styles.eyebrow}>Демо · без таймера и баллов</p>
          <h1>На рабочей станции обнаружены признаки компрометации. Первый разумный шаг?</h1>
          <ChoiceList choices={demoChoices} selected={demoChoice} onSelect={(value) => {
            setDemoChoice(value); setDemoPassed(false); setError('');
          }} disabled={demoPassed} />
          {error && <p className={styles.error} role="alert">{error}</p>}
          {demoPassed && <p className={styles.success}>Верно. В настоящем челлендже результат ответа появится только в финальном разборе.</p>}
          <button className={styles.primaryButton} disabled={demoChoice === null || busy} onClick={() => {
            if (!demoPassed) { checkDemo(); return; }
            setCountdown(3); setPhase('countdown');
          }}>
            {demoPassed ? 'Запустить челлендж' : 'Проверить демо-ответ'}
          </button>
        </section>
      </ChallengeShell>
    );
  }

  if (phase === 'active' && attempt?.question) {
    return (
      <ChallengeShell compact>
        <section className={styles.activeCard}>
          <header className={styles.questionHeader}>
            <div><span>Вопрос {attempt.question.ordinal}</span><strong>{difficultyLabels[attempt.question.difficulty]}</strong></div>
            <div className={styles.timers}>
              <Timer label="Вопрос" value={questionRemaining} danger={questionRemaining <= 10} />
              <Timer label="Всего" value={totalRemaining} danger={totalRemaining <= 60} />
            </div>
          </header>
          <div className={styles.progress}><i style={{ width: `${Math.min(100, Math.max(0, questionRemaining / 60 * 100))}%` }} /></div>
          <div className={styles.questionBody}>
            <p className={styles.eyebrow}>ИБ-челлендж · {attempt.nickname}</p>
            <h1>{attempt.question.prompt}</h1>
            {attempt.question.context && (
              <pre className={styles.context}><code>{attempt.question.context}</code></pre>
            )}
            <ChoiceList
              choices={attempt.question.choices}
              selected={selectedChoice}
              onSelect={setSelectedChoice}
              disabled={busy}
            />
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <footer className={styles.questionFooter}>
            <button className={styles.secondaryButton} onClick={() => setFinishConfirm(true)} disabled={busy}>Завершить тест</button>
            <span>{attempt.resolvedCount ?? 0} решено</span>
            <button className={styles.primaryButton} onClick={() => void submitAnswer(selectedChoice)} disabled={selectedChoice === null || busy}>
              {busy ? 'Сохраняем…' : 'Ответить'}
            </button>
          </footer>
        </section>
        {finishConfirm && (
          <div className={styles.modalBackdrop} role="presentation">
            <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="finish-title">
              <p className={styles.eyebrow}>Ручное завершение</p>
              <h2 id="finish-title">Закончить попытку сейчас?</h2>
              <p>Текущий неотправленный вопрос не будет считаться ошибкой. После завершения изменить результат нельзя.</p>
              <div><button className={styles.secondaryButton} onClick={() => setFinishConfirm(false)}>Продолжить</button><button className={styles.dangerButton} onClick={() => void finishAttempt()}>Завершить</button></div>
            </section>
          </div>
        )}
      </ChallengeShell>
    );
  }

  if (phase === 'completed' && attempt?.result) {
    return (
      <ChallengeShell>
        <section className={styles.resultHero}>
          <p className={styles.eyebrow}>Попытка завершена · {attempt.nickname}</p>
          <div className={styles.score}>{scoreLabel(attempt.result.score)}<small>балла</small></div>
          <h1>{attempt.result.eligibleForLeaderboard ? 'Результат учтён в рейтинге' : 'Результат сохранён'}</h1>
          {!attempt.result.eligibleForLeaderboard && <p>Для рейтинга нужно решить минимум пять вопросов.</p>}
          <div className={styles.resultMetrics}>
            <Metric label="Верно" value={attempt.result.correctCount} tone="good" />
            <Metric label="Ошибки" value={attempt.result.incorrectCount} tone="bad" />
            <Metric label="Тайм-ауты" value={attempt.result.timeoutCount} tone="neutral" />
            <Metric label="Решено" value={attempt.result.resolvedCount} tone="neutral" />
          </div>
          <div className={styles.resultActions}><button className={styles.primaryButton} onClick={reset}>Новая попытка</button><button className={styles.secondaryButton} onClick={() => setShowLeaderboard((value) => !value)}>Рейтинг</button><a href={appPath('/')}>На главную</a></div>
        </section>
        {showLeaderboard && <Leaderboard entries={leaderboard} />}
        <Review items={review} attemptId={attempt.attemptId} token={attempt.token} />
      </ChallengeShell>
    );
  }

  return (
    <ChallengeShell>
      <section className={styles.introGrid}>
        <div className={styles.introCopy}>
          <p className={styles.eyebrow}>Внутренний режим · информационная безопасность</p>
          <h1>Пятнадцать минут.<br />Никакой удачи в зачёт.</h1>
          <p>Вопросы идут без фиксированного количества. Ошибки и тайм-ауты уменьшают счёт так, чтобы случайное угадывание не давало преимущества.</p>
          <div className={styles.ruleGrid}><span><strong>15:00</strong> попытка</span><span><strong>01:00</strong> вопрос</span><span><strong>∞</strong> попыток</span><span><strong>5</strong> минимум в рейтинг</span></div>
          <button className={styles.linkButton} onClick={() => setShowLeaderboard((value) => !value)}>Открыть отдельный рейтинг →</button>
        </div>
        <form className={styles.startCard} onSubmit={openDemo}>
          <span className={styles.shield} aria-hidden="true">⌁</span>
          <p className={styles.eyebrow}>Позывной</p>
          <h2>Как показать вас в рейтинге?</h2>
          <p>Ник свободный. Одинаковые ники считаются одним участником, в таблице остаётся лучший результат.</p>
          <label htmlFor="challenge-nickname">Ник</label>
          <input id="challenge-nickname" value={nickname} maxLength={32} autoComplete="nickname" placeholder="Например, packet_witch" onChange={(event) => setNickname(event.target.value)} />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.primaryButton} type="submit">Пройти демо-вопрос</button>
        </form>
      </section>
      {showLeaderboard && <Leaderboard entries={leaderboard} />}
    </ChallengeShell>
  );
}

function ChallengeShell({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <main className={`${styles.shell} ${compact ? styles.compactShell : ''}`}>
      <div className={styles.grid} aria-hidden="true" />
      <header className={styles.siteHeader}>
        <div className={styles.headerNav}>
          <a className={styles.brandLink} href={appPath('/')} aria-label="Candidate Check — на главную">
            <span className={styles.brandMark} />
            <span className={styles.brandLabel}>Candidate Check</span>
          </a>
          <a className={styles.backLink} href={appPath('/')} aria-label="Вернуться на главную">← Назад</a>
        </div>
        <span>ИБ-челлендж</span>
      </header>
      <div className={styles.content}>{children}</div>
    </main>
  );
}

function StatePage({ title, copy, back = false }: { title: string; copy: string; back?: boolean }) {
  return <ChallengeShell><section className={styles.state}><span className={styles.loader} /><h1>{title}</h1><p>{copy}</p>{back && <a href={appPath('/')}>Вернуться на главную</a>}</section></ChallengeShell>;
}

function ChoiceList({ choices, selected, onSelect, disabled = false }: { choices: string[]; selected: number | null; onSelect: (index: number) => void; disabled?: boolean }) {
  return <fieldset className={styles.choices} disabled={disabled}><legend className={styles.srOnly}>Варианты ответа</legend>{choices.map((choice, index) => <label key={`${index}-${choice}`} className={selected === index ? styles.choiceSelected : undefined}><input type="radio" checked={selected === index} onChange={() => onSelect(index)} /><span>{String.fromCharCode(65 + index)}</span><p>{choice}</p><i /></label>)}</fieldset>;
}

function Timer({ label, value, danger }: { label: string; value: number; danger: boolean }) {
  return <div className={danger ? styles.timerDanger : undefined}><span>{label}</span><strong>{formatClock(value)}</strong></div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'good' | 'bad' | 'neutral' }) {
  return <article data-tone={tone}><span>{label}</span><strong>{value}</strong></article>;
}

function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  return <section className={styles.leaderboard}><div><p className={styles.eyebrow}>Лучший результат каждого ника</p><h2>Рейтинг ИБ-челленджа</h2></div>{entries.length === 0 ? <p className={styles.empty}>Здесь пока тихо. Первый результат задаст планку.</p> : <ol>{entries.map((entry) => <li key={`${entry.rank}-${entry.nickname}`}><strong>#{entry.rank}</strong><span>{entry.nickname}<small>{entry.correctCount} верно · {entry.incorrectCount} ошибок · {entry.timeoutCount} тайм-аутов</small></span><b>{scoreLabel(entry.score)}</b></li>)}</ol>}</section>;
}

function Review({ items, attemptId, token }: { items: ReviewItem[]; attemptId: string; token: string }) {
  if (items.length === 0) return <section className={styles.review}><h2>Готовим полный разбор…</h2></section>;
  return <section className={styles.review}><div><p className={styles.eyebrow}>Все показанные вопросы</p><h2>Разбор ответов</h2><p>Если формулировка или ключ спорные — отправьте комментарий. Он попадёт в отдельную очередь администратора.</p></div><div className={styles.reviewList}>{items.map((item) => <ReviewCard key={item.eventId} item={item} attemptId={attemptId} token={token} />)}</div></section>;
}

function ReviewCard({ item, attemptId, token }: { item: ReviewItem; attemptId: string; token: string }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState('');
  const tone = item.outcome === 'correct' ? 'good' : item.outcome === 'manual_unanswered' ? 'neutral' : 'bad';
  async function sendFeedback() {
    setStatus('Отправляем…');
    try {
      await challengeRequest(`/api/challenges/infosec/attempts/${attemptId}/feedback`, token, { method: 'POST', body: JSON.stringify({ eventId: item.eventId, comment }) });
      setStatus('Отмечено для проверки');
      setOpen(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Не удалось отправить.'); }
  }
  return <details className={styles.reviewCard}><summary><span>#{item.ordinal} · {difficultyLabels[item.difficulty]}</span><strong data-tone={tone}>{outcomeLabels[item.outcome]}</strong><b>{item.scoreDelta > 0 ? '+' : ''}{scoreLabel(item.scoreDelta)}</b></summary><div className={styles.reviewBody}><h3>{item.prompt}</h3>{item.context && <pre><code>{item.context}</code></pre>}<ol>{item.choices.map((choice, index) => <li key={`${index}-${choice}`} data-selected={item.selectedIndex === index || undefined} data-correct={item.correctIndex === index || undefined}>{choice}{item.selectedIndex === index && <small>Ваш выбор</small>}{item.correctIndex === index && <small>Правильный ответ</small>}</li>)}</ol><p>Время: {item.elapsedSeconds ?? 0} сек.</p>{open ? <div className={styles.feedbackForm}><textarea maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Что именно спорно?" /><div><button className={styles.secondaryButton} onClick={() => setOpen(false)}>Отмена</button><button className={styles.primaryButton} disabled={comment.trim().length < 3} onClick={() => void sendFeedback()}>Отправить</button></div></div> : <button className={styles.linkButton} onClick={() => setOpen(true)}>Отметить спорным</button>}{status && <p className={styles.feedbackStatus}>{status}</p>}</div></details>;
}
