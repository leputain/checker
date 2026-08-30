import { env } from 'cloudflare:workers';
import migration0000 from '../drizzle/0000_sweet_morgan_stark.sql?raw';
import migration0001 from '../drizzle/0001_furry_wallow.sql?raw';
import migration0002 from '../drizzle/0002_pink_wild_child.sql?raw';
import migration0003 from '../drizzle/0003_thin_johnny_blaze.sql?raw';
import migration0004 from '../drizzle/0004_overjoyed_vapor.sql?raw';
import migration0005 from '../drizzle/0005_mighty_madame_masque.sql?raw';
import migration0006 from '../drizzle/0006_numerous_jack_flag.sql?raw';
import migration0007 from '../drizzle/0007_youthful_nekra.sql?raw';
import migration0008 from '../drizzle/0008_lowly_mentor.sql?raw';
import migration0009 from '../drizzle/0009_productive_galactus.sql?raw';
import migration0010 from '../drizzle/0010_milky_bruce_banner.sql?raw';
import migration0011 from '../drizzle/0011_slimy_machine_man.sql?raw';
import migration0012 from '../drizzle/0012_silent_union_jack.sql?raw';
import migration0013 from '../drizzle/0013_productive_darkstar.sql?raw';
import migration0014 from '../drizzle/0014_supreme_domino.sql?raw';
import migration0015 from '../drizzle/0015_mighty_adam_destine.sql?raw';
import migration0016 from '../drizzle/0016_free_khan.sql?raw';
import migration0017 from '../drizzle/0017_narrow_baron_zemo.sql?raw';
import migration0018 from '../drizzle/0018_abnormal_captain_midlands.sql?raw';
import {
  BASE_MAX_SCORE,
  calculateAccuracy,
  calculateVerdict,
  questionScoreValue,
  type Verdict,
} from '@/lib/scoring.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_CONFIG_JSON,
  BASE_QUESTION_COUNT,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_CONFIG_JSON,
  type Difficulty,
} from '@/lib/test-config.ts';
import {
  summarizeAttemptBreakdown,
  summarizeAttemptStatistics,
  validateAttemptFacts,
  type AttemptBreakdownFact,
} from '@/lib/attempt-statistics.ts';
import { classifyQuestion, isUnsupportedActiveAttempt } from '@/lib/attempt-policy.ts';
import {
  ANALYTICS_FACTS_INTEGRITY_QUERY,
  ANALYTICS_FACTS_READINESS_QUERY,
} from '@/lib/analytics-facts-integrity.ts';
import { summarizeQuestionBank, type QuestionDefinition } from '@/lib/question-bank-validation.ts';
import { loadQuestionBank } from './question-bank';
import {
  normalizeQuestionCategoryName,
  planQuestionCategoryBootstrap,
  validateQuestionCategoryName,
} from '@/lib/question-categories.ts';

export type { Difficulty, Verdict };

export const CURRENT_SCHEMA_VERSION = 17;

export type QuestionRow = {
  id: number;
  category_id: number | null;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  context_type: QuestionDefinition['contextType'] | null;
  context_text: string | null;
  choices_json: string;
  correct_index: number;
  weight: number;
  active: number;
  content_hash: string | null;
  dedupe_key: string;
};

export type AttemptRow = {
  id: string;
  token_hash: string;
  start_key: string | null;
  candidate_name: string | null;
  candidate_key: string;
  public_alias: string;
  bank_revision: string | null;
  scoring_version: number;
  app_version: string;
  test_config_id: string;
  test_profile_id: string;
  analytics_facts_version: number;
  selection_version: number;
  selection_strategy: string;
  coverage_score: number | null;
  shadow_coverage_score: number | null;
  telegram_root_message_id: number | null;
  status: 'active' | 'completed' | 'aborted';
  started_at: number;
  total_deadline_at: number;
  current_question_started_at: number;
  question_deadline_at: number;
  current_question_id: number | null;
  pending_question_ids: string;
  asked_question_ids: string;
  base_question_ids: string;
  base_max_score: number;
  score: number;
  correct_count: number;
  wrong_count: number;
  verdict: Verdict | null;
  completed_at: number | null;
  duration_seconds: number | null;
};

export class QuestionBankConflictError extends Error {
  constructor(questionId: number) {
    super(`Question id ${questionId} already exists with different immutable content.`);
    this.name = 'QuestionBankConflictError';
  }
}

let schemaInitialization: Promise<void> | null = null;
let bankInitialization: Promise<string> | null = null;

