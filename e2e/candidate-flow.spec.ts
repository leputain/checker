import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { queryLocalD1, runWrangler } from '../scripts/local-d1.ts';

const E2E_STATE_PATH = path.resolve('.wrangler', 'e2e');
const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

type StartedAttempt = {
  attemptId: string;
  question: { id: number };
};

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

async function startCandidate(page: Page, suffix: string) {
  await page.goto('/');
  await expect(page.getByText('Система готова', { exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/attempts' && response.request().method() === 'POST';
  });
  await page.getByRole('textbox', { name: 'Имя и фамилия' }).fill(`E2E ${suffix}`);
  await page.getByRole('button', { name: 'Начать тест' }).click();
  const started = await (await responsePromise).json() as StartedAttempt;
  await expect(page.getByRole('group', { name: 'Варианты ответа' })).toBeVisible();
  return started;
}

function cleanupAttempt(attemptId: string) {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('Unexpected attempt id in E2E cleanup.');
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `DELETE FROM answers WHERE attempt_id = '${attemptId}';
     DELETE FROM telegram_outbox WHERE attempt_id = '${attemptId}';
     DELETE FROM attempts WHERE id = '${attemptId}';`,
  ], E2E_STATE_PATH);
}

async function stopAndCleanup(page: Page, attemptId: string) {
  await page.goto('about:blank').catch(() => undefined);
  if (attemptId) cleanupAttempt(attemptId);
}

function correctChoiceForAttempt(attemptId: string) {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('Unexpected attempt id in E2E query.');
  const row = queryLocalD1<{ choicesJson: string; correctIndex: number }>(`
    SELECT questions.choices_json AS choicesJson, questions.correct_index AS correctIndex
    FROM attempts JOIN questions ON questions.id = attempts.current_question_id
    WHERE attempts.id = '${attemptId}'
  `, E2E_STATE_PATH)[0];
  if (!row) throw new Error('Current E2E question was not found.');
  return (JSON.parse(row.choicesJson) as string[])[row.correctIndex];
}

test('таблица лидеров доступна до начала теста', async ({ page }) => {
  await page.goto('/');
  const leaderboardButton = page.getByRole('button', { name: 'Таблица лидеров' });
  await expect(leaderboardButton).toBeVisible();
  await leaderboardButton.click();
  const dialog = page.getByRole('dialog', { name: 'Таблица лидеров' });
  await expect(dialog).toBeVisible();
  await dialog.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(leaderboardButton).toBeFocused();
});

test('полный flow сохраняется после reload и показывает доступный результат', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  let attemptId = '';
  try {
    ({ attemptId } = await startCandidate(page, `${testInfo.project.name} ${Date.now()}`));
    await expectNoHorizontalOverflow(page);

    const firstQuestion = await page.getByRole('heading', { level: 1 }).textContent();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Варианты ответа' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(firstQuestion ?? '');

    for (let step = 0; step < 32; step += 1) {
      const radios = page.getByRole('radio');
      if (await radios.count() === 0) break;
      const previousQuestion = await page.getByRole('heading', { level: 1 }).textContent();
      const correctChoice = correctChoiceForAttempt(attemptId);
      await page.locator('label.answer').filter({
        has: page.getByText(correctChoice, { exact: true }),
      }).click();
      const submit = page.getByRole('button', { name: 'Ответить' });
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect.poll(async () => {
        if (await page.getByRole('radio').count() === 0) return true;
        return (await page.getByRole('heading', { level: 1 }).textContent()) !== previousQuestion;
      }).toBe(true);
      if (await page.getByRole('radio').count() > 0) {
        await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      }
    }

    await expect(page.getByRole('heading', { name: 'Результат готов.' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const actionHeights = await page.locator('.result-actions button').evaluateAll((buttons) => (
      buttons.map((button) => Math.round(button.getBoundingClientRect().height))
    ));
    expect(actionHeights.every((height) => height >= 44)).toBe(true);

    const leaderboardButton = page.getByRole('button', { name: 'Таблица лидеров' });
    await leaderboardButton.click();
    const dialog = page.getByRole('dialog', { name: 'Таблица лидеров' });
    await expect(dialog).toBeVisible();
    await dialog.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Закрыть' })).toBeFocused();
    await dialog.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(leaderboardButton).toBeFocused();
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('offline/reconnect и возврат на экран сохраняют активный вопрос', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Достаточно одного WebKit orientation для сетевого сценария.');
  let attemptId = '';

  try {
    await page.addInitScript(() => {
      const state = window as typeof window & { __wakeLockRequests?: number };
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async () => {
            state.__wakeLockRequests = (state.__wakeLockRequests ?? 0) + 1;
            return { released: false, release: async () => undefined };
          },
        },
      });
    });
    ({ attemptId } = await startCandidate(page, `reconnect ${Date.now()}`));
    const question = await page.getByRole('heading', { level: 1 }).textContent();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __wakeLockRequests?: number }).__wakeLockRequests ?? 0
    ))).toBeGreaterThanOrEqual(1);

    await page.locator('label.answer').first().click();
    await context.setOffline(true);
    await expect(page.getByRole('status')).toContainText('Нет связи.');
    await expect(page.getByRole('button', { name: 'Ответить' })).toBeDisabled();
    await page.route('**/api/health/ready', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'unavailable', code: 'telegram_misconfigured' }),
    }));
    await context.setOffline(false);
    await expect(page.getByRole('status')).toContainText('Текущую попытку можно продолжить.');
    await expect(page.getByRole('button', { name: 'Ответить' })).toBeEnabled();

    await page.evaluate(() => {
      let visibility: DocumentVisibilityState = 'hidden';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __wakeLockRequests?: number }).__wakeLockRequests ?? 0
    ))).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(question ?? '');
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await stopAndCleanup(page, attemptId);
  }
});

