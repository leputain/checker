import type { Verdict } from './scoring.ts';
import type { Difficulty } from './test-config.ts';

const TELEGRAM_FIELD_LIMITS = {
  candidateName: 80,
  prompt: 280,
  context: 2_000,
  answer: 160,
  topic: 120,
} as const;

const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Базовый',
  medium: 'Средний',
  hard: 'Сложный',
  expert: 'Экспертный',
};

const difficultyOrder: Difficulty[] = ['easy', 'medium', 'hard', 'expert'];

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

function truncateTelegramField(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const suffix = '…';
  let end = Math.max(0, maxLength - suffix.length);
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
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
    `👤 <b>${escapeTelegramHtml(truncateTelegramField(
      input.candidateName,
      TELEGRAM_FIELD_LIMITS.candidateName,
    ))}</b>`,
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
  contextType?: 'text' | 'code' | 'command' | 'log' | 'config';
  context?: string;
  selectedAnswer: string | null;
  correctAnswer: string;
  correct: boolean;
  timedOut: boolean;
  questionElapsedSeconds: number;
}) {
  const result = input.timedOut ? '⏱ Таймаут' : input.correct ? '✅ Верно' : '❌ Неверно';
  const contextLabels = {
    text: 'Контекст',
    code: 'Код',
    command: 'Команда',
    log: 'Фрагмент журнала',
    config: 'Конфигурация',
  } as const;
  const contextLines = input.context && input.contextType
    ? [
        '',
        `<b>${contextLabels[input.contextType]}:</b>`,
        input.contextType === 'text'
          ? escapeTelegramHtml(truncateTelegramField(input.context, TELEGRAM_FIELD_LIMITS.context))
          : `<pre>${escapeTelegramHtml(truncateTelegramField(
              input.context,
              TELEGRAM_FIELD_LIMITS.context,
            ))}</pre>`,
      ]
    : [];
  return [
    `<b>${result} · вопрос ${input.position} из ${input.totalQuestions}</b>`,
    `${difficultyLabels[input.difficulty]} · ${pointsLabel(input.weight)}`,
    '',
    escapeTelegramHtml(truncateTelegramField(input.prompt, TELEGRAM_FIELD_LIMITS.prompt)),
    ...contextLines,
    '',
    `<b>Выбрано:</b> ${escapeTelegramHtml(truncateTelegramField(
      input.selectedAnswer ?? 'ответ не дан',
      TELEGRAM_FIELD_LIMITS.answer,
    ))}`,
    `<b>Правильно:</b> ${escapeTelegramHtml(truncateTelegramField(
      input.correctAnswer,
      TELEGRAM_FIELD_LIMITS.answer,
    ))}`,
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
  timeoutCount: number;
  durationSeconds: number;
  averageAnswerSeconds: number;
  completedAt: number;
  difficultyStats: Array<{
    difficulty: Difficulty;
    correctCount: number;
    answeredCount: number;
    accuracy: number;
  }>;
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
        ...visibleTopics.map(({ topic, count }) => (
          `• ${escapeTelegramHtml(truncateTelegramField(topic, TELEGRAM_FIELD_LIMITS.topic))} — ${count}`
        )),
        ...(hiddenTopics ? [`• ещё тем: ${hiddenTopics}`] : []),
      ]
    : [];
  const difficultyLines = difficultyOrder
    .map((difficulty) => input.difficultyStats.find((item) => item.difficulty === difficulty))
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.answeredCount > 0))
    .map(
      (item) =>
        `• ${difficultyLabels[item.difficulty]}: ${item.correctCount}/${item.answeredCount} · ${item.accuracy}%`,
    );
  const difficultyBlock = difficultyLines.length
    ? ['', '<b>По сложности:</b>', ...difficultyLines]
    : [];

  return [
    `${verdictIcons[input.verdict]} <b>${escapeTelegramHtml(truncateTelegramField(
      input.candidateName,
      TELEGRAM_FIELD_LIMITS.candidateName,
    ))}</b>`,
    `<b>${verdictLabels[input.verdict]}</b>`,
    '',
    `<b>${input.score} / ${input.baseMaxScore} баллов · ${input.scorePercent}%</b>`,
    `✅ Верно: ${input.correctCount} · ❌ Ошибок: ${input.wrongCount} · из них таймаутов: ${input.timeoutCount}`,
    `Точность: ${input.accuracy}%`,
    `Время: ${durationLabel(input.durationSeconds)} · среднее на ответ: ${durationLabel(input.averageAnswerSeconds)}`,
    ...difficultyBlock,
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
    `⛔ <b>${escapeTelegramHtml(truncateTelegramField(
      input.candidateName,
      TELEGRAM_FIELD_LIMITS.candidateName,
    ))}</b>`,
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
