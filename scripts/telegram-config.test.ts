import assert from 'node:assert/strict';
import { isTelegramRuntimeConfigReady } from '../lib/telegram-runtime-config.ts';
import { parseTelegramConfig, TelegramConfigError } from './telegram-config.ts';

const token = `${'1'.repeat(10)}:${'A'.repeat(35)}`;
const chatId = `-100${'2'.repeat(10)}`;
assert.deepEqual(
  parseTelegramConfig(`Токен бота: ${token}\nГруппа для отчётов ${chatId}`),
  { botToken: token, chatId },
);
assert.throws(
  () => parseTelegramConfig(`Токен: ${token}\nПовтор: ${'3'.repeat(10)}:${'B'.repeat(35)}\n${chatId}`),
  TelegramConfigError,
);
assert.throws(
  () => parseTelegramConfig(`Токен: ${token}\nПовтор того же токена: ${token}\n${chatId}`),
  TelegramConfigError,
);
assert.throws(
  () => parseTelegramConfig(`Токен: ${token}\nГруппа: ${chatId}\nПовтор группы: ${chatId}`),
  TelegramConfigError,
);
assert.throws(() => parseTelegramConfig(`Токен: ${token}`), TelegramConfigError);
assert.equal(isTelegramRuntimeConfigReady({ status: 'ready', botToken: token, chatId }), true);
assert.equal(isTelegramRuntimeConfigReady({ status: 'missing', botToken: token, chatId }), false);
assert.equal(isTelegramRuntimeConfigReady({ status: 'invalid', botToken: token, chatId }), false);
assert.equal(
  isTelegramRuntimeConfigReady({ status: 'ready', botToken: `bot${token}`, chatId }),
  false,
);
assert.equal(
  isTelegramRuntimeConfigReady({ status: 'ready', botToken: token, chatId: chatId.slice(1) }),
  false,
);
console.log('telegram config tests: PASS');
