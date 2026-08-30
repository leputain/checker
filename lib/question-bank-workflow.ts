import type { QuestionRow } from '@/db/runtime.ts';
import {
  invalidateQuestionBankCache,
  questionBankRevision,
  questionContentHash,
  sha256Hex,
} from '@/db/runtime.ts';
import {
  evaluateQuestionBankReadiness,
  type QuestionBankReadiness,
} from './question-bank-readiness.ts';
import {
  QuestionBankValidationError,
  summarizeQuestionBank,
  validateQuestionBank,
  type QuestionDefinition,
} from './question-bank-validation.ts';
import {
  activeQuestionCategory,
  normalizeQuestionCategoryName,
  questionCategoryDependencyGuardStatement,
  validateQuestionCategoryName,
  type QuestionCategoryDependency,
} from './question-categories.ts';
import {
  DIFFICULTIES,
  GENERAL_TOPIC_PLAN,
  TEST_CONFIG,
  type Difficulty,
} from './test-config.ts';
import {
  QuestionAdminServiceError,
} from './question-admin-service.ts';
import type {
  QuestionBankBatchMutationDto,
  QuestionBankBatchOperationDto,
  QuestionBankBatchPatchDto,
  QuestionBankChangeSetDetailDto,
  QuestionBankChangeSetDto,
  QuestionBankChangeSetItemDto,
  QuestionBankChangeSetListDto,
  QuestionBankChangeSetPreviewDto,
  QuestionBankCoverageDto,
  QuestionBankExportDto,
  QuestionBankReadinessDto,
  QuestionCategoryDto,
  QuestionCategoryListDto,
  QuestionCategoryMutationDto,
  QuestionImportApplyDto,
  QuestionImportDiffItemDto,
  QuestionImportDraftDto,
  QuestionImportPreviewDto,
  QuestionReplacementDto,
} from './question-admin-contract.ts';

export const MAX_CHANGE_SET_OPERATIONS = 250;
export const MAX_QUESTION_WORKFLOW_BODY_BYTES = 2_000_000;
const MAX_CHANGE_SET_TITLE_LENGTH = 120;
const MAX_NOTE_LENGTH = 500;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/u;

type WorkflowRow = QuestionRow & {
  predecessor_id: number | null;
  successor_id: number | null;
  in_current_revision: number;
  current_active: number;
  selection_key: string | null;
};

type CategoryRow = {
  id: number;
  name: string;
  normalized_name: string;
  selection_key: string;
  active: number;
  created_at: number;
  updated_at: number;
};

type MutationRecord = {
  operation: string;
  request_hash: string;
  response_json: string;
};

type MutationMeta = {
  expectedBankRevision: string;
  idempotencyKey: string;
  note: string | null;
};

type ChangeSetMutationToken = {
  expectedChangeSetUpdatedAt: number;
};

type PlannedChange = {
  kind: 'create' | 'revise' | 'toggle';
  sourceIndex?: number;
  originalId: number | null;
  question: QuestionDefinition;
  changedFields: string[];
};

type MutationPlan = {
  rows: WorkflowRow[];
  changes: PlannedChange[];
  unchangedCount: number;
  definitions: QuestionDefinition[];
  revision: string;
  readiness: QuestionBankReadinessDto;
  replacements: QuestionReplacementDto[];
};

type ChangeSetRow = {
  id: string;
  title: string;
  note: string | null;
  status: 'draft' | 'published' | 'discarded';
  base_revision: string;
  published_revision: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  operation_count: number;
};

function parseChoices(row: Pick<QuestionRow, 'choices_json'>) {
  const choices = JSON.parse(row.choices_json) as unknown;
  if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== 'string')) {
    throw new Error('question_choices_corrupted');
  }
  return choices as string[];
}

function definitionFromRow(row: WorkflowRow): QuestionDefinition {
  return {
    id: row.id,
    categoryId: row.category_id,
    difficulty: row.difficulty,
    topic: row.topic,
    prompt: row.prompt,
    ...(row.context_type && row.context_text !== null
      ? { contextType: row.context_type, context: row.context_text }
      : {}),
    choices: parseChoices(row),
    correctIndex: row.correct_index,
    active: row.current_active === 1,
    dedupeKey: row.dedupe_key,
    selectionTopic: row.selection_key ?? row.topic,
  };
}

async function currentRevision(db: D1Database) {
  const row = await db.prepare(`SELECT current_revision
    FROM question_bank_state WHERE id = 1`).first<{ current_revision: string }>();
  if (!row?.current_revision) throw new Error('question_bank_state_missing');
  return row.current_revision;
}

async function workflowRows(db: D1Database) {
  const result = await db.prepare(`SELECT questions.*,
      predecessor.predecessor_question_id AS predecessor_id,
      successor.successor_question_id AS successor_id,
      CASE WHEN membership.question_id IS NULL THEN 0 ELSE 1 END AS in_current_revision,
      COALESCE(membership.active, questions.active) AS current_active,
      category.selection_key AS selection_key
    FROM questions
    LEFT JOIN question_version_links predecessor
      ON predecessor.successor_question_id = questions.id
    LEFT JOIN question_version_links successor
      ON successor.predecessor_question_id = questions.id
    LEFT JOIN question_bank_state state ON state.id = 1
    LEFT JOIN question_bank_revision_items membership
      ON membership.revision_hash = state.current_revision
      AND membership.question_id = questions.id
    LEFT JOIN question_categories category ON category.id = questions.category_id
    ORDER BY questions.id`).all<WorkflowRow>();
  return result.results;
}

async function categoryRows(db: D1Database) {
  const result = await db.prepare(`SELECT id, name, normalized_name, selection_key,
      active, created_at, updated_at
    FROM question_categories ORDER BY name, id`).all<CategoryRow>();
  return result.results;
}

function readinessDto(readiness: QuestionBankReadiness): QuestionBankReadinessDto {
  const issues = [
    ...readiness.legacy.reasonCodes.map((code) => `legacy:${code}`),
    ...readiness.balanced.reasonCodes.map((code) => `balanced:${code}`),
  ];
  return {
    ready: readiness.legacy.status !== 'NOT READY' && readiness.balanced.status !== 'NOT READY',
    issues,
    warnings: readiness.warnings,
  };
}

function validateEffectiveBank(definitions: QuestionDefinition[], requireReady = true) {
  const active = definitions.filter((question) => question.active);
  try {
    validateQuestionBank(active, 'admin-active-bank', {
      enforceOperationalReadiness: requireReady,
    });
  } catch (error) {
    if (error instanceof QuestionBankValidationError) {
      throw new QuestionAdminServiceError('question_bank_not_ready', 422, error.issues);
    }
    throw error;
  }
  const readiness = readinessDto(evaluateQuestionBankReadiness(active));
  if (requireReady && !readiness.ready) {
    throw new QuestionAdminServiceError('question_bank_not_ready', 422, readiness.issues);
  }
  return readiness;
}

function currentLeafRows(rows: WorkflowRow[]) {
  return rows.filter((row) => row.in_current_revision === 1 && row.successor_id === null);
}

function categoryDto(category: CategoryRow, rows: WorkflowRow[]): QuestionCategoryDto {
  const leaf = currentLeafRows(rows).filter((row) => (
    row.category_id === category.id
  ));
  const active = leaf.filter((row) => row.current_active === 1);
  return {
    id: category.id,
    name: category.name,
    normalizedName: category.normalized_name,
    selectionKey: category.selection_key,
    active: category.active === 1,
    activeQuestionCount: active.length,
    inactiveQuestionCount: leaf.length - active.length,
    difficultyCounts: Object.fromEntries(DIFFICULTIES.map((difficulty) => [
      difficulty,
      active.filter((row) => row.difficulty === difficulty).length,
    ])) as Record<Difficulty, number>,
  };
}

export async function listQuestionCategories(db: D1Database): Promise<QuestionCategoryListDto> {
  const [revision, categories, rows] = await Promise.all([
    currentRevision(db),
    categoryRows(db),
    workflowRows(db),
  ]);
  const catalogById = new Map(categories.map((category) => [category.id, category]));
  const orphan = currentLeafRows(rows).find((row) => {
    const category = row.category_id === null ? null : catalogById.get(row.category_id);
    return !category || normalizeQuestionCategoryName(row.topic) !== category.normalized_name;
  });
  if (orphan) throw new Error('question_category_catalog_incomplete');
  return {
    items: categories.map((category) => categoryDto(category, rows)),
    currentBankRevision: revision,
  };
}

