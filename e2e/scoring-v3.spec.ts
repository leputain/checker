import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { queryLocalD1, runWrangler } from '../scripts/local-d1.ts';
import { LEGACY_V2_BALANCED_TEST_CONFIG_ID, LEGACY_V2_TEST_CONFIG_ID } from '../lib/test-config.ts';

// All D1 operations are explicitly local and use the disposable E2E state.
const E2E_STATE_PATH = path.resolve('.wrangler', 'e2e');
const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/iu;

type Payload = {
  attemptId: string;
  status: 'active' | 'completed';
  model: { scoringVersion: number };
  question?: {
    id: number; choices: string[]; difficulty: string;
    questionKind: 'base' | 'additional'; scoreValue: number;
  };
  result?: {
    score: number; verdict: string; baseCorrectCount: number;
    additionalCorrectCount: number; scoringVersion: number;
    scoreBreakdown?: { earnedBase: number; earnedAdditional: number; totalPenalty: number; netScore: number };
  };
};

type Session = { id: string; token: string; payload: Payload; correctChoices: Map<number, string> };

function validId(id: string) {
  if (!ATTEMPT_ID_PATTERN.test(id)) throw new Error('Unexpected E2E attempt id.');
  return id;
}

function execute(sql: string) {
  runWrangler(['d1', 'execute', 'DB', '--command', sql], E2E_STATE_PATH);
}

function cleanup(id: string) {
  if (!id) return;
  validId(id);
  execute(`DELETE FROM answers WHERE attempt_id = '${id}';
    DELETE FROM attempt_questions WHERE attempt_id = '${id}';
    DELETE FROM telegram_outbox WHERE attempt_id = '${id}';
    DELETE FROM attempts WHERE id = '${id}';`);
}

