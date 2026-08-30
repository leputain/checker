import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type {
  QuestionAdminDetailResponseDto,
  QuestionAdminListDto,
  QuestionAdminMutationDto,
  QuestionBankBatchMutationDto,
  QuestionBankChangeSetDetailDto,
  QuestionBankChangeSetPreviewDto,
  QuestionBankCoverageDto,
  QuestionBankExportDto,
  QuestionImportApplyDto,
  QuestionImportDraftDto,
  QuestionImportPreviewDto,
  QuestionCategoryListDto,
  QuestionCategoryMutationDto,
} from '../lib/question-admin-contract.ts';
import { GENERAL_TOPIC_PLAN } from '../lib/test-config.ts';
import { queryLocalD1, runWrangler } from '../scripts/local-d1.ts';

const E2E_ADMIN_PIN_PATH = path.resolve('.data', 'e2e-admin-pin.txt');
const E2E_STATE_PATH = path.resolve('.wrangler', 'e2e');
const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/iu;

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

async function openQuestionBank(page: Page) {
  await page.getByRole('tab', { name: 'Вопросы', exact: true }).click();
  await page.getByRole('tab', { name: 'Банк вопросов', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Просмотр и безопасное редактирование' }))
    .toBeVisible();
}

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
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

function questionDraft(topic: string, suffix: string, revision: string) {
  const marker = randomBytes(15).toString('hex').match(/.{6}/gu)?.join(' ') ?? randomUUID();
  return {
    topic,
    difficulty: 'easy',
    prompt: `Какой результат ожидается для атомарного пакета ${suffix} ${marker}?`,
    contextType: null,
    context: null,
    choices: ['Одна целостная ревизия', 'Частичная запись', 'Изменение старого ID', 'Обход проверки'],
    correctIndex: 0,
    dedupeKey: `workflow:${suffix.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '-')}`,
    active: true,
    note: 'E2E workflow',
    expectedBankRevision: revision,
    idempotencyKey: `question-${randomUUID()}`,
  };
}

function cleanupAttempt(attemptId: string) {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) return;
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `DELETE FROM answers WHERE attempt_id = '${attemptId}';
     DELETE FROM telegram_outbox WHERE attempt_id = '${attemptId}';
     DELETE FROM attempts WHERE id = '${attemptId}';`,
  ], E2E_STATE_PATH);
}

function workflowCounts() {
  return queryLocalD1<{
    questions: number;
    revisions: number;
    events: number;
    mutations: number;
    changeSets: number;
    changeSetItems: number;
    currentRevision: string;
  }>(`SELECT
      (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM question_bank_revisions) AS revisions,
      (SELECT COUNT(*) FROM question_bank_change_events) AS events,
      (SELECT COUNT(*) FROM question_bank_mutations) AS mutations,
      (SELECT COUNT(*) FROM question_bank_change_sets) AS changeSets,
      (SELECT COUNT(*) FROM question_bank_change_set_items) AS changeSetItems,
      (SELECT current_revision FROM question_bank_state WHERE id = 1) AS currentRevision`,
  E2E_STATE_PATH)[0];
}

function importQuestion(
  topic: string,
  suffix: string,
  index: number,
): QuestionImportDraftDto {
  const marker = randomBytes(15).toString('hex').match(/.{6}/gu)?.join(' ') ?? randomUUID();
  return {
    topic,
    difficulty: 'easy',
    prompt: `E2E ${suffix}-${index.toString(36)} уникальная проверка ${marker}`,
    choices: [
      `Целостный результат ${index}`,
      `Частичная запись ${index}`,
      `Обход проверки ${index}`,
      `Потеря ревизии ${index}`,
    ],
    correctIndex: 0,
    dedupeKey: `e2e:import:${suffix}:${index}`,
    active: true,
  };
}

function startAttemptHeaders(startKey: string) {
  return { 'Idempotency-Key': startKey };
}

function installChangeSetRaceTrigger(triggerName: string, idempotencyKey: string, changeSetId: string) {
  if (!/^e2e_[a-z0-9_]+$/u.test(triggerName)) throw new Error('Unsafe E2E trigger name.');
  if (!/^[A-Za-z0-9:_-]{8,128}$/u.test(idempotencyKey)) {
    throw new Error('Unsafe E2E idempotency key.');
  }
  if (!ATTEMPT_ID_PATTERN.test(changeSetId)) throw new Error('Unsafe E2E change-set id.');
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON question_bank_mutations
       WHEN NEW.idempotency_key = '${idempotencyKey}'
       BEGIN
         UPDATE question_bank_change_sets SET updated_at = updated_at + 1
         WHERE id = '${changeSetId}';
       END;`,
  ], E2E_STATE_PATH);
}

function dropChangeSetRaceTrigger(triggerName: string) {
  if (!/^e2e_[a-z0-9_]+$/u.test(triggerName)) throw new Error('Unsafe E2E trigger name.');
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `DROP TRIGGER IF EXISTS ${triggerName};`,
  ], E2E_STATE_PATH);
}

function installCategoryRaceTrigger(
  triggerName: string,
  idempotencyKey: string,
  categoryId: number,
) {
  if (!/^e2e_[a-z0-9_]+$/u.test(triggerName)) throw new Error('Unsafe E2E trigger name.');
  if (!/^[A-Za-z0-9:_-]{8,128}$/u.test(idempotencyKey)) {
    throw new Error('Unsafe E2E idempotency key.');
  }
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
    throw new Error('Unsafe E2E category id.');
  }
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON question_bank_mutations
       WHEN NEW.idempotency_key = '${idempotencyKey}'
       BEGIN
         UPDATE question_categories SET active = 0, updated_at = updated_at + 1
         WHERE id = ${categoryId};
       END;`,
  ], E2E_STATE_PATH);
}

