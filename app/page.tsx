'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type Verdict = 'PASS' | 'REVIEW' | 'FAIL';

type QuestionView = {
  id: number;
  prompt: string;
  choices: string[];
  difficulty: Difficulty;
  topic: string;
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
};

type AttemptResponse = {
  attemptId: string;
  token: string;
  alias: string;
  status: 'active' | 'completed';
  question?: QuestionView;
  result?: Result;
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

type QuestionStat = {
  id: number;
  prompt: string;
  topic: string;
  difficulty: Difficulty;
  shownCount: number;
  correctCount: number;
  correctRate: number;
  wrongRate: number;
};

const STORAGE_KEY = 'candidate-check:active-attempt';
const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};
const verdictCopy: Record<Verdict, string> = {
  PASS: 'Кандидат прошёл первичный технический фильтр.',
  REVIEW: 'Результат требует дополнительной оценки.',
  FAIL: 'Минимальный порог технического отбора не достигнут.',
};

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function saveAttempt(attemptId: string, token: string) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ attemptId, token }));
}

export default function Home() {
  const [name, setName] = useState('');
  const [attempt, setAttempt] = useState<AttemptResponse | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [questionStats, setQuestionStats] = useState<QuestionStat[]>([]);
  const submittingRef = useRef(false);

  const question = attempt?.question;
  const totalLeft = question ? Math.ceil((question.totalDeadlineAt - now) / 1000) : 0;
  const questionLeft = question ? Math.ceil((question.questionDeadlineAt - now) / 1000) : 0;
  const timeProgress = question ? Math.min(100, Math.max(0, ((600 - totalLeft) / 600) * 100)) : 0;

  useEffect(() => {
    const restore = async () => {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (!saved) return;
        const session = JSON.parse(saved) as { attemptId?: string; token?: string };
        if (!session.attemptId || !session.token) throw new Error('invalid session');
        const response = await fetch(`/api/attempts/${session.attemptId}`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (!response.ok) throw new Error('restore failed');
        const data = (await response.json()) as AttemptResponse;
        setAttempt({ ...data, token: session.token });
        setNow(Date.now());
        if (data.status === 'completed') sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      } finally {
        setRestoring(false);
      }
    };
    void restore();
  }, []);

  useEffect(() => {
    if (!question) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [question]);

  const submitAnswer = useCallback(async (choiceIndex: number | null) => {
    if (!attempt?.question || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/attempts/${attempt.attemptId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: attempt.token,
          questionId: attempt.question.id,
          choiceIndex,
        }),
      });
      const data = (await response.json()) as AttemptResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить ответ');
      const nextAttempt = { ...data, token: attempt.token };
      setAttempt(nextAttempt);
      setSelectedChoice(null);
      setNow(Date.now());
      if (data.status === 'completed') sessionStorage.removeItem(STORAGE_KEY);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }, [attempt]);

  useEffect(() => {
    if (!question || busy) return;
    const deadline = Math.min(question.questionDeadlineAt, question.totalDeadlineAt);
    const timeout = window.setTimeout(
      () => void submitAnswer(null),
      Math.max(0, deadline - Date.now() + 50),
    );
    return () => window.clearTimeout(timeout);
  }, [question, busy, submitAnswer]);

  async function startTest(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      setError('Введите имя — хотя бы 2 символа.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName }),
      });
      const data = (await response.json()) as AttemptResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось начать тест');
      saveAttempt(data.attemptId, data.token);
      setAttempt(data);
      setNow(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
    } finally {
      setBusy(false);
    }
  }

  async function openLeaderboard() {
    setShowLeaderboard(true);
    setError('');
    try {
      const response = await fetch('/api/leaderboard');
      const data = (await response.json()) as { entries: LeaderboardEntry[] };
      if (!response.ok) throw new Error('Не удалось загрузить рейтинг');
      setLeaderboard(data.entries);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
    }
  }

  async function openQuestionStats() {
    setShowStats(true);
    setError('');
    try {
      const response = await fetch('/api/questions/stats');
      const data = (await response.json()) as { questions: QuestionStat[] };
      if (!response.ok) throw new Error('Не удалось загрузить статистику');
      setQuestionStats(data.questions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Что-то пошло не так');
    }
  }

  function resetToStart() {
    sessionStorage.removeItem(STORAGE_KEY);
    setAttempt(null);
    setName('');
  }

  if (restoring) {
    return <main className="app-shell loading-shell"><div className="brand-mark">C</div><p>Восстанавливаем попытку…</p></main>;
  }

  if (attempt?.status === 'completed' && attempt.result) {
    const result = attempt.result;
    return (
      <main className="app-shell result-shell">
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
        <section className={`result-card glass-card verdict-${result.verdict.toLowerCase()}`}>
          <span className="verdict-badge">{result.verdict}</span>
          <div className="score-ring" style={{ '--score': `${result.scorePercent * 3.6}deg` } as React.CSSProperties}>
            <div><strong>{result.score}/{result.baseMaxScore}</strong><span>базовый score</span></div>
          </div>
          <h1>Результат готов.</h1>
          <p className="verdict-copy">{verdictCopy[result.verdict]}</p>
          <p className="muted result-copy">Правильные ответы не раскрываются: банк вопросов остаётся пригодным для следующих кандидатов.</p>
          <div className="stats-grid result-stats">
            <div><strong>{result.accuracy}%</strong><span>accuracy</span></div>
            <div><strong>{result.correctCount}</strong><span>верных</span></div>
            <div><strong>{result.wrongCount}</strong><span>ошибок</span></div>
            <div><strong>{result.answeredCount}</strong><span>вопросов</span></div>
            <div><strong>{formatTime(result.durationSeconds)}</strong><span>время</span></div>
          </div>
          <div className="result-actions">
            <button className="primary-button" onClick={() => void openLeaderboard()}>Таблица лидеров</button>
            <button className="ghost-button" onClick={resetToStart}>На стартовую</button>
          </div>
        </section>
        {showLeaderboard && <Leaderboard entries={leaderboard} onClose={() => setShowLeaderboard(false)} />}
      </main>
    );
  }

  if (question) {
    return (
      <main className="app-shell quiz-shell">
        <div className="ambient ambient-one" />
        <header className="quiz-header">
          <div className="brand"><span className="brand-mark">C</span><span>Candidate Check</span></div>
          <div className="timer-group" aria-label="Оставшееся время">
            <div className={questionLeft <= 10 ? 'timer timer-alert' : 'timer'}><span>На вопрос</span><strong>{formatTime(questionLeft)}</strong></div>
            <div className={totalLeft <= 60 ? 'timer timer-alert' : 'timer'}><span>Всего</span><strong>{formatTime(totalLeft)}</strong></div>
          </div>
        </header>
        <section className="quiz-stage">
          <div className="quiz-meta">
            <span className={`difficulty difficulty-${question.difficulty}`}>{difficultyLabels[question.difficulty]} · {question.weight} {question.weight === 1 ? 'балл' : 'баллов'}</span>
            <span>Вопрос {question.position} · минимум {question.minimumQuestions}</span>
          </div>
          <div className="progress-track" aria-label="Использованное общее время"><span style={{ width: `${timeProgress}%` }} /></div>
          <article className="question-card glass-card">
            <p className="eyebrow">Выберите один ответ</p>
            <h1>{question.prompt}</h1>
            <div className="answers" role="radiogroup" aria-label="Варианты ответа">
              {question.choices.map((choice, index) => (
                <button key={`${index}-${choice}`} type="button" role="radio" aria-checked={selectedChoice === index} className={selectedChoice === index ? 'answer selected' : 'answer'} onClick={() => setSelectedChoice(index)}>
                  <span className="answer-letter">{String.fromCharCode(65 + index)}</span><span>{choice}</span><span className="answer-dot" />
                </button>
              ))}
            </div>
            <div className="question-footer"><p>Ответ нельзя изменить после отправки.</p><button className="primary-button" disabled={selectedChoice === null || busy} onClick={() => void submitAnswer(selectedChoice)}>{busy ? 'Сохраняем…' : 'Ответить'}</button></div>
          </article>
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell welcome-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="site-header">
        <div className="brand"><span className="brand-mark">C</span><span>Candidate Check</span></div>
        <div className="header-actions"><button className="text-button" onClick={() => void openQuestionStats()}>Качество вопросов</button><button className="text-button" onClick={() => void openLeaderboard()}>Рейтинг</button></div>
      </header>
      <section className="welcome-grid">
        <div className="welcome-copy"><p className="eyebrow"><span className="live-dot" /> Короткая оценка навыков</p><h1>Покажите, как вы <em>думаете</em>, а не как запоминаете.</h1><p className="lead">Небольшой адаптивный тест: десять минут, вопросы разной сложности и ни одного отвлекающего элемента.</p><div className="rules-row"><span><strong>10:00</strong> на весь тест</span><span><strong>01:00</strong> на вопрос</span><span><strong>6+</strong> вопросов</span></div></div>
        <form className="start-card glass-card" onSubmit={startTest}><div className="card-number">02</div><p className="eyebrow">Перед началом</p><h2>Как к вам обращаться?</h2><p className="muted">В рейтинге имя будет показано анонимно: только имя и первая буква фамилии.</p><label htmlFor="candidate-name">Имя и фамилия</label><input id="candidate-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" placeholder="Например, Анна Петрова" autoFocus />{error && <p className="error-message" role="alert">{error}</p>}<button className="primary-button full-button" disabled={busy} type="submit">{busy ? 'Готовим вопросы…' : 'Начать тест'}<span>→</span></button><p className="privacy-note">Результат сохраняется локально. Авторизация не требуется.</p></form>
      </section>
      <footer className="site-footer"><span>Оценка без лишнего стресса</span><span>v0.2 · локальный инструмент</span></footer>
      {showLeaderboard && <Leaderboard entries={leaderboard} onClose={() => setShowLeaderboard(false)} />}
      {showStats && <QuestionStats questions={questionStats} onClose={() => setShowStats(false)} />}
    </main>
  );
}

function Leaderboard({ entries, onClose }: { entries: LeaderboardEntry[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="leaderboard-card glass-card wide-modal" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p className="eyebrow">Лучшие результаты</p><h2 id="leaderboard-title">Таблица лидеров</h2></div><button className="close-button" onClick={onClose} aria-label="Закрыть">×</button></div>
        {entries.length === 0 ? <p className="empty-state">Пока здесь пусто. Первый результат задаст планку.</p> : (
          <ol className="leader-list">
            {entries.map((entry, index) => (
              <li className={entry.verdict === 'FAIL' ? 'leader-fail' : ''} key={`${entry.alias}-${entry.completedAt}`}>
                <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                <span className="leader-name"><strong>{entry.alias}</strong><small>{formatTime(entry.durationSeconds)}</small></span>
                <span className={`mini-verdict mini-${entry.verdict.toLowerCase()}`}>{entry.verdict}</span>
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

function QuestionStats({ questions, onClose }: { questions: QuestionStat[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="leaderboard-card glass-card wide-modal" role="dialog" aria-modal="true" aria-labelledby="stats-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><p className="eyebrow">Локальная аналитика</p><h2 id="stats-title">Качество вопросов</h2></div><button className="close-button" onClick={onClose} aria-label="Закрыть">×</button></div>
        <p className="muted modal-copy">Крайние значения после накопления ответов помогают найти слишком лёгкие, сложные или неоднозначные формулировки.</p>
        <div className="question-stat-list">
          {questions.map((question) => (
            <article key={question.id} className="question-stat-row">
              <div><span className="stat-topic">{question.topic} · {difficultyLabels[question.difficulty]}</span><strong>{question.prompt}</strong></div>
              <span>{question.shownCount}<small>попыток</small></span>
              <span className={question.shownCount > 0 && (question.correctRate >= 90 || question.correctRate <= 30) ? 'rate-warning' : ''}>{question.shownCount ? `${question.correctRate}%` : '—'}<small>правильно</small></span>
              <span>{question.shownCount ? `${question.wrongRate}%` : '—'}<small>ошибок</small></span>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
