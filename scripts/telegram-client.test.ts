import assert from 'node:assert/strict';
import {
  sendTelegramMessage,
  TELEGRAM_MESSAGE_VISIBLE_LIMIT,
  telegramVisibleTextLength,
} from '../lib/telegram-client.ts';
import {
  abortedTelegramMessage,
  answerTelegramMessage,
  completedTelegramMessage,
  progressTelegramMessage,
} from '../lib/telegram-messages.ts';
import {
  normalizeTelegramReportMode,
  telegramReportPolicy,
} from '../lib/telegram-report-policy.ts';

const credentials = {
  botToken: `${'1'.repeat(10)}:${'A'.repeat(35)}`,
  chatId: `-100${'2'.repeat(10)}`,
};

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let capturedUrl = '';
let capturedBody: Record<string, unknown> = {};
const success = await sendTelegramMessage(
  credentials,
  { text: '<b>Проверка</b>', parseMode: 'HTML', silent: true },
  async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, { ok: true, result: { message_id: 17 } });
  },
);
assert.deepEqual(success, { ok: true, messageId: 17 });
assert.match(capturedUrl, /\/sendMessage$/);
assert.deepEqual(capturedBody, {
  chat_id: credentials.chatId,
  text: '<b>Проверка</b>',
  parse_mode: 'HTML',
  protect_content: true,
  disable_notification: true,
});

const reply = await sendTelegramMessage(
  credentials,
  { text: 'Ошибка', deliveryMethod: 'reply_root', rootMessageId: 17, silent: true },
  async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, { ok: true, result: { message_id: 18 } });
  },
);
assert.deepEqual(reply, { ok: true, messageId: 18 });
assert.deepEqual((capturedBody as Record<string, unknown>).reply_parameters, { message_id: 17 });

const edit = await sendTelegramMessage(
  credentials,
  { text: 'Прогресс', deliveryMethod: 'edit_root', rootMessageId: 17, parseMode: 'HTML' },
  async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, { ok: true, result: { message_id: 17 } });
  },
);
assert.deepEqual(edit, { ok: true, messageId: 17 });
assert.match(capturedUrl, /\/editMessageText$/);
assert.equal((capturedBody as Record<string, unknown>).message_id, 17);
assert.equal('protect_content' in capturedBody, false);

const unchangedEdit = await sendTelegramMessage(
  credentials,
  { text: 'Прогресс', deliveryMethod: 'edit_root', rootMessageId: 17 },
  async () => response(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }),
);
assert.deepEqual(unchangedEdit, { ok: true, messageId: 17 });

assert.deepEqual(
  await sendTelegramMessage(credentials, { text: 'Ответ', deliveryMethod: 'reply_root' }),
  { ok: false, code: 'telegram_root_missing', retryable: false },
);
assert.deepEqual(
  await sendTelegramMessage(credentials, { text: 'X'.repeat(4_097) }),
  { ok: false, code: 'telegram_payload_invalid', retryable: false },
);

const cases = [
  [429, { ok: false, error_code: 429, parameters: { retry_after: 7 } }, { ok: false, code: 'telegram_429', retryable: true, retryAfterMs: 7_000 }],
  [400, { ok: false, error_code: 400 }, { ok: false, code: 'telegram_400', retryable: false }],
  [401, { ok: false, error_code: 401 }, { ok: false, code: 'telegram_401', retryable: false }],
  [403, { ok: false, error_code: 403 }, { ok: false, code: 'telegram_403', retryable: false }],
  [503, { ok: false, error_code: 503 }, { ok: false, code: 'telegram_503', retryable: true }],
] as const;
for (const [status, payload, expected] of cases) {
  const result = await sendTelegramMessage(
    credentials,
    { text: 'Проверка' },
    async () => response(status, payload),
  );
  assert.deepEqual(result, expected);
}

const networkError = await sendTelegramMessage(
  credentials,
  { text: 'Проверка' },
  async () => { throw new Error('private transport detail'); },
);
assert.deepEqual(networkError, { ok: false, code: 'telegram_network', retryable: true });

