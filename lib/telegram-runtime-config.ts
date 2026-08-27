export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{8,12}:[A-Za-z0-9_-]{20,64}$/;
export const TELEGRAM_GROUP_CHAT_PATTERN = /^-100\d{6,20}$/;

export function isTelegramRuntimeConfigReady(input: {
  status?: string;
  botToken: string;
  chatId: string;
}) {
  return (
    input.status?.trim().toLowerCase() === 'ready' &&
    TELEGRAM_BOT_TOKEN_PATTERN.test(input.botToken) &&
    TELEGRAM_GROUP_CHAT_PATTERN.test(input.chatId)
  );
}
