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
  DIFFICULTIES,
  TEST_CONFIG,
  type Difficulty,
} from './test-config.ts';
import type {
  QuestionAdminDetailDto,
  QuestionAdminDetailResponseDto,
  QuestionAdminDirection,
  QuestionAdminDraftDto,
  QuestionAdminErrorCode,
  QuestionAdminHistoryDto,
  QuestionAdminItemDto,
  QuestionAdminListDto,
  QuestionAdminMutationDto,
  QuestionAdminSort,
  QuestionAdminStatusFilter,
  QuestionAdminToggleDto,
  QuestionBankEventType,
  QuestionBankHistoryEventDto,
  QuestionBankReadinessDto,
} from './question-admin-contract.ts';

export const ADMIN_QUESTION_ID_FLOOR = 1_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/u;
const MAX_NOTE_LENGTH = 500;
const MAX_PAGE_SIZE = 100;

type QuestionAdminRow = QuestionRow & {
  predecessor_id: number | null;
  successor_id: number | null;
  usage_count: number;
  in_current_revision: number;
};

type MutationRecord = {
  operation: string;
  request_hash: string;
  response_json: string;
};

export class QuestionAdminServiceError extends Error {
  readonly code: QuestionAdminErrorCode | 'invalid_request' | 'not_found';
  readonly status: number;
  readonly issues?: string[];

  constructor(
    code: QuestionAdminServiceError['code'],
    status: number,
    issues?: string[],
  ) {
    super(code);
    this.name = 'QuestionAdminServiceError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export type QuestionAdminListQuery = {
  q: string;
  topic: string | null;
  difficulty: Difficulty | null;
  status: QuestionAdminStatusFilter;
  sort: QuestionAdminSort;
  direction: QuestionAdminDirection;
  offset: number;
  cursorRevision: string | null;
  limit: number;
};

function decodeCursor(value: string | null) {
  if (!value) return { offset: 0, revision: null };
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const cursor = JSON.parse(decoded) as { offset?: unknown; revision?: unknown };
    if (
      Number.isSafeInteger(cursor.offset) && Number(cursor.offset) >= 0
      && typeof cursor.revision === 'string' && SHA256_PATTERN.test(cursor.revision)
    ) {
      return { offset: Number(cursor.offset), revision: cursor.revision };
    }
  } catch {
    // Converted to a stable client error below.
  }
  throw new QuestionAdminServiceError('invalid_request', 400, ['Некорректный cursor']);
}

function encodeCursor(revision: string, offset: number) {
  return btoa(JSON.stringify({ revision, offset }))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new QuestionAdminServiceError('invalid_request', 400);
  return values[0] ?? null;
}

export function parseQuestionAdminListQuery(request: Request): QuestionAdminListQuery {
  const params = new URL(request.url).searchParams;
  const cursor = decodeCursor(one(params, 'cursor'));
  const q = (one(params, 'q') ?? '').trim().slice(0, 160);
  const topic = one(params, 'topic')?.trim() || null;
  const difficultyValue = one(params, 'difficulty');
  const difficulty = difficultyValue && DIFFICULTIES.includes(difficultyValue as Difficulty)
    ? difficultyValue as Difficulty
    : null;
  if (difficultyValue && !difficulty) throw new QuestionAdminServiceError('invalid_request', 400);
  const statusValue = one(params, 'status') ?? 'all';
  if (!['all', 'active', 'inactive'].includes(statusValue)) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  const sortValue = one(params, 'sort') ?? 'id';
  if (!['id', 'topic', 'difficulty', 'status'].includes(sortValue)) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  const directionValue = one(params, 'direction') ?? 'desc';
  if (!['asc', 'desc'].includes(directionValue)) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  const limitValue = Number(one(params, 'limit') ?? 40);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > MAX_PAGE_SIZE) {
    throw new QuestionAdminServiceError('invalid_request', 400);
  }
  return {
    q,
    topic,
    difficulty,
    status: statusValue as QuestionAdminStatusFilter,
    sort: sortValue as QuestionAdminSort,
    direction: directionValue as QuestionAdminDirection,
    offset: cursor.offset,
    cursorRevision: cursor.revision,
    limit: limitValue,
  };
}