export function buildQuestionCoverage(
  revision: string,
  categories: readonly QuestionCategoryDto[],
  readiness: QuestionBankReadinessDto,
): QuestionBankCoverageDto {
  return {
    currentBankRevision: revision,
    ready: readiness.ready,
    issues: readiness.issues,
    warnings: readiness.warnings,
    categories: categories.map((category) => {
      const topicPlan = GENERAL_TOPIC_PLAN as Readonly<Record<string, number>>;
      const requiredTotal = topicPlan[category.selectionKey] ?? 0;
      const total = category.activeQuestionCount;
      const deficits = requiredTotal === 0
        ? ['Категория не входит в тематические квоты balanced-профиля']
        : total < requiredTotal
          ? [`Нужно ещё ${requiredTotal - total} активных вопросов для тематической квоты`]
          : [];
      return {
        categoryId: category.id,
        name: category.name,
        counts: { ...category.difficultyCounts, total },
        requiredTotal,
        status: requiredTotal === 0
          ? 'unused' as const
          : total < requiredTotal ? 'deficit' as const : 'enough' as const,
        deficits,
      };
    }),
  };
}

export async function questionBankCoverage(db: D1Database): Promise<QuestionBankCoverageDto> {
  const catalog = await listQuestionCategories(db);
  const rows = await workflowRows(db);
  const definitions = rows.filter((row) => row.in_current_revision === 1).map(definitionFromRow);
  const readiness = readinessDto(evaluateQuestionBankReadiness(
    definitions.filter((question) => question.active),
  ));
  return buildQuestionCoverage(catalog.currentBankRevision, catalog.items, readiness);
}

function workflowMeta(value: Record<string, unknown>): MutationMeta {
  const expectedBankRevision = value.expectedBankRevision;
  const idempotencyKey = value.idempotencyKey;
  const note = value.note === undefined || value.note === null
    ? null
    : typeof value.note === 'string' ? value.note.trim() || null : undefined;
  const issues: string[] = [];
  if (typeof expectedBankRevision !== 'string' || !SHA256_PATTERN.test(expectedBankRevision)) {
    issues.push('expectedBankRevision должен быть SHA-256 текущей ревизии');
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    issues.push('idempotencyKey должен содержать 8–128 безопасных символов');
  }
  if (note === undefined || (note?.length ?? 0) > MAX_NOTE_LENGTH) {
    issues.push(`note должен содержать не более ${MAX_NOTE_LENGTH} символов`);
  }
  if (issues.length > 0) throw new QuestionAdminServiceError('invalid_request', 400, issues);
  return {
    expectedBankRevision: expectedBankRevision as string,
    idempotencyKey: idempotencyKey as string,
    note: note as string | null,
  };
}

function changeSetMutationToken(value: Record<string, unknown>): ChangeSetMutationToken {
  const expectedChangeSetUpdatedAt = value.expectedChangeSetUpdatedAt;
  if (!Number.isSafeInteger(expectedChangeSetUpdatedAt) || Number(expectedChangeSetUpdatedAt) < 0) {
    throw new QuestionAdminServiceError(
      'invalid_request',
      400,
      ['expectedChangeSetUpdatedAt должен быть актуальной меткой updatedAt черновика'],
    );
  }
  return { expectedChangeSetUpdatedAt: Number(expectedChangeSetUpdatedAt) };
}

async function requestHash(operation: string, value: unknown) {
  return sha256Hex(JSON.stringify({ operation, value }));
}

async function replayMutation<T>(
  db: D1Database,
  idempotencyKey: string,
  operation: string,
  hash: string,
): Promise<T | null> {
  const existing = await db.prepare(`SELECT operation, request_hash, response_json
    FROM question_bank_mutations WHERE idempotency_key = ?`)
    .bind(idempotencyKey)
    .first<MutationRecord>();
  if (!existing) return null;
  if (existing.operation !== operation || existing.request_hash !== hash) {
    throw new QuestionAdminServiceError('idempotency_conflict', 409);
  }
  return JSON.parse(existing.response_json) as T;
}

async function ensureExpectedRevision(db: D1Database, expected: string) {
  if (await currentRevision(db) !== expected) {
    throw new QuestionAdminServiceError('bank_revision_conflict', 409);
  }
}

function normalizePatch(value: unknown): QuestionBankBatchPatchDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['patch должен быть объектом']);
  }
  const raw = value as Record<string, unknown>;
  const patch: QuestionBankBatchPatchDto = {};
  const issues: string[] = [];
  const unknown = Object.keys(raw).filter((key) => !['topic', 'difficulty', 'active'].includes(key));
  if (unknown.length > 0) issues.push(`Неизвестные поля patch: ${unknown.join(', ')}`);
  if (raw.topic !== undefined) {
    const category = validateQuestionCategoryName(raw.topic);
    if (!category) issues.push('topic должен быть допустимым названием категории');
    else patch.topic = category.name;
  }
  if (raw.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(raw.difficulty as Difficulty)) {
      issues.push('difficulty должен быть easy, medium, hard или expert');
    } else patch.difficulty = raw.difficulty as Difficulty;
  }
  if (raw.active !== undefined) {
    if (typeof raw.active !== 'boolean') issues.push('active должен быть boolean');
    else patch.active = raw.active;
  }
  if (Object.keys(patch).length === 0) issues.push('patch не содержит изменений');
  if (issues.length > 0) throw new QuestionAdminServiceError('invalid_request', 400, issues);
  return patch;
}

function normalizeOperations(value: unknown): QuestionBankBatchOperationDto[] {
  if (!Array.isArray(value)) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['operations должен быть массивом']);
  }
  if (value.length > MAX_CHANGE_SET_OPERATIONS) {
    throw new QuestionAdminServiceError(
      'mutation_too_large',
      413,
      [`Допускается не более ${MAX_CHANGE_SET_OPERATIONS} операций`],
    );
  }
  if (value.length === 0) return [];
  const seen = new Set<number>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new QuestionAdminServiceError('invalid_request', 400, [`Операция #${index + 1} некорректна`]);
    }
    const raw = candidate as Record<string, unknown>;
    if (!Number.isInteger(raw.questionId) || Number(raw.questionId) <= 0) {
      throw new QuestionAdminServiceError('invalid_request', 400, [`Операция #${index + 1}: questionId некорректен`]);
    }
    const questionId = Number(raw.questionId);
    if (seen.has(questionId)) {
      throw new QuestionAdminServiceError('invalid_request', 400, [`questionId ${questionId} повторяется`]);
    }
    seen.add(questionId);
    return { questionId, patch: normalizePatch(raw.patch) };
  });
}

async function assertActivePatchCategories(
  db: D1Database,
  operations: readonly QuestionBankBatchOperationDto[],
  overrides: ReadonlyMap<string, CategoryRow> = new Map(),
) {
  const topics = [...new Set(operations.flatMap((operation) => (
    operation.patch.topic ? [operation.patch.topic] : []
  )))];
  const result = new Map<string, CategoryRow>();
  for (const topic of topics) {
    const normalized = normalizeQuestionCategoryName(topic);
    const override = overrides.get(normalized);
    const category = override ?? await activeQuestionCategory(db, topic);
    if (!category) {
      throw new QuestionAdminServiceError(
        'question_validation_failed',
        422,
        [`Категория «${topic}» не существует или отключена`],
      );
    }
    result.set(normalized, {
      id: category.id,
      name: category.name,
      normalized_name: category.normalized_name,
      selection_key: category.selection_key,
      active: category.active,
      created_at: 'created_at' in category ? Number(category.created_at) : 0,
      updated_at: 'updated_at' in category ? Number(category.updated_at) : 0,
    });
  }
  return result;
}

function changedDefinitionFields(
  previous: QuestionDefinition,
  next: QuestionDefinition,
) {
  const fields: string[] = [];
  if (previous.topic !== next.topic) fields.push('topic');
  if (previous.difficulty !== next.difficulty) fields.push('difficulty');
  if (previous.prompt !== next.prompt) fields.push('prompt');
  if ((previous.contextType ?? null) !== (next.contextType ?? null)) fields.push('contextType');
  if ((previous.context ?? null) !== (next.context ?? null)) fields.push('context');
  if (JSON.stringify(previous.choices) !== JSON.stringify(next.choices)) fields.push('choices');
  if (previous.correctIndex !== next.correctIndex) fields.push('correctIndex');
  if (previous.dedupeKey !== next.dedupeKey) fields.push('dedupeKey');
  if (previous.active !== next.active) fields.push('active');
  return fields;
}

