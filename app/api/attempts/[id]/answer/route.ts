import { NextResponse } from 'next/server';
import {
  AttemptQuestionConflictError,
  InvalidChoiceError,
  PrematureTimeoutError,
  processAttemptAnswer,
} from '@/db/attempt-engine';
import { attemptPayload, ensureSchema, verifyAttempt } from '@/db/runtime';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const body = (await request.json()) as { questionId?: number; choiceIndex?: number | null };
    const attempt = await verifyAttempt(id, bearerToken(request));
    if (!attempt) {
      return NextResponse.json(
        { error: 'Попытка не найдена.' },
        { status: 404, headers: NO_STORE },
      );
    }
    if (attempt.status === 'completed') {
      return NextResponse.json(await attemptPayload(attempt), { headers: NO_STORE });
    }
    if (!Number.isInteger(body.questionId) || body.choiceIndex === undefined) {
      return NextResponse.json(
        { error: 'Некорректный ответ.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const updated = await processAttemptAnswer(
      attempt,
      body.questionId as number,
      body.choiceIndex,
    );
    return NextResponse.json(await attemptPayload(updated), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof InvalidChoiceError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    if (error instanceof AttemptQuestionConflictError || error instanceof PrematureTimeoutError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: NO_STORE });
    }
    console.error('answer_failed');
    return NextResponse.json(
      { error: 'Не удалось сохранить ответ.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
