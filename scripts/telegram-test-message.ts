import { sendTelegramMessage } from '../lib/telegram-client.ts';
import { loadTelegramConfig, TelegramConfigError } from './telegram-config.ts';

try {
  const config = await loadTelegramConfig();
  const result = await sendTelegramMessage(
    { botToken: config.botToken, chatId: config.chatId },
    {
      text: `Candidate Check · проверка связи\nОбезличенное тестовое сообщение\n${new Date().toISOString()}`,
    },
  );
  if (!result.ok) throw new Error(result.code);
  console.log('Telegram test message: SENT');
} catch (error) {
  const code = error instanceof TelegramConfigError ? error.code : 'delivery_failed';
  console.error(`Telegram test message: FAILED (${code})`);
  process.exitCode = 1;
}