function parseChoices(row: Pick<QuestionRow, 'choices_json'>) {
  const value = JSON.parse(row.choices_json) as unknown;
  if (!Array.isArray(value) || value.some((choice) => typeof choice !== 'string')) {
    throw new Error('question_choices_corrupted');
  }
  return value as string[];
}

function definitionFromRow(row: QuestionRow): QuestionDefinition {
  return {
    id: row.id,
    difficulty: row.difficulty,
    topic: row.topic,
    prompt: row.prompt,
    ...(row.context_type && row.context_text !== null
      ? { contextType: row.context_type, context: row.context_text }
      : {}),
    choices: parseChoices(row),
    correctIndex: row.correct_index,
    active: row.active === 1,
    dedupeKey: row.dedupe_key,
  };
}

function itemFromRow(row: QuestionAdminRow): QuestionAdminItemDto {
  const promptPreview = row.prompt.length > 150 ? `${row.prompt.slice(0, 147)}…` : row.prompt;
  return {
    id: row.id,
    difficulty: row.difficulty,
    topic: row.topic,
    prompt: row.prompt,
    promptPreview,
    contextType: row.context_type ?? null,
    context: row.context_text,
    choices: parseChoices(row),
    active: row.active === 1,
    weight: row.weight,
    dedupeKey: row.dedupe_key,
    predecessorId: row.predecessor_id,
    successorId: row.successor_id,
    usageCount: row.usage_count,
  };
}

function detailFromRow(row: QuestionAdminRow): QuestionAdminDetailDto {
  return {
    ...itemFromRow(row),
    correctIndex: row.correct_index,
    contentHash: row.content_hash ?? '',
  };
}

async function currentRevision(db: D1Database) {
  const row = await db.prepare(`SELECT current_revision
    FROM question_bank_state WHERE id = 1`).first<{ current_revision: string }>();
  if (!row?.current_revision) throw new Error('question_bank_state_missing');
  return row.current_revision;
}

async function allQuestionRows(db: D1Database) {
  const rows = await db.prepare(`SELECT
      questions.*,
      predecessor.predecessor_question_id AS predecessor_id,
      successor.successor_question_id AS successor_id,
      COALESCE(usage.usage_count, 0) AS usage_count,
      CASE WHEN current_membership.question_id IS NULL THEN 0 ELSE 1 END AS in_current_revision
    FROM questions
    LEFT JOIN question_bank_state current_state ON current_state.id = 1
    LEFT JOIN question_bank_revision_items current_membership
      ON current_membership.revision_hash = current_state.current_revision
      AND current_membership.question_id = questions.id
    LEFT JOIN question_version_links predecessor
      ON predecessor.successor_question_id = questions.id
    LEFT JOIN question_version_links successor
      ON successor.predecessor_question_id = questions.id
    LEFT JOIN (
      SELECT question_id, COUNT(DISTINCT attempt_id) AS usage_count
      FROM attempt_questions GROUP BY question_id
    ) usage ON usage.question_id = questions.id
    ORDER BY questions.id`).all<QuestionAdminRow>();
  return rows.results;
}

function compareItems(
  left: QuestionAdminItemDto,
  right: QuestionAdminItemDto,
  sort: QuestionAdminSort,
) {
  if (sort === 'topic') return left.topic.localeCompare(right.topic, 'ru-RU') || left.id - right.id;
  if (sort === 'difficulty') {
    return DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty)
      || left.id - right.id;
  }
  if (sort === 'status') return Number(left.active) - Number(right.active) || left.id - right.id;
  return left.id - right.id;
}

