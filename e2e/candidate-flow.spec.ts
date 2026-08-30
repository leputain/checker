import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { queryLocalD1, runWrangler } from '../scripts/local-d1.ts';

const E2E_STATE_PATH = path.resolve('.wrangler', 'e2e');
const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

type StartedAttempt = {
  attemptId: string;
  question: {
    id: number;
    choices?: string[];
    difficulty?: 'easy' | 'medium' | 'hard' | 'expert';
    questionKind?: 'base' | 'additional';
    scoreValue?: number;
    additionalNumber?: number;
  };
};

type CurrentQuestionState = {
  id: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  correctChoice: string;
  incorrectChoice: string;
  isBase: number;
};

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

async function startCandidate(page: Page, suffix: string) {
  await page.goto('/');
  await expect(page.getByText('Система готова', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Имя и фамилия' }).fill(`E2E ${suffix}`);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByRole('heading', { name: 'Пробный вопрос' })).toBeVisible();
  await page.locator('label.answer').filter({
    hasText: 'Выбрать карточку и нажать «Проверить ответ»',
  }).click();
  await page.getByRole('button', { name: 'Проверить ответ' }).click();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/attempts' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Начать настоящий тест' }).click();
  await expect(page.getByRole('status', { name: 'До начала теста' })).toBeVisible();
  const started = await (await responsePromise).json() as StartedAttempt;
  await expect(page.getByRole('group', { name: 'Варианты ответа' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
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

function currentQuestionState(attemptId: string): CurrentQuestionState {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('Unexpected attempt id in E2E query.');
  const row = queryLocalD1<{
    id: number;
    difficulty: CurrentQuestionState['difficulty'];
    choicesJson: string;
    correctIndex: number;
    isBase: number;
  }>(`
    SELECT questions.id, questions.difficulty,
      questions.choices_json AS choicesJson, questions.correct_index AS correctIndex,
      CASE WHEN EXISTS (
        SELECT 1 FROM json_each(attempts.base_question_ids) AS base
        WHERE base.value = questions.id
      ) THEN 1 ELSE 0 END AS isBase
    FROM attempts JOIN questions ON questions.id = attempts.current_question_id
    WHERE attempts.id = '${attemptId}'
  `, E2E_STATE_PATH)[0];
  if (!row) throw new Error('Current E2E question was not found.');
  const choices = JSON.parse(row.choicesJson) as string[];
  return {
    id: row.id,
    difficulty: row.difficulty,
    correctChoice: choices[row.correctIndex],
    incorrectChoice: choices[(row.correctIndex + 1) % choices.length],
    isBase: row.isBase,
  };
}

test('таблица лидеров доступна до начала теста', async ({ page }) => {
  await page.goto('/');
  const leaderboardButton = page.getByRole('button', { name: 'Таблица лидеров' });
  await expect(leaderboardButton).toBeVisible();
  await leaderboardButton.click();
  const dialog = page.getByRole('dialog', { name: 'Таблица лидеров' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Сегодня' })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('tab', { name: 'Все' }).click();
  await expect(dialog.getByRole('tab', { name: 'Все' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tabpanel')).toBeVisible();
  await dialog.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(leaderboardButton).toBeFocused();
});

test('пробный вопрос не запускает серверный таймер и позволяет исправить выбор', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Логика demo не зависит от orientation.');
  let attemptId = '';
  let startRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/attempts' && request.method() === 'POST') {
      startRequests += 1;
    }
  });

  try {
    await page.goto('/');
    await expect(page.getByText('Система готова', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Имя и фамилия' }).fill(`E2E demo ${Date.now()}`);
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await expect(page.getByRole('heading', { name: 'Пробный вопрос' })).toBeVisible();
    expect(startRequests).toBe(0);

    await page.locator('label.answer').filter({ hasText: 'Дождаться окончания времени' }).click();
    await page.getByRole('button', { name: 'Проверить ответ' }).click();
    await expect(page.getByText(/Попробуйте ещё раз/)).toBeVisible();
    expect(startRequests).toBe(0);

    await page.locator('label.answer').filter({
      hasText: 'Выбрать карточку и нажать «Проверить ответ»',
    }).click();
    await page.getByRole('button', { name: 'Проверить ответ' }).click();
    const responsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/attempts'
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Начать настоящий тест' }).click();
    await expect(page.getByRole('status', { name: 'До начала теста' })).toContainText('3');
    expect(startRequests).toBe(0);
    const response = await responsePromise;
    const started = await response.json() as StartedAttempt;
    attemptId = started.attemptId;
    expect(startRequests).toBe(1);
    await expect(page.getByRole('group', { name: 'Варианты ответа' })).toBeVisible();
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('пробный вопрос доступен без readiness, а настоящий старт остаётся заблокирован', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Логика readiness не зависит от orientation.');
  let startRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/attempts' && request.method() === 'POST') {
      startRequests += 1;
    }
  });

  await page.goto('/');
  await expect(page.getByText('Система готова', { exact: true })).toBeVisible();
  await page.route('**/api/health/ready', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'unavailable', code: 'telegram_misconfigured' }),
  }));

  await page.getByRole('textbox', { name: 'Имя и фамилия' }).fill(`E2E no readiness ${Date.now()}`);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByRole('heading', { name: 'Пробный вопрос' })).toBeVisible();
  expect(startRequests).toBe(0);

  await page.locator('label.answer').filter({
    hasText: 'Выбрать карточку и нажать «Проверить ответ»',
  }).click();
  await page.getByRole('button', { name: 'Проверить ответ' }).click();
  await page.getByRole('button', { name: 'Начать настоящий тест' }).click();

  await expect(page.getByRole('heading', { name: 'Пробный вопрос' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Сервис пока не готов');
  expect(startRequests).toBe(0);
});

test('повтор starting-сессии старой версии очищается после 409', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Legacy starting recovery не зависит от orientation.');
  await page.goto('/');
  await expect(page.getByText('Система готова', { exact: true })).toBeVisible();

  await page.evaluate((session) => {
    localStorage.setItem('candidate-check:active-attempt', JSON.stringify(session));
  }, {
    version: 2,
    phase: 'starting',
    startKey: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    createdAt: Date.now(),
  });
  await page.route('**/api/attempts', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'Эта активная попытка создана в устаревшей версии теста.',
      code: 'attempt_version_unsupported',
    }),
  }));

  await page.getByRole('textbox', { name: 'Имя и фамилия' }).fill(`E2E legacy ${Date.now()}`);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await page.locator('label.answer').filter({
    hasText: 'Выбрать карточку и нажать «Проверить ответ»',
  }).click();
  await page.getByRole('button', { name: 'Проверить ответ' }).click();
  await page.getByRole('button', { name: 'Начать настоящий тест' }).click();

  await expect(page.getByText('Тест обновлён. Начните новую попытку.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Имя и фамилия' })).toHaveValue('');
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('candidate-check:active-attempt')
  ))).toBeNull();
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
    await expect(page.getByRole('img', { name: '100 из 100 баллов' })).toBeVisible();
    await expect(page.getByText('Рекомендован', { exact: true })).toBeVisible();
    const resultStats = page.locator('.result-stats');
    await expect(resultStats.getByText('20 из 20', { exact: true })).toHaveCount(2);
    await expect(resultStats.getByText('не задавались', { exact: true })).toBeVisible();
    await expect(resultStats.getByText('100%', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Компетенции' })).toBeVisible();
    await expect.poll(() => page.getByRole('progressbar').count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole('heading', { name: 'По направлениям' })).toHaveCount(0);
    const completed = queryLocalD1<{
      completedAt: number;
      score: number;
      baseMaxScore: number;
      verdict: string;
    }>(`
      SELECT completed_at AS completedAt, score,
        base_max_score AS baseMaxScore, verdict
      FROM attempts WHERE id = '${attemptId}'
    `, E2E_STATE_PATH)[0];
    expect(completed?.completedAt).toBeTruthy();
    expect(completed).toMatchObject({ score: 100, baseMaxScore: 100, verdict: 'PASS' });
    const completedAtIso = new Date(completed.completedAt).toISOString();
    const resultDate = page.locator('.result-stat-date time');
    await expect(resultDate).toHaveAttribute('datetime', completedAtIso);
    await expect(resultDate).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);
    await expectNoHorizontalOverflow(page);
    const actionHeights = await page.locator('.result-actions button').evaluateAll((buttons) => (
      buttons.map((button) => Math.round(button.getBoundingClientRect().height))
    ));
    expect(actionHeights.every((height) => height >= 44)).toBe(true);

    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `UPDATE attempts SET base_max_score = 50 WHERE id = '${attemptId}';`,
    ], E2E_STATE_PATH);
    const legacyLeaderboard = await page.request.get('/api/leaderboard?period=all');
    expect(legacyLeaderboard.status()).toBe(200);
    const legacyEntries = (await legacyLeaderboard.json()) as {
      entries: Array<{ completedAt: string; baseMaxScore: number }>;
    };
    expect(legacyEntries.entries.some((entry) => entry.completedAt === completedAtIso)).toBe(false);
    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `UPDATE attempts SET base_max_score = 100 WHERE id = '${attemptId}';`,
    ], E2E_STATE_PATH);
    const currentLeaderboard = await page.request.get('/api/leaderboard?period=all');
    expect(currentLeaderboard.status()).toBe(200);
    const currentEntries = (await currentLeaderboard.json()) as {
      entries: Array<{ completedAt: string; baseMaxScore: number }>;
    };
    expect(currentEntries.entries.some((entry) => (
      entry.completedAt === completedAtIso && entry.baseMaxScore === 100
    ))).toBe(true);

    const leaderboardButton = page.getByRole('button', { name: 'Таблица лидеров' });
    await leaderboardButton.click();
    const dialog = page.getByRole('dialog', { name: 'Таблица лидеров' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(`time[datetime="${completedAtIso}"]`)).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);
    await dialog.press('Shift+Tab');
    await expect(dialog.getByRole('tab', { name: 'Все' })).toBeFocused();
    await dialog.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(leaderboardButton).toBeFocused();
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('ошибки базовых hard и expert добавляют только два вопроса после основной двадцатки', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Remedial policy достаточно проверить один раз.');
  test.setTimeout(120_000);
  let attemptId = '';
  const missedDifficulties = new Set<CurrentQuestionState['difficulty']>();
  let baseSeen = 0;
  let additionalSeen = 0;
  const scoreValues = {
    easy: { base: 2, additional: 1 },
    medium: { base: 4, additional: 2 },
    hard: { base: 6, additional: 3 },
    expert: { base: 20, additional: 10 },
  } as const;
  const difficultyLabels = {
    easy: 'Базовый',
    medium: 'Средний',
    hard: 'Сложный',
    expert: 'Экспертный',
  } as const;

  try {
    ({ attemptId } = await startCandidate(page, `remedial ${Date.now()}`));

    for (let step = 0; step < 30; step += 1) {
      if (await page.getByRole('radio').count() === 0) break;
      const state = currentQuestionState(attemptId);
      const questionKind = state.isBase ? 'base' : 'additional';
      const previousQuestion = await page.getByRole('heading', { level: 1 }).textContent();
      const shouldMiss = state.isBase === 1
        && (state.difficulty === 'hard' || state.difficulty === 'expert')
        && !missedDifficulties.has(state.difficulty);

      if (state.isBase) {
        baseSeen += 1;
        expect(additionalSeen).toBe(0);
        if (shouldMiss) missedDifficulties.add(state.difficulty);
      } else {
        expect(baseSeen).toBe(20);
        additionalSeen += 1;
        expect(missedDifficulties.has(state.difficulty)).toBe(true);
        await expect(page.getByText(`Дополнительный вопрос ${additionalSeen}`, { exact: true })).toBeVisible();
      }

      const scoreValue = scoreValues[state.difficulty][questionKind];
      const pointsLabel = scoreValue % 10 === 1 && scoreValue % 100 !== 11
        ? `${scoreValue} балл`
        : scoreValue % 10 >= 2 && scoreValue % 10 <= 4
          && !(scoreValue % 100 >= 12 && scoreValue % 100 <= 14)
          ? `${scoreValue} балла`
          : `${scoreValue} баллов`;
      await expect(page.getByText(
        `${difficultyLabels[state.difficulty]} · ${pointsLabel}`,
        { exact: true },
      )).toBeVisible();

      const choice = shouldMiss ? state.incorrectChoice : state.correctChoice;
      await page.locator('label.answer').filter({
        has: page.getByText(choice, { exact: true }),
      }).click();
      await page.getByRole('button', { name: 'Ответить' }).click();
      await expect.poll(async () => {
        if (await page.getByRole('radio').count() === 0) return true;
        return (await page.getByRole('heading', { level: 1 }).textContent()) !== previousQuestion;
      }).toBe(true);
    }

    expect(baseSeen).toBe(20);
    expect(additionalSeen).toBe(2);
    expect([...missedDifficulties].sort()).toEqual(['expert', 'hard']);
    await expect(page.getByRole('heading', { name: 'Результат готов.' })).toBeVisible();
    await expect(page.getByRole('img', { name: '87 из 100 баллов' })).toBeVisible();
    await expect(page.getByText('Рекомендован', { exact: true })).toBeVisible();
    const resultStats = page.locator('.result-stats');
    await expect(resultStats.getByText('20 из 22', { exact: true })).toBeVisible();
    await expect(resultStats.getByText('18 из 20', { exact: true })).toBeVisible();
    await expect(resultStats.getByText('2 из 2', { exact: true })).toBeVisible();
    await expect(resultStats.getByText('91%', { exact: true })).toBeVisible();

    const completed = queryLocalD1<{
      score: number;
      baseMaxScore: number;
      correctCount: number;
      wrongCount: number;
      verdict: string;
      baseAnsweredCount: number;
      baseCorrectCount: number;
      additionalAnsweredCount: number;
      additionalCorrectCount: number;
    }>(`
      SELECT attempts.score, attempts.base_max_score AS baseMaxScore,
        attempts.correct_count AS correctCount, attempts.wrong_count AS wrongCount,
        attempts.verdict,
        SUM(CASE WHEN base.value IS NOT NULL THEN 1 ELSE 0 END) AS baseAnsweredCount,
        SUM(CASE WHEN base.value IS NOT NULL AND answers.is_correct = 1 THEN 1 ELSE 0 END) AS baseCorrectCount,
        SUM(CASE WHEN base.value IS NULL THEN 1 ELSE 0 END) AS additionalAnsweredCount,
        SUM(CASE WHEN base.value IS NULL AND answers.is_correct = 1 THEN 1 ELSE 0 END) AS additionalCorrectCount
      FROM attempts
      JOIN answers ON answers.attempt_id = attempts.id
      LEFT JOIN json_each(attempts.base_question_ids) AS base ON base.value = answers.question_id
      WHERE attempts.id = '${attemptId}'
      GROUP BY attempts.id
    `, E2E_STATE_PATH)[0];
    expect(completed).toEqual({
      score: 87,
      baseMaxScore: 100,
      correctCount: 20,
      wrongCount: 2,
      verdict: 'PASS',
      baseAnsweredCount: 20,
      baseCorrectCount: 18,
      additionalAnsweredCount: 2,
      additionalCorrectCount: 2,
    });
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
    const selectedRadio = page.getByRole('radio').first();
    await expect(selectedRadio).toBeChecked();
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
    await expect(selectedRadio).toBeChecked();
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await stopAndCleanup(page, attemptId);
  }
});

