import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  AnalyticsCohortDto,
  AnalyticsOverviewPeriodDto,
  CandidateAnalyticsItemDto,
  CandidatePrintDto,
  QuestionAnalyticsDetailDto,
  QuestionAnalyticsItemDto,
} from '../lib/analytics-contract.ts';
import { QUESTION_ANALYTICS_MODEL_VERSION } from '../lib/analytics-contract.ts';
import { APP_RELEASE } from '../lib/release.ts';
import { SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID } from '../lib/test-config.ts';

const E2E_ADMIN_PIN_PATH = path.resolve('.data', 'e2e-admin-pin.txt');
const FORBIDDEN_ADMIN_FIELDS = new Set([
  'adminpin',
  'answerkey',
  'canonicalselectedindex',
  'candidate_name',
  'candidatename',
  'choices_json',
  'choicesjson',
  'correct_answer',
  'correct_index',
  'correctanswer',
  'correctindex',
  'pin',
  'pinhash',
  'pinsalt',
  'rawanswer',
  'rawselectedanswer',
  'selected_answer',
  'selectedanswer',
  'selectedchoice',
  'selectedindex',
  'sessionsecret',
  'telegrambottoken',
  'telegramchatid',
]);

function e2eAdminPin() {
  const pin = readFileSync(E2E_ADMIN_PIN_PATH, 'utf8').trim();
  if (!/^\d{4,12}$/u.test(pin)) {
    throw new Error('Disposable E2E admin PIN is missing or invalid. Run the E2E reset first.');
  }
  return pin;
}

