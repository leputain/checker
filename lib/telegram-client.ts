export type TelegramCredentials = {
  botToken: string;
  chatId: string;
};

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | {
      ok: false;
      code: string;
      retryable: boolean;
      retryAfterMs?: number;
    };

type TelegramApiResponse = {
  ok?: boolean;
  result?: { message_id?: number };
  error_code?: number;
  parameters?: { retry_after?: number };
};

export async function sendTelegramMessage(
  credentials: TelegramCredentials,
  text: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<TelegramSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(
      `https://api.telegram.org/bot${credentials.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: credentials.chatId,
          text: text.slice(0, 4_096),
          protect_content: true,
        }),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => ({})) as TelegramApiResponse;
    if (response.ok && payload.ok && Number.isInteger(payload.result?.message_id)) {
      return { ok: true, messageId: payload.result!.message_id! };
    }

    const status = payload.error_code ?? response.status;
    if (status === 429) {
      const retryAfter = Math.max(1, payload.parameters?.retry_after ?? 5);
      return { ok: false, code: 'telegram_429', retryable: true, retryAfterMs: retryAfter * 1_000 };
    }
    if (status === 400 || status === 401 || status === 403) {
      return { ok: false, code: `telegram_${status}`, retryable: false };
    }
    return {
      ok: false,
      code: `telegram_${status || 'unknown'}`,
      retryable: status >= 500 || status === 408 || status === 0,
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof DOMException && error.name === 'AbortError'
        ? 'telegram_timeout'
        : 'telegram_network',
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
