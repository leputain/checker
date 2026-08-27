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

function secondsLabel(seconds: number) {
  return `${Math.max(0, Math.round(seconds))} сек.`;
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
    'Candidate Check · ответ',
    `Кандидат: ${input.candidateName}`,
    `Попытка: ${shortId(input.attemptId)} · событие: ${shortId(input.eventId)}`,
    `Вопрос ${input.position} · ${difficultyLabels[input.difficulty]} · ${input.weight} балл(а)`,
    '',
    input.prompt,
    '',
    `Ответ кандидата: ${input.selectedAnswer ?? 'Нет ответа'}`,
    `Правильный ответ: ${input.correctAnswer}`,
    `Результат: ${result}`,
    `Время на вопрос: ${secondsLabel(input.questionElapsedSeconds)} · осталось в тесте: ${secondsLabel(input.totalRemainingSeconds)}`,
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
    'Candidate Check · итог',
    `Кандидат: ${input.candidateName}`,
    `Попытка: ${shortId(input.attemptId)} · событие: ${shortId(input.eventId)}`,
    `Вердикт: ${verdictLabels[input.verdict]}`,
    `Баллы: ${input.score}/${input.baseMaxScore} (${input.scorePercent}%)`,
    `Точность: ${input.accuracy}% · верно: ${input.correctCount} · ошибок: ${input.wrongCount}`,
    `Всего ответов: ${input.answeredCount} · длительность: ${secondsLabel(input.durationSeconds)}`,
    `Ревизия банка: ${input.bankRevision?.slice(0, 12) ?? 'legacy'}`,
    `Завершено: ${new Date(input.completedAt).toISOString()}`,
  ].join('\n');
}
