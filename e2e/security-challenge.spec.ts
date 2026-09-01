import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { runWrangler } from '../scripts/local-d1.ts';

const E2E_STATE_PATH = path.resolve('.wrangler', 'e2e');
const ADMIN_PIN = readFileSync(path.resolve('.data', 'e2e-admin-pin.txt'), 'utf8').trim();
const ID_PATTERN = /^[0-9a-f-]{36}$/iu;

type StartedChallenge = {
  attemptId: string;
  status: 'active';
  question: {
    id: number;
    ordinal: number;
    choices: string[];
    difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  };
  result?: unknown;
};

function token() {
  return randomBytes(32).toString('base64url');
}

function cleanup(attemptId: string) {
  if (!ID_PATTERN.test(attemptId)) throw new Error('Unexpected challenge attempt id.');
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `DELETE FROM security_challenge_feedback WHERE attempt_id = '${attemptId}';
     DELETE FROM security_challenge_question_events WHERE attempt_id = '${attemptId}';
     DELETE FROM security_challenge_attempts WHERE id = '${attemptId}';`,
  ], E2E_STATE_PATH);
}

async function start(request: APIRequestContext, nickname: string) {
  const attemptToken = token();
  const response = await request.post('/api/challenges/infosec/attempts', {
    data: { nickname, startKey: randomUUID(), token: attemptToken },
  });
  expect(response.status()).toBe(201);
  return { payload: await response.json() as StartedChallenge, token: attemptToken };
}

test('ИБ-челлендж проходит demo, ответ и ручное завершение без штрафа текущего вопроса', async ({ page }) => {
  let attemptId = '';
  try {
    await page.goto('/challenge');
    await expect(page.getByRole('heading', { name: /Пятнадцать минут/u })).toBeVisible();
    await page.getByRole('textbox', { name: 'Ник' }).fill(`e2e-ui-${Date.now()}`);
    await page.getByRole('button', { name: 'Пройти демо-вопрос' }).click();
    await page.getByText('Изолировать узел, сохранить артефакты и начать проверку').click();
    await page.getByRole('button', { name: 'Проверить демо-ответ' }).click();
    const startResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/challenges/infosec/attempts'
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Запустить челлендж' }).click();
    const started = await (await startResponse).json() as StartedChallenge;
    attemptId = started.attemptId;
    await expect(page.getByText('Вопрос 1', { exact: true })).toBeVisible();
    await page.getByRole('group', { name: 'Варианты ответа' }).locator('label').first().click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Вопрос 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Завершить тест' }).click();
    const dialog = page.getByRole('dialog', { name: 'Закончить попытку сейчас?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Результат сохранён' })).toBeVisible();
    await expect(page.getByText('Не учитывался', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Разбор ответов' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await page.goto('about:blank').catch(() => undefined);
    if (attemptId) cleanup(attemptId);
  }
});

test('API не раскрывает результат до конца и учитывает timeout ровно один раз', async ({ request }) => {
  const { payload, token: attemptToken } = await start(request, `e2e-api-${Date.now()}`);
  try {
    expect(payload.result).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('correctIndex');
    const premature = await request.post(`/api/challenges/infosec/attempts/${payload.attemptId}/answer`, {
      headers: { Authorization: `Bearer ${attemptToken}` },
      data: { questionId: payload.question.id, choiceIndex: null },
    });
    expect(premature.status()).toBe(409);
    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `UPDATE security_challenge_attempts SET question_deadline_at = 1
       WHERE id = '${payload.attemptId}';`,
    ], E2E_STATE_PATH);
    const timeout = await request.post(`/api/challenges/infosec/attempts/${payload.attemptId}/answer`, {
      headers: { Authorization: `Bearer ${attemptToken}` },
      data: { questionId: payload.question.id, choiceIndex: null },
    });
    expect(timeout.ok()).toBe(true);
    const afterTimeout = await timeout.json() as StartedChallenge;
    expect(afterTimeout.status).toBe('active');
    expect(afterTimeout.question.ordinal).toBe(2);
    const finish = await request.post(`/api/challenges/infosec/attempts/${payload.attemptId}/finish`, {
      headers: { Authorization: `Bearer ${attemptToken}` }, data: {},
    });
    const completed = await finish.json() as { result: { timeoutCount: number; resolvedCount: number } };
    expect(completed.result.timeoutCount).toBe(1);
    expect(completed.result.resolvedCount).toBe(1);
  } finally {
    cleanup(payload.attemptId);
  }
});