export function database() {
  if (!env.DB) throw new Error('SQLite binding DB is unavailable');
  return env.DB;
}

const MANAGED_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-0000-0002',
    sql: [migration0000, migration0001, migration0002].join('\n--> statement-breakpoint\n'),
  },
  { version: 2, name: 'telegram-and-bank-revisions-0003', sql: migration0003 },
  { version: 3, name: 'attempt-timing-0004', sql: migration0004 },
  { version: 4, name: 'question-deduplication-0005', sql: migration0005 },
  { version: 5, name: 'telegram-reporting-0006', sql: migration0006 },
  { version: 6, name: 'question-context-and-answer-metrics-0007', sql: migration0007 },
  { version: 7, name: 'candidate-identity-key-0008', sql: migration0008 },
  { version: 8, name: 'analytics-facts-0009', sql: migration0009 },
  { version: 9, name: 'balanced-selection-metadata-0010', sql: migration0010 },
  { version: 10, name: 'question-review-history-0011', sql: migration0011 },
  { version: 11, name: 'analytics-report-aggregates-0012', sql: migration0012 },
  { version: 12, name: 'analytics-derived-aggregates-0013', sql: migration0013 },
  { version: 13, name: 'analytics-candidate-dimensions-0014', sql: migration0014 },
  { version: 14, name: 'runtime-and-readiness-indexes-0015', sql: migration0015 },
  { version: 15, name: 'analytics-refresh-lease-0016', sql: migration0016 },
  { version: 16, name: 'question-bank-admin-0017-narrow-baron-zemo', sql: migration0017 },
  { version: 17, name: 'question-bank-workflow-0018-abnormal-captain-midlands', sql: migration0018 },
] as const;

async function ensureCurrentTestConfigVersion() {
  const db = database();
  const configs = [
    { id: TEST_CONFIG_ID, json: TEST_CONFIG_JSON },
    { id: BALANCED_TEST_CONFIG_ID, json: BALANCED_TEST_CONFIG_JSON },
  ];
  for (const config of configs) {
    if (await sha256Hex(config.json) !== config.id) {
      throw new Error('test_config_hash_mismatch');
    }
    await db.prepare(`INSERT OR IGNORE INTO test_config_versions (
      id, scoring_version, config_json, created_at
    ) VALUES (?, ?, ?, ?)`)
      .bind(config.id, SCORING_VERSION, config.json, Date.now())
      .run();
    const stored = await db.prepare(`SELECT scoring_version, config_json
      FROM test_config_versions WHERE id = ?`)
      .bind(config.id)
      .first<{ scoring_version: number; config_json: string }>();
    if (
      !stored ||
      stored.scoring_version !== SCORING_VERSION ||
      stored.config_json !== config.json
    ) {
      throw new Error('test_config_identity_conflict');
    }
  }
}

function migrationStatements(sql: string) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function adoptLegacyBaselineIfNeeded() {
  const db = database();
  const applied = await db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').first<{ count: number }>();
  if ((applied?.count ?? 0) > 0) return;
  const attemptsTable = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempts'")
    .first<{ name: string }>();
  if (!attemptsTable) return;

  const attemptColumns = await db.prepare('PRAGMA table_info(attempts)').all<{ name: string }>();
  const questionColumns = await db.prepare('PRAGMA table_info(questions)').all<{ name: string }>();
  const attemptNames = new Set(attemptColumns.results.map((column) => column.name));
  const questionNames = new Set(questionColumns.results.map((column) => column.name));
  const supported = ['base_question_ids', 'base_max_score', 'verdict'].every((name) => (
    attemptNames.has(name)
  )) && questionNames.has('topic');
  if (!supported) throw new Error('unsupported_legacy_schema');

  await db
    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
    .bind('adopted-legacy-baseline-0000-0002', Date.now())
    .run();
}

async function applyManagedMigration(version: number, name: string, sql: string) {
  const db = database();
  const statements = migrationStatements(sql).map((statement) => db.prepare(statement));
  statements.push(
    db
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .bind(version, name, Date.now()),
  );
  await db.batch(statements);
}

