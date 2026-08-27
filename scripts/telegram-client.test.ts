import assert from 'node:assert/strict';
import { sendTelegramMessage } from '../lib/telegram-client.ts';
import { answerTelegramMessage, completedTelegramMessage } from '../lib/telegram-messages.ts';

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

const success = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(200, { ok: true, result: { message_id: 17 } }),
);
assert.deepEqual(success, { ok: true, messageId: 17 });

const limited = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(429, { ok: false, error_code: 429, parameters: { retry_after: 7 } }),
);
assert.deepEqual(limited, { ok: false, code: 'telegram_429', retryable: true, retryAfterMs: 7_000 });

const badRequest = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(400, { ok: false, error_code: 400 }),
);
assert.deepEqual(badRequest, { ok: false, code: 'telegram_400', retryable: false });

const unauthorized = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(401, { ok: false, error_code: 401 }),
);
assert.deepEqual(unauthorized, { ok: false, code: 'telegram_401', retryable: false });

const forbidden = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(403, { ok: false, error_code: 403 }),
);
assert.deepEqual(forbidden, { ok: false, code: 'telegram_403', retryable: false });

const serverError = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => response(503, { ok: false, error_code: 503 }),
);
assert.deepEqual(serverError, { ok: false, code: 'telegram_503', retryable: true });

const networkError = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => { throw new Error('private transport detail'); },
);
assert.deepEqual(networkError, { ok: false, code: 'telegram_network', retryable: true });

const timeoutError = await sendTelegramMessage(
  credentials,
  'Проверка',
  async () => { throw new DOMException('Timed out', 'AbortError'); },
);
assert.deepEqual(timeoutError, { ok: false, code: 'telegram_timeout', retryable: true });

const answerMessage = answerTelegramMessage({
  eventId: 'answer-attempt-7',
  attemptId: 'attempt-1',
  candidateName: 'Анна Петрова',
  position: 1,
  difficulty: 'medium',
  weight: 2,
  prompt: 'Что проверяет тест?',
  selectedAnswer: 'Логику',
  correctAnswer: 'Логику',
  correct: true,
  timedOut: false,
  questionElapsedSeconds: 12,
  totalRemainingSeconds: 540,
});
assert.match(answerMessage, /Анна Петрова/);
assert.match(answerMessage, /Правильный ответ: Логику/);
assert.match(answerMessage, /✅ Верно/);

const completedMessage = completedTelegramMessage({
  eventId: 'completed-attempt-1',
  attemptId: 'attempt-1',
  candidateName: 'Анна Петрова',
  verdict: 'PASS',
  score: 14,
  baseMaxScore: 14,
  scorePercent: 100,
  correctCount: 6,
  wrongCount: 0,
  answeredCount: 6,
  accuracy: 100,
  durationSeconds: 120,
  bankRevision: 'abcdef1234567890',
  completedAt: 1_700_000_000_000,
});
assert.match(completedMessage, /Рекомендован/);
assert.match(completedMessage, /14\/14/);

console.log('telegram client tests: PASS');