function findForbiddenFields(value: unknown, pathPrefix = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenFields(item, `${pathPrefix}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const currentPath = `${pathPrefix}.${key}`;
    const normalized = key.toLocaleLowerCase('en-US');
    return [
      ...(FORBIDDEN_ADMIN_FIELDS.has(normalized) ? [currentPath] : []),
      ...findForbiddenFields(child, currentPath),
    ];
  });
}

async function expectPrivateAdminResponse(response: {
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}, pin: string) {
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const payload = await response.json() as unknown;
  expect(findForbiddenFields(payload)).toEqual([]);
  if (JSON.stringify(payload).includes(pin)) {
    throw new Error('Admin API response leaked the disposable E2E credential.');
  }
  return payload;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

async function loginAsAdmin(page: Page) {
  const pin = e2eAdminPin();
  await page.goto('/admin/login');

  const pinInput = page.getByLabel('PIN администратора');
  await expect(pinInput).toBeVisible();
  await expect(pinInput).not.toBeFocused();
  await expect(pinInput).toHaveAttribute('maxlength', '12');
  await expect(pinInput).toHaveAttribute('pattern', '[0-9]{4,12}');
  await pinInput.fill(pin);

  const loginResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/session' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Открыть аналитику' }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  expect(loginResponse.headers()['cache-control']).toContain('no-store');

  await expect(page).toHaveURL(/\/admin\/analytics$/u);
  await expect(page.getByRole('heading', { name: 'Тесты, кандидаты и банк вопросов.' })).toBeVisible();
  return pin;
}

async function ensureAnalyticsReady(page: Page) {
  const refresh = page.getByRole('button', { name: 'Обновить аналитику' });
  const overviewHeading = page.getByRole('tabpanel').getByRole('heading', { name: 'Общая картина' });
  await expect.poll(async () => (
    await refresh.isVisible().catch(() => false)
      || await overviewHeading.isVisible().catch(() => false)
  )).toBe(true);
  if (!await refresh.isVisible().catch(() => false)) return;
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/admin/analytics/refresh'
      && response.request().method() === 'POST'
  ));
  await refresh.click();
  expect((await responsePromise).status()).toBe(200);
  await expect(overviewHeading).toBeVisible({ timeout: 20_000 });
}

const mockCohort: AnalyticsCohortDto = {
  questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
  from: '2026-07-29',
  to: '2026-08-28',
  bankRevision: 'revision-b',
  scoringVersion: SCORING_VERSION,
  testConfigId: TEST_CONFIG_ID,
  testProfileId: TEST_PROFILE_ID,
  appVersion: null,
  topic: null,
  difficulty: null,
  questionKind: 'base',
  qualityStatus: 'all',
  minSample: 30,
  candidatePolicy: 'latest',
  eligibleAttempts: 2,
  eligibleAnswers: 40,
  generatedAt: '2026-08-28T12:00:00.000Z',
  warnings: [],
  statisticsCompleteness: 'complete',
  calibrationEnabled: true,
};

const emptyBreakdown = {
  assigned: 0,
  presented: 0,
  resolved: 0,
  correct: 0,
  incorrect: 0,
  timedOut: 0,
  earned: 0,
  max: 0,
  successRate: null,
} as const;

function mockQuestion(questionId: number, topic: string): QuestionAnalyticsItemDto {
  const successRate = questionId === 101 ? 82 : 54;
  const correctCount = questionId === 101 ? 41 : 27;
  return {
    questionId,
    promptPreview: questionId === 101
      ? 'Какой протокол разрешает имена в IP-адреса?'
      : 'Как определить причину высокой нагрузки Linux-сервера?',
    topic,
    difficulty: questionId === 101 ? 'easy' : 'hard',
    active: true,
    kind: 'base',
    assignedCount: 50,
    presentedCount: 50,
    outcomeCount: 50,
    sampleSize: 50,
    reliability: 'directional',
    completionRate: 100,
    successRate,
    timeoutRate: 4,
    averageSeconds: 11,
    medianSeconds: 10,
    minSeconds: 2,
    maxSeconds: 29,
    lastPresentedAt: '2026-08-28T11:00:00.000Z',
    lastAnsweredAt: '2026-08-28T11:00:10.000Z',
    discrimination: null,
    base: {
      ...emptyBreakdown,
      assigned: 50,
      presented: 50,
      resolved: 50,
      correct: correctCount,
      incorrect: 48 - correctCount,
      timedOut: 2,
      earned: 82,
      max: 100,
      successRate,
    },
    additional: emptyBreakdown,
    quality: { enabled: true, earned: 75, maxAvailable: 80, partial: true, status: 'good', critical: false, components: [] },
    qualityWarnings: [],
    recommendation: { code: 'keep', label: 'Оставить', reasons: [] },
    observed: {
      assignedCount: 50,
      presentedCount: 50,
      outcomeCount: 50,
      submittedCount: 48,
      correctCount,
      incorrectCount: 48 - correctCount,
      timeoutCount: 2,
      presentationRate: 100,
      responseRate: 96,
      completionRate: 100,
      successRate,
      timeoutRate: 4,
      timing: {
        sampleSize: 48,
        averageSeconds: 11,
        medianSeconds: 10,
        minSeconds: 2,
        maxSeconds: 29,
      },
    },
    sample: { n: 50, status: 'working', nextGate: 100, remaining: 50 },
    signals: [],
  };
}

function mockCandidate(attemptId: string, score: number): CandidateAnalyticsItemDto {
  return {
    attemptId,
    alias: `Кандидат ${attemptId.slice(-8)}`,
    completedAt: '2026-08-28T11:30:00.000Z',
    score,
    accuracy: score,
    verdict: score >= 75 ? 'PASS' : 'REVIEW',
    durationSeconds: 360,
    baseAnswered: 20,
    baseCorrect: Math.round(score / 5),
    additionalAnswered: 0,
    additionalCorrect: 0,
    timeoutCount: 0,
  };
}

async function mockAdminAnalyticsUi(page: Page) {
  const questionA = mockQuestion(101, 'Сети');
  const questionB = mockQuestion(202, 'Linux');
  const candidateA = mockCandidate('attempt-00000101', 84);
  const candidateB = mockCandidate('attempt-00000202', 68);
  const overviewPeriod: AnalyticsOverviewPeriodDto = {
    from: '2026-07-29',
    to: '2026-08-28',
    attempts: 2,
    completedAttempts: 2,
    abortedAttempts: 0,
    uniqueCandidates: 2,
    repeatAttempts: 0,
    meanScore: 76,
    medianScore: 76,
    meanAccuracy: 76,
    medianAccuracy: 76,
    meanDurationSeconds: 360,
    medianDurationSeconds: 360,
    verdicts: { PASS: 1, REVIEW: 1, FAIL: 0 },
    scoreHistogram: [{ from: 70, to: 79, count: 1 }, { from: 80, to: 89, count: 1 }],
    selectionComparison: {
      eligibleAttempts: 2,
      sampleSize: 1,
      actualCoverage: 62,
      shadowCoverage: 74,
      delta: 12,
      fallbackOrNullCount: 1,
      fallbackOrNullRate: 50,
    },
  };
  const questionDetail: QuestionAnalyticsDetailDto = {
    ...questionA,
    bankRevision: 'revision-b',
    prompt: 'Какой протокол разрешает имена в IP-адреса?',
    contextType: null,
    context: null,
    responseCount: 50,
    choices: [
      { canonicalIndex: 0, selectedCount: 41, selectedRate: 82 },
      { canonicalIndex: 1, selectedCount: 9, selectedRate: 18 },
    ],
    reviewHistory: [],
  };
  const candidateDetail: CandidatePrintDto = {
    ...candidateA,
    generatedAt: candidateA.completedAt,
    statisticsCompleteness: 'complete',
    topics: [],
    difficulties: [],
    interviewerRecommendations: [],
  };

  await page.route('**/api/admin/analytics/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    let payload: unknown;
    if (pathname.endsWith('/overview')) {
      payload = { cohort: mockCohort, last30Days: overviewPeriod, allTime: overviewPeriod };
    } else if (pathname.endsWith('/trends')) {
      payload = {
        cohort: mockCohort,
        items: [{
          date: '2026-08-28', attempts: 2, averageScore: 76, medianScore: 76,
          averageAccuracy: 76, passRate: 50, averageDurationSeconds: 360, medianDurationSeconds: 360,
          verdicts: { PASS: 1, REVIEW: 1, FAIL: 0 },
          topics: [{ key: 'Сети', outcomeCount: 20, successRate: 80, timeoutRate: 5 }, { key: 'Linux', outcomeCount: 20, successRate: 60, timeoutRate: 10 }],
          difficulties: [{ key: 'easy', outcomeCount: 20, successRate: 85, timeoutRate: 5 }, { key: 'hard', outcomeCount: 20, successRate: 55, timeoutRate: 10 }],
        }],
      };
    } else if (pathname.endsWith('/revisions/compare')) {
      payload = {
        cohort: mockCohort,
        left: { revision: 'revision-a', attempts: 1, meanScore: 70, medianScore: 70, meanAccuracy: 70, medianAccuracy: 70, meanDurationSeconds: 400, medianDurationSeconds: 400, verdicts: { PASS: 0, REVIEW: 1, FAIL: 0 } },
        right: { revision: 'revision-b', attempts: 1, meanScore: 82, medianScore: 82, meanAccuracy: 82, medianAccuracy: 82, meanDurationSeconds: 320, medianDurationSeconds: 320, verdicts: { PASS: 1, REVIEW: 0, FAIL: 0 } },
        deltas: { attempts: 0, meanScore: 12, medianScore: 12, meanAccuracy: 12, medianAccuracy: 12, meanDurationSeconds: -80, medianDurationSeconds: -80, verdicts: { PASS: 1, REVIEW: -1, FAIL: 0 } },
      };
    } else if (pathname.endsWith('/revisions')) {
      payload = {
        cohort: mockCohort,
        items: [
          { revision: 'revision-b', attempts: 1, firstCompletedAt: candidateA.completedAt, lastCompletedAt: candidateA.completedAt, averageScore: 82, averageAccuracy: 82 },
          { revision: 'revision-a', attempts: 1, firstCompletedAt: candidateB.completedAt, lastCompletedAt: candidateB.completedAt, averageScore: 70, averageAccuracy: 70 },
        ],
      };
    } else if (/\/questions\/101$/u.test(pathname)) {
      payload = questionDetail;
    } else if (pathname.endsWith('/questions')) {
      payload = url.searchParams.has('cursor')
        ? {
            cohort: mockCohort,
            questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
            items: [questionA, questionB],
            totalCount: 2,
            summary: { total: 2, review: 0, observe: 0, good: 2, insufficient: 0, disabled: 0 },
            nextCursor: null,
          }
        : {
            cohort: mockCohort,
            questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
            items: [questionA],
            totalCount: 2,
            summary: { total: 2, review: 0, observe: 0, good: 2, insufficient: 0, disabled: 0 },
            nextCursor: 'questions-next',
          };
    } else if (/\/candidates\/attempt-00000101$/u.test(pathname)) {
      payload = candidateDetail;
    } else if (pathname.endsWith('/candidates')) {
      payload = url.searchParams.has('cursor')
        ? { cohort: mockCohort, items: [candidateA, candidateB], nextCursor: null }
        : { cohort: mockCohort, items: [candidateA], nextCursor: 'candidates-next' };
    } else if (pathname.endsWith('/topics') || pathname.endsWith('/difficulty')) {
      payload = { cohort: mockCohort, items: [] };
    } else {
      await route.fulfill({ status: 500, json: { error: 'unexpected_mock_route' } });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'Cache-Control': 'no-store' }, json: payload });
  });
}

test('admin analytics работает на iPad и не раскрывает ключи ответов', async ({ page }) => {
  const pin = await loginAsAdmin(page);
  await ensureAnalyticsReady(page);
  await expectNoHorizontalOverflow(page);

  const overviewTab = page.getByRole('tab', { name: 'Обзор' });
  await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Общая картина' })).toBeVisible();

  const defaultQuestionsResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/admin/analytics/questions'
  ));
  await page.getByRole('tab', { name: 'Аналитика вопросов' }).click();
  const defaultQuestionsResponse = await defaultQuestionsResponsePromise;
  const defaultQuestionsUrl = new URL(defaultQuestionsResponse.url());
  for (const parameter of ['scoringVersion', 'testConfigId', 'testProfileId', 'appVersion']) {
    expect(defaultQuestionsUrl.searchParams.has(parameter)).toBe(false);
  }
  const defaultQuestionsPayload = await expectPrivateAdminResponse(defaultQuestionsResponse, pin) as {
    cohort: { scoringVersion: number; testConfigId: string; testProfileId: string; appVersion: string | null };
  };
  expect(defaultQuestionsPayload.cohort).toMatchObject({
    scoringVersion: SCORING_VERSION,
    testConfigId: TEST_CONFIG_ID,
    testProfileId: TEST_PROFILE_ID,
    appVersion: null,
  });

  const questionsResponse = await page.request.get(
    '/api/admin/analytics/questions?questionKind=base&qualityStatus=all&minSample=30&candidatePolicy=latest',
  );
  await expectPrivateAdminResponse(questionsResponse, pin);

  const exportResponse = await page.request.get(
    '/api/admin/analytics/export?format=json&questionKind=base&qualityStatus=all&minSample=30&candidatePolicy=latest',
  );
  const exportPayload = await expectPrivateAdminResponse(exportResponse, pin) as {
    questionAnalyticsModelVersion: number;
    cohort: { questionAnalyticsModelVersion: number };
    rows: Array<Record<string, unknown>>;
  };
  expect(exportPayload.questionAnalyticsModelVersion).toBe(QUESTION_ANALYTICS_MODEL_VERSION);
  expect(exportPayload.cohort.questionAnalyticsModelVersion).toBe(QUESTION_ANALYTICS_MODEL_VERSION);
  expect(exportPayload.rows.every((row) => (
    row.questionAnalyticsModelVersion === QUESTION_ANALYTICS_MODEL_VERSION
  ))).toBe(true);
  expect(exportResponse.headers()['content-disposition']).toContain('attachment;');

  const csvResponse = await page.request.get(
    '/api/admin/analytics/export?format=csv&questionKind=base&qualityStatus=all&minSample=30&candidatePolicy=latest',
  );
  expect(csvResponse.status()).toBe(200);
  expect(csvResponse.headers()['cache-control']).toContain('no-store');
  expect(csvResponse.headers()['content-disposition']).toContain('attachment;');
  expect(csvResponse.headers()['content-type']).toContain('text/csv');
  const csv = await csvResponse.text();
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain(';');
  expect(csv).toContain('analytics_model_version;question_id;topic;difficulty;kind');
  expect(csv).toContain('observed_correct');
  expect(csv).toContain('sample_status');
  expect(csv).toContain('signals');
  expect(csv).not.toContain(pin);

  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes(pin)) throw new Error('Admin UI rendered the disposable E2E credential.');
  expect(bodyText).not.toContain('Правильный ответ');
  expect(bodyText).not.toContain('Выбранный ответ');
  expect(bodyText).not.toContain('TELEGRAM_BOT_TOKEN');
  expect(bodyText).not.toContain('ADMIN_PIN_HASH');

  const tabs = [
    ['Аналитика вопросов', 'Качество вопросов'],
    ['Банк вопросов', 'Все вопросы и их редакции'],
    ['Кандидаты', 'Кандидаты'],
    ['Темы', 'Аналитика по темам'],
    ['Сложность', 'Аналитика по сложности'],
    ['Описание', 'Описание всех функций'],
    ['Обзор', 'Общая картина'],
  ] as const;
  for (const [tabName, heading] of tabs) {
    const tab = page.getByRole('tab', { name: tabName });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel').getByRole('heading', { name: heading })).toBeVisible();
  }

  await page.getByRole('tab', { name: 'Описание' }).click();
  await expect(page).toHaveURL(/\?tab=help$/u);
  const helpPanel = page.getByRole('tabpanel');
  await expect(helpPanel.getByRole('navigation', { name: 'Содержание описания функций' })).toBeVisible();
  await expect(helpPanel.getByText('Архивированный вопрос', { exact: true })).toBeVisible();
  await expect(helpPanel.getByText('Не выбирается для новых тестов, но остаётся в истории и аналитике.', { exact: true })).toBeVisible();
  await expect(page.getByText('Изменить выборку', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Экспорт когорты', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('tab', { name: 'Аналитика вопросов' }).click();
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Качество вопросов' })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Изменить выборку' }).click();
  await page.locator('summary > span').filter({ hasText: 'Техническая модель' }).click();
  await page.getByLabel('Версия scoring').fill(String(SCORING_VERSION));
  await page.getByLabel('Конфигурация теста').fill(TEST_CONFIG_ID);
  await page.getByLabel('Профиль теста').fill(TEST_PROFILE_ID);
  await page.getByLabel('Версия приложения').fill(APP_RELEASE);
  await page.getByLabel('Тип вопроса').selectOption('all');
  await page.getByLabel('Тема').fill('Сети');
  await page.getByLabel('Порог агрегатов').selectOption('50');
  await page.getByLabel('Повторные попытки').selectOption('all');

  const filteredResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/questions'
      && url.searchParams.get('questionKind') === 'all'
      && url.searchParams.get('scoringVersion') === String(SCORING_VERSION)
      && url.searchParams.get('testConfigId') === TEST_CONFIG_ID
      && url.searchParams.get('testProfileId') === TEST_PROFILE_ID
      && url.searchParams.get('appVersion') === APP_RELEASE
      && url.searchParams.get('topic') === 'Сети'
      && url.searchParams.get('minSample') === '50'
      && url.searchParams.get('candidatePolicy') === 'all';
  });
  await page.getByRole('button', { name: 'Применить' }).click();
  const filteredResponse = await filteredResponsePromise;
  await expectPrivateAdminResponse(filteredResponse, pin);
  await expect(page.getByRole('tabpanel').getByText('Ничего не найдено', { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const touchTargetHeights = await page.getByRole('tab').evaluateAll((tabs) => (
    tabs.map((tab) => Math.round(tab.getBoundingClientRect().height))
  ));
  expect(touchTargetHeights.every((height) => height >= 44)).toBe(true);

  const logoutResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/session' && response.request().method() === 'DELETE';
  });
  await page.getByRole('button', { name: 'Выйти' }).click();
  expect((await logoutResponsePromise).status()).toBe(204);
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await expect(page.getByLabel('PIN администратора')).toBeVisible();

  const loggedOutResponse = await page.request.get('/api/admin/analytics/overview');
  expect(loggedOutResponse.status()).toBe(401);
  expect(loggedOutResponse.headers()['cache-control']).toContain('no-store');
  expect(await loggedOutResponse.json()).toEqual({ error: 'unauthorized' });
});

test('admin analytics показывает пагинацию, детали, динамику и сравнение ревизий', async ({ page }) => {
  await loginAsAdmin(page);
  await ensureAnalyticsReady(page);
  await mockAdminAnalyticsUi(page);
  await page.reload();

  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Общая картина' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сравнение ревизий' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '+12' }).first()).toBeVisible();
  await expect(page.getByText('Без сравнения', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Темы', exact: true }).click();
  await expect(page.getByText('Сети', { exact: true })).toBeVisible();
  await expect(page.getByText('Linux', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сложность', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByText('Базовый', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText('Сложный', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Аналитика вопросов' }).click();
  const qualitySummary = page.getByRole('region', { name: 'Сводка качества вопросов' });
  await expect(qualitySummary).toContainText('Вопросов в выборке');
  await expect(qualitySummary).toContainText('Требуют проверки');
  await expect(qualitySummary).toContainText('Наблюдать');
  await expect(qualitySummary).toContainText('Мало данных');
  for (const heading of ['Вопрос', 'Статус', 'Данные', 'Результаты', 'Время', 'Действие']) {
    await expect(page.getByRole('columnheader', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByText('Верно 41 из 50 · 82%', { exact: true })).toBeVisible();
  await expect(page.getByText('Тайм-ауты 2 из 50 · 4%', { exact: true })).toBeVisible();
  await expect(page.getByText('n=50', { exact: true })).toBeVisible();
  await expect(page.getByText('Рабочая оценка', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть аналитику вопроса 101' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(page.getByRole('button', { name: 'Открыть аналитику вопроса 202' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть аналитику вопроса 101' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Открыть аналитику вопроса 101' }).click();
  const questionDialog = page.getByRole('dialog', { name: 'Вопрос #101' });
  await expect(questionDialog).toBeVisible();
  await expect(questionDialog.getByRole('heading', {
    name: 'Какой протокол разрешает имена в IP-адреса?',
  })).toBeVisible();
  for (const section of [
    'Диагноз',
    'Достоверность',
    'Доказательства',
    'Индекс качества вопроса',
    'Распределение A / B / C / D',
    'Следующее действие',
    'Решение администратора',
  ]) {
    await expect(questionDialog.getByText(section, { exact: true }).first()).toBeVisible();
  }
  await expect(questionDialog.getByText('41 из 50 · 82%', { exact: true })).toBeVisible();
  await expect(questionDialog.getByText('2 из 50 · 4%', { exact: true })).toBeVisible();
  await expect(questionDialog.getByText('75 из доступных 80', { exact: true })).toBeVisible();
  await expect(questionDialog.getByText(/Индекс неполный/u)).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.goto('/admin/analytics?tab=questions&questionId=101');
  await expect(page.getByRole('dialog', { name: 'Вопрос #101' })).toBeVisible();
  await expect(page.getByLabel('Поиск по всему банку')).toHaveValue('101');
  await page.getByRole('dialog', { name: 'Вопрос #101' })
    .getByRole('button', { name: 'Закрыть' }).click();
  await expect(page).toHaveURL(/\/admin\/analytics\?tab=questions$/u);

  const searchResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/questions'
      && url.searchParams.get('q') === 'Linux';
  });
  await page.getByLabel('Поиск по всему банку').fill('Linux');
  await page.getByRole('button', { name: 'Найти' }).click();
  expect((await searchResponsePromise).status()).toBe(200);
  const sortResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/analytics/questions'
      && url.searchParams.get('sort') === 'timeout'
      && url.searchParams.get('direction') === 'desc';
  });
  await page.getByLabel('Порядок').selectOption('timeout:desc');
  expect((await sortResponsePromise).status()).toBe(200);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('tab', { name: 'Кандидаты' }).click();
  await expect(page.getByRole('button', { name: 'Кандидат 00000101' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(page.getByRole('button', { name: 'Кандидат 00000202' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Кандидат 00000101' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Кандидат 00000101' }).click();
  await expect(page.getByRole('dialog', { name: 'Кандидат 00000101' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Печать' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'JSON' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
