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

export function escapeTelegramHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

export function progressTelegramMessage(input: {
  attemptId: string;
  candidateName: string;
  state: 'started' | 'active' | 'completed' | 'aborted';
  answeredCount: number;
  totalQuestions: number;
  correctCount: number;
  wrongCount: number;
  score: number;
  baseMaxScore: number;
  totalRemainingSeconds: number;
}) {
  const headings = {
    started: ['🧪', 'Тестирование начато'],
    active: ['🧪', 'Тестирование идёт'],
    completed: ['🏁', 'Тестирование завершено'],
    aborted: ['⛔', 'Тестирование прервано'],
  } as const;
  const [icon, heading] = headings[input.state];
  return [
    `${icon} <b>${heading}</b>`,
    '',
    `👤 <b>${escapeTelegramHtml(input.candidateName)}</b>`,
    `Прогресс: <b>${input.answeredCount} из ${input.totalQuestions}</b>`,
    '',
    `✅ ${input.correctCount}   ❌ ${input.wrongCount}`,
    `Баллы: <b>${input.score} из ${input.baseMaxScore}</b>`,
    `Осталось: <b>${durationLabel(input.totalRemainingSeconds)}</b>`,
    '',
    `<code>#${shortId(input.attemptId)}</code>`,
  ].join('\n');
}

export function answerTelegramMessage(input: {
  attemptId: string;
  position: number;
  totalQuestions: number;
  difficulty: Difficulty;
  weight: number;
  prompt: string;
  selectedAnswer: string | null;
  correctAnswer: string;
  correct: boolean;
  timedOut: boolean;
  questionElapsedSeconds: number;
}) {
  const result = input.timedOut ? '⏱ Таймаут' : input.correct ? '✅ Верно' : '❌ Неверно';
  return [
    `<b>${result} · вопрос ${input.position} из ${input.totalQuestions}</b>`,
    `${difficultyLabels[input.difficulty]} · ${pointsLabel(input.weight)}`,
    '',
    escapeTelegramHtml(input.prompt),
    '',
    `<b>Выбрано:</b> ${escapeTelegramHtml(input.selectedAnswer ?? 'ответ не дан')}`,
    `<b>Правильно:</b> <tg-spoiler>${escapeTelegramHtml(input.correctAnswer)}</tg-spoiler>`,
    '',
    `⏱ ${durationLabel(input.questionElapsedSeconds)}`,
    `<code>#${shortId(input.attemptId)}</code>`,
  ].join('\n');
}

export function completedTelegramMessage(input: {
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
  completedAt: number;
  topicErrors: Array<{ topic: string; count: number }>;
}) {
  const sortedTopics = [...input.topicErrors]
    .sort((left, right) => right.count - left.count || left.topic.localeCompare(right.topic, 'ru'));
  const visibleTopics = sortedTopics.slice(0, 5);
  const hiddenTopics = Math.max(0, sortedTopics.length - visibleTopics.length);
  const topicLines = visibleTopics.length
    ? [
        '',
        '<b>Слабые темы:</b>',
        ...visibleTopics.map(({ topic, count }) => `• ${escapeTelegramHtml(topic)} — ${count}`),
        ...(hiddenTopics ? [`• ещё тем: ${hiddenTopics}`] : []),
      ]
    : [];

  return [
    `${verdictIcons[input.verdict]} <b>${escapeTelegramHtml(input.candidateName)}</b>`,
    `<b>${verdictLabels[input.verdict]}</b>`,
    '',
    `<b>${input.score} / ${input.baseMaxScore} баллов · ${input.scorePercent}%</b>`,
    `✅ ${input.correctCount} верных   ❌ ${input.wrongCount} ошибок`,
    `Точность: ${input.accuracy}% · время: ${durationLabel(input.durationSeconds)}`,
    ...topicLines,
    '',
    `Дата теста: ${completedAtLabel(input.completedAt)}`,
    `<code>#${shortId(input.attemptId)}</code>`,
  ].join('\n');
}

export function abortedTelegramMessage(input: {
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
    `⛔ <b>${escapeTelegramHtml(input.candidateName)}</b>`,
    '<b>Тестирование прервано</b>',
    '',
    `Пройдено: <b>${input.answeredCount} из ${input.minimumQuestions}</b>`,
    `Баллы: ${input.score} из ${input.baseMaxScore}`,
    `Время: ${durationLabel(input.durationSeconds)}`,
    '',
    `Прервано: ${completedAtLabel(input.abortedAt)}`,
    `<code>#${shortId(input.attemptId)}</code>`,
  ].join('\n');
}
