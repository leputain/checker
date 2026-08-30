import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type {
  QuestionAdminDetailResponseDto,
  QuestionAdminHistoryDto,
  QuestionAdminListDto,
  QuestionAdminMutationDto,
} from '../lib/question-admin-contract.ts';

const E2E_ADMIN_PIN_PATH = path.resolve('.data', 'e2e-admin-pin.txt');

function e2eAdminPin() {
  const pin = readFileSync(E2E_ADMIN_PIN_PATH, 'utf8').trim();
  if (!/^\d{6,12}$/u.test(pin)) throw new Error('Disposable E2E admin PIN is invalid.');
  return pin;
}

async function login(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('PIN администратора').fill(e2eAdminPin());
  await page.getByRole('button', { name: 'Открыть аналитику' }).click();
  await expect(page).toHaveURL(/\/admin\/analytics$/u);
  const response = await page.request.get('/api/admin/session');
  expect(response.status()).toBe(200);
  const session = await response.json() as { csrfToken?: string };
  expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/u);
  return session.csrfToken!;
}

async function json<T>(response: APIResponse, status: number) {
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toContain('no-store');
  return response.json() as Promise<T>;
}

function mutationHeaders(csrfToken: string) {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    Origin: 'http://localhost:3101',
    'Sec-Fetch-Site': 'same-origin',
  };
}

