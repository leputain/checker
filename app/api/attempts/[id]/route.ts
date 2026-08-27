import { NextResponse } from 'next/server';
import { attemptPayload, ensureDatabase, verifyAttempt } from '@/db/runtime';

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    const { id } = await context.params;
    const attempt = await verifyAttempt(id, bearerToken(request));
    if (!attempt) {
      return NextResponse.json({ error: 'Попытка не найдена.' }, { status: 404 });
    }
    return NextResponse.json(await attemptPayload(attempt));
  } catch (error) {
    console.error('attempt_restore_failed', error);
    return NextResponse.json({ error: 'Не удалось восстановить попытку.' }, { status: 500 });
  }
}
