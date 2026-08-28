import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  ANALYTICS_FACTS_VERSION,
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from '../lib/test-config.ts';

export const ANALYTICS_BENCHMARK_ATTEMPTS = 10_000;
export const ANALYTICS_BENCHMARK_ANSWERS = 300_000;
export const ANALYTICS_BENCHMARK_REVISION = 'c'.repeat(64);
export const ANALYTICS_BENCHMARK_NOW = Date.parse('2026-08-28T12:00:00.000Z');

const SCHEMA = [
  `CREATE TABLE attempts (
    id TEXT PRIMARY KEY, candidate_key TEXT NOT NULL, public_alias TEXT NOT NULL,
    bank_revision TEXT NOT NULL, app_version TEXT NOT NULL, scoring_version INTEGER NOT NULL,
    test_config_id TEXT NOT NULL, test_profile_id TEXT NOT NULL,
    selection_version INTEGER NOT NULL DEFAULT 1,
    selection_strategy TEXT NOT NULL DEFAULT 'random-difficulty-quota-v1',
    coverage_score REAL, shadow_coverage_score REAL,
    score INTEGER NOT NULL, correct_count INTEGER NOT NULL, wrong_count INTEGER NOT NULL,
    verdict TEXT, completed_at INTEGER, duration_seconds INTEGER, base_max_score INTEGER NOT NULL,
    status TEXT NOT NULL, analytics_facts_version INTEGER NOT NULL, started_at INTEGER NOT NULL
  )`,
  `CREATE TABLE question_bank_revisions (
    hash TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE questions (
    id INTEGER PRIMARY KEY, topic TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    difficulty TEXT NOT NULL, active INTEGER NOT NULL, prompt TEXT NOT NULL,
    context_type TEXT, context_text TEXT, choices_json TEXT NOT NULL, correct_index INTEGER NOT NULL
  )`,
  `CREATE TABLE question_bank_revision_items (
    revision_hash TEXT NOT NULL, question_id INTEGER NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY (revision_hash, question_id)
  )`,
  `CREATE TABLE attempt_questions (
    attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL, question_kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL, source_question_id INTEGER, score_value INTEGER NOT NULL,
    assigned_at INTEGER NOT NULL, presented_at INTEGER,
    PRIMARY KEY (attempt_id, question_id)
  )`,
  `CREATE TABLE answers (
    id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL,
    fact_version INTEGER NOT NULL, answer_origin TEXT NOT NULL,
    canonical_selected_index INTEGER, awarded_score INTEGER,
    is_correct INTEGER NOT NULL, timed_out INTEGER NOT NULL,
    elapsed_seconds INTEGER, answered_at INTEGER
  )`,
  `CREATE TABLE analytics_refresh_state (
    id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE analytics_report_aggregates (
    cache_key TEXT PRIMARY KEY, report_type TEXT NOT NULL, generation INTEGER NOT NULL,
    period_from TEXT, period_to TEXT, payload_json TEXT NOT NULL, generated_at INTEGER NOT NULL
  )`,
];

const INDEXES = [
  `CREATE INDEX idx_attempts_analytics_cohort
    ON attempts (status, scoring_version, test_config_id, test_profile_id, completed_at)`,
  `CREATE INDEX idx_attempts_analytics_latest
    ON attempts (
      analytics_facts_version, status, scoring_version, test_config_id,
      test_profile_id, bank_revision, candidate_key, completed_at
    )`,
  `CREATE UNIQUE INDEX idx_attempt_questions_attempt_ordinal
    ON attempt_questions (attempt_id, ordinal)`,
  `CREATE INDEX idx_attempt_questions_question_presentation
    ON attempt_questions (question_id, presented_at)`,
  `CREATE UNIQUE INDEX idx_answers_attempt_question
    ON answers (attempt_id, question_id)`,
  `CREATE INDEX idx_answers_question_id ON answers (question_id)`,
  `CREATE INDEX idx_analytics_report_aggregates_type_period
    ON analytics_report_aggregates (report_type, period_from, period_to)`,
];

