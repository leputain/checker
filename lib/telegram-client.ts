export type TelegramCredentials = {
  botToken: string;
  chatId: string;
};

export type TelegramDeliveryMethod = 'send' | 'edit_root' | 'reply_root';

export type TelegramMessageRequest = {
  text: string;
  deliveryMethod?: TelegramDeliveryMethod;
  parseMode?: 'HTML';
  silent?: boolean;
  rootMessageId?: number | null;
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
  result?: { message_id?: number } | boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

export async function sendTelegramMessage(
  credentials: TelegramCredentials,
  request: TelegramMessageRequest,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<TelegramSendResult> {
  const deliveryMethod = request.deliveryMethod ?? 'send';
  if (request.text.length === 0 || request.text.length > 4_096) {
    return { ok: false, code: 'telegram_payload_invalid', retryable: false };
  }
  if (deliveryMethod !== 'send' && !Number.isInteger(request.rootMessageId)) {
    return { ok: false, code: 'telegram_root_missing', retryable: false };
  }

  const method = deliveryMethod === 'edit_root' ? 'editMessageText' : 'sendMessage';
  const body: Record<string, unknown> = {
    chat_id: credentials.chatId,
    text: request.text,
  };
  if (request.parseMode) body.parse_mode = request.parseMode;
  if (deliveryMethod === 'edit_root') {
    body.message_id = request.rootMessageId;
  } else {
    body.protect_content = true;
    body.disable_notification = request.silent ?? false;
    if (deliveryMethod === 'reply_root') {
      body.reply_parameters = { message_id: request.rootMessageId };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(
      `https://api.telegram.org/bot${credentials.botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => ({})) as TelegramApiResponse;
    const responseMessageId = typeof payload.result === 'object'
      ? payload.result?.message_id
      : undefined;
    if (response.ok && payload.ok) {
      const messageId = Number.isInteger(responseMessageId)
        ? responseMessageId!
        : request.rootMessageId;
      if (Number.isInteger(messageId)) return { ok: true, messageId: messageId! };
    }

    const status = payload.error_code ?? response.status;
    if (
      status === 400 &&
      deliveryMethod === 'edit_root' &&
      payload.description?.toLowerCase().includes('message is not modified')
    ) {
      return { ok: true, messageId: request.rootMessageId! };
    }
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