test('длинный вопрос прокручивается без горизонтального overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'Длинный portrait layout — наиболее жёсткий вариант.');
  const longPrompt = `Длинный вопрос для проверки адаптивной вёрстки: ${'контекст и уточнение '.repeat(10)}`.slice(0, 280);
  const longToken = `C:\\${'very-long-technical-token'.repeat(10)}`;
  const longTopic = `Linux-${'infrastructure'.repeat(6)}`;
  let attemptId = '';

  try {
    await page.route('**/api/attempts', async (route) => {
      if (route.request().method() !== 'POST' || !route.request().url().endsWith('/api/attempts')) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      if (body.question) {
        body.question.prompt = longPrompt;
        body.question.topic = longTopic;
        body.question.contextType = 'log';
        body.question.context = `sshd[1842]: Failed password\n${'audit context '.repeat(24)}`;
        body.question.choices[0] = longToken;
      }
      await route.fulfill({ response, json: body });
    });

    ({ attemptId } = await startCandidate(page, `long ${Date.now()}`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(longPrompt);
    await expect(page.getByLabel('Фрагмент журнала')).toContainText('sshd[1842]');
    await expect(page.locator('.topic-chip')).toHaveText(longTopic);
    const longChoice = page.locator('.answer-copy').filter({ hasText: longToken });
    await expect(longChoice).toBeVisible();
    await expect.poll(() => longChoice.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect.poll(() => page.locator('.topic-chip').evaluate((element) => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true);
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
    const continueButton = dialog.getByRole('button', { name: 'Продолжить тест' });
    await continueButton.focus();
    await page.waitForTimeout(700);
    await expect(continueButton).toBeFocused();
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

test('таймаут закрывает abort-диалог, отправляет один ответ и безопасно синхронизируется', async ({ page }, testInfo) => {
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
      const deadlineAt = body.serverNowMs + 3_000;
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
    await page.getByRole('button', { name: 'Прервать' }).click();
    const abortDialog = page.getByRole('dialog', { name: 'Прервать тест?' });
    await expect(abortDialog).toBeVisible();
    await expect.poll(() => timeoutRequests).toBe(1);
    await expect(abortDialog).toBeHidden();
    await expect.poll(() => queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM answers
      WHERE attempt_id = '${attemptId}' AND question_id = ${started.question.id}
        AND selected_index IS NULL AND is_correct = 0
        AND timed_out = 1 AND elapsed_seconds >= 1
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
    const progress = queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM telegram_outbox
      WHERE attempt_id = '${attemptId}' AND question_id = ${started.question.id}
        AND event_type = 'progress' AND delivery_method = 'edit_root'
    `, E2E_STATE_PATH)[0];
    expect(progress.count).toBe(1);
    const scheduledAdditional = queryLocalD1<{ count: number }>(`
      WITH queued(id) AS (
        SELECT value FROM attempts, json_each(attempts.asked_question_ids)
        WHERE attempts.id = '${attemptId}'
        UNION
        SELECT value FROM attempts, json_each(attempts.pending_question_ids)
        WHERE attempts.id = '${attemptId}'
      )
      SELECT COUNT(*) AS count FROM queued
      WHERE NOT EXISTS (
        SELECT 1 FROM attempts, json_each(attempts.base_question_ids) AS base
        WHERE attempts.id = '${attemptId}' AND base.value = queued.id
      )
    `, E2E_STATE_PATH)[0];
    expect(scheduledAdditional.count).toBe(1);
    const abortEvents = queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count FROM telegram_outbox
      WHERE attempt_id = '${attemptId}' AND event_type = 'aborted'
    `, E2E_STATE_PATH)[0];
    expect(abortEvents.count).toBe(0);
    await page.waitForTimeout(1_200);
    expect(timeoutRequests).toBe(1);
  } finally {
    await stopAndCleanup(page, attemptId);
  }
});

test('общий таймаут не считает незаданный дополнительный вопрос ошибкой', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 integration не зависит от orientation.');
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  let attemptId = '';

  try {
    const start = await request.post('/api/attempts', {
      data: { name: `E2E total timeout ${Date.now()}`, startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(start.status()).toBe(201);
    const payload = await start.json() as StartedAttempt;
    attemptId = payload.attemptId;
    const choices = payload.question.choices ?? [];
    const correctChoice = correctChoiceForAttempt(attemptId);
    const correctDisplayedIndex = choices.indexOf(correctChoice);
    expect(correctDisplayedIndex).toBeGreaterThanOrEqual(0);
    const wrongDisplayedIndex = (correctDisplayedIndex + 1) % choices.length;

    const firstAnswer = await request.post(`/api/attempts/${attemptId}/answer`, {
      data: { questionId: payload.question.id, choiceIndex: wrongDisplayedIndex },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(firstAnswer.status()).toBe(200);
    const afterFirst = await firstAnswer.json() as StartedAttempt;
    const scheduledAdditional = queryLocalD1<{ id: number }>(`
      SELECT pending.value AS id
      FROM attempts, json_each(attempts.pending_question_ids) AS pending
      WHERE attempts.id = '${attemptId}'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(attempts.base_question_ids) AS base
          WHERE base.value = pending.value
        )
      LIMIT 1
    `, E2E_STATE_PATH)[0];
    expect(scheduledAdditional?.id).toBeTruthy();

    const expiredAt = Date.now() - 1_000;
    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `UPDATE attempts SET total_deadline_at = ${expiredAt}, question_deadline_at = ${expiredAt}
       WHERE id = '${attemptId}';`,
    ], E2E_STATE_PATH);
    const completedResponse = await request.post(`/api/attempts/${attemptId}/answer`, {
      data: { questionId: afterFirst.question.id, choiceIndex: null },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(completedResponse.status()).toBe(200);
    const completedPayload = await completedResponse.json() as {
      status: string;
      result: {
        wrongCount: number;
        timeoutCount: number;
        baseAnsweredCount: number;
        additionalAnsweredCount: number;
      };
    };
    expect(completedPayload.status).toBe('completed');
    expect(completedPayload.result).toMatchObject({
      wrongCount: 20,
      timeoutCount: 19,
      baseAnsweredCount: 20,
      additionalAnsweredCount: 0,
    });

    const state = queryLocalD1<{
      answers: number;
      baseAssigned: number;
      baseResolved: number;
      additionalAssigned: number;
      additionalPresented: number;
      additionalAnswers: number;
      askedQuestions: number;
      additionalAnswerEvents: number;
      submitted: number;
      totalTimeoutPresented: number;
      totalTimeoutUnshown: number;
      questionTimeout: number;
      presentedWithoutAnswer: number;
      invalidUnshownBaseFacts: number;
      unshownAdditionalAnswers: number;
      score: number;
      awardedScore: number;
      correctCount: number;
      wrongCount: number;
      factCorrect: number;
      factWrong: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM answers WHERE attempt_id = attempts.id) AS answers,
        (SELECT COUNT(*) FROM attempt_questions
          WHERE attempt_id = attempts.id AND question_kind = 'base') AS baseAssigned,
        (SELECT COUNT(*) FROM attempt_questions aq JOIN answers a
          ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
          WHERE aq.attempt_id = attempts.id AND aq.question_kind = 'base'
            AND a.fact_version = attempts.analytics_facts_version) AS baseResolved,
        (SELECT COUNT(*) FROM attempt_questions
          WHERE attempt_id = attempts.id AND question_kind = 'additional') AS additionalAssigned,
        (SELECT COUNT(*) FROM attempt_questions
          WHERE attempt_id = attempts.id AND question_kind = 'additional'
            AND presented_at IS NOT NULL) AS additionalPresented,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id AND question_id = ${scheduledAdditional.id}) AS additionalAnswers,
        json_array_length(asked_question_ids) AS askedQuestions,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = attempts.id AND question_id = ${scheduledAdditional.id}
            AND event_type = 'answer') AS additionalAnswerEvents,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id AND answer_origin = 'submitted') AS submitted,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id
            AND answer_origin = 'total_timeout_presented') AS totalTimeoutPresented,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id
            AND answer_origin = 'total_timeout_unshown') AS totalTimeoutUnshown,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id AND answer_origin = 'question_timeout') AS questionTimeout,
        (SELECT COUNT(*) FROM attempt_questions aq
          LEFT JOIN answers a ON a.attempt_id = aq.attempt_id
            AND a.question_id = aq.question_id
            AND a.fact_version = attempts.analytics_facts_version
          WHERE aq.attempt_id = attempts.id AND aq.presented_at IS NOT NULL
            AND a.id IS NULL) AS presentedWithoutAnswer,
        (SELECT COUNT(*) FROM attempt_questions aq
          LEFT JOIN answers a ON a.attempt_id = aq.attempt_id
            AND a.question_id = aq.question_id
            AND a.fact_version = attempts.analytics_facts_version
          WHERE aq.attempt_id = attempts.id AND aq.question_kind = 'base'
            AND aq.presented_at IS NULL
            AND (a.id IS NULL OR a.answer_origin != 'total_timeout_unshown'))
          AS invalidUnshownBaseFacts,
        (SELECT COUNT(*) FROM attempt_questions aq JOIN answers a
          ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
          WHERE aq.attempt_id = attempts.id AND aq.question_kind = 'additional'
            AND aq.presented_at IS NULL) AS unshownAdditionalAnswers,
        score,
        COALESCE((SELECT SUM(awarded_score) FROM answers
          WHERE attempt_id = attempts.id), 0) AS awardedScore,
        correct_count AS correctCount,
        wrong_count AS wrongCount,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id AND is_correct = 1) AS factCorrect,
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = attempts.id AND is_correct = 0) AS factWrong
      FROM attempts WHERE id = '${attemptId}'
    `, E2E_STATE_PATH)[0];
    expect(state).toEqual({
      answers: 20,
      baseAssigned: 20,
      baseResolved: 20,
      additionalAssigned: 1,
      additionalPresented: 0,
      additionalAnswers: 0,
      askedQuestions: 20,
      additionalAnswerEvents: 0,
      submitted: 1,
      totalTimeoutPresented: 1,
      totalTimeoutUnshown: 18,
      questionTimeout: 0,
      presentedWithoutAnswer: 0,
      invalidUnshownBaseFacts: 0,
      unshownAdditionalAnswers: 0,
      score: 0,
      awardedScore: 0,
      correctCount: 0,
      wrongCount: 20,
      factCorrect: 0,
      factWrong: 20,
    });
  } finally {
    if (attemptId) cleanupAttempt(attemptId);
  }
});

test('активная попытка берёт дополнительный вопрос из своей замороженной ревизии', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 integration не зависит от orientation.');
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const replacementRevision = randomBytes(32).toString('hex');
  let attemptId = '';
  let originalRevision = '';
  let replacementQuestionId = 0;

  try {
    const start = await request.post('/api/attempts', {
      data: { name: `E2E frozen revision ${Date.now()}`, startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(start.status()).toBe(201);
    const payload = await start.json() as StartedAttempt;
    attemptId = payload.attemptId;
    const state = queryLocalD1<{
      bankRevision: string;
      difficulty: CurrentQuestionState['difficulty'];
      weight: number;
      nextId: number;
    }>(`SELECT attempts.bank_revision AS bankRevision, questions.difficulty,
        questions.weight, (SELECT MAX(id) + 1 FROM questions) AS nextId
      FROM attempts JOIN questions ON questions.id = attempts.current_question_id
      WHERE attempts.id = '${attemptId}'`, E2E_STATE_PATH)[0];
    expect(state?.bankRevision).toMatch(/^[a-f0-9]{64}$/u);
    originalRevision = state.bankRevision;
    replacementQuestionId = Math.max(2_000_000, state.nextId);

    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `UPDATE questions SET active = 0 WHERE difficulty = '${state.difficulty}';
       INSERT INTO questions (
         id, difficulty, topic, prompt, choices_json, correct_index, weight,
         active, content_hash, dedupe_key
       ) VALUES (
         ${replacementQuestionId}, '${state.difficulty}', 'Frozen revision E2E',
         'Question from a newer bank revision', '["New A","New B"]', 0, ${state.weight},
         1, '${randomBytes(32).toString('hex')}', 'e2e:frozen-new-${replacementQuestionId}'
       );
       INSERT INTO question_bank_revisions (
         hash, applied_at, total_count, active_count, pools_json
       ) SELECT '${replacementRevision}', ${Date.now()}, COUNT(*), SUM(active), '{}'
         FROM questions;
       INSERT INTO question_bank_revision_items (revision_hash, question_id, active)
         SELECT '${replacementRevision}', id, active FROM questions;
       UPDATE question_bank_state SET current_revision = '${replacementRevision}',
         updated_at = ${Date.now()} WHERE id = 1;`,
    ], E2E_STATE_PATH);

    const choices = payload.question.choices ?? [];
    const correctChoice = correctChoiceForAttempt(attemptId);
    const correctDisplayedIndex = choices.indexOf(correctChoice);
    expect(correctDisplayedIndex).toBeGreaterThanOrEqual(0);
    const answer = await request.post(`/api/attempts/${attemptId}/answer`, {
      data: {
        questionId: payload.question.id,
        choiceIndex: (correctDisplayedIndex + 1) % choices.length,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(answer.status()).toBe(200);

    const scheduled = queryLocalD1<{ id: number; frozenMembership: number }>(`
      SELECT pending.value AS id,
        EXISTS (
          SELECT 1 FROM question_bank_revision_items AS membership
          WHERE membership.revision_hash = '${originalRevision}'
            AND membership.question_id = pending.value AND membership.active = 1
        ) AS frozenMembership
      FROM attempts, json_each(attempts.pending_question_ids) AS pending
      WHERE attempts.id = '${attemptId}'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(attempts.base_question_ids) AS base
          WHERE base.value = pending.value
        )
      LIMIT 1
    `, E2E_STATE_PATH)[0];
    expect(scheduled?.id).toBeTruthy();
    expect(scheduled.id).not.toBe(replacementQuestionId);
    expect(scheduled.frozenMembership).toBe(1);
  } finally {
    if (attemptId) cleanupAttempt(attemptId);
    if (originalRevision && replacementQuestionId) {
      runWrangler([
        'd1', 'execute', 'DB', '--command',
        `UPDATE question_bank_state SET current_revision = '${originalRevision}',
           updated_at = ${Date.now()} WHERE id = 1;
         UPDATE questions SET active = COALESCE((
           SELECT membership.active FROM question_bank_revision_items AS membership
           WHERE membership.revision_hash = '${originalRevision}'
             AND membership.question_id = questions.id
         ), 0) WHERE id != ${replacementQuestionId};
         DELETE FROM question_bank_revision_items
           WHERE revision_hash = '${replacementRevision}';
         DELETE FROM questions WHERE id = ${replacementQuestionId};
         DELETE FROM question_bank_revisions WHERE hash = '${replacementRevision}';`,
      ], E2E_STATE_PATH);
    }
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

test('идемпотентный API создаёт один ответ и согласованный набор Telegram-событий', async ({ request }, testInfo) => {
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
      question: { id: number; choices: string[] };
    };
    attemptId = payload.attemptId;

    const baseSelection = queryLocalD1<{ total: number; uniqueConcepts: number }>(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT questions.dedupe_key) AS uniqueConcepts
      FROM attempts, json_each(attempts.base_question_ids) AS selected
      JOIN questions ON questions.id = selected.value
      WHERE attempts.id = '${attemptId}'
    `, E2E_STATE_PATH)[0];
    expect(baseSelection).toEqual({ total: 20, uniqueConcepts: 20 });

    const replay = await request.post('/api/attempts', {
      data: { startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).attemptId).toBe(attemptId);

    const answerUrl = `/api/attempts/${attemptId}/answer`;
    const correctChoice = correctChoiceForAttempt(attemptId);
    const correctDisplayedIndex = payload.question.choices.indexOf(correctChoice);
    expect(correctDisplayedIndex).toBeGreaterThanOrEqual(0);
    const wrongDisplayedIndex = (correctDisplayedIndex + 1) % payload.question.choices.length;
    const answerBody = {
      questionId: payload.question.id,
      choiceIndex: wrongDisplayedIndex,
    };
    const [firstAnswer, duplicateAnswer] = await Promise.all([
      request.post(answerUrl, {
        data: answerBody,
        headers: { Authorization: `Bearer ${token}` },
      }),
      request.post(answerUrl, {
        data: answerBody,
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    expect(firstAnswer.status()).toBe(200);
    expect(duplicateAnswer.status()).toBe(200);

    const counts = queryLocalD1<{
      answers: number;
      isCorrect: number;
      remedial: number;
      started: number;
      progress: number;
      progressPending: number;
      progressDead: number;
      answerEvent: number;
      answerPending: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM answers
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}) AS answers,
        (SELECT is_correct FROM answers
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}) AS isCorrect,
        (SELECT COUNT(*) FROM attempt_questions
          WHERE attempt_id = '${attemptId}' AND question_kind = 'additional'
            AND source_question_id = ${payload.question.id}) AS remedial,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND event_type = 'started') AS started,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'progress' AND delivery_method = 'edit_root') AS progress,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'progress' AND delivery_method = 'edit_root'
            AND status = 'pending' AND last_error_code IS NULL) AS progressPending,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'progress' AND status = 'dead') AS progressDead,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'answer' AND delivery_method = 'reply_root') AS answerEvent,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'answer' AND delivery_method = 'reply_root'
            AND status = 'pending' AND last_error_code IS NULL) AS answerPending
    `, E2E_STATE_PATH)[0];
    expect(counts.answers).toBe(1);
    expect(counts.isCorrect).toBe(0);
    expect(counts.remedial).toBe(1);
    expect(counts.started).toBe(1);
    expect(counts.progress).toBe(1);
    expect(counts.progressPending).toBe(1);
    expect(counts.progressDead).toBe(0);
    expect(counts.answerEvent).toBe(1);
    expect(counts.answerPending).toBe(1);

    for (let index = 0; index < 2; index += 1) {
      const flush = await request.post(`/api/attempts/${attemptId}/notifications/flush`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(flush.status()).toBe(202);
      expect((await flush.json()).pending).toBe(true);
    }
    const afterFlush = queryLocalD1<{ progress: number; answerEvent: number }>(`
      SELECT
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'progress') AS progress,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND question_id = ${payload.question.id}
            AND event_type = 'answer') AS answerEvent
    `, E2E_STATE_PATH)[0];
    expect(afterFlush.progress).toBe(1);
    expect(afterFlush.answerEvent).toBe(1);

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

test('после прерывания устаревший ответ не записывается', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 integration не зависит от orientation.');
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  let attemptId = '';

  try {
    const start = await request.post('/api/attempts', {
      data: { name: `E2E abort race ${Date.now()}`, startKey, token },
      headers: { 'Idempotency-Key': startKey },
    });
    expect(start.status()).toBe(201);
    const payload = await start.json() as { attemptId: string; question: { id: number } };
    attemptId = payload.attemptId;

    const aborted = await request.post(`/api/attempts/${attemptId}/abort`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(aborted.status()).toBe(200);
    expect((await aborted.json()).status).toBe('aborted');

    const staleAnswer = await request.post(`/api/attempts/${attemptId}/answer`, {
      data: { questionId: payload.question.id, choiceIndex: 0 },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(staleAnswer.status()).toBe(200);
    expect((await staleAnswer.json()).status).toBe('aborted');

    const state = queryLocalD1<{ answers: number; answerEvents: number; abortEvents: number }>(`
      SELECT
        (SELECT COUNT(*) FROM answers WHERE attempt_id = '${attemptId}') AS answers,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND event_type = 'answer') AS answerEvents,
        (SELECT COUNT(*) FROM telegram_outbox
          WHERE attempt_id = '${attemptId}' AND event_type = 'aborted') AS abortEvents
    `, E2E_STATE_PATH)[0];
    expect(state).toEqual({ answers: 0, answerEvents: 0, abortEvents: 1 });
  } finally {
    if (attemptId) cleanupAttempt(attemptId);
  }
});