async function seed(db: D1Database) {
  await db.prepare(`INSERT INTO question_bank_revisions (hash, applied_at)
    VALUES (?, ?)`).bind(ANALYTICS_BENCHMARK_REVISION, ANALYTICS_BENCHMARK_NOW).run();
  await db.prepare(`WITH RECURSIVE question_numbers(id) AS (
      SELECT 1 UNION ALL SELECT id + 1 FROM question_numbers WHERE id < 30
    )
    INSERT INTO questions (
      id, topic, dedupe_key, difficulty, active, prompt, context_type,
      context_text, choices_json, correct_index
    )
    SELECT id,
      CASE (id - 1) % 4
        WHEN 0 THEN 'Сети' WHEN 1 THEN 'Linux'
        WHEN 2 THEN 'Windows и AD' ELSE 'Информационная безопасность' END,
      printf('benchmark-question-%02d', id),
      CASE WHEN id <= 5 THEN 'easy' WHEN id <= 12 THEN 'medium'
        WHEN id <= 19 THEN 'hard' WHEN id = 20 THEN 'expert'
        ELSE CASE (id - 21) % 3 WHEN 0 THEN 'easy' WHEN 1 THEN 'medium' ELSE 'hard' END END,
      1, printf('Benchmark question %02d', id), NULL, NULL,
      '["A","B","C","D"]', (id - 1) % 4
    FROM question_numbers`).run();
  await db.prepare(`INSERT INTO question_bank_revision_items (revision_hash, question_id, active)
    SELECT ?, id, 1 FROM questions`).bind(ANALYTICS_BENCHMARK_REVISION).run();

  await db.prepare(`WITH RECURSIVE hundred(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM hundred WHERE n < 99
    ), attempt_numbers(n) AS (
      SELECT left_side.n * 100 + right_side.n + 1
      FROM hundred left_side CROSS JOIN hundred right_side
    )
    INSERT INTO attempts (
      id, candidate_key, public_alias, bank_revision, app_version, scoring_version,
      test_config_id, test_profile_id, score, correct_count, wrong_count, verdict,
      completed_at, duration_seconds, base_max_score, status,
      analytics_facts_version, started_at
    )
    SELECT printf('attempt-%05d', n),
      printf('candidate-%05d', ((n - 1) % 5000) + 1),
      printf('Кандидат %05d', ((n - 1) % 5000) + 1),
      ?, 'benchmark', ?, ?, ?, 20 + (n % 81), 5 + (n % 16), 15 - (n % 11),
      CASE WHEN 20 + (n % 81) >= 80 THEN 'PASS'
        WHEN 20 + (n % 81) >= 50 THEN 'REVIEW' ELSE 'FAIL' END,
      ? - (10001 - n) * 1000, 180 + (n % 421), 100, 'completed', ?,
      ? - (10001 - n) * 1000 - 600000
    FROM attempt_numbers`).bind(
      ANALYTICS_BENCHMARK_REVISION,
      SCORING_VERSION,
      TEST_CONFIG_ID,
      TEST_PROFILE_ID,
      ANALYTICS_BENCHMARK_NOW,
      ANALYTICS_FACTS_VERSION,
      ANALYTICS_BENCHMARK_NOW,
    ).run();

  await db.prepare(`INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, source_question_id,
      score_value, assigned_at, presented_at
    )
    SELECT attempts.id, questions.id,
      CASE WHEN questions.id <= 20 THEN 'base' ELSE 'additional' END,
      questions.id, CASE WHEN questions.id <= 20 THEN NULL ELSE questions.id - 20 END,
      CASE WHEN questions.id <= 5 THEN 2 WHEN questions.id <= 12 THEN 4
        WHEN questions.id <= 19 THEN 6 WHEN questions.id = 20 THEN 20
        ELSE CASE (questions.id - 21) % 3 WHEN 0 THEN 1 WHEN 1 THEN 2 ELSE 3 END END,
      attempts.started_at + questions.id * 1000,
      attempts.started_at + questions.id * 1000
    FROM attempts CROSS JOIN questions`).run();

  await db.prepare(`INSERT INTO answers (
      id, attempt_id, question_id, fact_version, answer_origin,
      canonical_selected_index, awarded_score, is_correct, timed_out,
      elapsed_seconds, answered_at
    )
    SELECT ((CAST(substr(aq.attempt_id, 9) AS INTEGER) - 1) * 30) + aq.question_id,
      aq.attempt_id, aq.question_id, ?, 'submitted',
      (CAST(substr(aq.attempt_id, 9) AS INTEGER) + aq.question_id) % 4,
      CASE WHEN (CAST(substr(aq.attempt_id, 9) AS INTEGER) + aq.question_id) % 4
        = (aq.question_id - 1) % 4 THEN aq.score_value ELSE 0 END,
      CASE WHEN (CAST(substr(aq.attempt_id, 9) AS INTEGER) + aq.question_id) % 4
        = (aq.question_id - 1) % 4 THEN 1 ELSE 0 END,
      0, 5 + ((CAST(substr(aq.attempt_id, 9) AS INTEGER) + aq.question_id) % 26),
      aq.presented_at + (5 + ((CAST(substr(aq.attempt_id, 9) AS INTEGER) + aq.question_id) % 26)) * 1000
    FROM attempt_questions aq`).bind(ANALYTICS_FACTS_VERSION).run();
}

export async function createAnalyticsBenchmarkFixture(options: { seed?: boolean } = {}) {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = await miniflare.getD1Database('DB');
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  await db.prepare(`INSERT INTO analytics_refresh_state (id, generation, updated_at)
    VALUES (1, 1, ?)`).bind(ANALYTICS_BENCHMARK_NOW).run();
  for (const migrationName of [
    '0013_productive_darkstar.sql',
    '0014_supreme_domino.sql',
  ]) {
    const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), 'utf8');
    await db.batch(migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement)));
  }
  const seedStartedAt = performance.now();
  if (options.seed !== false) await seed(db);
  await db.batch(INDEXES.map((sql) => db.prepare(sql)));
  await db.prepare('ANALYZE').run();
  const seedDurationMs = performance.now() - seedStartedAt;
  return { miniflare, db, seedDurationMs };
}

export async function benchmarkFixtureCounts(db: D1Database) {
  const [attempts, answers, ledger] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM answers').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM attempt_questions').first<{ count: number }>(),
  ]);
  return {
    attempts: attempts?.count ?? 0,
    answers: answers?.count ?? 0,
    ledger: ledger?.count ?? 0,
  };
}
