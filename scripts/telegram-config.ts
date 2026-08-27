import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type TelegramFileConfig = {
  botToken: string;
  chatId: string;
};

const BOT_TOKEN_PATTERN = /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{20,64}(?![A-Za-z0-9_-])/g;
const GROUP_CHAT_PATTERN = /(?<!\d)-100\d{6,20}(?!\d)/g;

export class TelegramConfigError extends Error {
  readonly code: 'missing' | 'invalid';

  constructor(code: 'missing' | 'invalid') {
    super(code === 'missing' ? 'Telegram config file is missing.' : 'Telegram config file is invalid.');
    this.name = 'TelegramConfigError';
    this.code = code;
  }
}

export function parseTelegramConfig(contents: string): TelegramFileConfig {
  const tokenMatches = [...contents.matchAll(BOT_TOKEN_PATTERN)].map((match) => match[0]);
  const chatMatches = [...contents.matchAll(GROUP_CHAT_PATTERN)].map((match) => match[0]);

  if (tokenMatches.length !== 1 || chatMatches.length !== 1) {
    throw new TelegramConfigError('invalid');
  }

  return {
    botToken: tokenMatches[0],
    chatId: chatMatches[0],
  };
}

export async function loadTelegramConfig(
  filePath = path.resolve(process.cwd(), 'tg_token.txt'),
): Promise<TelegramFileConfig> {
  try {
    return parseTelegramConfig(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof TelegramConfigError) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') throw new TelegramConfigError('missing');
    throw new TelegramConfigError('invalid');
  }
}
