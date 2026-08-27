'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
type QuestionView = { id: number; prompt: string; choices: string[]; difficulty: Difficulty; weight: number; position: number; plannedTotal: number; questionDeadlineAt: number; totalDeadlineAt: number };
type Result = { score: number; correctCount: number; wrongCount: number; answeredCount: number; accuracy: number; durationSeconds: number };
type AttemptResponse = { attemptId: string; token: string; status: 'active' | 'completed'; question?: QuestionView; result?: Result };
type LeaderboardEntry = { alias: string; score: number; accuracy: number; completedAt: string };

const difficultyLabels: Record<Difficulty, string> = { easy: 'Базовый', medium: 'Средний', hard: 'Сложный', expert: 'Экспертный' };
function formatTime(seconds: number) { const safe = Math.max(0, seconds); return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`; }

export default function Home() {
  const [name, setName] = useState('');
  const [attempt, setAttempt] = useState<AttemptResponse | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  const question = attempt?.question;
  const totalLeft = question ? Math.ceil((question.totalDeadlineAt - now) / 1000) : 0;
  const questionLeft = question ? Math.ceil((question.questionDeadlineAt - now) / 1000) : 0;

  useEffect(() => { if (!question) return; const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, [question]);

  const submitAnswer = useCallback(async (choiceIndex: number | null) => {
    if (!attempt?.question || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/attempts/${attempt.attemptId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: attempt.token, questionId: attempt.question.id, choiceIndex }) });
      const data = (await response.json()) as AttemptResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить ответ');
      setAttempt({ ...data, token: attempt.token }); setSelectedChoice(null); setNow(Date.now());
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Что-то пошло не так'); }
    finally { setBusy(false); }
  }, [attempt, busy]);

  useEffect(() => {
    if (!question || busy) return;
    const deadline = Math.min(question.questionDeadlineAt, question.totalDeadlineAt);
    const timeout = window.setTimeout(() => void submitAnswer(null), Math.max(0, deadline - Date.now() + 50));
    return () => window.clearTimeout(timeout);
  }, [question, busy, submitAnswer]);

  async function startTest(event: FormEvent) {
    event.preventDefault(); const cleanName = name.trim();
    if (cleanName.length < 2) { setError('Введите имя — хотя бы 2 символа.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/attempts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName }) });
      const data = (await response.json()) as AttemptResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось начать тест');
      setAttempt(data); setNow(Date.now());
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Что-то пошло не так'); }
    finally { setBusy(false); }
  }

  async function openLeaderboard() {
    setShowLeaderboard(true); setError('');
    try { const response = await fetch('/api/leaderboard'); const data = (await response.json()) as { entries: LeaderboardEntry[] }; if (!response.ok) throw new Error('Не удалось загрузить рейтинг'); setLeaderboard(data.entries); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Что-то пошло не так'); }
  }

  const progress = useMemo(() => question ? Math.min(100, Math.round(((question.position - 1) / question.plannedTotal) * 100)) : 0, [question]);

  if (attempt?.status === 'completed' && attempt.result) {
    const result = attempt.result;
    return <main className="app-shell result-shell"><div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <section className="result-card glass-card"><p className="eyebrow">Тест завершён</p><div className="score-ring" style={{ '--score': `${result.accuracy * 3.6}deg` } as React.CSSProperties}><div><strong>{result.score}</strong><span>баллов</span></div></div>
        <h1>Готово, {name.trim()}.</h1><p className="muted result-copy">Результат сохранён. Разбор правильных ответов скрыт, чтобы банк вопросов оставался честным.</p>
        <div className="stats-grid"><div><strong>{result.answeredCount}</strong><span>вопросов</span></div><div><strong>{result.correctCount}</strong><span>верных</span></div><div><strong>{result.wrongCount}</strong><span>ошибок</span></div><div><strong>{formatTime(result.durationSeconds)}</strong><span>время</span></div></div>
        <div className="result-actions"><button className="primary-button" onClick={() => void openLeaderboard()}>Таблица лидеров</button><button className="ghost-button" onClick={() => { setAttempt(null); setName(''); }}>На стартовую</button></div></section>
      {showLeaderboard && <Leaderboard entries={leaderboard} onClose={() => setShowLeaderboard(false)} />}</main>;
  }

  if (question) return <main className="app-shell quiz-shell"><div className="ambient ambient-one" />
    <header className="quiz-header"><div className="brand"><span className="brand-mark">C</span><span>Candidate Check</span></div><div className="timer-group" aria-label="Оставшееся время"><div className={questionLeft <= 10 ? 'timer timer-alert' : 'timer'}><span>На вопрос</span><strong>{formatTime(questionLeft)}</strong></div><div className={totalLeft <= 60 ? 'timer timer-alert' : 'timer'}><span>Всего</span><strong>{formatTime(totalLeft)}</strong></div></div></header>
    <section className="quiz-stage"><div className="quiz-meta"><span className={`difficulty difficulty-${question.difficulty}`}>{difficultyLabels[question.difficulty]} · {question.weight} {question.weight === 1 ? 'балл' : 'баллов'}</span><span>Вопрос {question.position} из {question.plannedTotal}</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <article className="question-card glass-card"><p className="eyebrow">Выберите один ответ</p><h1>{question.prompt}</h1><div className="answers" role="radiogroup" aria-label="Варианты ответа">{question.choices.map((choice, index) => <button key={choice} type="button" role="radio" aria-checked={selectedChoice === index} className={selectedChoice === index ? 'answer selected' : 'answer'} onClick={() => setSelectedChoice(index)}><span className="answer-letter">{String.fromCharCode(65 + index)}</span><span>{choice}</span><span className="answer-dot" /></button>)}</div>
        <div className="question-footer"><p>Ответ нельзя изменить после отправки.</p><button className="primary-button" disabled={selectedChoice === null || busy} onClick={() => void submitAnswer(selectedChoice)}>{busy ? 'Сохраняем…' : 'Ответить'}</button></div></article>{error && <p className="error-message" role="alert">{error}</p>}</section></main>;

  return <main className="app-shell welcome-shell"><div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="site-header"><div className="brand"><span className="brand-mark">C</span><span>Candidate Check</span></div><button className="text-button" onClick={() => void openLeaderboard()}>Рейтинг</button></header>
    <section className="welcome-grid"><div className="welcome-copy"><p className="eyebrow"><span className="live-dot" /> Короткая оценка навыков</p><h1>Покажите, как вы <em>думаете</em>, а не как запоминаете.</h1><p className="lead">Небольшой адаптивный тест: десять минут, вопросы разной сложности и ни одного отвлекающего элемента.</p><div className="rules-row"><span><strong>10:00</strong> на весь тест</span><span><strong>01:00</strong> на вопрос</span><span><strong>6+</strong> вопросов</span></div></div>
      <form className="start-card glass-card" onSubmit={startTest}><div className="card-number">01</div><p className="eyebrow">Перед началом</p><h2>Как к вам обращаться?</h2><p className="muted">В рейтинге имя будет показано анонимно: только имя и первая буква фамилии.</p><label htmlFor="candidate-name">Имя и фамилия</label><input id="candidate-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" placeholder="Например, Анна Петрова" autoFocus />{error && <p className="error-message" role="alert">{error}</p>}<button className="primary-button full-button" disabled={busy} type="submit">{busy ? 'Готовим вопросы…' : 'Начать тест'}<span>→</span></button><p className="privacy-note">Результат сохраняется локально. Авторизация не требуется.</p></form></section>
    <footer className="site-footer"><span>Оценка без лишнего стресса</span><span>v0.1 · локальный прототип</span></footer>{showLeaderboard && <Leaderboard entries={leaderboard} onClose={() => setShowLeaderboard(false)} />}</main>;
}

function Leaderboard({ entries, onClose }: { entries: LeaderboardEntry[]; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="leaderboard-card glass-card" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Лучшие результаты</p><h2 id="leaderboard-title">Таблица лидеров</h2></div><button className="close-button" onClick={onClose} aria-label="Закрыть">×</button></div>{entries.length === 0 ? <p className="empty-state">Пока здесь пусто. Первый результат задаст планку.</p> : <ol className="leader-list">{entries.map((entry, index) => <li key={`${entry.alias}-${entry.completedAt}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className="leader-name"><strong>{entry.alias}</strong><small>{new Date(entry.completedAt).toLocaleDateString('ru-RU')}</small></span><span className="leader-accuracy">{entry.accuracy}%</span><strong className="leader-score">{entry.score}</strong></li>)}</ol>}</section></div>;
}
