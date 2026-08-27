import type { Verdict } from './scoring.ts';
import type { Difficulty } from './test-config.ts';

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

const verdictIcons: Record<Verdict, string> = {
  PASS: '🟢',
  REVIEW: '🟡',
  FAIL: '🔴',
};

function durationLabel(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function pointsLabel(points: number) {
  const lastTwo = points % 100;
  const last = points % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${points} баллов`;
  if (last === 1) return `${points} балл`;
  if (last >= 2 && last <= 4) return `${points} балла`;
  return `${points} баллов`;
}

function completedAtLabel(timestamp: number) {
  return `${new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp)).replace(',', ' ·')} МСК`;
}

function shortId(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();
}

export function answerTelegramMessage(input: {
  eventId: string;
  attemptId: string;
  candidateName: string;
  position: number;
  difficulty: Difficulty;
  weight: number;
  prompt: string;
  selectedAnswer: string | null;
  correctAnswer: string;
  correct: boolean;
  timedOut: boolean;
  questionElapsedSeconds: number;
  totalRemainingSeconds: number;
}) {
  const result = input.timedOut ? '⏱ Таймаут' : input.correct ? '✅ Верно' : '❌ Неверно';
  return [
    `${result} · вопрос ${input.position}`,
    `👤 ${input.candidateName}`,
    `${difficultyLabels[input.difficulty]} · ${pointsLabel(input.weight)}`,
    '',
    `🧩 ${input.prompt}`,
    '',
    `Ответ: ${input.selectedAnswer ?? 'не дан'}`,
    `Эталон: ${input.correctAnswer}`,
    '',
    `⏱ ${durationLabel(input.questionElapsedSeconds)} на вопрос · ${durationLabel(input.totalRemainingSeconds)} до конца`,
    `ID: ${shortId(input.attemptId)} / ${shortId(input.eventId)}`,
  ].join('\n');
}

export function completedTelegramMessage(input: {
  eventId: string;
  attemptId: string;
  candidateName: string;
  verdict: Verdict;
  score: number;
  baseMaxScore: number;
  scorePercent: number;
  correctCount: number;
  wrongCount: number;
  answeredCount: number;
  accuracy: number;
  durationSeconds: number;
  bankRevision: string | null;
  completedAt: number;
}) {
  return [
    '🏁 CANDIDATE CHECK · ИТОГ',
    `👤 ${input.candidateName}`,
    `${verdictIcons[input.verdict]} ${verdictLabels[input.verdict]}`,
    '',
    `Результат: ${input.score} из ${input.baseMaxScore} · ${input.scorePercent}%`,
    `Верно: ${input.correctCount} из ${input.answeredCount} · ошибок: ${input.wrongCount}`,
    `Точность: ${input.accuracy}% · время: ${durationLabel(input.durationSeconds)}`,
    '',
    `Завершено: ${completedAtLabel(input.completedAt)}`,
    `ID: ${shortId(input.attemptId)} / ${shortId(input.eventId)} · банк ${input.bankRevision?.slice(0, 8) ?? 'legacy'}`,
  ].join('\n');
}

export function abortedTelegramMessage(input: {
  eventId: string;
  attemptId: string;
  candidateName: string;
  score: number;
  baseMaxScore: number;
  answeredCount: number;
  minimumQuestions: number;
  durationSeconds: number;
  abortedAt: number;
}) {
  return [
    '⛔ CANDIDATE CHECK · ТЕСТ ПРЕРВАН',
    `👤 ${input.candidateName}`,
    '',
    `Пройдено: ${input.answeredCount} из ${input.minimumQuestions}`,
    `Баллы на момент остановки: ${input.score} из ${input.baseMaxScore}`,
    `Время: ${durationLabel(input.durationSeconds)}`,
    '',
    `Прервано: ${completedAtLabel(input.abortedAt)}`,
    `ID: ${shortId(input.attemptId)} / ${shortId(input.eventId)}`,
  ].join('\n');
}