test('категории и массовые операции сохраняют immutable/atomic семантику', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 семантика не зависит от orientation.');
  expect((await page.request.get('/api/admin/questions/categories')).status()).toBe(401);
  const csrfToken = await login(page);
  const initial = await json<QuestionAdminListDto>(
    await page.request.get('/api/admin/questions?limit=5&status=all'),
    200,
  );
  const suffix = randomUUID().slice(0, 8);
  const sourceName = `Сети Пакет-${suffix}`;
  const targetName = `Целевая категория ${suffix}`;
  const categoryBody = (name: string, key: string) => ({
    name,
    expectedBankRevision: initial.currentBankRevision,
    idempotencyKey: `${key}-${randomUUID()}`,
  });
  const source = await json<QuestionCategoryMutationDto>(
    await page.request.post('/api/admin/questions/categories', {
      headers: mutationHeaders(csrfToken),
      data: categoryBody(`  ${sourceName.replace(' ', '\u00a0  ')}  `, 'category-source'),
    }),
    201,
  );
  expect(source.category.name).toBe(sourceName);
  expect(source.currentBankRevision).toBe(initial.currentBankRevision);
  const target = await json<QuestionCategoryMutationDto>(
    await page.request.post('/api/admin/questions/categories', {
      headers: mutationHeaders(csrfToken),
      data: categoryBody(targetName, 'category-target'),
    }),
    201,
  );
  expect(target.currentBankRevision).toBe(initial.currentBankRevision);
  const staleCategoryName = await page.request.put(
    `/api/admin/questions/categories/${target.category.id}`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        name: `${targetName} renamed`,
        expectedCategoryName: `${targetName} stale`,
        expectedBankRevision: initial.currentBankRevision,
        idempotencyKey: `category-stale-name-${randomUUID()}`,
      },
    },
  );
  expect(staleCategoryName.status()).toBe(409);
  expect(await staleCategoryName.json()).toMatchObject({ error: 'category_conflict' });

  const duplicate = await page.request.post('/api/admin/questions/categories', {
    headers: mutationHeaders(csrfToken),
    data: categoryBody(`сети\u00a0\u00a0пакет-${suffix}`, 'category-duplicate'),
  });
  expect(duplicate.status()).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: 'category_conflict' });

  const first = await json<QuestionAdminMutationDto>(
    await page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(sourceName, `first-${suffix}`, initial.currentBankRevision),
    }),
    201,
  );
  const second = await json<QuestionAdminMutationDto>(
    await page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(sourceName, `second-${suffix}`, first.currentBankRevision),
    }),
    201,
  );

  const merged = await json<QuestionCategoryMutationDto>(
    await page.request.post(`/api/admin/questions/categories/${source.category.id}/merge`, {
      headers: mutationHeaders(csrfToken),
      data: {
        targetCategoryId: target.category.id,
        expectedCategoryName: source.category.name,
        expectedBankRevision: second.currentBankRevision,
        idempotencyKey: `category-merge-${randomUUID()}`,
        note: 'E2E atomic merge',
      },
    }),
    200,
  );
  expect(merged.changedQuestionCount).toBe(2);
  expect(merged.replacements).toHaveLength(2);
  expect(new Set(merged.replacements.map((item) => item.questionId)).size).toBe(2);
  const firstReplacement = merged.replacements.find(
    (item) => item.previousQuestionId === first.question.id,
  )!;
  const secondReplacement = merged.replacements.find(
    (item) => item.previousQuestionId === second.question.id,
  )!;
  for (const replacement of merged.replacements) {
    const oldDetail = await json<QuestionAdminDetailResponseDto>(
      await page.request.get(`/api/admin/questions/${replacement.previousQuestionId}`),
      200,
    );
    expect(oldDetail.question.active).toBe(false);
    expect(oldDetail.question.successorId).toBe(replacement.questionId);
    const nextDetail = await json<QuestionAdminDetailResponseDto>(
      await page.request.get(`/api/admin/questions/${replacement.questionId}`),
      200,
    );
    expect(nextDetail.question.topic).toBe(targetName);
    expect(nextDetail.question.predecessorId).toBe(replacement.previousQuestionId);
  }

  const beforeFailure = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${firstReplacement.questionId}`),
    200,
  );
  const atomicFailure = await page.request.post('/api/admin/questions/bulk', {
    headers: mutationHeaders(csrfToken),
    data: {
      questionIds: [first.question.id, firstReplacement.questionId],
      patch: { difficulty: 'medium' },
      expectedBankRevision: merged.currentBankRevision,
      idempotencyKey: `bulk-failure-${randomUUID()}`,
    },
  });
  expect(atomicFailure.status()).toBe(409);
  expect(await atomicFailure.json()).toMatchObject({ error: 'question_has_successor' });
  const afterFailure = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${firstReplacement.questionId}`),
    200,
  );
  expect(afterFailure.currentBankRevision).toBe(merged.currentBankRevision);
  expect(afterFailure.question).toEqual(beforeFailure.question);
  expect(afterFailure.history).toEqual(beforeFailure.history);

  const bulkKey = `bulk-success-${randomUUID()}`;
  const bulkBody = {
    questionIds: [firstReplacement.questionId, secondReplacement.questionId],
    patch: { difficulty: 'medium' },
    expectedBankRevision: merged.currentBankRevision,
    idempotencyKey: bulkKey,
    note: 'E2E immutable bulk',
  };
  const bulk = await json<QuestionBankBatchMutationDto>(
    await page.request.post('/api/admin/questions/bulk', {
      headers: mutationHeaders(csrfToken),
      data: bulkBody,
    }),
    200,
  );
  expect(bulk.changedCount).toBe(2);
  expect(bulk.replacements).toHaveLength(2);
  const replay = await json<QuestionBankBatchMutationDto>(
    await page.request.post('/api/admin/questions/bulk', {
      headers: mutationHeaders(csrfToken),
      data: bulkBody,
    }),
    200,
  );
  expect(replay).toEqual(bulk);

  const currentLeafId = bulk.replacements[0].questionId;
  const unknownTopic = `Категория отсутствует ${suffix}`;
  for (const request of [
    () => page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(unknownTopic, `unknown-create-${suffix}`, bulk.currentBankRevision),
    }),
    () => page.request.put(`/api/admin/questions/${currentLeafId}`, {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(unknownTopic, `unknown-revise-${suffix}`, bulk.currentBankRevision),
    }),
    () => page.request.post('/api/admin/questions/bulk', {
      headers: mutationHeaders(csrfToken),
      data: {
        questionIds: [currentLeafId],
        patch: { topic: unknownTopic },
        expectedBankRevision: bulk.currentBankRevision,
        idempotencyKey: `unknown-bulk-${randomUUID()}`,
      },
    }),
    () => page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(sourceName, `inactive-category-${suffix}`, bulk.currentBankRevision),
    }),
  ]) {
    const response = await request();
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'question_validation_failed' });
  }
  const afterRejected = await json<QuestionAdminListDto>(
    await page.request.get('/api/admin/questions?limit=1&status=all'),
    200,
  );
  expect(afterRejected.currentBankRevision).toBe(bulk.currentBankRevision);

  const historicalQuestionId = queryLocalD1<{ id: number }>(
    'SELECT MAX(id) + 1 AS id FROM questions',
    E2E_STATE_PATH,
  )[0].id;
  const escapedSourceName = sourceName.replaceAll("'", "''");
  runWrangler([
    'd1', 'execute', 'DB', '--command',
    `INSERT INTO questions (
       id, category_id, difficulty, topic, prompt, choices_json, correct_index,
       weight, active, content_hash, dedupe_key
     ) VALUES (
       ${historicalQuestionId}, ${source.category.id}, 'easy', '${escapedSourceName}',
       'Historical-only inactive E2E leaf', '["A","B"]', 0, 1, 0,
       '${randomBytes(32).toString('hex')}', 'e2e:historical:${suffix}'
     );`,
  ], E2E_STATE_PATH);
  try {
    const beforeHistoricalActivation = workflowCounts();
    const activation = await page.request.patch(
      `/api/admin/questions/${historicalQuestionId}`,
      {
        headers: mutationHeaders(csrfToken),
        data: {
          active: true,
          expectedBankRevision: bulk.currentBankRevision,
          idempotencyKey: `historical-activation-${randomUUID()}`,
        },
      },
    );
    expect(activation.status()).toBe(422);
    expect(await activation.json()).toMatchObject({ error: 'question_validation_failed' });
    expect(workflowCounts()).toEqual(beforeHistoricalActivation);
    expect(queryLocalD1<{ active: number }>(
      `SELECT active FROM questions WHERE id = ${historicalQuestionId}`,
      E2E_STATE_PATH,
    )[0].active).toBe(0);
  } finally {
    runWrangler([
      'd1', 'execute', 'DB', '--command',
      `DELETE FROM questions WHERE id = ${historicalQuestionId};`,
    ], E2E_STATE_PATH);
  }

  const firstExportResponse = await page.request.get('/api/admin/questions/export?status=all');
  const secondExportResponse = await page.request.get('/api/admin/questions/export?status=all');
  expect(firstExportResponse.status()).toBe(200);
  expect(firstExportResponse.headers()['cache-control']).toContain('no-store');
  const firstExportText = await firstExportResponse.text();
  expect(await secondExportResponse.text()).toBe(firstExportText);
  expect(firstExportText).not.toContain(e2eAdminPin());
  expect(firstExportText).not.toContain('TELEGRAM_BOT_TOKEN');
  expect(firstExportText).not.toContain('candidate_name');
  const exported = JSON.parse(firstExportText) as QuestionBankExportDto;
  const exportIds = exported.questions.flatMap((item) => item.id === undefined ? [] : [item.id]);
  expect(exportIds).toEqual([...exportIds].sort((left, right) => left - right));
  expect(exportIds).not.toContain(first.question.id);
  expect(exportIds).not.toContain(second.question.id);
  expect(exportIds).toContain(currentLeafId);

  const activeExport = await json<QuestionBankExportDto>(
    await page.request.get('/api/admin/questions/export?status=active'),
    200,
  );
  const coverage = await json<QuestionBankCoverageDto>(
    await page.request.get('/api/admin/questions/coverage'),
    200,
  );
  expect(coverage.categories.reduce((sum, item) => sum + item.counts.total, 0))
    .toBe(activeExport.questions.length);
});

