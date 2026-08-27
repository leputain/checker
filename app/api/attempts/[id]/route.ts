import { NextResponse } from 'next/server';
import { settleExpiredAttempt } from '@/db/attempt-engine';
import { attemptPayload, ensureSchema, verifyAttempt } from '@/db/runtime';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const attempt = await verifyAttempt(id, bearerToken(request));
    if (!attempt) {
      return NextResponse.json(
        { error: 'Попытка не найдена.' },
        { status: 404, headers: NO_STORE },
      );
    }
    const current = await settleExpiredAttempt(attempt);
    return NextResponse.json(await attemptPayload(current), { headers: NO_STORE });
  } catch {
    console.error('attempt_restore_failed');
    return NextResponse.json(
      { error: 'Не удалось восстановить попытку.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