async function planQuestionOperations(
  db: D1Database,
  operations: readonly QuestionBankBatchOperationDto[],
  categoryOverrides: ReadonlyMap<string, CategoryRow> = new Map(),
  requireReady = true,
): Promise<MutationPlan> {
  if (operations.length > MAX_CHANGE_SET_OPERATIONS) {
    throw new QuestionAdminServiceError('mutation_too_large', 413);
  }
  const patchCategories = await assertActivePatchCategories(db, operations, categoryOverrides);
  const rows = await workflowRows(db);
  const leafById = new Map(currentLeafRows(rows).map((row) => [row.id, row]));
  let nextId = Math.max(1_000_000, ...rows.map((row) => row.id + 1));
  const changes: PlannedChange[] = [];
  let unchangedCount = 0;
  const definitions = rows.filter((row) => row.in_current_revision === 1).map(definitionFromRow);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const operation of operations) {
    const row = leafById.get(operation.questionId);
    if (!row) {
      const historical = rows.find((candidate) => candidate.id === operation.questionId);
      throw new QuestionAdminServiceError(
        historical?.successor_id ? 'question_has_successor' : 'not_found',
        historical?.successor_id ? 409 : 404,
      );
    }
    const previous = definitionFromRow(row);
    const next: QuestionDefinition = {
      ...previous,
      ...(operation.patch.topic === undefined ? {} : { topic: operation.patch.topic }),
      ...(operation.patch.difficulty === undefined
        ? {}
        : { difficulty: operation.patch.difficulty }),
      ...(operation.patch.active === undefined ? {} : { active: operation.patch.active }),
    };
    if (operation.patch.topic !== undefined) {
      const category = patchCategories.get(normalizeQuestionCategoryName(operation.patch.topic))!;
      next.topic = category.name;
      next.categoryId = category.id;
      next.selectionTopic = category.selection_key;
    }
    const changedFields = changedDefinitionFields(previous, next);
    if (changedFields.length === 0) {
      unchangedCount += 1;
      continue;
    }
    const contentChanged = changedFields.some((field) => field !== 'active');
    if (contentChanged) {
      const original = definitionsById.get(previous.id);
      if (original) original.active = false;
      const successor = { ...next, id: nextId };
      nextId += 1;
      definitions.push(successor);
      definitionsById.set(successor.id, successor);
      changes.push({
        kind: 'revise',
        originalId: previous.id,
        question: successor,
        changedFields,
      });
    } else {
      const target = definitionsById.get(previous.id);
      if (target) target.active = next.active;
      changes.push({
        kind: 'toggle',
        originalId: previous.id,
        question: next,
        changedFields,
      });
    }
  }
  const readiness = validateEffectiveBank(definitions, requireReady);
  const revision = await questionBankRevision(definitions);
  return {
    rows,
    changes,
    unchangedCount,
    definitions,
    revision,
    readiness,
    replacements: changes.flatMap((change) => change.kind === 'revise' ? [{
      previousQuestionId: change.originalId!,
      questionId: change.question.id,
    }] : []),
  };
}