export function ensureSchema() {
  if (schemaInitialization) return schemaInitialization;
  schemaInitialization = (async () => {
    const db = database();
    await db
      .prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`)
      .run();
    await adoptLegacyBaselineIfNeeded();
    const applied = await db
      .prepare('SELECT version FROM schema_migrations')
      .all<{ version: number }>();
    const versions = new Set(applied.results.map((row) => row.version));
    for (const migration of MANAGED_MIGRATIONS) {
      if (versions.has(migration.version)) continue;
      await applyManagedMigration(migration.version, migration.name, migration.sql);
      versions.add(migration.version);
    }
    await ensureCurrentTestConfigVersion();
    await db.prepare('PRAGMA optimize').run();
  })().catch((error) => {
    schemaInitialization = null;
    console.error('schema_initialization_failed');
    throw error;
  });
  return schemaInitialization;
}

export async function currentSchemaVersion() {
  const row = await database()
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .first<{ version: number }>();
  return row?.version ?? 0;
}

export async function analyticsFactsIntegrityViolations(
  scope: 'full' | 'readiness' = 'full',
) {
  const row = await database()
    .prepare(scope === 'readiness'
      ? ANALYTICS_FACTS_READINESS_QUERY
      : ANALYTICS_FACTS_INTEGRITY_QUERY)
    .first<{ violations: number }>();
  return row?.violations ?? 0;
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuestion(question: QuestionDefinition) {
  return {
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    ...(question.contextType && question.context !== undefined
      ? { contextType: question.contextType, context: question.context }
      : {}),
    choices: question.choices,
    correctIndex: question.correctIndex,
    weight: TEST_CONFIG.weights[question.difficulty],
  };
}

export async function questionContentHash(question: QuestionDefinition) {
  // dedupeKey affects both selection and historical interviewer grouping, so it
  // is immutable for an existing question id just like prompt/choices/weight.
  return sha256Hex(JSON.stringify({
    ...canonicalQuestion(question),
    dedupeKey: question.dedupeKey,
  }));
}

export async function questionBankRevision(questions = loadQuestionBank()) {
  const canonical = [...questions]
    .sort((left, right) => left.id - right.id)
    .map((question) => ({
      ...canonicalQuestion(question),
      active: question.active,
      dedupeKey: question.dedupeKey,
    }));
  return sha256Hex(JSON.stringify(canonical));
}

export function invalidateQuestionBankCache() {
  bankInitialization = null;
}

function rowMatchesQuestion(row: QuestionRow, question: QuestionDefinition) {
  return (
    row.difficulty === question.difficulty &&
    row.topic === question.topic &&
    row.prompt === question.prompt &&
    row.context_type === (question.contextType ?? null) &&
    row.context_text === (question.context ?? null) &&
    row.choices_json === JSON.stringify(question.choices) &&
    row.correct_index === question.correctIndex &&
    row.weight === TEST_CONFIG.weights[question.difficulty] &&
    row.dedupe_key === question.dedupeKey
  );
}

async function storedQuestionBankRevision(db: D1Database) {
  const current = await db.prepare(`SELECT state.current_revision
    FROM question_bank_state state
    JOIN question_bank_revisions revisions ON revisions.hash = state.current_revision
    WHERE state.id = 1`)
    .first<{ current_revision: string }>();
  return current?.current_revision ?? null;
}

async function ensureQuestionCategories(db: D1Database) {
  const [topicResult, categoryResult] = await Promise.all([
    db.prepare(`SELECT questions.topic,
        MAX(CASE WHEN membership.question_id IS NOT NULL
          AND successors.successor_question_id IS NULL THEN 1 ELSE 0 END) AS current_leaf
      FROM questions
      LEFT JOIN question_bank_state state ON state.id = 1
      LEFT JOIN question_bank_revision_items membership
        ON membership.revision_hash = state.current_revision
        AND membership.question_id = questions.id
      LEFT JOIN question_version_links successors
        ON successors.predecessor_question_id = questions.id
      WHERE questions.category_id IS NULL
      GROUP BY questions.topic
      ORDER BY questions.topic`).all<{ topic: string; current_leaf: number }>(),
    db.prepare(`SELECT id, name, normalized_name, selection_key, active
      FROM question_categories ORDER BY id`)
      .all<{
        id: number;
        name: string;
        normalized_name: string;
        selection_key: string;
        active: number;
      }>(),
  ]);
  const bootstrapPlan = planQuestionCategoryBootstrap(topicResult.results.map((row, index) => ({
    id: index + 1,
    topic: row.topic,
    currentLeaf: row.current_leaf === 1,
  })));
  const desiredByNormalized = new Map(bootstrapPlan.categories.map((category) => [
    category.normalizedName,
    { name: category.name, active: category.active },
  ]));
  const storedByNormalized = new Map<string, typeof categoryResult.results[number]>();
  const normalizedRows = categoryResult.results.map((category) => ({
    ...category,
    normalized_name: normalizeQuestionCategoryName(category.name),
  }));
  if (normalizedRows.some((category) => (
    !validateQuestionCategoryName(category.name)
    || !validateQuestionCategoryName(category.selection_key)
  ))) {
    throw new Error('question_category_catalog_invalid_identity');
  }
  for (const category of normalizedRows) {
    if (storedByNormalized.has(category.normalized_name)) {
      throw new Error('question_category_catalog_collision');
    }
    storedByNormalized.set(category.normalized_name, category);
  }
  if (new Set(normalizedRows.map((category) => (
    normalizeQuestionCategoryName(category.selection_key)
  ))).size !== normalizedRows.length) {
    throw new Error('question_category_selection_key_collision');
  }
  if (normalizedRows.some((category) => normalizedRows.some((other) => (
    other.id !== category.id
    && normalizeQuestionCategoryName(category.selection_key) === other.normalized_name
  )))) {
    throw new Error('question_category_identity_cross_collision');
  }
  const missing = [...desiredByNormalized].filter(([normalized]) => !storedByNormalized.has(normalized))
    .map(([normalizedName, category]) => ({
      name: category.name,
      normalizedName,
      selectionKey: category.name,
      active: category.active,
    }));
  const mismatched = normalizedRows.filter((category) => (
    category.normalized_name !== categoryResult.results.find((row) => row.id === category.id)!.normalized_name
  ));
  const inactiveCurrent = [...desiredByNormalized].find(([normalized, desired]) => (
    desired.active === 1 && storedByNormalized.get(normalized)?.active === 0
  ));
  if (inactiveCurrent) throw new Error('question_category_current_topic_inactive');
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (mismatched.length > 0) {
    const payload = JSON.stringify(mismatched.map((category) => ({
      id: category.id,
      normalizedName: `__category_migration_${category.id}`,
    })));
    statements.push(db.prepare(`UPDATE question_categories
      SET normalized_name = (
        SELECT json_extract(value, '$.normalizedName') FROM json_each(?)
        WHERE json_extract(value, '$.id') = question_categories.id
      )
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`)
      .bind(payload, payload));
    const finalPayload = JSON.stringify(mismatched.map((category) => ({
      id: category.id,
      normalizedName: category.normalized_name,
    })));
    statements.push(db.prepare(`UPDATE question_categories
      SET normalized_name = (
        SELECT json_extract(value, '$.normalizedName') FROM json_each(?)
        WHERE json_extract(value, '$.id') = question_categories.id
      ), updated_at = ?
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`)
      .bind(finalPayload, now, finalPayload));
  }
  if (missing.length > 0) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO question_categories (
        name, normalized_name, selection_key, active, created_at, updated_at
      )
      SELECT json_extract(value, '$.name'), json_extract(value, '$.normalizedName'),
        json_extract(value, '$.selectionKey'), CAST(json_extract(value, '$.active') AS INTEGER), ?, ?
      FROM json_each(?)`)
      .bind(now, now, JSON.stringify(missing)));
  }
  if (statements.length > 0) await db.batch(statements);
  const [resolvedCategories, uncategorized] = await Promise.all([
    db.prepare(`SELECT id, name, normalized_name FROM question_categories`)
      .all<{ id: number; name: string; normalized_name: string }>(),
    db.prepare(`SELECT id, topic FROM questions WHERE category_id IS NULL ORDER BY id`)
      .all<{ id: number; topic: string }>(),
  ]);
  const categoryIdByNormalized = new Map(resolvedCategories.results.map((category) => [
    category.normalized_name,
    category.id,
  ]));
  const assignments = uncategorized.results.map((question) => ({
    id: question.id,
    categoryId: categoryIdByNormalized.get(normalizeQuestionCategoryName(question.topic)) ?? null,
  }));
  if (assignments.some((assignment) => assignment.categoryId === null)) {
    throw new Error('question_category_backfill_missing');
  }
  if (assignments.length > 0) {
    const payload = JSON.stringify(assignments);
    await db.prepare(`UPDATE questions
      SET category_id = (
        SELECT CAST(json_extract(value, '$.categoryId') AS INTEGER)
        FROM json_each(?)
        WHERE CAST(json_extract(value, '$.id') AS INTEGER) = questions.id
      )
      WHERE id IN (
        SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?)
      )`).bind(payload, payload).run();
  }
  const integrity = await db.prepare(`SELECT questions.topic, category.name AS category_name,
      category.active AS category_active, category.id AS category_id
    FROM questions
    JOIN question_bank_state state ON state.id = 1
    JOIN question_bank_revision_items membership
      ON membership.revision_hash = state.current_revision
      AND membership.question_id = questions.id
    LEFT JOIN question_version_links successors
      ON successors.predecessor_question_id = questions.id
    LEFT JOIN question_categories category ON category.id = questions.category_id
    WHERE successors.successor_question_id IS NULL`)
    .all<{
      topic: string;
      category_name: string | null;
      category_active: number | null;
      category_id: number | null;
    }>();
  if (integrity.results.some((row) => (
    row.category_id === null
    || row.category_active !== 1
    || row.category_name === null
    || normalizeQuestionCategoryName(row.topic) !== normalizeQuestionCategoryName(row.category_name)
  ))) {
    throw new Error('question_category_current_leaf_integrity');
  }
}