test('rename required category сохраняет selection identity и frozen remedial', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 семантика не зависит от orientation.');
  test.setTimeout(120_000);
  const csrfToken = await login(page);
  const categoriesBefore = await json<QuestionCategoryListDto>(
    await page.request.get('/api/admin/questions/categories'),
    200,
  );
  const required = categoriesBefore.items.find((category) => category.selectionKey === 'Linux');
  expect(required).toBeTruthy();
  const other = categoriesBefore.items.find((category) => (
    category.active && category.id !== required!.id
  ));
  expect(other).toBeTruthy();
  const renamedName = `${required!.name} E2E ${randomUUID().slice(0, 8)}`;
  const startKey = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const newStartKey = randomUUID();
  const newToken = randomBytes(32).toString('base64url');
  let frozenAttemptId = '';
  let newAttemptId = '';
  let renamed = false;

  try {
    const start = await page.request.post('/api/attempts', {
      headers: startAttemptHeaders(startKey),
      data: { name: `E2E rename frozen ${Date.now()}`, startKey, token },
    });
    expect(start.status()).toBe(201);
    let payload = await start.json() as {
      attemptId: string;
      question: { id: number; choices: string[] };
    };
    frozenAttemptId = payload.attemptId;
    const target = queryLocalD1<{ questionId: number; ordinal: number }>(`
      SELECT ledger.question_id AS questionId, ledger.ordinal
      FROM attempt_questions AS ledger
      JOIN questions ON questions.id = ledger.question_id
      JOIN question_categories AS category ON category.id = questions.category_id
      WHERE ledger.attempt_id = '${frozenAttemptId}'
        AND ledger.question_kind = 'base' AND category.id = ${required!.id}
      ORDER BY ledger.ordinal LIMIT 1
    `, E2E_STATE_PATH)[0];
    expect(target).toBeTruthy();

    const renameBody = {
      name: renamedName,
      expectedCategoryName: required!.name,
      expectedBankRevision: categoriesBefore.currentBankRevision,
      idempotencyKey: `category-required-rename-${randomUUID()}`,
      note: 'E2E stable selection key',
    };
    const renameResult = await json<QuestionCategoryMutationDto>(
      await page.request.put(`/api/admin/questions/categories/${required!.id}`, {
        headers: mutationHeaders(csrfToken),
        data: renameBody,
      }),
      200,
    );
    renamed = true;
    expect(renameResult.category).toMatchObject({
      id: required!.id,
      name: renamedName,
      selectionKey: required!.selectionKey,
    });
    expect(renameResult.changedQuestionCount).toBeGreaterThan(0);

    const oldIdentityVariant = `  ${required!.selectionKey.toLocaleLowerCase('ru-RU')}\u00a0 `;
    const createCollision = await page.request.post('/api/admin/questions/categories', {
      headers: mutationHeaders(csrfToken),
      data: {
        name: oldIdentityVariant,
        expectedBankRevision: renameResult.currentBankRevision,
        idempotencyKey: `category-selection-create-conflict-${randomUUID()}`,
      },
    });
    expect(createCollision.status()).toBe(409);
    expect(await createCollision.json()).toMatchObject({ error: 'category_conflict' });
    const renameCollision = await page.request.put(`/api/admin/questions/categories/${other!.id}`, {
      headers: mutationHeaders(csrfToken),
      data: {
        name: oldIdentityVariant.normalize('NFKC'),
        expectedCategoryName: other!.name,
        expectedBankRevision: renameResult.currentBankRevision,
        idempotencyKey: `category-selection-rename-conflict-${randomUUID()}`,
      },
    });
    expect(renameCollision.status()).toBe(409);
    expect(await renameCollision.json()).toMatchObject({ error: 'category_conflict' });

    let wrongAnswered = false;
    for (let step = 0; step < 20 && payload.question; step += 1) {
      const current = queryLocalD1<{
        id: number;
        choicesJson: string;
        correctIndex: number;
      }>(`SELECT questions.id, questions.choices_json AS choicesJson,
          questions.correct_index AS correctIndex
        FROM attempts JOIN questions ON questions.id = attempts.current_question_id
        WHERE attempts.id = '${frozenAttemptId}'`, E2E_STATE_PATH)[0];
      expect(current).toBeTruthy();
      const canonicalChoices = JSON.parse(current.choicesJson) as string[];
      const correctChoice = canonicalChoices[current.correctIndex];
      const correctDisplayed = payload.question.choices.indexOf(correctChoice);
      expect(correctDisplayed).toBeGreaterThanOrEqual(0);
      const choiceIndex = current.id === target.questionId
        ? (correctDisplayed + 1) % payload.question.choices.length
        : correctDisplayed;
      const answer = await page.request.post(`/api/attempts/${frozenAttemptId}/answer`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { questionId: current.id, choiceIndex },
      });
      expect(answer.status()).toBe(200);
      payload = await answer.json() as typeof payload;
      if (current.id === target.questionId) {
        wrongAnswered = true;
        break;
      }
    }
    expect(wrongAnswered).toBe(true);
    const remedial = queryLocalD1<{
      id: number;
      topic: string;
      categoryId: number;
      frozenMembership: number;
    }>(`SELECT pending.value AS id, questions.topic,
        questions.category_id AS categoryId,
        EXISTS (
          SELECT 1 FROM question_bank_revision_items AS membership
          WHERE membership.revision_hash = attempts.bank_revision
            AND membership.question_id = pending.value AND membership.active = 1
        ) AS frozenMembership
      FROM attempts, json_each(attempts.pending_question_ids) AS pending
      JOIN questions ON questions.id = pending.value
      WHERE attempts.id = '${frozenAttemptId}'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(attempts.base_question_ids) AS base
          WHERE base.value = pending.value
        )
      LIMIT 1`, E2E_STATE_PATH)[0];
    expect(remedial).toMatchObject({
      topic: required!.name,
      categoryId: required!.id,
      frozenMembership: 1,
    });

    const categoriesAfterRename = await json<QuestionCategoryListDto>(
      await page.request.get('/api/admin/questions/categories'),
      200,
    );
    expect(categoriesAfterRename.items).toHaveLength(categoriesBefore.items.length);
    expect(categoriesAfterRename.items.filter((category) => (
      category.selectionKey === required!.selectionKey
    ))).toHaveLength(1);
    expect(categoriesAfterRename.items.some((category) => (
      category.normalizedName === required!.normalizedName && category.id !== required!.id
    ))).toBe(false);
    const coverage = await json<QuestionBankCoverageDto>(
      await page.request.get('/api/admin/questions/coverage'),
      200,
    );
    expect(coverage.ready).toBe(true);
    expect(coverage.categories.find((category) => category.categoryId === required!.id))
      .toMatchObject({ name: renamedName, requiredTotal: GENERAL_TOPIC_PLAN.Linux, status: 'enough' });

    const newStart = await page.request.post('/api/attempts', {
      headers: startAttemptHeaders(newStartKey),
      data: { name: `E2E rename new ${Date.now()}`, startKey: newStartKey, token: newToken },
    });
    expect(newStart.status()).toBe(201);
    const newPayload = await newStart.json() as { attemptId: string };
    newAttemptId = newPayload.attemptId;
    const newSelection = queryLocalD1<{
      baseCount: number;
      coverageScore: number | null;
    }>(`SELECT
        (SELECT COUNT(*) FROM attempt_questions
          WHERE attempt_id = attempts.id AND question_kind = 'base') AS baseCount,
        attempts.coverage_score AS coverageScore
      FROM attempts WHERE id = '${newAttemptId}'`, E2E_STATE_PATH)[0];
    expect(newSelection.baseCount).toBe(20);
    expect(newSelection.coverageScore).not.toBeNull();
    const renamedCurrentMembers = queryLocalD1<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM question_bank_state AS state
      JOIN question_bank_revision_items AS membership
        ON membership.revision_hash = state.current_revision AND membership.active = 1
      JOIN questions ON questions.id = membership.question_id
      JOIN question_categories AS category ON category.id = questions.category_id
      WHERE state.id = 1 AND category.selection_key = 'Linux'
        AND category.name = '${renamedName.replaceAll("'", "''")}'
    `, E2E_STATE_PATH)[0];
    expect(renamedCurrentMembers.count).toBeGreaterThanOrEqual(GENERAL_TOPIC_PLAN.Linux);
  } finally {
    if (renamed) {
      const currentCategories = await json<QuestionCategoryListDto>(
        await page.request.get('/api/admin/questions/categories'),
        200,
      );
      const restore = await page.request.put(`/api/admin/questions/categories/${required!.id}`, {
        headers: mutationHeaders(csrfToken),
        data: {
          name: required!.name,
          expectedCategoryName: renamedName,
          expectedBankRevision: currentCategories.currentBankRevision,
          idempotencyKey: `category-required-restore-${randomUUID()}`,
          note: 'E2E restore display name',
        },
      });
      expect(restore.status()).toBe(200);
    }
    if (frozenAttemptId) cleanupAttempt(frozenAttemptId);
    if (newAttemptId) cleanupAttempt(newAttemptId);
  }
});

test('черновик публикуется атомарно и отклоняет stale CAS', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 семантика не зависит от orientation.');
  const csrfToken = await login(page);
  const categories = await json<QuestionCategoryListDto>(
    await page.request.get('/api/admin/questions/categories'),
    200,
  );
  const category = categories.items.find((item) => item.active);
  expect(category).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const created = await json<QuestionAdminMutationDto>(
    await page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(category!.name, `change-set-${suffix}`, categories.currentBankRevision),
    }),
    201,
  );

  const createKey = `change-set-create-${randomUUID()}`;
  const draft = await json<QuestionBankChangeSetDetailDto>(
    await page.request.post('/api/admin/questions/change-sets', {
      headers: mutationHeaders(csrfToken),
      data: {
        title: `E2E пакет ${suffix}`,
        note: 'Атомарная проверка',
        expectedBankRevision: created.currentBankRevision,
        idempotencyKey: createKey,
      },
    }),
    201,
  );
  const updateBody = {
    operations: [{ questionId: created.question.id, patch: { difficulty: 'medium' } }],
    expectedBankRevision: created.currentBankRevision,
    expectedChangeSetUpdatedAt: draft.changeSet.updatedAt,
    idempotencyKey: `change-set-update-${randomUUID()}`,
  };
  const updated = await json<QuestionBankChangeSetDetailDto>(
    await page.request.put(`/api/admin/questions/change-sets/${draft.changeSet.id}`, {
      headers: mutationHeaders(csrfToken),
      data: updateBody,
    }),
    200,
  );
  expect(updated.changeSet.operationCount).toBe(1);
  expect(updated.operations).toHaveLength(1);
  const staleVersionUpdate = await page.request.put(
    `/api/admin/questions/change-sets/${draft.changeSet.id}`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        operations: [{ questionId: created.question.id, patch: { difficulty: 'hard' } }],
        expectedBankRevision: created.currentBankRevision,
        expectedChangeSetUpdatedAt: draft.changeSet.updatedAt,
        idempotencyKey: `change-set-stale-version-${randomUUID()}`,
      },
    },
  );
  expect(staleVersionUpdate.status()).toBe(409);
  expect(await staleVersionUpdate.json()).toMatchObject({ error: 'change_set_conflict' });

  const updateRaceKey = `change-set-update-race-${randomUUID()}`;
  const updateRaceTrigger = `e2e_update_${suffix.replaceAll('-', '_')}`;
  const beforeUpdateRace = workflowCounts();
  installChangeSetRaceTrigger(updateRaceTrigger, updateRaceKey, draft.changeSet.id);
  try {
    const updateRace = await page.request.put(
      `/api/admin/questions/change-sets/${draft.changeSet.id}`,
      {
        headers: mutationHeaders(csrfToken),
        data: {
          operations: [{ questionId: created.question.id, patch: { difficulty: 'hard' } }],
          expectedBankRevision: created.currentBankRevision,
          expectedChangeSetUpdatedAt: updated.changeSet.updatedAt,
          idempotencyKey: updateRaceKey,
        },
      },
    );
    expect(updateRace.status()).toBe(409);
    expect(await updateRace.json()).toMatchObject({ error: 'change_set_conflict' });
  } finally {
    dropChangeSetRaceTrigger(updateRaceTrigger);
  }
  expect(workflowCounts()).toEqual(beforeUpdateRace);
  const afterUpdateRace = await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${draft.changeSet.id}`),
    200,
  );
  expect(afterUpdateRace.changeSet).toEqual(updated.changeSet);
  const operationContent = ({
    questionId,
    patch,
    createdAt,
  }: QuestionBankChangeSetDetailDto['operations'][number]) => ({ questionId, patch, createdAt });
  expect(afterUpdateRace.operations.map(operationContent))
    .toEqual(updated.operations.map(operationContent));

  const beforePreview = workflowCounts();
  const preview = await json<QuestionBankChangeSetPreviewDto>(
    await page.request.post(`/api/admin/questions/change-sets/${draft.changeSet.id}/preview`, {
      headers: mutationHeaders(csrfToken),
    }),
    200,
  );
  expect(preview.changedCount).toBe(1);
  expect(preview.replacements).toHaveLength(1);
  const repeatedPreview = await json<QuestionBankChangeSetPreviewDto>(
    await page.request.post(`/api/admin/questions/change-sets/${draft.changeSet.id}/preview`, {
      headers: mutationHeaders(csrfToken),
    }),
    200,
  );
  expect(repeatedPreview).toEqual(preview);
  expect(workflowCounts()).toEqual(beforePreview);

  const publishRaceKey = `change-set-publish-race-${randomUUID()}`;
  const publishRaceTrigger = `e2e_publish_${suffix.replaceAll('-', '_')}`;
  const beforePublishRace = workflowCounts();
  installChangeSetRaceTrigger(publishRaceTrigger, publishRaceKey, draft.changeSet.id);
  try {
    const publishRace = await page.request.post(
      `/api/admin/questions/change-sets/${draft.changeSet.id}/publish`,
      {
        headers: mutationHeaders(csrfToken),
        data: {
          expectedBankRevision: created.currentBankRevision,
          expectedChangeSetUpdatedAt: updated.changeSet.updatedAt,
          idempotencyKey: publishRaceKey,
        },
      },
    );
    expect(publishRace.status()).toBe(409);
    expect(await publishRace.json()).toMatchObject({ error: 'change_set_conflict' });
  } finally {
    dropChangeSetRaceTrigger(publishRaceTrigger);
  }
  expect(workflowCounts()).toEqual(beforePublishRace);
  expect((await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${draft.changeSet.id}`),
    200,
  )).changeSet.status).toBe('draft');

  const publishBody = {
    expectedBankRevision: created.currentBankRevision,
    expectedChangeSetUpdatedAt: updated.changeSet.updatedAt,
    idempotencyKey: `change-set-publish-${randomUUID()}`,
  };
  const published = await json<QuestionBankBatchMutationDto>(
    await page.request.post(`/api/admin/questions/change-sets/${draft.changeSet.id}/publish`, {
      headers: mutationHeaders(csrfToken),
      data: publishBody,
    }),
    200,
  );
  expect(published.changedCount).toBe(1);
  expect(published.replacements).toHaveLength(1);
  const publishReplay = await json<QuestionBankBatchMutationDto>(
    await page.request.post(`/api/admin/questions/change-sets/${draft.changeSet.id}/publish`, {
      headers: mutationHeaders(csrfToken),
      data: publishBody,
    }),
    200,
  );
  expect(publishReplay).toEqual(published);
  const publishedDetail = await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${draft.changeSet.id}`),
    200,
  );
  expect(publishedDetail.changeSet).toMatchObject({
    status: 'published',
    publishedBankRevision: published.currentBankRevision,
  });
  const successorId = published.replacements[0].questionId;
  const original = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${created.question.id}`),
    200,
  );
  const successor = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${successorId}`),
    200,
  );
  expect(original.question.successorId).toBe(successorId);
  expect(successor.question).toMatchObject({
    predecessorId: created.question.id,
    difficulty: 'medium',
  });

  const staleDraft = await json<QuestionBankChangeSetDetailDto>(
    await page.request.post('/api/admin/questions/change-sets', {
      headers: mutationHeaders(csrfToken),
      data: {
        title: `E2E conflict ${suffix}`,
        expectedBankRevision: published.currentBankRevision,
        idempotencyKey: `change-set-stale-create-${randomUUID()}`,
      },
    }),
    201,
  );
  await json<QuestionBankChangeSetDetailDto>(
    await page.request.put(`/api/admin/questions/change-sets/${staleDraft.changeSet.id}`, {
      headers: mutationHeaders(csrfToken),
      data: {
        operations: [{ questionId: successorId, patch: { difficulty: 'hard' } }],
        expectedBankRevision: published.currentBankRevision,
        expectedChangeSetUpdatedAt: staleDraft.changeSet.updatedAt,
        idempotencyKey: `change-set-stale-update-${randomUUID()}`,
      },
    }),
    200,
  );
  const external = await json<QuestionAdminMutationDto>(
    await page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(category!.name, `external-${suffix}`, published.currentBankRevision),
    }),
    201,
  );
  const beforeConflict = workflowCounts();
  const conflict = await page.request.post(
    `/api/admin/questions/change-sets/${staleDraft.changeSet.id}/publish`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        expectedBankRevision: published.currentBankRevision,
        expectedChangeSetUpdatedAt: staleDraft.changeSet.updatedAt,
        idempotencyKey: `change-set-conflict-publish-${randomUUID()}`,
      },
    },
  );
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: 'bank_revision_conflict' });
  expect(workflowCounts()).toEqual(beforeConflict);
  const untouched = await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${successorId}`),
    200,
  );
  expect(untouched.question.difficulty).toBe('medium');
  expect(untouched.question.successorId).toBeNull();
  const staleDetail = await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${staleDraft.changeSet.id}`),
    200,
  );
  expect(staleDetail.changeSet.status).toBe('draft');
  const discardRaceKey = `change-set-discard-race-${randomUUID()}`;
  const discardRaceTrigger = `e2e_discard_${suffix.replaceAll('-', '_')}`;
  const beforeDiscardRace = workflowCounts();
  installChangeSetRaceTrigger(discardRaceTrigger, discardRaceKey, staleDraft.changeSet.id);
  try {
    const discardRace = await page.request.delete(
      `/api/admin/questions/change-sets/${staleDraft.changeSet.id}`,
      {
        headers: mutationHeaders(csrfToken),
        data: {
          expectedBankRevision: external.currentBankRevision,
          expectedChangeSetUpdatedAt: staleDetail.changeSet.updatedAt,
          idempotencyKey: discardRaceKey,
        },
      },
    );
    expect(discardRace.status()).toBe(409);
    expect(await discardRace.json()).toMatchObject({ error: 'change_set_conflict' });
  } finally {
    dropChangeSetRaceTrigger(discardRaceTrigger);
  }
  expect(workflowCounts()).toEqual(beforeDiscardRace);
  expect((await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${staleDraft.changeSet.id}`),
    200,
  )).changeSet.status).toBe('draft');
  const discarded = await json<QuestionBankChangeSetDetailDto>(
    await page.request.delete(`/api/admin/questions/change-sets/${staleDraft.changeSet.id}`, {
      headers: mutationHeaders(csrfToken),
      data: {
        expectedBankRevision: external.currentBankRevision,
        expectedChangeSetUpdatedAt: staleDetail.changeSet.updatedAt,
        idempotencyKey: `change-set-conflict-discard-${randomUUID()}`,
      },
    }),
    200,
  );
  expect(discarded.changeSet.status).toBe('discarded');
});

test('изменение категории во время mutation откатывает весь batch', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 race не зависит от orientation.');
  test.setTimeout(120_000);
  const csrfToken = await login(page);
  const catalog = await json<QuestionCategoryListDto>(
    await page.request.get('/api/admin/questions/categories'),
    200,
  );
  const category = catalog.items.find((item) => item.active && item.selectionKey === 'Linux')
    ?? catalog.items.find((item) => item.active);
  expect(category).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);

  async function expectCategoryRaceRollback(
    label: string,
    idempotencyKey: string,
    request: () => Promise<APIResponse>,
  ) {
    const triggerName = `e2e_category_${label}_${suffix}`.replaceAll('-', '_');
    const before = workflowCounts();
    installCategoryRaceTrigger(triggerName, idempotencyKey, category!.id);
    try {
      const response = await request();
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'category_conflict' });
    } finally {
      dropChangeSetRaceTrigger(triggerName);
    }
    expect(workflowCounts()).toEqual(before);
    expect(queryLocalD1<{ active: number; name: string }>(
      `SELECT active, name FROM question_categories WHERE id = ${category!.id}`,
      E2E_STATE_PATH,
    )[0]).toEqual({ active: 1, name: category!.name });
  }

  const createRaceKey = `category-race-create-${randomUUID()}`;
  const createRaceDraft = {
    ...questionDraft(category!.name, `race-create-${suffix}`, catalog.currentBankRevision),
    idempotencyKey: createRaceKey,
  };
  await expectCategoryRaceRollback('create', createRaceKey, () => page.request.post(
    '/api/admin/questions',
    { headers: mutationHeaders(csrfToken), data: createRaceDraft },
  ));

  const baseline = await json<QuestionAdminMutationDto>(
    await page.request.post('/api/admin/questions', {
      headers: mutationHeaders(csrfToken),
      data: questionDraft(category!.name, `race-base-${suffix}`, catalog.currentBankRevision),
    }),
    201,
  );
  const stableRevision = baseline.currentBankRevision;

  const reviseRaceKey = `category-race-revise-${randomUUID()}`;
  const reviseRaceDraft = {
    ...questionDraft(category!.name, `race-revise-${suffix}`, stableRevision),
    idempotencyKey: reviseRaceKey,
  };
  await expectCategoryRaceRollback('revise', reviseRaceKey, () => page.request.put(
    `/api/admin/questions/${baseline.question.id}`,
    { headers: mutationHeaders(csrfToken), data: reviseRaceDraft },
  ));
  expect((await json<QuestionAdminDetailResponseDto>(
    await page.request.get(`/api/admin/questions/${baseline.question.id}`),
    200,
  )).question.successorId).toBeNull();

  const bulkRaceKey = `category-race-bulk-${randomUUID()}`;
  await expectCategoryRaceRollback('bulk', bulkRaceKey, () => page.request.post(
    '/api/admin/questions/bulk',
    {
      headers: mutationHeaders(csrfToken),
      data: {
        questionIds: [baseline.question.id],
        patch: { difficulty: 'medium' },
        expectedBankRevision: stableRevision,
        idempotencyKey: bulkRaceKey,
      },
    },
  ));

  const importQuestions = [importQuestion(category!.name, `race-${suffix}`, 0)];
  const importPreview = await json<QuestionImportPreviewDto>(
    await page.request.post('/api/admin/questions/import/preview', {
      headers: mutationHeaders(csrfToken),
      data: { expectedBankRevision: stableRevision, questions: importQuestions },
    }),
    200,
  );
  expect(importPreview.summary.invalid).toBe(0);
  const importRaceKey = `category-race-import-${randomUUID()}`;
  await expectCategoryRaceRollback('import', importRaceKey, () => page.request.post(
    '/api/admin/questions/import/apply',
    {
      headers: mutationHeaders(csrfToken),
      data: {
        expectedBankRevision: stableRevision,
        questions: importQuestions,
        previewToken: importPreview.previewToken,
        idempotencyKey: importRaceKey,
      },
    },
  ));

  const draft = await json<QuestionBankChangeSetDetailDto>(
    await page.request.post('/api/admin/questions/change-sets', {
      headers: mutationHeaders(csrfToken),
      data: {
        title: `Category race ${suffix}`,
        expectedBankRevision: stableRevision,
        idempotencyKey: `category-race-draft-${randomUUID()}`,
      },
    }),
    201,
  );
  const draftWithOperation = await json<QuestionBankChangeSetDetailDto>(
    await page.request.put(`/api/admin/questions/change-sets/${draft.changeSet.id}`, {
      headers: mutationHeaders(csrfToken),
      data: {
        operations: [{ questionId: baseline.question.id, patch: { difficulty: 'medium' } }],
        expectedBankRevision: stableRevision,
        expectedChangeSetUpdatedAt: draft.changeSet.updatedAt,
        idempotencyKey: `category-race-draft-update-${randomUUID()}`,
      },
    }),
    200,
  );
  const publishRaceKey = `category-race-publish-${randomUUID()}`;
  await expectCategoryRaceRollback('publish', publishRaceKey, () => page.request.post(
    `/api/admin/questions/change-sets/${draft.changeSet.id}/publish`,
    {
      headers: mutationHeaders(csrfToken),
      data: {
        expectedBankRevision: stableRevision,
        expectedChangeSetUpdatedAt: draftWithOperation.changeSet.updatedAt,
        idempotencyKey: publishRaceKey,
      },
    },
  ));
  const afterPublishRace = await json<QuestionBankChangeSetDetailDto>(
    await page.request.get(`/api/admin/questions/change-sets/${draft.changeSet.id}`),
    200,
  );
  expect(afterPublishRace.changeSet.status).toBe('draft');
  expect(afterPublishRace.operations).toHaveLength(1);
});

test('импорт 130 вопросов имеет read-only preview и idempotent apply', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('landscape'), 'API/D1 семантика не зависит от orientation.');
  test.setTimeout(120_000);
  const csrfToken = await login(page);
  const categories = await json<QuestionCategoryListDto>(
    await page.request.get('/api/admin/questions/categories'),
    200,
  );
  const category = categories.items.find((item) => item.active);
  expect(category).toBeTruthy();
  const suffix = randomUUID().slice(0, 8);
  const questions = Array.from({ length: 130 }, (_, index) => (
    importQuestion(category!.name, suffix, index)
  ));
  const previewBody = {
    expectedBankRevision: categories.currentBankRevision,
    questions,
  };
  const beforePreview = workflowCounts();
  const preview = await json<QuestionImportPreviewDto>(
    await page.request.post('/api/admin/questions/import/preview', {
      headers: mutationHeaders(csrfToken),
      data: previewBody,
    }),
    200,
  );
  expect(preview.summary).toEqual({ added: 130, revised: 0, unchanged: 0, invalid: 0 });
  expect(preview.items).toHaveLength(130);
  expect(new Set(preview.items.map((item) => item.sourceIndex)).size).toBe(130);
  const repeatedPreview = await json<QuestionImportPreviewDto>(
    await page.request.post('/api/admin/questions/import/preview', {
      headers: mutationHeaders(csrfToken),
      data: previewBody,
    }),
    200,
  );
  expect(repeatedPreview).toEqual(preview);
  expect(workflowCounts()).toEqual(beforePreview);

  for (const invalidQuestions of [
    [{ ...questions[0], id: 987_654_321 }],
    [{ ...questions[0], topic: `Неизвестная категория ${suffix}` }],
  ]) {
    const invalid = await json<QuestionImportPreviewDto>(
      await page.request.post('/api/admin/questions/import/preview', {
        headers: mutationHeaders(csrfToken),
        data: {
          expectedBankRevision: categories.currentBankRevision,
          questions: invalidQuestions,
        },
      }),
      200,
    );
    expect(invalid.summary.invalid).toBe(1);
    expect(invalid.items[0].action).toBe('invalid');
    expect(workflowCounts()).toEqual(beforePreview);
  }
  const oversized = await page.request.post('/api/admin/questions/import/preview', {
    headers: mutationHeaders(csrfToken),
    data: {
      expectedBankRevision: categories.currentBankRevision,
      questions: Array.from({ length: 251 }, (_, index) => questions[index % questions.length]),
    },
  });
  expect(oversized.status()).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: 'mutation_too_large' });
  expect(workflowCounts()).toEqual(beforePreview);

  const applyBody = {
    ...previewBody,
    previewToken: preview.previewToken,
    idempotencyKey: `import-apply-${randomUUID()}`,
    note: 'E2E set-based import 130',
  };
  const applied = await json<QuestionImportApplyDto>(
    await page.request.post('/api/admin/questions/import/apply', {
      headers: mutationHeaders(csrfToken),
      data: applyBody,
    }),
    200,
  );
  expect(applied.changedCount).toBe(130);
  expect(applied.importSummary).toEqual(preview.summary);
  const afterApply = workflowCounts();
  expect(afterApply.questions).toBe(beforePreview.questions + 130);
  expect(afterApply.revisions).toBe(beforePreview.revisions + 1);
  expect(afterApply.events).toBe(beforePreview.events + 130);
  expect(afterApply.mutations).toBe(beforePreview.mutations + 1);
  const replay = await json<QuestionImportApplyDto>(
    await page.request.post('/api/admin/questions/import/apply', {
      headers: mutationHeaders(csrfToken),
      data: applyBody,
    }),
    200,
  );
  expect(replay).toEqual(applied);
  expect(workflowCounts()).toEqual(afterApply);
});

test('рабочее место банка доступно на iPad и очередь качества открывает редактор', async ({ page }) => {
  await login(page);
  await openQuestionBank(page);
  const listResponse = await page.request.get('/api/admin/questions?limit=1&status=all');
  expect(listResponse.status()).toBe(200);
  const list = await listResponse.json() as QuestionAdminListDto;
  const question = list.items[0];
  expect(question).toBeTruthy();

  await page.route('**/api/admin/questions/quality-queue', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store, max-age=0' },
      body: JSON.stringify({
        currentBankRevision: list.currentBankRevision,
        totalCount: 1,
        items: [{
          questionId: question.id,
          topic: question.topic,
          difficulty: question.difficulty,
          qualityStatus: 'review',
          warnings: ['high_timeout'],
          editorHref: `/admin/analytics?tab=questions&view=bank&questionId=${question.id}`,
          analyticsHref: `/admin/analytics?tab=questions&questionId=${question.id}`,
        }],
      }),
    });
  });

  const workspace = page.getByRole('tablist', { name: 'Разделы банка вопросов' });
  const tabs = [
    ['Вопросы', 'Просмотр и безопасное редактирование'],
    ['Категории', 'Категории вопросов'],
    ['Импорт и экспорт', 'Проверить пакет до публикации'],
    ['Черновики', 'Черновики изменений'],
    ['Контроль', 'Хватает ли вопросов для теста'],
  ] as const;
  for (const [tabName, heading] of tabs) {
    const tab = workspace.getByRole('tab', { name: new RegExp(`^${tabName}`) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    expect(Math.round(await tab.evaluate((element) => element.getBoundingClientRect().height)))
      .toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
  }

  const coverageTable = page.getByRole('table');
  await expect(coverageTable).toBeVisible();
  expect(await coverageTable.evaluate((table) => {
    const wrapper = table.parentElement;
    return Boolean(wrapper && wrapper.scrollWidth >= wrapper.clientWidth);
  })).toBe(true);
  await page.getByRole('link', { name: 'Открыть вопрос' }).click();
  const viewer = page.getByRole('dialog', { name: `Вопрос #${question.id}` });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('Правильный ответ')).toBeVisible();
  await viewer.getByRole('button', { name: 'Закрыть' }).click();

  await page.goto(`/admin/analytics?tab=questions&view=bank&questionId=${question.id}`);
  await expect(page.getByRole('dialog', { name: `Вопрос #${question.id}` })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('массовая операция имеет доступный review-диалог без публикации', async ({ page }) => {
  await login(page);
  await openQuestionBank(page);
  const firstSelector = page.getByLabel(/Выбрать вопрос #\d+/u).first();
  await firstSelector.check();
  const bulkButton = page.getByRole('button', { name: 'Массовое изменение' });
  await expect(bulkButton).toBeEnabled();
  await bulkButton.click();
  const dialog = page.getByRole('dialog', { name: 'Изменить 1 вопросов' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Проверить пакет' }).click();
  await expect(dialog.getByRole('heading', { name: 'Проверьте изменение' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить черновик' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Опубликовать' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Назад' }).click();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
  await expectNoPageOverflow(page);
});