async function start(request: APIRequestContext): Promise<Session> {
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const response = await request.post('/api/attempts', {
    data: { name: `E2E scoring ${startKey}`, startKey, token },
    headers: { 'Idempotency-Key': startKey },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as Payload;
  const id = validId(payload.attemptId);
  const rows = queryLocalD1<{ id: number; correctChoice: string }>(`
    SELECT q.id, json_extract(q.choices_json, '$[' || q.correct_index || ']') AS correctChoice
    FROM questions q JOIN question_bank_revision_items ri ON ri.question_id = q.id
    JOIN attempts a ON a.bank_revision = ri.revision_hash
    WHERE a.id = '${id}' AND ri.active = 1`, E2E_STATE_PATH);
  return { id, token, payload, correctChoices: new Map(rows.map((row) => [row.id, row.correctChoice])) };
}

function answerBody(session: Session, correct: boolean) {
  const question = session.payload.question;
  if (!question) throw new Error('No active E2E question.');
  const correctChoice = session.correctChoices.get(question.id);
  const correctIndex = question.choices.indexOf(correctChoice ?? '');
  expect(correctIndex).toBeGreaterThanOrEqual(0);
  return {
    questionId: question.id,
    choiceIndex: correct ? correctIndex : (correctIndex + 1) % question.choices.length,
  };
}

async function answer(request: APIRequestContext, session: Session, correct: boolean) {
  const response = await request.post(`/api/attempts/${session.id}/answer`, {
    data: answerBody(session, correct), headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(response.status()).toBe(200);
  session.payload = await response.json() as Payload;
  return session.payload;
}

async function finishFiveMediumErrors(request: APIRequestContext, session: Session) {
  let mistakes = 0;
  for (let submitted = 0; session.payload.status === 'active'; submitted += 1) {
    expect(submitted).toBeLessThan(30);
    const question = session.payload.question!;
    const wrong = question.questionKind === 'base' && question.difficulty === 'medium' && mistakes < 5;
    if (wrong) mistakes += 1;
    await answer(request, session, !wrong);
  }
  expect(mistakes).toBe(5);
  return session.payload.result!;
}

async function restoreResult(page: Page, session: Session) {
  await page.goto('/');
  await page.evaluate((saved) => localStorage.setItem('candidate-check:active-attempt', JSON.stringify(saved)), {
    version: 2, phase: 'active', attemptId: session.id, token: session.token,
    expiresAt: Date.now() + 60_000,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Результат готов.' })).toBeVisible();
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API integration and scoring rules do not depend on orientation.');
  test.setTimeout(120_000);
});

test('v3: 15 верных основных и 5 восстановлений дают 80 и REVIEW', async ({ request, page }) => {
  let id = '';
  try {
    await page.goto('/');
    await expect(page.locator('.scoring-rules')).toContainText('17');
    const session = await start(request);
    id = session.id;
    expect(session.payload.model.scoringVersion).toBe(3);
    const result = await finishFiveMediumErrors(request, session);
    expect(result).toMatchObject({ score: 80, verdict: 'REVIEW', baseCorrectCount: 15,
      additionalCorrectCount: 5, scoringVersion: 3 });
    expect(result.scoreBreakdown).toMatchObject({ earnedBase: 80, earnedAdditional: 10,
      totalPenalty: 10, netScore: 80 });
    const ledger = queryLocalD1<{ earned: number; penalty: number; answers: number }>(`
      SELECT SUM(awarded_score) AS earned, SUM(penalty_score) AS penalty, COUNT(*) AS answers
      FROM answers WHERE attempt_id = '${id}'`, E2E_STATE_PATH)[0];
    expect(ledger).toEqual({ earned: 90, penalty: 10, answers: 25 });
    await restoreResult(page, session);
    const formula = page.locator('.result-scoring');
    await expect(formula).toContainText('Основные 80');
    await expect(formula).toContainText('дополнительные 10');
    await expect(formula).toContainText('штрафы 10');
    await expect(formula).toContainText('итог 80');
    await expect(formula).toContainText('Баллов достаточно, но верных основных ответов — 15');
  } finally {
    await page.goto('about:blank');
    cleanup(id);
  }
});

test('v3: первый штраф сохраняется у нуля, повтор ответа не удваивает штраф', async ({ request }) => {
  let id = '';
  try {
    const session = await start(request);
    id = session.id;
    const first = session.payload.question!;
    const body = answerBody(session, false);
    const url = `/api/attempts/${id}/answer`;
    const duplicates = await Promise.all([1, 2].map(() => request.post(url, {
      data: body, headers: { Authorization: `Bearer ${session.token}` },
    })));
    for (const response of duplicates) expect(response.status()).toBe(200);
    session.payload = await duplicates[0].json() as Payload;
    const early = queryLocalD1<{ score: number; penalty: number; answers: number; additional: number }>(`
      SELECT score,
        (SELECT SUM(penalty_score) FROM answers WHERE attempt_id = attempts.id) AS penalty,
        (SELECT COUNT(*) FROM answers WHERE attempt_id = attempts.id) AS answers,
        (SELECT COUNT(*) FROM attempt_questions WHERE attempt_id = attempts.id
          AND source_question_id = ${first.id}) AS additional
      FROM attempts WHERE id = '${id}'`, E2E_STATE_PATH)[0];
    expect(early).toEqual({ score: 0, penalty: first.scoreValue / 2, answers: 1, additional: 1 });
    const secondValue = session.payload.question!.scoreValue;
    await answer(request, session, true);
    const afterPositive = queryLocalD1<{ score: number }>(`
      SELECT score FROM attempts WHERE id = '${id}'`, E2E_STATE_PATH)[0];
    expect(afterPositive.score).toBe(Math.max(0, secondValue - first.scoreValue / 2));
    for (let submitted = 0; session.payload.status === 'active'; submitted += 1) {
      expect(submitted).toBeLessThan(30);
      await answer(request, session, true);
    }
    expect(session.payload.result?.score).toBe(100 - first.scoreValue);
    expect(session.payload.result?.baseCorrectCount).toBe(19);
  } finally {
    cleanup(id);
  }
});

test('v2: активная попытка продолжается по старым правилам, завершённые 90 не пересчитываются', async ({ request, page }) => {
  let id = '';
  try {
    const session = await start(request);
    id = session.id;
    execute(`UPDATE attempts SET scoring_version = 2,
      test_config_id = CASE WHEN selection_version = 2 THEN '${LEGACY_V2_BALANCED_TEST_CONFIG_ID}'
        ELSE '${LEGACY_V2_TEST_CONFIG_ID}' END WHERE id = '${id}';`);
    const restored = await request.get(`/api/attempts/${id}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(restored.status()).toBe(200);
    session.payload = await restored.json() as Payload;
    expect(session.payload.model.scoringVersion).toBe(2);
    const result = await finishFiveMediumErrors(request, session);
    expect(result).toMatchObject({ score: 90, verdict: 'PASS', baseCorrectCount: 15,
      additionalCorrectCount: 5, scoringVersion: 2 });
    expect(result.scoreBreakdown).toBeUndefined();
    const ledger = queryLocalD1<{ penalties: number }>(`
      SELECT SUM(penalty_score) AS penalties FROM answers WHERE attempt_id = '${id}'`, E2E_STATE_PATH)[0];
    expect(ledger.penalties).toBe(0);
    const before = queryLocalD1<Record<string, unknown>>(`SELECT score, verdict, correct_count,
      wrong_count, scoring_version, test_config_id FROM attempts WHERE id = '${id}'`, E2E_STATE_PATH);
    const completed = await request.get(`/api/attempts/${id}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    expect(completed.status()).toBe(200);
    expect((await completed.json()).result).toMatchObject({ score: 90, verdict: 'PASS', scoringVersion: 2 });
    await restoreResult(page, session);
    await expect(page.locator('.result-scoring')).toHaveText('Оценка по прежним правилам: без штрафов за ошибки.');
    await expect(page.getByText('Для рекомендации: не менее 80 баллов и 17 верных основных ответов', { exact: false })).toHaveCount(0);
    expect(queryLocalD1(`SELECT score, verdict, correct_count, wrong_count, scoring_version,
      test_config_id FROM attempts WHERE id = '${id}'`, E2E_STATE_PATH)).toEqual(before);
  } finally {
    await page.goto('about:blank');
    cleanup(id);
  }
});