export async function listAdminQuestions(
  db: D1Database,
  query: QuestionAdminListQuery,
): Promise<QuestionAdminListDto> {
  const revision = await currentRevision(db);
  if (query.cursorRevision && query.cursorRevision !== revision) {
    throw new QuestionAdminServiceError('bank_revision_conflict', 409);
  }
  const rows = await allQuestionRows(db);
  const definitions = rows.map(definitionFromRow);
  const currentDefinitions = rows
    .filter((row) => row.in_current_revision === 1)
    .map(definitionFromRow);
  const activeCount = definitions.filter((question) => question.active).length;
  const topics = [...new Set(rows.map((row) => row.topic))]
    .sort((left, right) => left.localeCompare(right, 'ru-RU'));
  const needle = query.q.toLocaleLowerCase('ru-RU');
  const items = rows.map(itemFromRow).filter((item) => (
    (!query.topic || item.topic === query.topic)
    && (!query.difficulty || item.difficulty === query.difficulty)
    && (query.status === 'all' || item.active === (query.status === 'active'))
    && (!needle || [
      String(item.id),
      item.topic,
      item.prompt,
      item.context ?? '',
      item.dedupeKey,
      ...item.choices,
    ].some((value) => value.toLocaleLowerCase('ru-RU').includes(needle)))
  ));
  items.sort((left, right) => (
    compareItems(left, right, query.sort) * (query.direction === 'asc' ? 1 : -1)
  ));
  const page = items.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + page.length;
  return {
    items: page,
    totalCount: items.length,
    nextCursor: nextOffset < items.length ? encodeCursor(revision, nextOffset) : null,
    currentBankRevision: revision,
    topics,
    bankCounts: {
      total: definitions.length,
      active: activeCount,
      inactive: definitions.length - activeCount,
    },
    readiness: readinessDto(evaluateQuestionBankReadiness(currentDefinitions)),
  };
}

function lineageIds(rows: QuestionAdminRow[], questionId: number) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (!byId.has(questionId)) throw new QuestionAdminServiceError('not_found', 404);
  let first = questionId;
  const visited = new Set<number>();
  while (byId.get(first)?.predecessor_id !== null) {
    if (visited.has(first)) throw new Error('question_lineage_cycle');
    visited.add(first);
    first = byId.get(first)!.predecessor_id!;
  }
  const result: number[] = [];
  visited.clear();
  let current: number | null = first;
  while (current !== null) {
    if (visited.has(current)) throw new Error('question_lineage_cycle');
    visited.add(current);
    result.push(current);
    current = byId.get(current)?.successor_id ?? null;
  }
  return result;
}

async function questionHistory(
  db: D1Database,
  rows: QuestionAdminRow[],
  questionId: number,
): Promise<{ history: QuestionBankHistoryEventDto[]; lineage: QuestionAdminItemDto[] }> {
  const ids = lineageIds(rows, questionId);
  const idSet = new Set(ids);
  const events = await db.prepare(`SELECT id, event_type, question_id,
      predecessor_question_id, successor_question_id, bank_revision, created_at, note
    FROM question_bank_change_events ORDER BY created_at, id`)
    .all<{
      id: number;
      event_type: QuestionBankEventType;
      question_id: number;
      predecessor_question_id: number | null;
      successor_question_id: number | null;
      bank_revision: string;
      created_at: number;
      note: string | null;
    }>();
  return {
    history: events.results.filter((event) => (
      idSet.has(event.question_id)
      || (event.predecessor_question_id !== null && idSet.has(event.predecessor_question_id))
      || (event.successor_question_id !== null && idSet.has(event.successor_question_id))
    )).map((event) => ({
      id: event.id,
      eventType: event.event_type,
      questionId: event.question_id,
      predecessorId: event.predecessor_question_id,
      successorId: event.successor_question_id,
      bankRevision: event.bank_revision,
      createdAt: event.created_at,
      note: event.note,
    })),
    lineage: ids.map((id) => itemFromRow(rows.find((row) => row.id === id)!)),
  };
}