test('длинный вопрос прокручивается без горизонтального overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Длинный portrait layout — наиболее жёсткий вариант.');
  const longPrompt = `Длинный вопрос для проверки адаптивной вёрстки: ${'контекст и уточнение '.repeat(10)}`.slice(0, 280);
  let attemptId = '';

  try {
    await page.route('**/api/attempts', async (route) => {
      if (route.request().method() !== 'POST' || !route.request().url().endsWith('/api/attempts')) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      if (body.question) body.question.prompt = longPrompt;
      await route.fulfill({ response, json: body });
    });

    ({ attemptId } = await startCandidate(page, `long ${Date.now()}`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(longPrompt);
    await expectNoHorizontalOverflow(page);
    const overflowY = await page.locator('body').evaluate((body) => getComputedStyle(body).overflowY);
    expect(overflowY).not.toBe('hidden');
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('кандидат может окончательно прервать активный тест', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Серверная логика прерывания не зависит от orientation.');
  let attemptId = '';

  try {
    ({ attemptId } = await startCandidate(page, `abort ${Date.now()}`));
    const abortButton = page.getByRole('button', { name: 'Прервать' });
    await expect(abortButton).toBeVisible();
    await abortButton.click();

    const dialog = page.getByRole('dialog', { name: 'Прервать тест?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Продолжить эту попытку будет нельзя');
    await dialog.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(abortButton).toBeFocused();

    await abortButton.click();
    await page.getByRole('button', { name: 'Да, прервать' }).click();
    await expect(page.getByRole('textbox', { name: 'Имя и фамилия' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Результат не добавлен в рейтинг');

    const state = queryLocalD1<{ status: string; answers: number; outbox: number }>(`
      SELECT status,
        (SELECT COUNT(*) FROM answers WHERE attempt_id = attempts.id) AS answers,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = attempts.id AND event_type = 'aborted') AS outbox
      FROM attempts WHERE id = '${attemptId}'
    `, E2E_STATE_PATH)[0];
    expect(state).toEqual({ status: 'aborted', answers: 0, outbox: 1 });

    const leaderboard = queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM attempts
      WHERE id = '${attemptId}' AND status = 'completed'
    `, E2E_STATE_PATH)[0];
    expect(leaderboard.count).toBe(0);
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('истечение клиентского дедлайна отправляет один timeout и безопасно синхронизируется', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Логика дедлайна не зависит от orientation.');
  let timeoutRequests = 0;
  let attemptId = '';

  try {
    page.on('request', (request) => {
      if (!request.url().includes('/answer') || request.method() !== 'POST') return;
      const payload = request.postDataJSON() as { choiceIndex?: number | null } | null;
      if (payload?.choiceIndex === null) timeoutRequests += 1;
    });
    await page.route('**/api/attempts', async (route) => {
      if (route.request().method() !== 'POST' || !route.request().url().endsWith('/api/attempts')) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json() as StartedAttempt & { serverNowMs: number };
      const deadlineAt = body.serverNowMs + 500;
      runWrangler([
        'd1', 'execute', 'DB', '--command',
        `UPDATE attempts SET question_deadline_at = ${deadlineAt} WHERE id = '${body.attemptId}';`,
      ], E2E_STATE_PATH);
      if (body.question) {
        (body.question as { id: number; questionDeadlineAt?: number }).questionDeadlineAt = deadlineAt;
      }
      await route.fulfill({ response, json: body });
    });

    const started = await startCandidate(page, `timeout ${Date.now()}`);
    attemptId = started.attemptId;
    const firstQuestion = await page.getByRole('heading', { level: 1 }).textContent();
    await expect.poll(() => timeoutRequests).toBe(1);
    await expect.poll(() => queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM answers
      WHERE attempt_id = '${attemptId}' AND question_id = ${started.question.id}
        AND selected_index IS NULL AND is_correct = 0
    `, E2E_STATE_PATH)[0]?.count ?? 0).toBe(1);
    await expect.poll(async () => (
      await page.getByRole('radio').count() === 0
        || (await page.getByRole('heading', { level: 1 }).textContent()) !== firstQuestion
    )).toBe(true);
    const outbox = queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM telegram_outbox
      WHERE attempt_id = '${attemptId}' AND question_id = ${started.question.id}
        AND event_type = 'answer'
    `, E2E_STATE_PATH)[0];
    expect(outbox.count).toBe(1);
    await page.waitForTimeout(1_200);
    expect(timeoutRequests).toBe(1);
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('сессия восстанавливается при значительном сдвиге часов iPad', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Clock-skew логика не зависит от orientation.');
  let attemptId = '';
  try {
    await page.addInitScript(() => {
      const nativeNow = Date.now.bind(Date);
      Date.now = () => nativeNow() + 7 * 24 * 60 * 60 * 1_000;
    });
    ({ attemptId } = await startCandidate(page, `clock-skew ${Date.now()}`));
    const question = await page.getByRole('heading', { level: 1 }).textContent();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Варианты ответа' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(question ?? '');
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('HTTP 5xx не удаляет локальную очередь Telegram delivery', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Delivery queue логика не зависит от orientation.');
  let attemptId = '';
  let failedFlushes = 0;
  try {
    await page.route('**/notifications/flush', (route) => {
      failedFlushes += 1;
      return route.fulfill({
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
        body: JSON.stringify({ error: 'temporary' }),
      });
    });
    ({ attemptId } = await startCandidate(page, `delivery-retry ${Date.now()}`));
    await expect.poll(() => failedFlushes).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate((id) => {
      const queue = JSON.parse(
        localStorage.getItem('candidate-check:pending-telegram-deliveries') ?? '[]',
      ) as Array<{ attemptId: string; nextAttemptAt: number }>;
      const delivery = queue.find((item) => item.attemptId === id);
      return Boolean(delivery && delivery.nextAttemptAt > Date.now());
    }, attemptId)).toBe(true);

    await page.locator('label.answer').first().click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect.poll(() => queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM telegram_outbox WHERE attempt_id = '${attemptId}'
    `, E2E_STATE_PATH)[0]?.count ?? 0).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate((id) => {
      const queue = JSON.parse(
        localStorage.getItem('candidate-check:pending-telegram-deliveries') ?? '[]',
      ) as Array<{ attemptId: string }>;
      return queue.some((item) => item.attemptId === id);
    }, attemptId)).toBe(true);
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('идемпотентный API создаёт один ответ и одно outbox-событие', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 integration не зависит от orientation.');
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  let attemptId = '';

  try {
    const start = await request.post('/api/attempts', {
      data: { name: `E2E API ${Date.now()}`, startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(start.status()).toBe(201);
    const payload = await start.json() as {
      attemptId: string;
      question: { id: number };
    };
    attemptId = payload.attemptId;

    const replay = await request.post('/api/attempts', {
      data: { startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).attemptId).toBe(attemptId);

    const answerUrl = `/api/attempts/${attemptId}/answer`;
    const answerBody = { questionId: payload.question.id, choiceIndex: 0 };
    const firstAnswer = await request.post(answerUrl, {
      data: answerBody,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(firstAnswer.status()).toBe(200);
    const duplicateAnswer = await request.post(answerUrl, {
      data: answerBody,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(duplicateAnswer.status()).toBe(200);

    const counts = queryLocalD1<{ answers: number; outbox: number }>(`
      SELECT
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}) AS answers,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'answer') AS outbox
    `, E2E_STATE_PATH)[0];
    expect(counts).toEqual({ answers: 1, outbox: 1 });

    for (let index = 0; index < 2; index += 1) {
      const flush = await request.post(`/api/attempts/${attemptId}/notifications/flush`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(flush.status()).toBe(202);
      expect((await flush.json()).pending).toBe(true);
    }
    const afterFlush = queryLocalD1<{ outbox: number }>(`
      SELECT COUNT(*) AS outbox FROM telegram_outbox
      WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
        AND event_type = 'answer'
    `, E2E_STATE_PATH)[0];
    expect(afterFlush.outbox).toBe(1);

    const abortUrl = `/api/attempts/${attemptId}/abort`;
    for (let index = 0; index < 2; index += 1) {
      const aborted = await request.post(abortUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(aborted.status()).toBe(200);
      expect((await aborted.json()).status).toBe('aborted');
    }
    const abortedState = queryLocalD1<{ status: string; outbox: number }>(`
      SELECT status,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND event_type = 'aborted') AS outbox
      FROM attempts WHERE id = '${attemptId}'
    `, E2E_STATE_PATH)[0];
    expect(abortedState).toEqual({ status: 'aborted', outbox: 1 });
  } finally {
    if (attemptId) cleanupAttempt(attemptId);
  }
});