test('первые десять вопросов соблюдают цикл 3/3/3/1 и не повторяются', async ({ request }) => {
  const { payload: initial, token: attemptToken } = await start(request, `e2e-cycle-${Date.now()}`);
  let current = initial;
  const ids: number[] = [];
  const difficulties: string[] = [];
  try {
    for (let index = 0; index < 10; index += 1) {
      ids.push(current.question.id);
      difficulties.push(current.question.difficulty);
      const response = await request.post(`/api/challenges/infosec/attempts/${initial.attemptId}/answer`, {
        headers: { Authorization: `Bearer ${attemptToken}` },
        data: { questionId: current.question.id, choiceIndex: 0 },
      });
      expect(response.ok()).toBe(true);
      current = await response.json() as StartedChallenge;
      expect(current.result).toBeUndefined();
    }
    expect(new Set(ids).size).toBe(10);
    expect(difficulties.filter((value) => value === 'easy')).toHaveLength(3);
    expect(difficulties.filter((value) => value === 'medium')).toHaveLength(3);
    expect(difficulties.filter((value) => value === 'hard')).toHaveLength(3);
    expect(difficulties.filter((value) => value === 'expert')).toHaveLength(1);
    const finish = await request.post(`/api/challenges/infosec/attempts/${initial.attemptId}/finish`, {
      headers: { Authorization: `Bearer ${attemptToken}` }, data: {},
    });
    const completed = await finish.json() as { result: { eligibleForLeaderboard: boolean } };
    expect(completed.result.eligibleForLeaderboard).toBe(true);
  } finally {
    cleanup(initial.attemptId);
  }
});

test('answer/finish race оставляет один terminal-результат без двойного ответа', async ({ request }) => {
  const { payload, token: attemptToken } = await start(request, `e2e-race-${Date.now()}`);
  try {
    const headers = { Authorization: `Bearer ${attemptToken}` };
    await Promise.all([
      request.post(`/api/challenges/infosec/attempts/${payload.attemptId}/answer`, {
        headers, data: { questionId: payload.question.id, choiceIndex: 0 },
      }),
      request.post(`/api/challenges/infosec/attempts/${payload.attemptId}/finish`, {
        headers, data: {},
      }),
    ]);
    const restored = await request.get(`/api/challenges/infosec/attempts/${payload.attemptId}`, {
      headers,
    });
    const completed = await restored.json() as {
      status: string;
      result: { resolvedCount: number; correctCount: number; incorrectCount: number; timeoutCount: number };
    };
    expect(completed.status).toBe('completed');
    expect(completed.result.resolvedCount).toBeLessThanOrEqual(1);
    expect(completed.result.correctCount + completed.result.incorrectCount + completed.result.timeoutCount)
      .toBe(completed.result.resolvedCount);
  } finally {
    cleanup(payload.attemptId);
  }
});

test('admin показывает отдельную аналитику ИБ-челленджа', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('PIN администратора').fill(ADMIN_PIN);
  await page.getByRole('button', { name: 'Открыть аналитику' }).click();
  await expect(page).toHaveURL(/\/admin\/analytics$/u);
  await page.getByRole('tab', { name: 'ИБ-челлендж' }).click();
  await expect(page.getByRole('heading', { name: 'ИБ-челлендж' })).toBeVisible();
  await expect(page.getByText('First exposure не искажён повторными попытками')).toBeVisible();
});