const timeoutError = await sendTelegramMessage(
  credentials,
  { text: 'Проверка' },
  async () => { throw new DOMException('Timed out', 'AbortError'); },
);
assert.deepEqual(timeoutError, { ok: false, code: 'telegram_timeout', retryable: true });

const progressMessage = progressTelegramMessage({
  attemptId: 'attempt-1',
  candidateName: 'Анна <Петрова>',
  state: 'active',
  answeredCount: 7,
  totalQuestions: 21,
  correctCount: 5,
  wrongCount: 2,
  score: 9,
  baseMaxScore: 50,
  totalRemainingSeconds: 388,
});
assert.match(progressMessage, /Анна &lt;Петрова&gt;/);
assert.match(progressMessage, /Прогресс: <b>7 из 21<\/b>/);
assert.match(progressMessage, /Осталось: <b>06:28<\/b>/);

const answerMessage = answerTelegramMessage({
  attemptId: 'attempt-1',
  position: 7,
  totalQuestions: 21,
  difficulty: 'medium',
  weight: 2,
  prompt: 'Что проверяет <тест>?',
  contextType: 'log',
  context: 'sshd: Failed password & retry',
  selectedAnswer: 'Логику & синтаксис',
  correctAnswer: 'Логику',
  correct: false,
  timedOut: false,
  questionElapsedSeconds: 12,
});
assert.match(answerMessage, /❌ Неверно · вопрос 7 из 21/);
assert.match(answerMessage, /Что проверяет &lt;тест&gt;?/);
assert.match(answerMessage, /<b>Фрагмент журнала:<\/b>/);
assert.match(answerMessage, /<pre>sshd: Failed password &amp; retry<\/pre>/);
assert.match(answerMessage, /Логику &amp; синтаксис/);
assert.match(answerMessage, /<b>Правильно:<\/b> Логику/);
assert.doesNotMatch(answerMessage, /tg-spoiler/);
assert.doesNotMatch(answerMessage, /Анна/);

