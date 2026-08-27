import { NextResponse } from 'next/server';
import { flushAttemptNotifications } from '@/db/telegram-outbox';
import { ensureSchema, verifyAttempt } from '@/db/runtime';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    if (!(await verifyAttempt(id, bearerToken(request)))) {
      return NextResponse.json(
        { error: 'Попытка не найдена.' },
        { status: 404, headers: NO_STORE },
      );
    }
    const state = await flushAttemptNotifications(id);
    const retryAfterMs = state.pending && state.nextAttemptAt
      ? Math.max(1_000, state.nextAttemptAt - Date.now())
      : null;
    return NextResponse.json(
      { accepted: true, pending: state.pending, retryAfterMs },
      { status: 202, headers: NO_STORE },
    );
  } catch {
    console.error('telegram_flush_failed');
    return NextResponse.json(
      { accepted: true, pending: true, retryAfterMs: 5_000 },
      { status: 202, headers: NO_STORE },
    );
  }
}