function mutationStatement(
  db: D1Database,
  meta: MutationMeta,
  operation: string,
  hash: string,
  response: unknown,
  now: number,
) {
  return db.prepare(`INSERT INTO question_bank_mutations (
      idempotency_key, operation, expected_revision, request_hash, response_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      meta.idempotencyKey,
      operation,
      meta.expectedBankRevision,
      hash,
      JSON.stringify(response),
      now,
    );
}

function revisionGuardStatement(db: D1Database, expectedRevision: string) {
  return db.prepare(`UPDATE question_bank_state
    SET current_revision = CASE WHEN current_revision = ? THEN current_revision ELSE NULL END
    WHERE id = 1`).bind(expectedRevision);
}

function changeSetDraftGuardStatement(
  db: D1Database,
  id: string,
  expectedUpdatedAt: number,
  baseRevision?: string,
) {
  if (baseRevision === undefined) {
    return db.prepare(`UPDATE question_bank_change_sets
      SET status = CASE
        WHEN status = 'draft' AND updated_at = ? THEN status ELSE NULL END
      WHERE id = ?`).bind(expectedUpdatedAt, id);
  }
  return db.prepare(`UPDATE question_bank_change_sets
    SET status = CASE
      WHEN status = 'draft' AND base_revision = ? AND updated_at = ?
      THEN status ELSE NULL END
    WHERE id = ?`).bind(baseRevision, expectedUpdatedAt, id);
}

function categoryStateGuardStatement(db: D1Database, category: CategoryRow) {
  return db.prepare(`UPDATE question_categories
    SET active = CASE
      WHEN active = ? AND name = ? AND normalized_name = ? AND selection_key = ?
      THEN active ELSE NULL END
    WHERE id = ?`).bind(
    category.active,
    category.name,
    category.normalized_name,
    category.selection_key,
    category.id,
  );
}

function constraintFailureMentions(error: unknown, column: string) {
  return String(error).includes(column)
    || (error instanceof Error && String(error.cause).includes(column));
}

function categoryDependenciesForPlan(plan: MutationPlan): QuestionCategoryDependency[] {
  return plan.changes.map((change) => {
    const { categoryId, selectionTopic, topic } = change.question;
    if (!Number.isInteger(categoryId) || !selectionTopic) {
      throw new QuestionAdminServiceError(
        'question_validation_failed',
        422,
        [`Вопрос ${change.question.id} не связан со справочником категорий`],
      );
    }
    return { id: categoryId!, name: topic, selectionKey: selectionTopic };
  });
}

async function persistMutationPlan<T>(
  db: D1Database,
  options: {
    plan: MutationPlan;
    meta: MutationMeta;
    operation: string;
    hash: string;
    response: T;
    adminSessionFingerprint: string;
    extraStatements?: (revision: string, now: number) => D1PreparedStatement[];
    conflictCheck?: (error: unknown) => Promise<QuestionAdminServiceError | null>;
    guardCategoryDependencies?: boolean;
  },
) {
  const { plan, meta } = options;
  const replay = await replayMutation<T>(db, meta.idempotencyKey, options.operation, options.hash);
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const now = Date.now();
  const categoryDependencyGuard = options.guardCategoryDependencies === false
    ? null
    : questionCategoryDependencyGuardStatement(db, categoryDependenciesForPlan(plan));
  if (plan.changes.length === 0) {
    try {
      await db.batch([
        mutationStatement(db, meta, options.operation, options.hash, options.response, now),
        revisionGuardStatement(db, meta.expectedBankRevision),
        ...(categoryDependencyGuard ? [categoryDependencyGuard] : []),
        ...(options.extraStatements?.(meta.expectedBankRevision, now) ?? []),
      ]);
      return options.response;
    } catch (error) {
      const concurrentReplay = await replayMutation<T>(
        db,
        meta.idempotencyKey,
        options.operation,
        options.hash,
      );
      if (concurrentReplay) return concurrentReplay;
      if (await currentRevision(db) !== meta.expectedBankRevision) {
        throw new QuestionAdminServiceError('bank_revision_conflict', 409);
      }
      if (constraintFailureMentions(error, 'question_categories.active')) {
        throw new QuestionAdminServiceError('category_conflict', 409);
      }
      const conflict = await options.conflictCheck?.(error);
      if (conflict) throw conflict;
      throw error;
    }
  }
  const newQuestions = await Promise.all(plan.changes
    .filter((change) => change.kind !== 'toggle')
    .map(async (change) => ({
      id: change.question.id,
      categoryId: change.question.categoryId,
      difficulty: change.question.difficulty,
      topic: change.question.topic,
      prompt: change.question.prompt,
      contextType: change.question.contextType ?? null,
      context: change.question.context ?? null,
      choicesJson: JSON.stringify(change.question.choices),
      correctIndex: change.question.correctIndex,
      weight: TEST_CONFIG.weights[change.question.difficulty],
      active: change.question.active ? 1 : 0,
      contentHash: await questionContentHash(change.question),
      dedupeKey: change.question.dedupeKey,
      originalId: change.originalId,
      kind: change.kind,
    })));
  const toggles = plan.changes.filter((change) => change.kind === 'toggle').map((change) => ({
    id: change.question.id,
    active: change.question.active ? 1 : 0,
  }));
  const revisedOriginalIds = newQuestions.flatMap((question) => (
    question.kind === 'revise' && question.originalId !== null ? [question.originalId] : []
  ));
  const events = plan.changes.map((change) => ({
    eventType: change.kind === 'create'
      ? 'created'
      : change.kind === 'revise'
        ? 'revised'
        : change.question.active ? 'activated' : 'deactivated',
    questionId: change.question.id,
    predecessorId: change.kind === 'revise' ? change.originalId : null,
    successorId: change.kind === 'revise' ? change.question.id : null,
  }));
  const summary = summarizeQuestionBank(plan.definitions);
  const newQuestionsJson = JSON.stringify(newQuestions);
  const togglesJson = JSON.stringify(toggles);
  const revisedIdsJson = JSON.stringify(revisedOriginalIds);
  const eventsJson = JSON.stringify(events);
  const statements: D1PreparedStatement[] = [
    mutationStatement(db, meta, options.operation, options.hash, options.response, now),
  ];
  if (categoryDependencyGuard) statements.push(categoryDependencyGuard);
  if (revisedOriginalIds.length > 0) {
    statements.push(db.prepare(`UPDATE questions SET active = 0
      WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`)
      .bind(revisedIdsJson));
  }
  if (toggles.length > 0) {
    statements.push(db.prepare(`UPDATE questions
      SET active = (
        SELECT CAST(json_extract(value, '$.active') AS INTEGER)
        FROM json_each(?) WHERE CAST(json_extract(value, '$.id') AS INTEGER) = questions.id
      )
      WHERE id IN (
        SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?)
      )`).bind(togglesJson, togglesJson));
  }
  if (newQuestions.length > 0) {
    statements.push(db.prepare(`INSERT INTO questions (
        id, category_id, difficulty, topic, prompt, context_type, context_text, choices_json,
        correct_index, weight, active, content_hash, dedupe_key
      )
      SELECT
        CAST(json_extract(value, '$.id') AS INTEGER),
        CAST(json_extract(value, '$.categoryId') AS INTEGER),
        json_extract(value, '$.difficulty'),
        json_extract(value, '$.topic'),
        json_extract(value, '$.prompt'),
        json_extract(value, '$.contextType'),
        json_extract(value, '$.context'),
        json_extract(value, '$.choicesJson'),
        CAST(json_extract(value, '$.correctIndex') AS INTEGER),
        CAST(json_extract(value, '$.weight') AS INTEGER),
        CAST(json_extract(value, '$.active') AS INTEGER),
        json_extract(value, '$.contentHash'),
        json_extract(value, '$.dedupeKey')
      FROM json_each(?)`).bind(newQuestionsJson));
  }
  statements.push(db.prepare(`INSERT INTO question_bank_revisions (
      hash, applied_at, total_count, active_count, pools_json
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET applied_at = excluded.applied_at`)
    .bind(plan.revision, now, summary.total, summary.active, JSON.stringify(summary.pools)));
  statements.push(db.prepare(`INSERT OR IGNORE INTO question_bank_revision_items (
      revision_hash, question_id, active
    )
    SELECT ?, membership.question_id, questions.active
    FROM question_bank_revision_items membership
    JOIN questions ON questions.id = membership.question_id
    WHERE membership.revision_hash = ?`)
    .bind(plan.revision, meta.expectedBankRevision));
  if (newQuestions.length > 0) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO question_bank_revision_items (
        revision_hash, question_id, active
      )
      SELECT ?, CAST(json_extract(value, '$.id') AS INTEGER),
        CAST(json_extract(value, '$.active') AS INTEGER)
      FROM json_each(?)`).bind(plan.revision, newQuestionsJson));
  }
  if (newQuestions.some((question) => question.kind === 'revise')) {
    statements.push(db.prepare(`INSERT INTO question_version_links (
        predecessor_question_id, successor_question_id, created_at, bank_revision,
        admin_session_fingerprint
      )
      SELECT CAST(json_extract(value, '$.originalId') AS INTEGER),
        CAST(json_extract(value, '$.id') AS INTEGER), ?, ?, ?
      FROM json_each(?) WHERE json_extract(value, '$.kind') = 'revise'`)
      .bind(now, plan.revision, options.adminSessionFingerprint, newQuestionsJson));
  }
  statements.push(db.prepare(`INSERT INTO question_bank_change_events (
      event_type, question_id, predecessor_question_id, successor_question_id,
      bank_revision, created_at, note, admin_session_fingerprint
    )
    SELECT json_extract(value, '$.eventType'),
      CAST(json_extract(value, '$.questionId') AS INTEGER),
      CAST(json_extract(value, '$.predecessorId') AS INTEGER),
      CAST(json_extract(value, '$.successorId') AS INTEGER),
      ?, ?, ?, ?
    FROM json_each(?)`)
    .bind(plan.revision, now, meta.note, options.adminSessionFingerprint, eventsJson));
  statements.push(...(options.extraStatements?.(plan.revision, now) ?? []));
  statements.push(db.prepare(`UPDATE question_bank_state
    SET current_revision = CASE WHEN current_revision = ? THEN ? ELSE NULL END,
      updated_at = ?
    WHERE id = 1`)
    .bind(meta.expectedBankRevision, plan.revision, now));
  try {
    await db.batch(statements);
  } catch (error) {
    const concurrentReplay = await replayMutation<T>(
      db,
      meta.idempotencyKey,
      options.operation,
      options.hash,
    );
    if (concurrentReplay) return concurrentReplay;
    if (await currentRevision(db) !== meta.expectedBankRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    if (constraintFailureMentions(error, 'question_categories.active')) {
      throw new QuestionAdminServiceError('category_conflict', 409);
    }
    const conflict = await options.conflictCheck?.(error);
    if (conflict) throw conflict;
    throw error;
  }
  invalidateQuestionBankCache();
  return options.response;
}

export async function bulkUpdateQuestions(
  db: D1Database,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionBankBatchMutationDto> {
  const meta = workflowMeta(body);
  if (!Array.isArray(body.questionIds)) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['questionIds должен быть массивом']);
  }
  if (body.questionIds.length > MAX_CHANGE_SET_OPERATIONS) {
    throw new QuestionAdminServiceError('mutation_too_large', 413);
  }
  const patch = normalizePatch(body.patch);
  const operations = normalizeOperations(body.questionIds.map((questionId) => ({
    questionId,
    patch,
  })));
  const hash = await requestHash('bulk', { operations, ...meta });
  const replay = await replayMutation<QuestionBankBatchMutationDto>(
    db,
    meta.idempotencyKey,
    'bulk',
    hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const plan = await planQuestionOperations(db, operations);
  const response: QuestionBankBatchMutationDto = {
    changedCount: plan.changes.length,
    unchangedCount: plan.unchangedCount,
    replacements: plan.replacements,
    currentBankRevision: plan.revision,
    readiness: plan.readiness,
  };
  return persistMutationPlan(db, {
    plan,
    meta,
    operation: 'bulk',
    hash,
    response,
    adminSessionFingerprint,
  });
}

function categoryNameFromBody(body: Record<string, unknown>) {
  const category = validateQuestionCategoryName(body.name);
  if (!category) {
    throw new QuestionAdminServiceError(
      'invalid_request',
      400,
      ['name должен быть непустым названием категории длиной до 80 символов'],
    );
  }
  return category;
}

function expectedCategoryNameFromBody(body: Record<string, unknown>) {
  if (
    typeof body.expectedCategoryName !== 'string'
    || body.expectedCategoryName.length === 0
    || body.expectedCategoryName.length > 80
  ) {
    throw new QuestionAdminServiceError(
      'invalid_request',
      400,
      ['expectedCategoryName должен содержать текущее имя категории'],
    );
  }
  return body.expectedCategoryName;
}

function currentDefinitions(rows: WorkflowRow[]) {
  return rows.filter((row) => row.in_current_revision === 1).map(definitionFromRow);
}

function categoryReadiness(rows: WorkflowRow[]) {
  return validateEffectiveBank(currentDefinitions(rows));
}