const boundaryAnswerMessage = answerTelegramMessage({
  attemptId: 'boundary-attempt-12345678',
  position: 20,
  totalQuestions: 20,
  difficulty: 'expert',
  weight: 10,
  prompt: '<&>'.repeat(500),
  contextType: 'config',
  context: '&'.repeat(2_000),
  selectedAnswer: '<&>'.repeat(200),
  correctAnswer: '<&>'.repeat(200),
  correct: false,
  timedOut: false,
  questionElapsedSeconds: 30,
});
assert.ok(boundaryAnswerMessage.length > TELEGRAM_MESSAGE_VISIBLE_LIMIT);
assert.ok(
  telegramVisibleTextLength(boundaryAnswerMessage, 'HTML') <= TELEGRAM_MESSAGE_VISIBLE_LIMIT,
);
assert.match(boundaryAnswerMessage, /<pre>(?:&amp;){2000}<\/pre>/);
assert.match(boundaryAnswerMessage, /<code>#12345678<\/code>$/);
assert.doesNotMatch(boundaryAnswerMessage, /tg-spoiler/);
const escapedBoundaryResult = await sendTelegramMessage(
  credentials,
  { text: boundaryAnswerMessage, parseMode: 'HTML' },
  async () => response(200, { ok: true, result: { message_id: 19 } }),
);
assert.deepEqual(escapedBoundaryResult, { ok: true, messageId: 19 });

const completedMessage = completedTelegramMessage({
  attemptId: 'attempt-1',
  candidateName: 'Анна Петрова',
  verdict: 'PASS',
  score: 43,
  baseMaxScore: 50,
  scorePercent: 86,
  correctCount: 18,
  wrongCount: 2,
  answeredCount: 20,
  accuracy: 90,
  timeoutCount: 1,
  durationSeconds: 120,
  averageAnswerSeconds: 6,
  completedAt: 1_700_000_000_000,
  difficultyStats: [
    { difficulty: 'hard', correctCount: 4, answeredCount: 5, accuracy: 80 },
    { difficulty: 'easy', correctCount: 5, answeredCount: 5, accuracy: 100 },
    { difficulty: 'expert', correctCount: 0, answeredCount: 0, accuracy: 0 },
    { difficulty: 'medium', correctCount: 9, answeredCount: 10, accuracy: 90 },
  ],
  topicErrors: [{ topic: 'Linux & shell', count: 2 }],
});
assert.match(completedMessage, /Рекомендован/);
assert.match(completedMessage, /43 \/ 50 баллов · 86%/);
assert.match(completedMessage, /✅ Верно: 18 · ❌ Ошибок: 2 · из них таймаутов: 1/);
assert.match(completedMessage, /Точность: 90%/);
assert.match(completedMessage, /Время: 02:00 · среднее на ответ: 00:06/);
assert.match(completedMessage, /По сложности/);
assert.match(completedMessage, /Базовый: 5\/5 · 100%/);
assert.match(completedMessage, /Средний: 9\/10 · 90%/);
assert.match(completedMessage, /Сложный: 4\/5 · 80%/);
assert.doesNotMatch(completedMessage, /Экспертный:/);
assert.match(completedMessage, /Слабые темы/);
assert.match(completedMessage, /Linux &amp; shell — 2/);
assert.match(completedMessage, /Дата теста: 15\.11\.2023 · 01:13 МСК/);
assert.match(completedMessage, /<code>#ATTEMPT1<\/code>/);
assert.doesNotMatch(completedMessage, /банк|\/ COMPLETED-/i);
assert.doesNotMatch(completedMessage, /tg-spoiler/);

const boundaryCompletedMessage = completedTelegramMessage({
  attemptId: 'boundary-summary-87654321',
  candidateName: '<&>'.repeat(100),
  verdict: 'REVIEW',
  score: 25,
  baseMaxScore: 50,
  scorePercent: 50,
  correctCount: 10,
  wrongCount: 10,
  answeredCount: 20,
  accuracy: 50,
  timeoutCount: 3,
  durationSeconds: 600,
  averageAnswerSeconds: 30,
  completedAt: 1_700_000_000_000,
  difficultyStats: [
    { difficulty: 'easy', correctCount: 3, answeredCount: 5, accuracy: 60 },
    { difficulty: 'medium', correctCount: 4, answeredCount: 7, accuracy: 57 },
    { difficulty: 'hard', correctCount: 3, answeredCount: 7, accuracy: 43 },
    { difficulty: 'expert', correctCount: 0, answeredCount: 1, accuracy: 0 },
  ],
  topicErrors: Array.from({ length: 10 }, (_, index) => ({
    topic: `${index}-${'<&>'.repeat(2_000)}`,
    count: 10 - index,
  })),
});
assert.ok(
  telegramVisibleTextLength(boundaryCompletedMessage, 'HTML') <= TELEGRAM_MESSAGE_VISIBLE_LIMIT,
);
assert.match(boundaryCompletedMessage, /…/);
assert.match(boundaryCompletedMessage, /ещё тем: 5/);
assert.match(boundaryCompletedMessage, /<code>#87654321<\/code>$/);

const abortedMessage = abortedTelegramMessage({
  attemptId: 'attempt-1',
  candidateName: 'Анна Петрова',
  score: 3,
  baseMaxScore: 50,
  answeredCount: 4,
  minimumQuestions: 20,
  durationSeconds: 75,
  abortedAt: 1_700_000_000_000,
});
assert.match(abortedMessage, /Тестирование прервано/);
assert.match(abortedMessage, /Пройдено: <b>4 из 20<\/b>/);

assert.equal(normalizeTelegramReportMode(undefined), 'progress_errors');
assert.equal(normalizeTelegramReportMode('ALL_ANSWERS'), 'all_answers');
assert.equal(telegramReportPolicy('summary').createProgressCard, false);
assert.equal(telegramReportPolicy('progress_errors').sendAnswer(true), false);
assert.equal(telegramReportPolicy('progress_errors').sendAnswer(false), true);
assert.equal(telegramReportPolicy('all_answers').sendAnswer(true), true);

console.log('telegram client tests: PASS');