function draft(
  suffix: string,
  revision: string,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    topic: `E2E ${suffix}`,
    difficulty: 'easy',
    prompt: `Какой результат ожидается в изолированном сценарии ${suffix}?`,
    contextType: null,
    context: null,
    choices: ['Ожидаемый результат', 'Побочный эффект', 'Нет изменений', 'Ошибка конфигурации'],
    correctIndex: 0,
    dedupeKey: `e2e:${suffix.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
    active: true,
    note: 'Изолированная E2E-проверка',
    expectedBankRevision: revision,
    idempotencyKey,
    ...overrides,
  };
}

test('API банка сохраняет immutable-редакции, CAS и идемпотентность', async ({ page }, testInfo) => {
  const anonymous = await page.request.get('/api/admin/questions');
  expect(anonymous.status()).toBe(401);

  const csrfToken = await login(page);
  const initial = await json<QuestionAdminListDto>(
    await page.request.get('/api/admin/questions?limit=5'),
    200,
  );
  expect(initial.bankCounts.total).toBeGreaterThanOrEqual(initial.bankCounts.active);
  expect(initial.bankCounts.inactive).toBe(
    initial.bankCounts.total - initial.bankCounts.active,
  );
  expect(initial.readiness.ready).toBe(true);
  expect(initial.nextCursor).not.toBeNull();
  const suffix = `${testInfo.project.name}-${randomUUID().slice(0, 8)}`;
  const createKey = `create-${randomUUID()}`;
  const createBody = draft(suffix, initial.currentBankRevision, createKey);

  const csrfRejected = await page.request.post('/api/admin/questions', { data: createBody });
  expect(csrfRejected.status()).toBe(403);
  expect(await csrfRejected.json()).toEqual({ error: 'csrf_invalid' });
  const wrongCsrf = await page.request.post('/api/admin/questions', {
    headers: mutationHeaders('wrong-csrf-token'),
    data: createBody,
  });
  expect(wrongCsrf.status()).toBe(403);
  expect(await wrongCsrf.json()).toEqual({ error: 'csrf_invalid' });

  const created = await json<QuestionAdminMutationDto>(await page.request.post(
    '/api/admin/questions',
    { headers: mutationHeaders(csrfToken), data: createBody },
  ), 201);
  expect(created.question.id).toBeGreaterThanOrEqual(1_000_000);
  expect(created.question.active).toBe(true);
  expect(created.currentBankRevision).not.toBe(initial.currentBankRevision);

  const stalePage = await page.request.get(
    `/api/admin/questions?limit=5&cursor=${encodeURIComponent(initial.nextCursor!)}`,
  );
  expect(stalePage.status()).toBe(409);
  expect(await stalePage.json()).toMatchObject({ error: 'bank_revision_conflict' });

  const replay = await json<QuestionAdminMutationDto>(await page.request.post(
    '/api/admin/questions',
    { headers: mutationHeaders(csrfToken), data: createBody },
  ), 201);
  expect(replay).toEqual(created);

  const idempotencyConflict = await page.request.post('/api/admin/questions', {
    headers: mutationHeaders(csrfToken),
    data: { ...createBody, note: 'Другой payload с тем же ключом' },
  });
  expect(idempotencyConflict.status()).toBe(409);
  expect(await idempotencyConflict.json()).toMatchObject({ error: 'idempotency_conflict' });

  const stale = await page.request.post('/api/admin/questions', {
    headers: mutationHeaders(csrfToken),
    data: draft(`${suffix}-stale`, initial.currentBankRevision, `stale-${randomUUID()}`),
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'bank_revision_conflict' });

  const revisionKey = `revise-${randomUUID()}`;
  const revisionBody = draft(suffix, created.currentBankRevision, revisionKey, {
    topic: `E2E Сети ${suffix}`,
    difficulty: 'hard',
    prompt: `Как проверить сетевую доступность в сценарии ${suffix}?`,
    dedupeKey: `e2e:network-${suffix.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
    note: 'Переназначены тема и сложность',
  });
  const revised = await json<QuestionAdminMutationDto>(await page.request.put(
    `/api/admin/questions/${created.question.id}`,
    { headers: mutationHeaders(csrfToken), data: revisionBody },
  ), 201);
  expect(revised.previousQuestionId).toBe(created.question.id);
  expect(revised.question.id).toBeGreaterThan(created.question.id);
  expect(revised.question.topic).toBe(`E2E Сети ${suffix}`);
  expect(revised.question.difficulty).toBe('hard');

  const reviseReplay = await json<QuestionAdminMutationDto>(await page.request.put(
    `/api/admin/questions/${created.question.id}`,
    { headers: mutationHeaders(csrfToken), data: revisionBody },
  ), 201);
  expect(reviseReplay).toEqual(revised);

  const oldDetail = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${created.question.id}`),
    200,
  );
  expect(oldDetail.question.active).toBe(false);
  expect(oldDetail.question.successorId).toBe(revised.question.id);
  expect(oldDetail.question.prompt).toBe(createBody.prompt);
  const newDetail = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${revised.question.id}`),
    200,
  );
  expect(newDetail.question.predecessorId).toBe(created.question.id);
  expect(newDetail.lineage.map((item) => item.id)).toEqual([
    created.question.id,
    revised.question.id,
  ]);
  expect(newDetail.history.map((event) => event.eventType)).toEqual(['created', 'revised']);
  expect(JSON.stringify(newDetail)).not.toContain(e2eAdminPin());

  const supersededActivation = await page.request.patch(
    `/api/admin/questions/${created.question.id}`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        active: true,
        expectedBankRevision: revised.currentBankRevision,
        idempotencyKey: `superseded-${randomUUID()}`,
      },
    },
  );
  expect(supersededActivation.status()).toBe(409);
  expect(await supersededActivation.json()).toMatchObject({ error: 'question_has_successor' });

  const toggleKey = `toggle-${randomUUID()}`;
  const toggleBody = {
    active: false,
    note: 'Проверка выключения',
    expectedBankRevision: revised.currentBankRevision,
    idempotencyKey: toggleKey,
  };
  const deactivated = await json<QuestionAdminMutationDto>(await page.request.patch(
    `/api/admin/questions/${revised.question.id}`,
    { headers: mutationHeaders(csrfToken), data: toggleBody },
  ), 200);
  expect(deactivated.question.active).toBe(false);
  const toggleReplay = await json<QuestionAdminMutationDto>(await page.request.patch(
    `/api/admin/questions/${revised.question.id}`,
    { headers: mutationHeaders(csrfToken), data: toggleBody },
  ), 200);
  expect(toggleReplay).toEqual(deactivated);

  const activated = await json<QuestionAdminMutationDto>(await page.request.patch(
    `/api/admin/questions/${revised.question.id}`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        active: true,
        note: 'Проверка обратного включения актуальной редакции',
        expectedBankRevision: deactivated.currentBankRevision,
        idempotencyKey: `activate-${randomUUID()}`,
      },
    },
  ), 200);
  expect(activated.question.active).toBe(true);
  const history = await json<QuestionAdminHistoryDto>(await page.request.get(
    `/api/admin/questions/${revised.question.id}/history`,
  ), 200);
  expect(history.items.map((event) => event.eventType)).toEqual([
    'created',
    'revised',
    'deactivated',
    'activated',
  ]);

  const invalid = await page.request.post('/api/admin/questions', {
    headers: mutationHeaders(csrfToken),
    data: draft(`${suffix}-invalid`, activated.currentBankRevision, `invalid-${randomUUID()}`, {
      prompt: 'x'.repeat(281),
    }),
  });
  expect(invalid.status()).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: 'question_validation_failed' });
  const invalidTopic = await page.request.post('/api/admin/questions', {
    headers: mutationHeaders(csrfToken),
    data: draft(`${suffix}-invalid-topic`, activated.currentBankRevision, `invalid-topic-${randomUUID()}`, {
      topic: 'Я'.repeat(81),
    }),
  });
  expect(invalidTopic.status()).toBe(422);
  expect(await invalidTopic.json()).toMatchObject({ error: 'question_validation_failed' });

  const afterReload = await json<QuestionAdminListDto>(await page.request.get(
    `/api/admin/questions?q=${revised.question.id}&limit=10`,
  ), 200);
  expect(afterReload.items.some((item) => item.id === revised.question.id)).toBe(true);
  expect(afterReload.currentBankRevision).toBe(activated.currentBankRevision);

  const concurrencyRevision = afterReload.currentBankRevision;
  const concurrentBodies = [0, 1].map((index) => draft(
    `${suffix}-concurrent-${index}`,
    concurrencyRevision,
    `concurrent-${index}-${randomUUID()}`,
  ));
  const concurrent = await Promise.all(concurrentBodies.map((data) => page.request.post(
    '/api/admin/questions',
    { headers: mutationHeaders(csrfToken), data },
  )));
  expect(concurrent.map((response) => response.status()).sort()).toEqual([201, 409]);
});