export async function ensureQuestionBankReady() {
  await ensureSchema();
  const db = database();
  const current = await storedQuestionBankRevision(db);
  if (current) {
    await ensureQuestionCategories(db);
    return current;
  }
  if (bankInitialization) return bankInitialization;

  // Cache only the one-time bootstrap work. The current revision itself must
  // always come from D1: another Worker isolate may have changed the bank.
  const initialization = (async () => {
    const refreshed = await storedQuestionBankRevision(db);
    if (refreshed) {
      await ensureQuestionCategories(db);
      return refreshed;
    }

    // The bundled JSON is a one-time bootstrap source. Once question_bank_state
    // exists, D1 is authoritative so administrative edits survive restarts.
    const questions = loadQuestionBank();
    const revision = await questionBankRevision(questions);

    const stored = await db.prepare('SELECT * FROM questions').all<QuestionRow>();
    const byId = new Map(stored.results.map((question) => [question.id, question]));
    const hashes = new Map<number, string>();
    for (const question of questions) {
      const hash = await questionContentHash(question);
      hashes.set(question.id, hash);
      const existing = byId.get(question.id);
      if (existing && !rowMatchesQuestion(existing, question)) {
        throw new QuestionBankConflictError(question.id);
      }
    }

    const summary = summarizeQuestionBank(questions);
    const statements: D1PreparedStatement[] = [db.prepare('UPDATE questions SET active = 0')];
    for (const question of questions) {
      const hash = hashes.get(question.id)!;
      if (byId.has(question.id)) {
        statements.push(
          db
            .prepare('UPDATE questions SET active = ?, content_hash = ?, dedupe_key = ? WHERE id = ?')
            .bind(question.active ? 1 : 0, hash, question.dedupeKey, question.id),
        );
      } else {
        statements.push(
          db
            .prepare(`INSERT INTO questions (
              id, difficulty, topic, prompt, context_type, context_text, choices_json,
              correct_index, weight, active, content_hash, dedupe_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              question.id,
              question.difficulty,
              question.topic,
              question.prompt,
              question.contextType ?? null,
              question.context ?? null,
              JSON.stringify(question.choices),
              question.correctIndex,
              TEST_CONFIG.weights[question.difficulty],
              question.active ? 1 : 0,
              hash,
              question.dedupeKey,
            ),
        );
      }
    }
    statements.push(
      db
        .prepare(`INSERT INTO question_bank_revisions (
          hash, applied_at, total_count, active_count, pools_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
          applied_at = excluded.applied_at,
          total_count = excluded.total_count,
          active_count = excluded.active_count,
          pools_json = excluded.pools_json`)
        .bind(
          revision,
          Date.now(),
          summary.total,
          summary.active,
          JSON.stringify(summary.pools),
        ),
    );
    for (const question of questions) {
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO question_bank_revision_items (
          revision_hash, question_id, active
        ) VALUES (?, ?, ?)`)
          .bind(revision, question.id, question.active ? 1 : 0),
      );
      statements.push(
        db.prepare(`INSERT INTO question_bank_change_events (
          event_type, question_id, bank_revision, created_at, note
        ) VALUES ('created', ?, ?, ?, ?)`)
          .bind(question.id, revision, Date.now(), 'Импортировано из базового банка'),
      );
    }
    statements.push(
      db.prepare(`INSERT INTO question_bank_state (id, current_revision, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          current_revision = excluded.current_revision,
          updated_at = excluded.updated_at`)
        .bind(revision, Date.now()),
    );
    await db.batch(statements);
    await ensureQuestionCategories(db);
    return revision;
  })();
  bankInitialization = initialization;
  try {
    return await initialization;
  } finally {
    if (bankInitialization === initialization) bankInitialization = null;
  }
}

export function publicAlias(name: string) {
  const words = name.trim().replace(/\s+/g, ' ').split(' ');
  const first = words[0].slice(0, 30);
  return words.length > 1
    ? `${first} ${words.at(-1)![0].toLocaleUpperCase('ru-RU')}.`
    : `${first[0].toLocaleUpperCase('ru-RU')}***`;
}

export async function choicePermutation(attemptId: string, questionId: number, length: number) {
  const digest = await sha256(`${attemptId}:${questionId}`);
  let state = new DataView(digest.buffer).getUint32(0) || 1;
  const indexes = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swapIndex = (state >>> 0) % (index + 1);
    [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
  }
  return indexes;
}

export async function findAttempt(id: string) {
  return database().prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first<AttemptRow>();
}

export async function findAttemptByStartKey(startKey: string) {
  return database()
    .prepare('SELECT * FROM attempts WHERE start_key = ?')
    .bind(startKey)
    .first<AttemptRow>();
}

export async function findQuestion(id: number) {
  return database()
    .prepare(`SELECT id, difficulty, topic, prompt, context_type, context_text,
      choices_json, correct_index, weight, active, content_hash, dedupe_key
      FROM questions WHERE id = ?`)
    .bind(id)
    .first<QuestionRow>();
}

export async function verifyAttempt(id: string, token: string) {
  const attempt = await findAttempt(id);
  if (!attempt || !token || (await sha256Hex(token)) !== attempt.token_hash) return null;
  return attempt;
}

type AttemptStatisticRow = {
  question_id: number;
  difficulty: Difficulty;
  topic: string;
  is_correct: number;
  timed_out: number;
  elapsed_seconds: number;
  selected_index: number | null;
  awarded_score: number | null;
  fact_version: number;
  answer_origin: string;
};

type AttemptLedgerStatisticRow = {
  question_id: number;
  question_kind: 'base' | 'additional';
  score_value: number;
  presented_at: number | null;
  answer_id: number | null;
  is_correct: number | null;
  timed_out: number | null;
  awarded_score: number | null;
  fact_version: number | null;
  answer_origin: string | null;
  canonical_selected_index: number | null;
};

async function loadAttemptResultStats(attempt: AttemptRow, baseQuestionIds: ReadonlySet<number>) {
  const rows = await database()
    .prepare(`SELECT answers.question_id, questions.difficulty, questions.topic,
      answers.is_correct, answers.timed_out, answers.elapsed_seconds, answers.selected_index,
      answers.awarded_score, answers.fact_version, answers.answer_origin
      FROM answers JOIN questions ON questions.id = answers.question_id
      WHERE answers.attempt_id = ?`)
    .bind(attempt.id)
    .all<AttemptStatisticRow>();

  const summary = summarizeAttemptStatistics(rows.results.map((row) => ({
    questionKind: classifyQuestion(row.question_id, baseQuestionIds),
    difficulty: row.difficulty,
    topic: row.topic,
    answeredCount: 1,
    correctCount: row.is_correct,
    timeoutCount: row.timed_out,
    elapsedSeconds: row.elapsed_seconds,
    measuredCount: row.fact_version >= ANALYTICS_FACTS_VERSION
      ? row.answer_origin === 'submitted' ? 1 : 0
      : row.selected_index !== null || row.elapsed_seconds > 0 ? 1 : 0,
  })));

  const ledger = await database().prepare(`SELECT
      attempt_questions.question_id,
      attempt_questions.question_kind,
      attempt_questions.score_value,
      attempt_questions.presented_at,
      answers.id AS answer_id,
      answers.is_correct,
      answers.timed_out,
      answers.awarded_score,
      answers.fact_version,
      answers.answer_origin,
      answers.canonical_selected_index
    FROM attempt_questions
    LEFT JOIN answers
      ON answers.attempt_id = attempt_questions.attempt_id
      AND answers.question_id = attempt_questions.question_id
    WHERE attempt_questions.attempt_id = ?
    ORDER BY attempt_questions.ordinal`)
    .bind(attempt.id)
    .all<AttemptLedgerStatisticRow>();
  const ledgerQuestionIds = new Set(ledger.results.map((row) => row.question_id));
  const supportedOrigins = new Set([
    'submitted',
    'question_timeout',
    'total_timeout_presented',
    'total_timeout_unshown',
  ]);
  const answerFactsComplete = ledger.results.every((row) => row.answer_id === null || (
    row.fact_version === attempt.analytics_facts_version
    && row.awarded_score !== null
    && row.answer_origin !== null
    && supportedOrigins.has(row.answer_origin)
    && (row.answer_origin !== 'submitted' || (
      row.presented_at !== null
      && row.timed_out === 0
      && row.canonical_selected_index !== null
    ))
    && (!['question_timeout', 'total_timeout_presented'].includes(row.answer_origin) || (
      row.presented_at !== null && row.timed_out === 1
    ))
    && (row.answer_origin !== 'total_timeout_unshown' || (
      row.presented_at === null
      && row.timed_out === 1
      && row.canonical_selected_index === null
    ))
  ));
  const ledgerFacts: AttemptBreakdownFact[] = ledger.results.map((row) => ({
    questionKind: row.question_kind,
    assigned: true,
    presented: row.presented_at !== null,
    resolved: row.answer_id !== null,
    correct: row.is_correct === 1,
    timedOut: row.timed_out === 1,
    awardedScore: row.awarded_score ?? 0,
    scoreValue: row.score_value,
  }));
  const ledgerValidation = validateAttemptFacts(ledgerFacts, {
    expectedBaseAssigned: BASE_QUESTION_COUNT,
    maxAdditionalAssigned: TEST_CONFIG.maxAdditionalQuestions,
    expectedBaseMaxScore: BASE_MAX_SCORE,
    attemptScore: attempt.score,
  });
  const ledgerIsComplete = attempt.analytics_facts_version >= ANALYTICS_FACTS_VERSION
    && ledger.results.length >= baseQuestionIds.size
    && rows.results.every((row) => ledgerQuestionIds.has(row.question_id))
    && answerFactsComplete
    && ledgerValidation.valid;

  let breakdownFacts: AttemptBreakdownFact[];
  if (ledgerIsComplete) {
    breakdownFacts = ledgerFacts;
  } else {
    const asked = new Set(JSON.parse(attempt.asked_question_ids) as number[]);
    const pending = new Set(JSON.parse(attempt.pending_question_ids) as number[]);
    const answeredByQuestion = new Map(rows.results.map((row) => [row.question_id, row]));
    const knownIds = new Set<number>([
      ...baseQuestionIds,
      ...asked,
      ...pending,
      ...answeredByQuestion.keys(),
      ...(attempt.current_question_id === null ? [] : [attempt.current_question_id]),
    ]);
    const questionRows = await database().prepare(
      'SELECT id, weight FROM questions',
    ).all<{ id: number; weight: number }>();
    const weightByQuestion = new Map(questionRows.results.map((row) => [row.id, row.weight]));
    breakdownFacts = [...knownIds].flatMap((questionId): AttemptBreakdownFact[] => {
      const weight = weightByQuestion.get(questionId);
      if (weight === undefined) return [];
      const questionKind = classifyQuestion(questionId, baseQuestionIds);
      const answer = answeredByQuestion.get(questionId);
      const scoreValue = attempt.base_max_score === BASE_MAX_SCORE
        ? questionScoreValue(weight, questionKind)
        : weight;
      return [{
        questionKind,
        assigned: baseQuestionIds.has(questionId)
          || asked.has(questionId)
          || pending.has(questionId)
          || answer !== undefined,
        presented: asked.has(questionId)
          || attempt.current_question_id === questionId
          || answer !== undefined,
        resolved: answer !== undefined,
        correct: answer?.is_correct === 1,
        timedOut: answer?.timed_out === 1,
        awardedScore: answer?.awarded_score ?? (answer?.is_correct === 1 ? scoreValue : 0),
        scoreValue,
      }];
    });
  }

  return {
    ...summary,
    breakdown: summarizeAttemptBreakdown(breakdownFacts),
    statisticsCompleteness: ledgerIsComplete ? 'complete' as const : 'partial' as const,
  };
}

function attemptModel(attempt: AttemptRow, statisticsCompleteness?: 'complete' | 'partial') {
  return {
    bankRevision: attempt.bank_revision ?? 'legacy-unknown',
    scoringVersion: attempt.scoring_version,
    appVersion: attempt.app_version,
    testConfigId: attempt.test_config_id,
    testProfileId: attempt.test_profile_id,
    analyticsFactsVersion: attempt.analytics_facts_version,
    statisticsCompleteness: statisticsCompleteness
      ?? (attempt.analytics_facts_version >= ANALYTICS_FACTS_VERSION ? 'complete' : 'partial'),
  };
}

export async function attemptPayload(attempt: AttemptRow) {
  const serverNowMs = Date.now();
  const answeredCount = attempt.correct_count + attempt.wrong_count;
  const accuracy = calculateAccuracy(attempt.correct_count, attempt.wrong_count);
  const baseQuestionIds = new Set(JSON.parse(attempt.base_question_ids) as number[]);

  if (attempt.status === 'aborted') {
    return {
      attemptId: attempt.id,
      alias: attempt.public_alias,
      status: 'aborted' as const,
      serverNowMs,
      model: attemptModel(attempt),
    };
  }

  if (attempt.status === 'completed' || attempt.current_question_id === null) {
    const scoreForVerdict = attempt.base_max_score === BASE_MAX_SCORE
      ? attempt.score
      : attempt.base_max_score > 0
        ? Math.round((attempt.score / attempt.base_max_score) * BASE_MAX_SCORE)
        : 0;
    // Stored legacy verdicts are authoritative. Normalization is only a read-time
    // fallback for old/test rows that were completed before verdict persistence.
    const verdict = attempt.verdict ?? calculateVerdict(scoreForVerdict, accuracy);
    const resultStats = await loadAttemptResultStats(attempt, baseQuestionIds);
    return {
      attemptId: attempt.id,
      alias: attempt.public_alias,
      status: 'completed' as const,
      serverNowMs,
      model: attemptModel(attempt, resultStats.statisticsCompleteness),
      result: {
        verdict,
        score: attempt.score,
        baseMaxScore: attempt.base_max_score,
        scorePercent: attempt.base_max_score
          ? Math.round((attempt.score / attempt.base_max_score) * 100)
          : 0,
        correctCount: attempt.correct_count,
        wrongCount: attempt.wrong_count,
        answeredCount,
        accuracy,
        durationSeconds: attempt.duration_seconds ?? 0,
        timeoutCount: resultStats.timeoutCount,
        averageAnswerSeconds: resultStats.averageAnswerSeconds,
        baseAnsweredCount: resultStats.baseAnsweredCount,
        baseCorrectCount: resultStats.baseCorrectCount,
        additionalAnsweredCount: resultStats.additionalAnsweredCount,
        additionalCorrectCount: resultStats.additionalCorrectCount,
        difficultyStats: resultStats.difficultyStats,
        breakdown: resultStats.breakdown,
        completedAt: new Date(
          attempt.completed_at ?? attempt.started_at + (attempt.duration_seconds ?? 0) * 1_000,
        ).toISOString(),
      },
    };
  }

  if (isUnsupportedActiveAttempt(attempt)) throw new Error('attempt_version_unsupported');

  const question = await findQuestion(attempt.current_question_id);
  if (!question) throw new Error('Question not found');
  const choices = JSON.parse(question.choices_json) as string[];
  const permutation = await choicePermutation(attempt.id, question.id, choices.length);
  const askedQuestionIds = JSON.parse(attempt.asked_question_ids) as number[];
  const ledgerQuestion = await database().prepare(`SELECT question_kind, ordinal, score_value
    FROM attempt_questions WHERE attempt_id = ? AND question_id = ?`)
    .bind(attempt.id, question.id)
    .first<{ question_kind: 'base' | 'additional'; ordinal: number; score_value: number }>();
  const questionKind = ledgerQuestion?.question_kind
    ?? classifyQuestion(question.id, baseQuestionIds);
  const additionalNumber = questionKind === 'additional'
    ? ledgerQuestion
      ? Math.max(1, ledgerQuestion.ordinal - baseQuestionIds.size)
      : askedQuestionIds.filter((questionId) => !baseQuestionIds.has(questionId)).length
    : undefined;

  return {
    attemptId: attempt.id,
    alias: attempt.public_alias,
    status: 'active' as const,
    serverNowMs,
    model: attemptModel(attempt),
    question: {
      id: question.id,
      prompt: question.prompt,
      topic: question.topic,
      ...(question.context_type && question.context_text !== null
        ? { contextType: question.context_type, context: question.context_text }
        : {}),
      choices: permutation.map((index) => choices[index]),
      difficulty: question.difficulty,
      scoreValue: ledgerQuestion?.score_value ?? questionScoreValue(question.weight, questionKind),
      questionKind,
      ...(additionalNumber === undefined ? {} : { additionalNumber }),
      position: askedQuestionIds.length,
      minimumQuestions: baseQuestionIds.size,
      questionDeadlineAt: attempt.question_deadline_at,
      totalDeadlineAt: attempt.total_deadline_at,
    },
  };
}