export async function createQuestionCategory(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<QuestionCategoryMutationDto> {
  const meta = workflowMeta(body);
  const name = categoryNameFromBody(body);
  const hash = await requestHash('category-create', { name, ...meta });
  const replay = await replayMutation<QuestionCategoryMutationDto>(
    db,
    meta.idempotencyKey,
    'category-create',
    hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const [categories, rows, maxRow] = await Promise.all([
    categoryRows(db),
    workflowRows(db),
    db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM question_categories')
      .first<{ max_id: number }>(),
  ]);
  if (categories.some((category) => (
    category.normalized_name === name.normalizedName
    || normalizeQuestionCategoryName(category.selection_key) === name.normalizedName
  ))) {
    throw new QuestionAdminServiceError('category_conflict', 409);
  }
  const now = Date.now();
  const row: CategoryRow = {
    id: (maxRow?.max_id ?? 0) + 1,
    name: name.name,
    normalized_name: name.normalizedName,
    selection_key: name.name,
    active: 1,
    created_at: now,
    updated_at: now,
  };
  const response: QuestionCategoryMutationDto = {
    category: categoryDto(row, rows),
    changedQuestionCount: 0,
    replacements: [],
    currentBankRevision: meta.expectedBankRevision,
    readiness: categoryReadiness(rows),
  };
  try {
    await db.batch([
      mutationStatement(db, meta, 'category-create', hash, response, now),
      revisionGuardStatement(db, meta.expectedBankRevision),
      db.prepare(`INSERT INTO question_categories (
          id, name, normalized_name, selection_key, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)`)
        .bind(row.id, row.name, row.normalized_name, row.selection_key, now, now),
    ]);
  } catch {
    const concurrentReplay = await replayMutation<QuestionCategoryMutationDto>(
      db,
      meta.idempotencyKey,
      'category-create',
      hash,
    );
    if (concurrentReplay) return concurrentReplay;
    if (await currentRevision(db) !== meta.expectedBankRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    throw new QuestionAdminServiceError('category_conflict', 409);
  }
  return response;
}

async function categoryById(db: D1Database, id: number) {
  const category = await db.prepare(`SELECT id, name, normalized_name, selection_key,
      active, created_at, updated_at
    FROM question_categories WHERE id = ?`).bind(id).first<CategoryRow>();
  if (!category) throw new QuestionAdminServiceError('not_found', 404);
  return category;
}

function mergeCategoryDtos(
  target: QuestionCategoryDto,
  source: QuestionCategoryDto,
): QuestionCategoryDto {
  return {
    ...target,
    activeQuestionCount: target.activeQuestionCount + source.activeQuestionCount,
    inactiveQuestionCount: target.inactiveQuestionCount + source.inactiveQuestionCount,
    difficultyCounts: Object.fromEntries(DIFFICULTIES.map((difficulty) => [
      difficulty,
      target.difficultyCounts[difficulty] + source.difficultyCounts[difficulty],
    ])) as Record<Difficulty, number>,
  };
}

export async function renameQuestionCategory(
  db: D1Database,
  categoryId: number,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionCategoryMutationDto> {
  const meta = workflowMeta(body);
  const name = categoryNameFromBody(body);
  const expectedCategoryName = expectedCategoryNameFromBody(body);
  const hash = await requestHash('category-rename', {
    categoryId,
    name,
    expectedCategoryName,
    ...meta,
  });
  const replay = await replayMutation<QuestionCategoryMutationDto>(
    db,
    meta.idempotencyKey,
    'category-rename',
    hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const [source, categories, rows] = await Promise.all([
    categoryById(db, categoryId),
    categoryRows(db),
    workflowRows(db),
  ]);
  if (source.active !== 1) throw new QuestionAdminServiceError('category_conflict', 409);
  if (source.name !== expectedCategoryName) {
    throw new QuestionAdminServiceError('category_conflict', 409);
  }
  if (categories.some((category) => (
    category.id !== source.id && category.normalized_name === name.normalizedName
  ))) throw new QuestionAdminServiceError('category_conflict', 409);
  if (categories.some((category) => (
    category.id !== source.id
    && normalizeQuestionCategoryName(category.selection_key) === name.normalizedName
  ))) throw new QuestionAdminServiceError('category_conflict', 409);
  const operations = currentLeafRows(rows)
    .filter((row) => row.category_id === source.id)
    .map((row) => ({ questionId: row.id, patch: { topic: name.name } }));
  const renamedCategory: CategoryRow = {
    ...source,
    name: name.name,
    normalized_name: name.normalizedName,
    updated_at: Date.now(),
  };
  const overrides = new Map([[name.normalizedName, renamedCategory]]);
  const plan = await planQuestionOperations(db, operations, overrides);
  const sourceDto = categoryDto(source, rows);
  const response: QuestionCategoryMutationDto = {
    category: {
      ...sourceDto,
      name: name.name,
      normalizedName: name.normalizedName,
    },
    changedQuestionCount: plan.changes.length,
    replacements: plan.replacements,
    currentBankRevision: plan.revision,
    readiness: plan.readiness,
  };
  return persistMutationPlan(db, {
    plan,
    meta,
    operation: 'category-rename',
    hash,
    response,
    adminSessionFingerprint,
    guardCategoryDependencies: false,
    extraStatements: (_revision, now) => [
      categoryStateGuardStatement(db, source),
      db.prepare(`UPDATE question_categories
        SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?`)
        .bind(name.name, name.normalizedName, now, source.id),
    ],
    conflictCheck: async (error) => {
      if (constraintFailureMentions(error, 'question_categories.active')) {
        return new QuestionAdminServiceError('category_conflict', 409);
      }
      const current = await categoryById(db, source.id);
      return current.active === source.active
        && current.name === source.name
        && current.normalized_name === source.normalized_name
        && current.selection_key === source.selection_key
        ? null
        : new QuestionAdminServiceError('category_conflict', 409);
    },
  });
}

export async function mergeQuestionCategory(
  db: D1Database,
  categoryId: number,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionCategoryMutationDto> {
  const meta = workflowMeta(body);
  const expectedCategoryName = expectedCategoryNameFromBody(body);
  const targetCategoryId = body.targetCategoryId;
  if (!Number.isInteger(targetCategoryId) || Number(targetCategoryId) <= 0) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['targetCategoryId некорректен']);
  }
  if (Number(targetCategoryId) === categoryId) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['Нельзя объединить категорию с собой']);
  }
  const hash = await requestHash('category-merge', {
    categoryId,
    targetCategoryId,
    expectedCategoryName,
    ...meta,
  });
  const replay = await replayMutation<QuestionCategoryMutationDto>(
    db,
    meta.idempotencyKey,
    'category-merge',
    hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const [source, target, rows] = await Promise.all([
    categoryById(db, categoryId),
    categoryById(db, Number(targetCategoryId)),
    workflowRows(db),
  ]);
  if (source.active !== 1 || target.active !== 1) {
    throw new QuestionAdminServiceError('category_conflict', 409);
  }
  if (source.name !== expectedCategoryName) {
    throw new QuestionAdminServiceError('category_conflict', 409);
  }
  const operations = currentLeafRows(rows)
    .filter((row) => row.category_id === source.id)
    .map((row) => ({ questionId: row.id, patch: { topic: target.name } }));
  const plan = await planQuestionOperations(db, operations);
  const response: QuestionCategoryMutationDto = {
    category: mergeCategoryDtos(categoryDto(target, rows), categoryDto(source, rows)),
    changedQuestionCount: plan.changes.length,
    replacements: plan.replacements,
    currentBankRevision: plan.revision,
    readiness: plan.readiness,
  };
  return persistMutationPlan(db, {
    plan,
    meta,
    operation: 'category-merge',
    hash,
    response,
    adminSessionFingerprint,
    extraStatements: (_revision, now) => [
      categoryStateGuardStatement(db, target),
      categoryStateGuardStatement(db, source),
      db.prepare(`UPDATE question_categories SET active = 0, updated_at = ?
        WHERE id = ?`).bind(now, source.id),
    ],
    conflictCheck: async (error) => {
      if (constraintFailureMentions(error, 'question_categories.active')) {
        return new QuestionAdminServiceError('category_conflict', 409);
      }
      const [currentSource, currentTarget] = await Promise.all([
        categoryById(db, source.id),
        categoryById(db, target.id),
      ]);
      const matches = (current: CategoryRow, expected: CategoryRow) => (
        current.active === expected.active
        && current.name === expected.name
        && current.normalized_name === expected.normalized_name
        && current.selection_key === expected.selection_key
      );
      return matches(currentSource, source) && matches(currentTarget, target)
        ? null
        : new QuestionAdminServiceError('category_conflict', 409);
    },
  });
}

function changeSetDto(row: ChangeSetRow): QuestionBankChangeSetDto {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    baseBankRevision: row.base_revision,
    publishedBankRevision: row.published_revision,
    operationCount: row.operation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

async function changeSetRows(db: D1Database, id?: string) {
  const result = await db.prepare(`SELECT change_sets.*,
      COUNT(items.id) AS operation_count
    FROM question_bank_change_sets change_sets
    LEFT JOIN question_bank_change_set_items items ON items.change_set_id = change_sets.id
    ${id ? 'WHERE change_sets.id = ?' : ''}
    GROUP BY change_sets.id
    ORDER BY change_sets.updated_at DESC, change_sets.id`)
    .bind(...(id ? [id] : []))
    .all<ChangeSetRow>();
  return result.results;
}

async function changeSetItems(db: D1Database, id: string) {
  const result = await db.prepare(`SELECT id, question_id, patch_json, created_at
    FROM question_bank_change_set_items WHERE change_set_id = ? ORDER BY id`)
    .bind(id)
    .all<{ id: number; question_id: number; patch_json: string; created_at: number }>();
  return result.results.map((row): QuestionBankChangeSetItemDto => ({
    id: row.id,
    questionId: row.question_id,
    patch: JSON.parse(row.patch_json) as QuestionBankBatchPatchDto,
    createdAt: row.created_at,
  }));
}

async function requireChangeSet(db: D1Database, id: string) {
  const row = (await changeSetRows(db, id))[0];
  if (!row) throw new QuestionAdminServiceError('not_found', 404);
  return row;
}

export async function listQuestionBankChangeSets(
  db: D1Database,
): Promise<QuestionBankChangeSetListDto> {
  return {
    items: (await changeSetRows(db)).map(changeSetDto),
    currentBankRevision: await currentRevision(db),
  };
}

export async function getQuestionBankChangeSet(
  db: D1Database,
  id: string,
): Promise<QuestionBankChangeSetDetailDto> {
  const row = await requireChangeSet(db, id);
  return {
    changeSet: changeSetDto(row),
    operations: await changeSetItems(db, id),
    currentBankRevision: await currentRevision(db),
  };
}

function changeSetTitle(value: unknown) {
  if (typeof value !== 'string') return null;
  const title = value.trim().replace(/\s+/gu, ' ');
  return title && title.length <= MAX_CHANGE_SET_TITLE_LENGTH ? title : null;
}

export async function createQuestionBankChangeSet(
  db: D1Database,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionBankChangeSetDetailDto> {
  const meta = workflowMeta(body);
  const title = changeSetTitle(body.title);
  if (!title) throw new QuestionAdminServiceError('invalid_request', 400, ['title некорректен']);
  const hash = await requestHash('change-set-create', { title, ...meta });
  const replay = await replayMutation<QuestionBankChangeSetDetailDto>(
    db,
    meta.idempotencyKey,
    'change-set-create',
    hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const now = Date.now();
  const id = crypto.randomUUID();
  const response: QuestionBankChangeSetDetailDto = {
    changeSet: {
      id,
      title,
      note: meta.note,
      status: 'draft',
      baseBankRevision: meta.expectedBankRevision,
      publishedBankRevision: null,
      operationCount: 0,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    },
    operations: [],
    currentBankRevision: meta.expectedBankRevision,
  };
  try {
    await db.batch([
      mutationStatement(db, meta, 'change-set-create', hash, response, now),
      revisionGuardStatement(db, meta.expectedBankRevision),
      db.prepare(`INSERT INTO question_bank_change_sets (
          id, title, note, status, base_revision, created_at, updated_at,
          admin_session_fingerprint
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .bind(id, title, meta.note, meta.expectedBankRevision, now, now, adminSessionFingerprint),
    ]);
  } catch (error) {
    const concurrentReplay = await replayMutation<QuestionBankChangeSetDetailDto>(
      db, meta.idempotencyKey, 'change-set-create', hash,
    );
    if (concurrentReplay) return concurrentReplay;
    if (await currentRevision(db) !== meta.expectedBankRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    throw error;
  }
  return response;
}

export async function replaceQuestionBankChangeSetOperations(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
): Promise<QuestionBankChangeSetDetailDto> {
  const meta = workflowMeta(body);
  const token = changeSetMutationToken(body);
  const operations = normalizeOperations(body.operations);
  const hash = await requestHash('change-set-update', { id, operations, ...meta, ...token });
  const replay = await replayMutation<QuestionBankChangeSetDetailDto>(
    db, meta.idempotencyKey, 'change-set-update', hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const row = await requireChangeSet(db, id);
  if (
    row.status !== 'draft'
    || row.base_revision !== meta.expectedBankRevision
    || row.updated_at !== token.expectedChangeSetUpdatedAt
  ) {
    throw new QuestionAdminServiceError('change_set_conflict', 409);
  }
  await planQuestionOperations(db, operations, new Map(), false);
  const now = Math.max(Date.now(), row.updated_at + 1);
  const response: QuestionBankChangeSetDetailDto = {
    changeSet: {
      ...changeSetDto(row),
      operationCount: operations.length,
      updatedAt: now,
    },
    operations: operations.map((operation) => ({
      id: operation.questionId,
      questionId: operation.questionId,
      patch: operation.patch,
      createdAt: now,
    })),
    currentBankRevision: meta.expectedBankRevision,
  };
  const payload = JSON.stringify(operations);
  try {
    await db.batch([
      mutationStatement(db, meta, 'change-set-update', hash, response, now),
      revisionGuardStatement(db, meta.expectedBankRevision),
      changeSetDraftGuardStatement(
        db,
        id,
        token.expectedChangeSetUpdatedAt,
        meta.expectedBankRevision,
      ),
      db.prepare('DELETE FROM question_bank_change_set_items WHERE change_set_id = ?').bind(id),
      db.prepare(`INSERT INTO question_bank_change_set_items (
          change_set_id, question_id, patch_json, created_at
        )
        SELECT ?, CAST(json_extract(value, '$.questionId') AS INTEGER),
          json(json_extract(value, '$.patch')), ?
        FROM json_each(?)`).bind(id, now, payload),
      db.prepare('UPDATE question_bank_change_sets SET updated_at = ? WHERE id = ?')
        .bind(now, id),
    ]);
  } catch (error) {
    const concurrentReplay = await replayMutation<QuestionBankChangeSetDetailDto>(
      db, meta.idempotencyKey, 'change-set-update', hash,
    );
    if (concurrentReplay) return concurrentReplay;
    if (await currentRevision(db) !== meta.expectedBankRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    if (constraintFailureMentions(error, 'question_bank_change_sets.status')) {
      throw new QuestionAdminServiceError('change_set_conflict', 409);
    }
    const current = await requireChangeSet(db, id);
    if (
      current.status !== 'draft'
      || current.base_revision !== meta.expectedBankRevision
      || current.updated_at !== token.expectedChangeSetUpdatedAt
    ) {
      throw new QuestionAdminServiceError('change_set_conflict', 409);
    }
    throw error;
  }
  return response;
}

function effectiveLeafDefinitions(plan: MutationPlan) {
  const revisedIds = new Set(plan.changes.flatMap((change) => (
    change.kind === 'revise' && change.originalId !== null ? [change.originalId] : []
  )));
  const toggles = new Map(plan.changes.filter((change) => change.kind === 'toggle')
    .map((change) => [change.question.id, change.question]));
  const leaves = currentLeafRows(plan.rows)
    .filter((row) => !revisedIds.has(row.id))
    .map((row) => toggles.get(row.id) ?? definitionFromRow(row));
  leaves.push(...plan.changes.filter((change) => change.kind !== 'toggle')
    .map((change) => change.question));
  return leaves;
}

function coverageForPlan(plan: MutationPlan, categories: readonly QuestionCategoryDto[]) {
  const leaves = effectiveLeafDefinitions(plan);
  const projected = categories.map((category) => {
    const matching = leaves.filter((question) => question.categoryId === category.id);
    const active = matching.filter((question) => question.active);
    return {
      ...category,
      activeQuestionCount: active.length,
      inactiveQuestionCount: matching.length - active.length,
      difficultyCounts: Object.fromEntries(DIFFICULTIES.map((difficulty) => [
        difficulty,
        active.filter((question) => question.difficulty === difficulty).length,
      ])) as Record<Difficulty, number>,
    };
  });
  return buildQuestionCoverage(plan.revision, projected, plan.readiness);
}

export async function previewQuestionBankChangeSet(
  db: D1Database,
  id: string,
): Promise<QuestionBankChangeSetPreviewDto> {
  const detail = await getQuestionBankChangeSet(db, id);
  if (
    detail.changeSet.status !== 'draft'
    || detail.changeSet.baseBankRevision !== detail.currentBankRevision
  ) throw new QuestionAdminServiceError('change_set_conflict', 409);
  const operations = detail.operations.map((item) => ({
    questionId: item.questionId,
    patch: item.patch,
  }));
  const plan = await planQuestionOperations(db, operations, new Map(), false);
  const catalog = await listQuestionCategories(db);
  return {
    ...detail,
    changedCount: plan.changes.length,
    unchangedCount: plan.unchangedCount,
    replacements: plan.replacements.map((replacement) => ({
      previousQuestionId: replacement.previousQuestionId,
      proposedQuestionId: replacement.questionId,
    })),
    readiness: plan.readiness,
    coverage: coverageForPlan(plan, catalog.items),
  };
}

export async function publishQuestionBankChangeSet(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionBankBatchMutationDto> {
  const meta = workflowMeta(body);
  const token = changeSetMutationToken(body);
  const hash = await requestHash('change-set-publish', { id, ...meta, ...token });
  const replay = await replayMutation<QuestionBankBatchMutationDto>(
    db, meta.idempotencyKey, 'change-set-publish', hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const detail = await getQuestionBankChangeSet(db, id);
  if (
    detail.changeSet.status !== 'draft'
    || detail.changeSet.baseBankRevision !== meta.expectedBankRevision
    || detail.changeSet.updatedAt !== token.expectedChangeSetUpdatedAt
  ) throw new QuestionAdminServiceError('change_set_conflict', 409);
  const operations = detail.operations.map((item) => ({
    questionId: item.questionId,
    patch: item.patch,
  }));
  const plan = await planQuestionOperations(db, operations);
  const response: QuestionBankBatchMutationDto = {
    changedCount: plan.changes.length,
    unchangedCount: plan.unchangedCount,
    replacements: plan.replacements,
    currentBankRevision: plan.revision,
    readiness: plan.readiness,
  };
  return persistMutationPlan(db, {
    plan,
    meta,
    operation: 'change-set-publish',
    hash,
    response,
    adminSessionFingerprint,
    extraStatements: (revision, now) => [
      db.prepare(`UPDATE question_bank_change_sets
        SET status = CASE
          WHEN status = 'draft' AND base_revision = ? AND updated_at = ?
          THEN 'published' ELSE NULL END,
          published_revision = ?, published_at = ?, updated_at = ?
        WHERE id = ?`)
        .bind(
          meta.expectedBankRevision,
          token.expectedChangeSetUpdatedAt,
          revision,
          now,
          now,
          id,
        ),
    ],
    conflictCheck: async (error) => {
      if (constraintFailureMentions(error, 'question_bank_change_sets.status')) {
        return new QuestionAdminServiceError('change_set_conflict', 409);
      }
      const current = await requireChangeSet(db, id);
      return current.status === 'draft'
        && current.base_revision === meta.expectedBankRevision
        && current.updated_at === token.expectedChangeSetUpdatedAt
        ? null
        : new QuestionAdminServiceError('change_set_conflict', 409);
    },
  });
}

export async function discardQuestionBankChangeSet(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
): Promise<QuestionBankChangeSetDetailDto> {
  const meta = workflowMeta(body);
  const token = changeSetMutationToken(body);
  const hash = await requestHash('change-set-discard', { id, ...meta, ...token });
  const replay = await replayMutation<QuestionBankChangeSetDetailDto>(
    db, meta.idempotencyKey, 'change-set-discard', hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const detail = await getQuestionBankChangeSet(db, id);
  if (
    detail.changeSet.status !== 'draft'
    || detail.changeSet.updatedAt !== token.expectedChangeSetUpdatedAt
  ) {
    throw new QuestionAdminServiceError('change_set_conflict', 409);
  }
  const now = Math.max(Date.now(), detail.changeSet.updatedAt + 1);
  const response: QuestionBankChangeSetDetailDto = {
    ...detail,
    changeSet: { ...detail.changeSet, status: 'discarded', updatedAt: now },
  };
  try {
    await db.batch([
      mutationStatement(db, meta, 'change-set-discard', hash, response, now),
      revisionGuardStatement(db, meta.expectedBankRevision),
      db.prepare(`UPDATE question_bank_change_sets
        SET status = CASE
          WHEN status = 'draft' AND updated_at = ? THEN 'discarded' ELSE NULL END,
          updated_at = ?
        WHERE id = ?`).bind(token.expectedChangeSetUpdatedAt, now, id),
    ]);
  } catch (error) {
    const concurrentReplay = await replayMutation<QuestionBankChangeSetDetailDto>(
      db, meta.idempotencyKey, 'change-set-discard', hash,
    );
    if (concurrentReplay) return concurrentReplay;
    if (await currentRevision(db) !== meta.expectedBankRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    if (constraintFailureMentions(error, 'question_bank_change_sets.status')) {
      throw new QuestionAdminServiceError('change_set_conflict', 409);
    }
    const current = await requireChangeSet(db, id);
    if (
      current.status !== 'draft'
      || current.updated_at !== token.expectedChangeSetUpdatedAt
    ) {
      throw new QuestionAdminServiceError('change_set_conflict', 409);
    }
    throw error;
  }
  return response;
}

type ImportPlanningResult = {
  preview: QuestionImportPreviewDto;
  plan: MutationPlan | null;
};

function importSummary(items: readonly QuestionImportDiffItemDto[]) {
  return {
    added: items.filter((item) => item.action === 'added').length,
    revised: items.filter((item) => item.action === 'revised').length,
    unchanged: items.filter((item) => item.action === 'unchanged').length,
    invalid: items.filter((item) => item.action === 'invalid').length,
  };
}

function importDefinition(
  candidate: unknown,
  id: number,
  defaultActive: boolean,
) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new QuestionBankValidationError('import', ['ожидается объект']);
  }
  const raw = candidate as Record<string, unknown>;
  const normalizedContext = raw.contextType == null && raw.context == null
    ? {}
    : { contextType: raw.contextType, context: raw.context };
  return validateQuestionBank([{
    id,
    topic: raw.topic,
    difficulty: raw.difficulty,
    prompt: raw.prompt,
    ...normalizedContext,
    choices: raw.choices,
    correctIndex: raw.correctIndex,
    dedupeKey: raw.dedupeKey,
    active: raw.active === undefined ? defaultActive : raw.active,
  }], 'import-question', { enforceOperationalReadiness: false })[0];
}

function importSourceId(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const id = (candidate as Record<string, unknown>).id;
  return id === undefined ? null : Number.isInteger(id) && Number(id) > 0 ? Number(id) : Number.NaN;
}

export async function buildImportPreviewPlan(
  db: D1Database,
  questions: unknown,
  expectedBankRevision: string,
): Promise<ImportPlanningResult> {
  if (!Array.isArray(questions)) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['questions должен быть массивом']);
  }
  if (questions.length > MAX_CHANGE_SET_OPERATIONS) {
    throw new QuestionAdminServiceError(
      'mutation_too_large',
      413,
      [`Импорт поддерживает не более ${MAX_CHANGE_SET_OPERATIONS} вопросов`],
    );
  }
  const previewToken = await sha256Hex(JSON.stringify({ expectedBankRevision, questions }));
  const [rows, categories] = await Promise.all([workflowRows(db), categoryRows(db)]);
  const leafById = new Map(currentLeafRows(rows).map((row) => [row.id, row]));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const activeCategoryByNormalized = new Map(categories.filter((category) => category.active === 1)
    .map((category) => [category.normalized_name, category]));
  const seenSourceIds = new Set<number>();
  let nextId = Math.max(1_000_000, ...rows.map((row) => row.id + 1));
  const items: QuestionImportDiffItemDto[] = [];
  const changes: PlannedChange[] = [];
  const definitions = rows.filter((row) => row.in_current_revision === 1).map(definitionFromRow);
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));

  for (let sourceIndex = 0; sourceIndex < questions.length; sourceIndex += 1) {
    const candidate = questions[sourceIndex];
    const sourceId = importSourceId(candidate);
    const issues: string[] = [];
    if (Number.isNaN(sourceId)) issues.push('id должен быть положительным целым числом или отсутствовать');
    if (sourceId !== null && !Number.isNaN(sourceId)) {
      if (seenSourceIds.has(sourceId)) issues.push(`id ${sourceId} повторяется в импорте`);
      seenSourceIds.add(sourceId);
      const historical = rowById.get(sourceId);
      if (!historical) issues.push(`Вопрос id ${sourceId} не найден`);
      else if (historical.successor_id !== null) issues.push(`Вопрос id ${sourceId} уже имеет новую редакцию`);
      else if (!leafById.has(sourceId)) issues.push(`Вопрос id ${sourceId} не входит в текущую ревизию`);
    }
    const target = sourceId !== null && !Number.isNaN(sourceId) ? leafById.get(sourceId) : undefined;
    let definition: QuestionDefinition | null = null;
    try {
      definition = importDefinition(candidate, target?.id ?? nextId, target?.current_active === 1);
    } catch (error) {
      if (error instanceof QuestionBankValidationError) issues.push(...error.issues);
      else throw error;
    }
    let category: CategoryRow | undefined;
    if (definition) {
      category = activeCategoryByNormalized.get(normalizeQuestionCategoryName(definition.topic));
      if (!category) issues.push(`Категория «${definition.topic}» не существует или отключена`);
      else {
        definition.categoryId = category.id;
        definition.selectionTopic = category.selection_key;
        definition.topic = category.name;
      }
    }
    if (issues.length > 0 || !definition || !category) {
      items.push({
        sourceIndex,
        sourceId: sourceId !== null && !Number.isNaN(sourceId) ? sourceId : null,
        matchedQuestionId: target?.id ?? null,
        action: 'invalid',
        issues,
        changedFields: [],
      });
      continue;
    }
    if (!target) {
      const question = { ...definition, id: nextId };
      nextId += 1;
      definitions.push(question);
      definitionsById.set(question.id, question);
      changes.push({ kind: 'create', originalId: null, question, changedFields: ['created'], sourceIndex });
      items.push({
        sourceIndex,
        sourceId: null,
        matchedQuestionId: null,
        action: 'added',
        issues: [],
        changedFields: ['created'],
      });
      continue;
    }
    const previous = definitionFromRow(target);
    const changedFields = changedDefinitionFields(previous, definition);
    if (changedFields.length === 0) {
      items.push({
        sourceIndex,
        sourceId: target.id,
        matchedQuestionId: target.id,
        action: 'unchanged',
        issues: [],
        changedFields: [],
      });
      continue;
    }
    if (changedFields.every((field) => field === 'active')) {
      const stored = definitionsById.get(target.id);
      if (stored) stored.active = definition.active;
      changes.push({ kind: 'toggle', originalId: target.id, question: definition, changedFields, sourceIndex });
    } else {
      const stored = definitionsById.get(target.id);
      if (stored) stored.active = false;
      const successor = { ...definition, id: nextId };
      nextId += 1;
      definitions.push(successor);
      definitionsById.set(successor.id, successor);
      changes.push({ kind: 'revise', originalId: target.id, question: successor, changedFields, sourceIndex });
    }
    items.push({
      sourceIndex,
      sourceId: target.id,
      matchedQuestionId: target.id,
      action: 'revised',
      issues: [],
      changedFields,
    });
  }

  let plan: MutationPlan | null = null;
  let readiness: QuestionBankReadinessDto | null = null;
  if (items.every((item) => item.action !== 'invalid')) {
    try {
      readiness = validateEffectiveBank(definitions, false);
      const revision = await questionBankRevision(definitions);
      plan = {
        rows,
        changes,
        unchangedCount: items.filter((item) => item.action === 'unchanged').length,
        definitions,
        revision,
        readiness,
        replacements: changes.flatMap((change) => change.kind === 'revise' ? [{
          previousQuestionId: change.originalId!,
          questionId: change.question.id,
        }] : []),
      };
    } catch (error) {
      if (!(error instanceof QuestionAdminServiceError)) throw error;
      const globalIssues = error.issues ?? [error.code];
      for (const item of items) {
        if (item.action === 'unchanged') continue;
        item.action = 'invalid';
        item.issues.push(...globalIssues);
      }
    }
  }
  return {
    preview: {
      expectedBankRevision,
      previewToken,
      summary: importSummary(items),
      items,
      readiness,
    },
    plan,
  };
}

export async function previewQuestionImport(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<QuestionImportPreviewDto> {
  const expected = body.expectedBankRevision;
  if (typeof expected !== 'string' || !SHA256_PATTERN.test(expected)) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  await ensureExpectedRevision(db, expected);
  return (await buildImportPreviewPlan(db, body.questions, expected)).preview;
}

export async function applyQuestionImport(
  db: D1Database,
  body: Record<string, unknown>,
  adminSessionFingerprint: string,
): Promise<QuestionImportApplyDto> {
  const meta = workflowMeta(body);
  const previewToken = body.previewToken;
  if (typeof previewToken !== 'string' || !SHA256_PATTERN.test(previewToken)) {
    throw new QuestionAdminServiceError('invalid_request', 400, ['previewToken некорректен']);
  }
  const hash = await requestHash('import-apply', {
    questions: body.questions,
    previewToken,
    ...meta,
  });
  const replay = await replayMutation<QuestionImportApplyDto>(
    db, meta.idempotencyKey, 'import-apply', hash,
  );
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const planning = await buildImportPreviewPlan(db, body.questions, meta.expectedBankRevision);
  if (planning.preview.previewToken !== previewToken) {
    throw new QuestionAdminServiceError('import_preview_conflict', 409);
  }
  if (!planning.plan || planning.preview.summary.invalid > 0) {
    throw new QuestionAdminServiceError(
      'question_validation_failed',
      422,
      planning.preview.items.flatMap((item) => item.issues),
    );
  }
  if (!planning.plan.readiness.ready) {
    throw new QuestionAdminServiceError(
      'question_bank_not_ready',
      422,
      planning.plan.readiness.issues,
    );
  }
  const response: QuestionImportApplyDto = {
    changedCount: planning.plan.changes.length,
    unchangedCount: planning.plan.unchangedCount,
    replacements: planning.plan.replacements,
    currentBankRevision: planning.plan.revision,
    readiness: planning.plan.readiness,
    importSummary: planning.preview.summary,
  };
  return persistMutationPlan(db, {
    plan: planning.plan,
    meta,
    operation: 'import-apply',
    hash,
    response,
    adminSessionFingerprint,
  });
}

export async function exportQuestionBank(
  db: D1Database,
  filters: { topic: string | null; status: 'all' | 'active' | 'inactive' },
): Promise<QuestionBankExportDto> {
  const revision = await currentRevision(db);
  const rows = currentLeafRows(await workflowRows(db))
    .filter((row) => !filters.topic || row.topic === filters.topic)
    .filter((row) => (
      filters.status === 'all' || (row.current_active === 1) === (filters.status === 'active')
    ))
    .sort((left, right) => left.id - right.id);
  const applied = await db.prepare(`SELECT applied_at FROM question_bank_revisions WHERE hash = ?`)
    .bind(revision)
    .first<{ applied_at: number }>();
  if (!applied) throw new Error('question_bank_revision_missing');
  return {
    schemaVersion: 1,
    bankRevision: revision,
    exportedAt: new Date(applied.applied_at).toISOString(),
    questions: rows.map((row): QuestionImportDraftDto => ({
      id: row.id,
      topic: row.topic,
      difficulty: row.difficulty,
      prompt: row.prompt,
      ...(row.context_type && row.context_text !== null
        ? { contextType: row.context_type, context: row.context_text }
        : {}),
      choices: parseChoices(row),
      correctIndex: row.correct_index,
      dedupeKey: row.dedupe_key,
      active: row.current_active === 1,
    })),
  };
}
