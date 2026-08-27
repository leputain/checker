import { NextResponse } from 'next/server';
import { telegramReadiness } from '@/db/telegram-outbox';
import {
  CURRENT_SCHEMA_VERSION,
  currentSchemaVersion,
  database,
  ensureQuestionBankReady,
  ensureSchema,
} from '@/db/runtime';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  try {
    await ensureSchema();
    await database().prepare('SELECT 1').first();
    if ((await currentSchemaVersion()) !== CURRENT_SCHEMA_VERSION) {
      return NextResponse.json(
        { status: 'unavailable', code: 'schema_outdated' },
        { status: 503, headers: NO_STORE },
      );
    }
    await ensureQuestionBankReady();
    const telegram = await telegramReadiness();
    if (!telegram.ready) {
      return NextResponse.json(
        { status: 'unavailable', code: telegram.code ?? 'telegram_misconfigured' },
        { status: 503, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { status: 'ready', telegram: telegram.status },
      { headers: NO_STORE },
    );
  } catch (error) {
    const code = error instanceof Error && error.name.includes('QuestionBank')
      ? 'bank_invalid'
      : 'database_unavailable';
    return NextResponse.json(
      { status: 'unavailable', code },
      { status: 503, headers: NO_STORE },
    );
  }
}