test('iPad UI создаёт вопрос и выпускает новую категорию редакцией', async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole('tab', { name: 'Вопросы', exact: true }).click();
  await page.getByRole('tab', { name: 'Банк вопросов', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Просмотр и безопасное редактирование' })).toBeVisible();
  await expect(page.getByText('Правильный ответ', { exact: true })).toHaveCount(0);
  expect(await page.getByRole('button', { name: 'Новый вопрос' }).evaluate((button) => (
    Math.round(button.getBoundingClientRect().height)
  ))).toBeGreaterThanOrEqual(44);

  const suffix = `${testInfo.project.name}-${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Новый вопрос' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Новый вопрос' });
  await createDialog.getByLabel('Тема').fill(`UI ${suffix}`);
  await page.keyboard.press('Escape');
  const discardDialog = page.getByRole('alertdialog', { name: 'Отменить несохранённые изменения?' });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Сложность').selectOption('easy');
  await createDialog.getByLabel('Смысловая группа').fill(
    `ui:${suffix.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
  );
  await createDialog.getByLabel('Текст вопроса').fill(`Как работает UI-редактор ${suffix}?`);
  await createDialog.getByLabel('Вариант A').fill('Корректно и атомарно');
  await createDialog.getByLabel('Вариант B').fill('Только после перезапуска');
  await createDialog.getByLabel('Вариант C').fill('Без сохранения истории');
  await createDialog.getByLabel('Вариант D').fill('С изменением старого ID');
  const createResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/admin/questions'
      && response.request().method() === 'POST'
  ));
  await createDialog.getByRole('button', { name: 'Создать вопрос', exact: true }).click();
  expect((await createResponse).status()).toBe(201);

  const viewer = page.getByRole('dialog', { name: /Вопрос #\d+/u });
  await expect(viewer.getByText('Правильный ответ')).toBeVisible();
  const originalTitle = await viewer.getByRole('heading', { name: /Вопрос #\d+/u }).innerText();
  const originalId = Number(originalTitle.replace(/\D/gu, ''));
  await viewer.getByRole('button', { name: 'Создать новую редакцию' }).click();
  const reviseDialog = page.getByRole('dialog', { name: `Новая редакция #${originalId}` });
  await reviseDialog.getByLabel('Тема').fill(`UI Security ${suffix}`);
  await reviseDialog.getByLabel('Сложность').selectOption('medium');
  const reviseResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/api/admin/questions/${originalId}`
      && response.request().method() === 'PUT'
  ));
  await reviseDialog.getByRole('button', { name: 'Создать новую редакцию', exact: true }).click();
  expect((await reviseResponse).status()).toBe(201);

  const revisedViewer = page.getByRole('dialog', { name: /Вопрос #\d+/u });
  await expect(revisedViewer.getByText(`UI Security ${suffix}`, { exact: true })).toBeVisible();
  await expect(revisedViewer.getByText('Средний', { exact: true })).toBeVisible();
  await expect(revisedViewer.getByRole('button', { name: `#${originalId}`, exact: true })).toBeVisible();
  await expect(revisedViewer.getByText('Создана новая редакция', { exact: true })).toBeVisible();

  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
});