export async function getAdminQuestion(
  db: D1Database,
  questionId: number,
): Promise<QuestionAdminDetailResponseDto> {
  const rows = await allQuestionRows(db);
  const row = rows.find((candidate) => candidate.id === questionId);
  if (!row) throw new QuestionAdminServiceError('not_found', 404);
  const { history, lineage } = await questionHistory(db, rows, questionId);
  return {
    question: detailFromRow(row),
    currentBankRevision: await currentRevision(db),
    history,
    lineage,
  };
}

export async function getAdminQuestionHistory(
  db: D1Database,
  questionId: number,
): Promise<QuestionAdminHistoryDto> {
  const rows = await allQuestionRows(db);
  const { history, lineage } = await questionHistory(db, rows, questionId);
  return {
    items: history,
    lineage,
    currentBankRevision: await currentRevision(db),
  };
}

type NormalizedMutationMeta = {
  expectedBankRevision: string;
  idempotencyKey: string;
  note: string | null;
};

function mutationMeta(value: Record<string, unknown>): NormalizedMutationMeta {
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

function normalizedDraft(
  value: Record<string, unknown>,
  id: number,
  defaultActive: boolean,
) {
  const meta = mutationMeta(value);
  const active = value.active === undefined ? defaultActive : value.active;
  const raw = [{
    id,
    difficulty: value.difficulty,
    topic: value.topic,
    prompt: value.prompt,
    ...(value.contextType === null && (value.context === null || value.context === undefined)
      ? {}
      : { contextType: value.contextType, context: value.context }),
    choices: value.choices,
    correctIndex: value.correctIndex,
    active,
    dedupeKey: value.dedupeKey,
  }];
  try {
    const [question] = validateQuestionBank(raw, 'admin-question', {
      enforceOperationalReadiness: false,
    });
    return { meta, question };
  } catch (error) {
    if (error instanceof QuestionBankValidationError) {
      throw new QuestionAdminServiceError('question_validation_failed', 422, error.issues);
    }
    throw error;
  }
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

function validateEffectiveBank(definitions: QuestionDefinition[]) {
  const active = definitions.filter((question) => question.active);
  try {
    validateQuestionBank(active, 'admin-active-bank');
  } catch (error) {
    if (error instanceof QuestionBankValidationError) {
      throw new QuestionAdminServiceError('question_bank_not_ready', 422, error.issues);
    }
    throw error;
  }
  const readiness = readinessDto(evaluateQuestionBankReadiness(active));
  if (!readiness.ready) {
    throw new QuestionAdminServiceError('question_bank_not_ready', 422, readiness.issues);
  }
  return readiness;
}

async function replayMutation(
  db: D1Database,
  idempotencyKey: string,
  operation: string,
  requestHash: string,
) {
  const existing = await db.prepare(`SELECT operation, request_hash, response_json
    FROM question_bank_mutations WHERE idempotency_key = ?`)
    .bind(idempotencyKey)
    .first<MutationRecord>();
  if (!existing) return null;
  if (existing.operation !== operation || existing.request_hash !== requestHash) {
    throw new QuestionAdminServiceError('idempotency_conflict', 409);
  }
  return JSON.parse(existing.response_json) as QuestionAdminMutationDto;
}

async function ensureExpectedRevision(db: D1Database, expected: string) {
  if (await currentRevision(db) !== expected) {
    throw new QuestionAdminServiceError('bank_revision_conflict', 409);
  }
}

async function nextAdminQuestionId(db: D1Database) {
  const row = await db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM questions')
    .first<{ max_id: number }>();
  return Math.max(ADMIN_QUESTION_ID_FLOOR, (row?.max_id ?? 0) + 1);
}

function syntheticRow(
  question: QuestionDefinition,
  hash: string,
  predecessorId: number | null,
): QuestionAdminRow {
  return {
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    context_type: question.contextType ?? null,
    context_text: question.context ?? null,
    choices_json: JSON.stringify(question.choices),
    correct_index: question.correctIndex,
    weight: TEST_CONFIG.weights[question.difficulty],
    active: question.active ? 1 : 0,
    content_hash: hash,
    dedupe_key: question.dedupeKey,
    predecessor_id: predecessorId,
    successor_id: null,
    usage_count: 0,
    in_current_revision: 1,
  };
}

async function mutationRequestHash(
  operation: string,
  questionId: number | null,
  value: unknown,
) {
  return sha256Hex(JSON.stringify({ operation, questionId, value }));
}

function draftHashValue(
  question: QuestionDefinition,
  meta: NormalizedMutationMeta,
  activeValue: boolean | 'preserve' = question.active,
) {
  return {
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    contextType: question.contextType ?? null,
    context: question.context ?? null,
    choices: question.choices,
    correctIndex: question.correctIndex,
    active: activeValue,
    dedupeKey: question.dedupeKey,
    ...meta,
  };
}

async function persistRevision(
  db: D1Database,
  options: {
    operation: 'create' | 'revise' | 'toggle';
    eventType: QuestionBankEventType;
    question: QuestionDefinition;
    previousQuestionId: number | null;
    originalQuestionId: number | null;
    expectedRevision: string;
    idempotencyKey: string;
    requestHash: string;
    note: string | null;
    adminSessionFingerprint: string;
    existingRows: QuestionAdminRow[];
  },
) {
  const definitions = options.existingRows
    .filter((row) => row.in_current_revision === 1)
    .map(definitionFromRow);
  if (options.operation === 'revise' && options.originalQuestionId !== null) {
    const original = definitions.find((question) => question.id === options.originalQuestionId);
    if (original) original.active = false;
    definitions.push(options.question);
  } else if (options.operation === 'create') {
    definitions.push(options.question);
  } else {
    const target = definitions.find((question) => question.id === options.question.id);
    if (target) target.active = options.question.active;
    else definitions.push(options.question);
  }
  const readiness = validateEffectiveBank(definitions);
  const revision = await questionBankRevision(definitions);
  const summary = summarizeQuestionBank(definitions);
  const now = Date.now();
  const hash = await questionContentHash(options.question);

  const predecessorId = options.operation === 'revise' ? options.originalQuestionId : (
    options.existingRows.find((row) => row.id === options.question.id)?.predecessor_id ?? null
  );
  const existingResultRow = options.existingRows.find((row) => row.id === options.question.id);
  const resultRow = options.operation === 'toggle' && existingResultRow
    ? {
        ...existingResultRow,
        active: options.question.active ? 1 : 0,
        content_hash: hash,
      }
    : syntheticRow(options.question, hash, predecessorId);
  const result: QuestionAdminMutationDto = {
    question: detailFromRow(resultRow),
    previousQuestionId: options.previousQuestionId,
    currentBankRevision: revision,
    readiness,
  };
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO question_bank_mutations (
      idempotency_key, operation, expected_revision, request_hash, response_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        options.idempotencyKey,
        options.operation,
        options.expectedRevision,
        options.requestHash,
        JSON.stringify(result),
        now,
      ),
  ];
  if (options.operation === 'create' || options.operation === 'revise') {
    if (options.operation === 'revise' && options.originalQuestionId !== null) {
      statements.push(db.prepare('UPDATE questions SET active = 0 WHERE id = ?')
        .bind(options.originalQuestionId));
    }
    statements.push(db.prepare(`INSERT INTO questions (
      id, difficulty, topic, prompt, context_type, context_text, choices_json,
      correct_index, weight, active, content_hash, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        options.question.id,
        options.question.difficulty,
        options.question.topic,
        options.question.prompt,
        options.question.contextType ?? null,
        options.question.context ?? null,
        JSON.stringify(options.question.choices),
        options.question.correctIndex,
        TEST_CONFIG.weights[options.question.difficulty],
        options.question.active ? 1 : 0,
        hash,
        options.question.dedupeKey,
      ));
  } else {
    statements.push(db.prepare('UPDATE questions SET active = ? WHERE id = ?')
      .bind(options.question.active ? 1 : 0, options.question.id));
  }
  statements.push(db.prepare(`INSERT INTO question_bank_revisions (
    hash, applied_at, total_count, active_count, pools_json
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET applied_at = excluded.applied_at`)
    .bind(revision, now, summary.total, summary.active, JSON.stringify(summary.pools)));
  statements.push(db.prepare(`INSERT OR IGNORE INTO question_bank_revision_items (
      revision_hash, question_id, active
    )
    SELECT ?, membership.question_id, questions.active
    FROM question_bank_revision_items membership
    JOIN questions ON questions.id = membership.question_id
    WHERE membership.revision_hash = ?`)
    .bind(revision, options.expectedRevision));
  const targetWasMember = options.existingRows.some((row) => (
    row.id === options.question.id && row.in_current_revision === 1
  ));
  if (options.operation !== 'toggle' || !targetWasMember) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO question_bank_revision_items (
      revision_hash, question_id, active
    ) VALUES (?, ?, ?)`)
      .bind(revision, options.question.id, options.question.active ? 1 : 0));
  }
  if (options.operation === 'revise' && options.originalQuestionId !== null) {
    statements.push(db.prepare(`INSERT INTO question_version_links (
      predecessor_question_id, successor_question_id, created_at, bank_revision,
      admin_session_fingerprint
    ) VALUES (?, ?, ?, ?, ?)`)
      .bind(
        options.originalQuestionId,
        options.question.id,
        now,
        revision,
        options.adminSessionFingerprint,
      ));
  }
  statements.push(db.prepare(`INSERT INTO question_bank_change_events (
    event_type, question_id, predecessor_question_id, successor_question_id,
    bank_revision, created_at, note, admin_session_fingerprint
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      options.eventType,
      options.question.id,
      options.operation === 'revise' ? options.originalQuestionId : null,
      options.operation === 'revise' ? options.question.id : null,
      revision,
      now,
      options.note,
      options.adminSessionFingerprint,
    ));
  statements.push(db.prepare(`UPDATE question_bank_state
    SET current_revision = ?, updated_at = ?
    WHERE id = 1 AND current_revision = ?`)
    .bind(revision, now, options.expectedRevision));

  try {
    await db.batch(statements);
  } catch (error) {
    const replay = await replayMutation(
      db,
      options.idempotencyKey,
      options.operation,
      options.requestHash,
    );
    if (replay) return replay;
    if (await currentRevision(db) !== options.expectedRevision) {
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    throw error;
  }
  invalidateQuestionBankCache();
  return result;
}

export async function createAdminQuestion(
  db: D1Database,
  body: QuestionAdminDraftDto | Record<string, unknown>,
  adminSessionFingerprint: string,
) {
  const raw = body as Record<string, unknown>;
  const normalized = normalizedDraft(raw, ADMIN_QUESTION_ID_FLOOR, true);
  const { meta } = normalized;
  const requestHash = await mutationRequestHash(
    'create',
    null,
    draftHashValue(normalized.question, meta),
  );
  const replay = await replayMutation(db, meta.idempotencyKey, 'create', requestHash);
  if (replay) return replay;
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const question = { ...normalized.question, id: await nextAdminQuestionId(db) };
  return persistRevision(db, {
    operation: 'create',
    eventType: 'created',
    question,
    previousQuestionId: null,
    originalQuestionId: null,
    expectedRevision: meta.expectedBankRevision,
    idempotencyKey: meta.idempotencyKey,
    requestHash,
    note: meta.note,
    adminSessionFingerprint,
    existingRows: await allQuestionRows(db),
  });
}

export async function reviseAdminQuestion(
  db: D1Database,
  questionId: number,
  body: QuestionAdminDraftDto | Record<string, unknown>,
  adminSessionFingerprint: string,
) {
  const rows = await allQuestionRows(db);
  const original = rows.find((row) => row.id === questionId);
  if (!original) throw new QuestionAdminServiceError('not_found', 404);
  const normalized = normalizedDraft(
    body as Record<string, unknown>,
    ADMIN_QUESTION_ID_FLOOR,
    original.active === 1,
  );
  const { meta } = normalized;
  const requestHash = await mutationRequestHash(
    'revise',
    questionId,
    draftHashValue(
      normalized.question,
      meta,
      (body as Record<string, unknown>).active === undefined
        ? 'preserve'
        : normalized.question.active,
    ),
  );
  const replay = await replayMutation(db, meta.idempotencyKey, 'revise', requestHash);
  if (replay) return replay;
  if (original.successor_id !== null) {
    throw new QuestionAdminServiceError('question_has_successor', 409);
  }
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  const question = { ...normalized.question, id: await nextAdminQuestionId(db) };
  return persistRevision(db, {
    operation: 'revise',
    eventType: 'revised',
    question,
    previousQuestionId: questionId,
    originalQuestionId: questionId,
    expectedRevision: meta.expectedBankRevision,
    idempotencyKey: meta.idempotencyKey,
    requestHash,
    note: meta.note,
    adminSessionFingerprint,
    existingRows: rows,
  });
}

export async function toggleAdminQuestion(
  db: D1Database,
  questionId: number,
  body: QuestionAdminToggleDto | Record<string, unknown>,
  adminSessionFingerprint: string,
) {
  const raw = body as Record<string, unknown>;
  const meta = mutationMeta(raw);
  if (typeof raw.active !== 'boolean') {
    throw new QuestionAdminServiceError('invalid_request', 400, ['active должен быть boolean']);
  }
  const rows = await allQuestionRows(db);
  const row = rows.find((candidate) => candidate.id === questionId);
  if (!row) throw new QuestionAdminServiceError('not_found', 404);
  const definition = { ...definitionFromRow(row), active: raw.active };
  const requestHash = await mutationRequestHash('toggle', questionId, { active: raw.active, ...meta });
  const replay = await replayMutation(db, meta.idempotencyKey, 'toggle', requestHash);
  if (replay) return replay;
  if (raw.active === true && row.successor_id !== null) {
    throw new QuestionAdminServiceError('question_has_successor', 409);
  }
  await ensureExpectedRevision(db, meta.expectedBankRevision);
  if (row.active === (raw.active ? 1 : 0)) {
    const result: QuestionAdminMutationDto = {
      question: detailFromRow(row),
      previousQuestionId: null,
      currentBankRevision: meta.expectedBankRevision,
      readiness: validateEffectiveBank(rows.map(definitionFromRow)),
    };
    try {
      await db.prepare(`INSERT INTO question_bank_mutations (
        idempotency_key, operation, expected_revision, request_hash, response_json, created_at
      ) VALUES (?, 'toggle', ?, ?, ?, ?)`)
        .bind(
          meta.idempotencyKey,
          meta.expectedBankRevision,
          requestHash,
          JSON.stringify(result),
          Date.now(),
        )
        .run();
    } catch {
      const concurrentReplay = await replayMutation(db, meta.idempotencyKey, 'toggle', requestHash);
      if (concurrentReplay) return concurrentReplay;
      throw new QuestionAdminServiceError('bank_revision_conflict', 409);
    }
    return result;
  }
  return persistRevision(db, {
    operation: 'toggle',
    eventType: raw.active ? 'activated' : 'deactivated',
    question: definition,
    previousQuestionId: null,
    originalQuestionId: questionId,
    expectedRevision: meta.expectedBankRevision,
    idempotencyKey: meta.idempotencyKey,
    requestHash,
    note: meta.note,
    adminSessionFingerprint,
    existingRows: rows,
  });
}
