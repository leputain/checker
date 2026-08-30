import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createBackup } from './ops-backup.ts';
import { verifyBackup, assertLocalDatabaseIntegrity } from './ops-backup-verify.ts';
import { executeLocalD1File, queryLocalD1, runWrangler } from './local-d1.ts';
import { resolveOpsContext } from './ops-context.ts';
import { restoreBackup } from './ops-restore.ts';
import { registerRuntimeLock } from './runtime-lock.ts';
import { runRetention } from './ops-retention.ts';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';
import {
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_CONFIG_JSON,
  TEST_PROFILE_ID,
} from '../lib/test-config.ts';

type Journal = {
  entries: Array<{ idx: number; tag: string }>;
};

type TestWorkspace = ReturnType<typeof resolveOpsContext>;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workingPersistPath = path.join(projectRoot, '.wrangler', 'state');
const now = Date.parse('2026-08-28T12:00:00.000Z');
const dayMs = 24 * 60 * 60 * 1_000;
const oldAt = now - (2 * dayMs);
const freshAt = now - (60 * 60 * 1_000);
const seededBankQuestions = [
  {
    id: 1,
    difficulty: 'easy',
    topic: 'Ops',
    prompt: 'Integration question',
    choices: ['A', 'B'],
    correctIndex: 0,
    weight: 1,
    active: false,
    dedupeKey: 'ops-integration',
  },
  {
    id: 2,
    difficulty: 'easy',
    topic: 'Ops v2',
    prompt: 'Integration question v2',
    choices: ['A', 'B'],
    correctIndex: 0,
    weight: 1,
    active: true,
    dedupeKey: 'ops-integration-v2',
  },
] as const;
function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
const seededQuestionHashes = new Map(seededBankQuestions.map((question) => [
  question.id,
  sha256(JSON.stringify({
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    choices: question.choices,
    correctIndex: question.correctIndex,
    weight: question.weight,
    dedupeKey: question.dedupeKey,
  })),
]));
const revision = sha256(JSON.stringify(seededBankQuestions.map((question) => ({
  id: question.id,
  difficulty: question.difficulty,
  topic: question.topic,
  prompt: question.prompt,
  choices: question.choices,
  correctIndex: question.correctIndex,
  weight: question.weight,
  active: question.active,
  dedupeKey: question.dedupeKey,
}))));
const completedId = '11111111-1111-4111-8111-111111111111';
const oldActiveId = '22222222-2222-4222-8222-222222222222';
const freshAbortedId = '33333333-3333-4333-8333-333333333333';
const freshActiveId = '44444444-4444-4444-8444-444444444444';
const oldAbortedId = '55555555-5555-4555-8555-555555555555';

function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createWorkspace(root: string, name: string) {
  const workspaceRoot = path.join(root, name);
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = path.join(workspaceRoot, 'wrangler.local.jsonc');
  await writeFile(configPath, `${JSON.stringify({
    name: `candidate-check-ops-${name}`,
    compatibility_date: '2026-08-27',
    d1_databases: [{
      binding: 'DB',
      database_name: 'site-creator-d1',
      database_id: '00000000-0000-4000-8000-000000000000',
    }],
  }, null, 2)}\n`, 'utf8');
  const workspace = resolveOpsContext({ workspaceRoot, configPath });
  assert.notEqual(
    path.resolve(workspace.persistPath),
    path.resolve(workingPersistPath),
    'integration workspace must never resolve to the working D1 state',
  );
  return workspace;
}

function executeSql(workspace: TestWorkspace, sql: string) {
  runWrangler(
    ['d1', 'execute', 'DB', '--command', sql, '--json'],
    workspace.persistPath,
    workspace.localD1,
  );
}

async function migrationJournal() {
  return JSON.parse(await readFile(
    path.join(projectRoot, 'drizzle', 'meta', '_journal.json'),
    'utf8',
  )) as Journal;
}

async function applyMigrationChain(
  workspace: TestWorkspace,
  journal: Journal,
  lastIndex: number,
) {
  const selected = journal.entries
    .filter((entry) => entry.idx <= lastIndex)
    .toSorted((left, right) => left.idx - right.idx);
  assert.deepEqual(
    selected.map((entry) => entry.idx),
    Array.from({ length: lastIndex + 1 }, (_, index) => index),
    'migration journal must be contiguous',
  );
  for (const entry of selected) {
    executeLocalD1File(
      path.join(projectRoot, 'drizzle', `${entry.tag}.sql`),
      workspace.persistPath,
      workspace.localD1,
    );
  }
}

function installManagedMigrationLedger(workspace: TestWorkspace, schemaVersion: number) {
  executeSql(workspace, `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  executeSql(workspace, `INSERT INTO schema_migrations (version, name, applied_at) VALUES
    ${Array.from({ length: schemaVersion }, (_, index) => (
      `(${index + 1}, 'integration-${index + 1}', ${now + index})`
    )).join(', ')}`);
}

function seedLegacyDatabase(workspace: TestWorkspace) {
  executeSql(workspace, `INSERT INTO questions (
      id, difficulty, prompt, choices_json, correct_index, weight, active
    ) VALUES (1, 'easy', 'Legacy question', '["A","B"]', 0, 1, 1)`);
  executeSql(workspace, `INSERT INTO attempts (
      id, token_hash, public_alias, status, started_at, total_deadline_at,
      question_deadline_at, current_question_id, pending_question_ids, asked_question_ids
    ) VALUES (
      'legacy-attempt', 'hash', 'Candidate L.', 'completed', ${oldAt}, ${oldAt + 600000},
      ${oldAt + 30000}, 1, '[]', '[1]'
    )`);
  executeSql(workspace, `INSERT INTO answers (
      attempt_id, question_id, selected_index, is_correct, answered_at
    ) VALUES ('legacy-attempt', 1, 0, 1, ${oldAt + 1000})`);
}

function seedPreAdminUpgradeDatabase(workspace: TestWorkspace) {
  executeSql(workspace, `INSERT INTO question_bank_revisions (
      hash, applied_at, total_count, active_count, pools_json
    ) VALUES (${sqlText(revision)}, ${oldAt}, 1, 1, '{}')`);
  executeSql(workspace, `INSERT INTO questions (
      id, difficulty, topic, prompt, choices_json, correct_index, weight, active,
      content_hash, dedupe_key
    ) VALUES
      (1, 'easy', 'Current', 'Current member', '["A","B"]', 0, 1, 1,
        ${sqlText('b'.repeat(64))}, 'upgrade-current'),
      (2, 'easy', 'Historical', 'Inactive orphan', '["A","B"]', 0, 1, 0,
        ${sqlText('c'.repeat(64))}, 'upgrade-orphan')`);
  executeSql(workspace, `INSERT INTO question_bank_revision_items (
      revision_hash, question_id, active
    ) VALUES (${sqlText(revision)}, 1, 1)`);
}

function seedStaleActiveAttempt(workspace: TestWorkspace) {
  executeSql(workspace, `INSERT INTO attempts (
      id, token_hash, candidate_name, candidate_key, public_alias, bank_revision,
      scoring_version, app_version, test_config_id, test_profile_id,
      analytics_facts_version, selection_version, selection_strategy,
      status, started_at, total_deadline_at, question_deadline_at,
      pending_question_ids, asked_question_ids, completed_at
    ) VALUES (${sqlText(oldActiveId)}, 'hash-2', 'Abandoned Name', 'candidate-2',
      'Candidate A.', ${sqlText(revision)}, 0, 'legacy-unknown', 'legacy-unknown',
      'legacy-unknown', 0, 0, 'unknown', 'active', ${oldAt}, ${oldAt + 600000},
      ${oldAt + 30000}, '[]', '[1]', NULL)`);
  executeSql(workspace, `INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, score_value, assigned_at, presented_at
    ) VALUES (${sqlText(oldActiveId)}, 1, 'base', 1, 5, ${oldAt}, ${oldAt})`);
  executeSql(workspace, `INSERT INTO answers (
      attempt_id, question_id, selected_index, is_correct, answered_at,
      elapsed_seconds, timed_out, fact_version, answer_origin,
      canonical_selected_index, awarded_score
    ) VALUES (${sqlText(oldActiveId)}, 1, 0, 1, ${oldAt + 5000}, 5, 0, 0,
      'unknown', 0, 5)`);
  executeSql(workspace, `INSERT INTO telegram_outbox (
      id, attempt_id, question_id, event_type, payload_text, next_attempt_at, created_at
    ) VALUES ('outbox-abandoned', ${sqlText(oldActiveId)}, 1, 'answer',
      'sensitive-abandoned', ${oldAt}, ${oldAt})`);
}

function seedCurrentDatabase(workspace: TestWorkspace) {
  executeSql(workspace, `INSERT INTO question_bank_revisions (
      hash, applied_at, total_count, active_count, pools_json
    ) VALUES (${sqlText(revision)}, ${oldAt}, 2, 1, '{}')`);
  executeSql(workspace, `INSERT INTO questions (
      id, difficulty, topic, prompt, choices_json, correct_index, weight, active,
      content_hash, dedupe_key
    ) VALUES
      (1, 'easy', 'Ops', 'Integration question', '["A","B"]', 0, 1, 0,
        ${sqlText(seededQuestionHashes.get(1)!)}, 'ops-integration'),
      (2, 'easy', 'Ops v2', 'Integration question v2', '["A","B"]', 0, 1, 1,
        ${sqlText(seededQuestionHashes.get(2)!)}, 'ops-integration-v2')`);
  executeSql(workspace, `INSERT INTO question_bank_revision_items (
      revision_hash, question_id, active
    ) VALUES
      (${sqlText(revision)}, 1, 0),
      (${sqlText(revision)}, 2, 1)`);
  executeSql(workspace, `INSERT INTO question_bank_state (id, current_revision, updated_at)
    VALUES (1, ${sqlText(revision)}, ${oldAt})`);
  executeSql(workspace, `INSERT INTO question_version_links (
      predecessor_question_id, successor_question_id, created_at, bank_revision
    ) VALUES (1, 2, ${oldAt}, ${sqlText(revision)})`);
  executeSql(workspace, `INSERT INTO question_bank_change_events (
      event_type, question_id, predecessor_question_id, successor_question_id,
      bank_revision, created_at, note
    ) VALUES ('revised', 2, 1, 2, ${sqlText(revision)}, ${oldAt}, 'integration')`);
  executeSql(workspace, `INSERT INTO question_bank_mutations (
      idempotency_key, operation, expected_revision, request_hash, response_json, created_at
    ) VALUES ('ops-integration-key', 'revise', ${sqlText(revision)},
      ${sqlText('d'.repeat(64))}, '{}', ${oldAt})`);
  executeSql(workspace, `INSERT INTO test_config_versions (
      id, scoring_version, config_json, created_at
    ) VALUES (
      ${sqlText(TEST_CONFIG_ID)}, ${SCORING_VERSION}, ${sqlText(TEST_CONFIG_JSON)}, ${oldAt}
    )`);
  executeSql(workspace, `INSERT INTO attempts (
      id, token_hash, candidate_name, candidate_key, public_alias, bank_revision,
      scoring_version, app_version, test_config_id, test_profile_id,
      analytics_facts_version, selection_version, selection_strategy,
      status, started_at, total_deadline_at, question_deadline_at,
      pending_question_ids, asked_question_ids, completed_at
    ) VALUES
      (${sqlText(completedId)}, 'hash-1', 'Completed Name', 'candidate-1', 'Candidate C.',
        ${sqlText(revision)}, ${SCORING_VERSION}, '0.7.1', ${sqlText(TEST_CONFIG_ID)},
        ${sqlText(TEST_PROFILE_ID)}, 0, 1, 'random-difficulty-quota-v1', 'completed',
        ${oldAt}, ${oldAt + 600000}, ${oldAt + 30000}, '[]', '[1]', ${oldAt + 60000}),
      (${sqlText(freshAbortedId)}, 'hash-3', 'Recent Abort', 'candidate-3', 'Candidate R.',
        ${sqlText(revision)}, 0, 'legacy-unknown', 'legacy-unknown', 'legacy-unknown',
        0, 0, 'unknown', 'aborted', ${freshAt}, ${freshAt + 600000}, ${freshAt + 30000},
        '[]', '[]', ${freshAt + 1000}),
      (${sqlText(freshActiveId)}, 'hash-4', 'Recent Active', 'candidate-4', 'Candidate N.',
        ${sqlText(revision)}, 0, 'legacy-unknown', 'legacy-unknown', 'legacy-unknown',
        0, 0, 'unknown', 'active', ${freshAt}, ${freshAt + 600000}, ${freshAt + 30000},
        '[]', '[]', NULL),
      (${sqlText(oldAbortedId)}, 'hash-5', 'Old Abort', 'candidate-5', 'Candidate O.',
        ${sqlText(revision)}, 0, 'legacy-unknown', 'legacy-unknown', 'legacy-unknown',
        0, 0, 'unknown', 'aborted', ${oldAt}, ${oldAt + 600000}, ${oldAt + 30000},
        '[]', '[1]', ${oldAt + 1000})`);
  executeSql(workspace, `INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, score_value, assigned_at, presented_at
    ) VALUES
      (${sqlText(completedId)}, 1, 'base', 1, 5, ${oldAt}, ${oldAt}),
      (${sqlText(oldAbortedId)}, 1, 'base', 1, 5, ${oldAt}, ${oldAt})`);
  executeSql(workspace, `INSERT INTO answers (
      attempt_id, question_id, selected_index, is_correct, answered_at,
      elapsed_seconds, timed_out, fact_version, answer_origin,
      canonical_selected_index, awarded_score
    ) VALUES
      (${sqlText(completedId)}, 1, 0, 1, ${oldAt + 5000}, 5, 0, 0,
        'unknown', 0, 5),
      (${sqlText(oldAbortedId)}, 1, 0, 0, ${oldAt + 5000}, 5, 0, 0,
        'unknown', 0, 0)`);
  executeSql(workspace, `INSERT INTO telegram_outbox (
      id, attempt_id, question_id, event_type, payload_text, next_attempt_at, created_at
    ) VALUES
      ('outbox-completed', ${sqlText(completedId)}, NULL, 'completed', 'sensitive-completed',
        ${oldAt}, ${oldAt}),
      ('outbox-old-aborted', ${sqlText(oldAbortedId)}, 1, 'aborted', 'sensitive-old-aborted',
        ${oldAt}, ${oldAt})`);
  seedStaleActiveAttempt(workspace);
  executeSql(workspace, `INSERT INTO question_review_history (
      question_id, bank_revision, decision, note, created_at
    ) VALUES (1, ${sqlText(revision)}, 'observe', 'integration', ${oldAt})`);
  executeSql(workspace, `INSERT INTO analytics_report_aggregates (
      cache_key, report_type, generation, period_from, period_to, payload_json, generated_at
    ) VALUES ('ops-cache', 'overview', 1, '2026-08-01', '2026-08-28', '{}', ${oldAt})`);
}

function countRows(workspace: TestWorkspace, table: string) {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('Unsafe test table name.');
  return queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
    workspace.persistPath,
    workspace.localD1,
  )[0]?.count ?? 0;
}

async function testAnalyticsFactsIntegrityQuery() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  try {
    const db = await miniflare.getD1Database('DB');
    await db.batch([
      db.prepare(`CREATE TABLE attempts (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, score INTEGER NOT NULL,
        base_max_score INTEGER NOT NULL, correct_count INTEGER NOT NULL,
        wrong_count INTEGER NOT NULL, analytics_facts_version INTEGER NOT NULL,
        base_question_ids TEXT NOT NULL, bank_revision TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE attempt_questions (
        attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL, question_kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL, source_question_id INTEGER,
        score_value INTEGER NOT NULL, presented_at INTEGER,
        PRIMARY KEY (attempt_id, question_id)
      )`),
      db.prepare(`CREATE TABLE questions (
        id INTEGER PRIMARY KEY, weight INTEGER NOT NULL,
        choices_json TEXT NOT NULL, correct_index INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE question_bank_revision_items (
        revision_hash TEXT NOT NULL, question_id INTEGER NOT NULL, active INTEGER NOT NULL,
        PRIMARY KEY (revision_hash, question_id)
      )`),
      db.prepare(`CREATE TABLE answers (
        id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL,
        fact_version INTEGER NOT NULL, answer_origin TEXT NOT NULL,
        canonical_selected_index INTEGER, awarded_score INTEGER,
        is_correct INTEGER NOT NULL, timed_out INTEGER NOT NULL,
        elapsed_seconds INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`INSERT INTO attempts (
        id, status, score, base_max_score, correct_count, wrong_count,
        analytics_facts_version, base_question_ids, bank_revision
      ) VALUES ('exact', 'completed', 100, 100, 20, 0, 1,
        '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`),
    ]);
    await db.batch(Array.from({ length: 21 }, (_, index) => db.prepare(
      `INSERT INTO questions (id, weight, choices_json, correct_index)
        VALUES (?, ?, '["A","B"]', 0)`,
    ).bind(index + 1, index < 10 ? 2 : 3)));
    await db.batch(Array.from({ length: 21 }, (_, index) => db.prepare(
      `INSERT INTO question_bank_revision_items (revision_hash, question_id, active)
        VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`,
    ).bind(index + 1)));
    await db.batch(Array.from({ length: 20 }, (_, index) => {
      const unitWeight = index < 10 ? 2 : 3;
      return db.prepare(
      `INSERT INTO attempt_questions (
        attempt_id, question_id, question_kind, ordinal, source_question_id,
        score_value, presented_at
      ) VALUES ('exact', ?, 'base', ?, NULL, ?, 1000)`,
      ).bind(index + 1, index + 1, unitWeight * 2);
    }));
    await db.batch(Array.from({ length: 20 }, (_, index) => {
      const awardedScore = (index < 10 ? 2 : 3) * 2;
      return db.prepare(
      `INSERT INTO answers (
        id, attempt_id, question_id, fact_version, answer_origin,
        canonical_selected_index, awarded_score, is_correct, timed_out
      ) VALUES (?, 'exact', ?, 1, 'submitted', 0, ?, 1, 0)`,
      ).bind(index + 1, index + 1, awardedScore);
    }));
    const violations = async () => (
      await db.prepare(ANALYTICS_FACTS_INTEGRITY_QUERY)
        .first<{ violations: number }>()
    )?.violations ?? 0;

    assert.equal(await violations(), 0, 'complete exact facts must pass integrity');
    await db.prepare('DELETE FROM answers WHERE attempt_id = ? AND question_id = 20')
      .bind('exact').run();
    assert.equal(await violations(), 1, 'a presented base question without an exact answer must fail');
    await db.prepare(`INSERT INTO answers (
      id, attempt_id, question_id, fact_version, answer_origin,
      canonical_selected_index, awarded_score, is_correct, timed_out
    ) VALUES (20, 'exact', 20, 1, 'submitted', 0, 6, 1, 0)`).run();

    await db.prepare("UPDATE attempts SET correct_count = 19, wrong_count = 1 WHERE id = 'exact'")
      .run();
    assert.equal(await violations(), 1, 'stored attempt counters must match exact answer facts');
    await db.prepare("UPDATE attempts SET correct_count = 20, wrong_count = 0 WHERE id = 'exact'")
      .run();

    await db.batch([
      db.prepare(`UPDATE answers SET awarded_score = 7
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE answers SET awarded_score = 3
        WHERE attempt_id = 'exact' AND question_id = 1`),
    ]);
    assert.equal(
      await violations(),
      1,
      'per-answer awarded score must stay within the question score value even if the total matches',
    );
    await db.batch([
      db.prepare(`UPDATE answers SET awarded_score = 6
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE answers SET awarded_score = 4
        WHERE attempt_id = 'exact' AND question_id = 1`),
    ]);

    await db.prepare(`UPDATE answers SET canonical_selected_index = 1
      WHERE attempt_id = 'exact' AND question_id = 20`).run();
    assert.equal(
      await violations(),
      1,
      'canonical selected index and correctness must match the immutable answer key',
    );
    await db.prepare(`UPDATE answers SET canonical_selected_index = 0
      WHERE attempt_id = 'exact' AND question_id = 20`).run();

    await db.prepare(`DELETE FROM question_bank_revision_items
      WHERE revision_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        AND question_id = 20`).run();
    assert.equal(
      await violations(),
      1,
      'every ledger question must belong to the attempt bank revision snapshot',
    );
    await db.prepare(`INSERT INTO question_bank_revision_items (
      revision_hash, question_id, active
    ) VALUES (
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 20, 1
    )`).run();

    await db.prepare(`UPDATE attempt_questions SET ordinal = 21
      WHERE attempt_id = 'exact' AND question_id = 20`).run();
    assert.equal(await violations(), 1, 'base ordinals must be contiguous from 1 through 20');
    await db.prepare(`UPDATE attempt_questions SET ordinal = 20, score_value = 7
      WHERE attempt_id = 'exact' AND question_id = 20`).run();
    assert.equal(await violations(), 1, 'base score value must be twice the unit weight');
    await db.prepare(`UPDATE attempt_questions SET score_value = 6
      WHERE attempt_id = 'exact' AND question_id = 20`).run();

    await db.prepare("UPDATE attempts SET base_question_ids = 'not-json' WHERE id = 'exact'")
      .run();
    assert.equal(await violations(), 1, 'an invalid base question plan must fail without SQL errors');
    await db.prepare(`UPDATE attempts
      SET base_question_ids = '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,21]'
      WHERE id = 'exact'`).run();
    assert.equal(await violations(), 1, 'base ledger IDs must equal the canonical base question plan');
    await db.prepare(`UPDATE attempts
      SET base_question_ids = '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]'
      WHERE id = 'exact'`).run();

    await db.batch([
      db.prepare(`UPDATE attempt_questions SET presented_at = NULL
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE answers SET answer_origin = 'total_timeout_unshown',
        canonical_selected_index = NULL, awarded_score = 0, is_correct = 0, timed_out = 1
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE attempts SET score = 94, correct_count = 19, wrong_count = 1
        WHERE id = 'exact'`),
    ]);
    assert.equal(await violations(), 0, 'an unshown base timeout is a resolved base fact');
    await db.batch([
      db.prepare(`UPDATE attempt_questions SET presented_at = 1000
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE answers SET answer_origin = 'submitted', canonical_selected_index = 0,
        awarded_score = 6, is_correct = 1, timed_out = 0
        WHERE attempt_id = 'exact' AND question_id = 20`),
      db.prepare(`UPDATE attempts SET score = 100, correct_count = 20, wrong_count = 0
        WHERE id = 'exact'`),
    ]);

    await db.prepare(`INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, source_question_id,
      score_value, presented_at
    ) VALUES ('exact', 21, 'additional', 21, 1, 3, NULL)`).run();
    assert.equal(
      await violations(),
      1,
      'an additional question must originate from an incorrectly resolved base question',
    );
    await db.batch([
      db.prepare(`UPDATE answers SET awarded_score = 0, is_correct = 0,
        canonical_selected_index = 1
        WHERE attempt_id = 'exact' AND question_id = 1`),
      db.prepare(`UPDATE attempts SET score = 96, correct_count = 19, wrong_count = 1
        WHERE id = 'exact'`),
    ]);
    assert.equal(await violations(), 0, 'an unshown additional question may remain unresolved');
    await db.batch([
      db.prepare(`UPDATE attempt_questions SET presented_at = NULL
        WHERE attempt_id = 'exact' AND question_id = 1`),
      db.prepare(`UPDATE answers SET answer_origin = 'total_timeout_unshown',
        canonical_selected_index = NULL, timed_out = 1
        WHERE attempt_id = 'exact' AND question_id = 1`),
    ]);
    assert.equal(await violations(), 1, 'an unshown total-timeout base cannot source remediation');
    await db.batch([
      db.prepare(`UPDATE attempt_questions SET presented_at = 1000
        WHERE attempt_id = 'exact' AND question_id = 1`),
      db.prepare(`UPDATE answers SET answer_origin = 'total_timeout_presented', timed_out = 1
        WHERE attempt_id = 'exact' AND question_id = 1`),
    ]);
    assert.equal(await violations(), 1, 'a presented total-timeout base cannot source remediation');
    await db.prepare(`UPDATE answers SET answer_origin = 'question_timeout', timed_out = 1
      WHERE attempt_id = 'exact' AND question_id = 1`).run();
    assert.equal(await violations(), 0, 'a per-question timeout may source remediation');
    await db.prepare(`UPDATE answers SET answer_origin = 'submitted',
      canonical_selected_index = 1, timed_out = 0
      WHERE attempt_id = 'exact' AND question_id = 1`).run();
    await db.prepare(`UPDATE attempt_questions SET ordinal = 22
      WHERE attempt_id = 'exact' AND question_id = 21`).run();
    assert.equal(await violations(), 1, 'additional ordinals must be contiguous from 21');
    await db.prepare(`UPDATE attempt_questions SET ordinal = 21, score_value = 4
      WHERE attempt_id = 'exact' AND question_id = 21`).run();
    assert.equal(await violations(), 1, 'additional score value must equal the unit weight');
    await db.prepare(`UPDATE attempt_questions SET score_value = 3
      WHERE attempt_id = 'exact' AND question_id = 21`).run();
    await db.batch([
      db.prepare(`INSERT INTO answers (
        id, attempt_id, question_id, fact_version, answer_origin,
        canonical_selected_index, awarded_score, is_correct, timed_out
      ) VALUES (21, 'exact', 21, 1, 'total_timeout_unshown', NULL, 0, 0, 1)`),
      db.prepare("UPDATE attempts SET wrong_count = 2 WHERE id = 'exact'"),
    ]);
    assert.equal(await violations(), 1, 'an unshown additional question must never have an answer');
    await db.batch([
      db.prepare("DELETE FROM answers WHERE attempt_id = 'exact' AND question_id = 21"),
      db.prepare("UPDATE attempts SET wrong_count = 1 WHERE id = 'exact'"),
    ]);
    assert.equal(await violations(), 0, 'an assigned but unshown additional question stays unresolved');
    await db.prepare(`UPDATE attempt_questions SET presented_at = 1000
      WHERE attempt_id = 'exact' AND question_id = 21`).run();
    assert.equal(await violations(), 1, 'every presented additional question needs an exact answer');
  } finally {
    await miniflare.dispose();
  }
}

const integrationRoot = await mkdtemp(path.join(tmpdir(), 'candidate-check-ops-'));
try {
  await testAnalyticsFactsIntegrityQuery();
  const journal = await migrationJournal();
  const latestMigrationIndex = journal.entries.at(-1)?.idx;
  assert(
    latestMigrationIndex !== undefined && latestMigrationIndex >= 12,
    'integration test must cover migrations through the analytics aggregate schema',
  );
  const managedSchemaVersion = latestMigrationIndex - 1;

  const current = await createWorkspace(integrationRoot, 'current');
  await applyMigrationChain(current, journal, latestMigrationIndex);
  installManagedMigrationLedger(current, managedSchemaVersion);
  const tables = new Set(queryLocalD1<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    current.persistPath,
    current.localD1,
  ).map((row) => row.name));
  for (const table of [
    'attempts',
    'answers',
    'attempt_questions',
    'test_config_versions',
    'question_bank_revision_items',
    'question_bank_state',
    'question_version_links',
    'question_bank_change_events',
    'question_bank_mutations',
    'question_review_history',
    'telegram_outbox',
    'analytics_refresh_state',
    'analytics_report_aggregates',
  ]) {
    assert(tables.has(table), `clean migration chain did not create ${table}`);
  }
  assertLocalDatabaseIntegrity(current.persistPath, current.localD1);

  const adminMigration = journal.entries.find((entry) => entry.tag === '0017_narrow_baron_zemo');
  assert(adminMigration, 'question bank admin migration must be present');
  const upgrade = await createWorkspace(integrationRoot, 'admin-upgrade');
  await applyMigrationChain(upgrade, journal, adminMigration.idx - 1);
  seedPreAdminUpgradeDatabase(upgrade);
  executeLocalD1File(
    path.join(projectRoot, 'drizzle', `${adminMigration.tag}.sql`),
    upgrade.persistPath,
    upgrade.localD1,
  );
  assert.deepEqual(queryLocalD1<{ question_id: number }>(
    'SELECT question_id FROM question_bank_change_events ORDER BY question_id',
    upgrade.persistPath,
    upgrade.localD1,
  ), [{ question_id: 1 }], 'upgrade audit must include only current revision members');
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count
      FROM question_bank_revision_items items
      JOIN question_bank_state state ON state.current_revision = items.revision_hash
      WHERE state.id = 1`,
    upgrade.persistPath,
    upgrade.localD1,
  )[0]?.count, 1, 'upgrade must not pull inactive orphan rows into current membership');

  const legacy = await createWorkspace(integrationRoot, 'legacy-v7');
  await applyMigrationChain(legacy, journal, 8);
  seedLegacyDatabase(legacy);
  const legacyBackup = await createBackup(legacy);
  await verifyBackup(legacyBackup.sqlPath, legacy);
  assert.equal(legacyBackup.manifest.format, 3);
  assert.equal(legacyBackup.manifest.counts.attempt_questions, 0);
  assert.equal(legacyBackup.manifest.counts.test_config_versions, 0);
  assert.equal(legacyBackup.manifest.counts.bank_revision_items, 0);
  assert.equal(legacyBackup.manifest.counts.bank_state, 0);
  assert.equal(legacyBackup.manifest.counts.question_version_links, 0);
  assert.equal(legacyBackup.manifest.counts.question_bank_change_events, 0);
  assert.equal(legacyBackup.manifest.counts.question_bank_mutations, 0);
  assert.equal(legacyBackup.manifest.counts.question_reviews, 0);
  assert.equal(legacyBackup.manifest.counts.analytics_refresh_state, 0);
  assert.equal(legacyBackup.manifest.counts.analytics_report_aggregates, 0);

  const format1Sql = path.join(legacy.workspaceRoot, 'backups', 'legacy-format1.sql');
  const format1Manifest = format1Sql.replace(/\.sql$/u, '.manifest.json');
  await copyFile(legacyBackup.sqlPath, format1Sql);
  await writeFile(format1Manifest, `${JSON.stringify({
    format: 1,
    sha256: legacyBackup.manifest.sha256,
    counts: {
      attempts: legacyBackup.manifest.counts.attempts,
      answers: legacyBackup.manifest.counts.answers,
      questions: legacyBackup.manifest.counts.questions,
      outbox: legacyBackup.manifest.counts.outbox,
      schema_version: legacyBackup.manifest.counts.schema_version,
      bank_revision: legacyBackup.manifest.counts.bank_revision,
    },
  }, null, 2)}\n`, 'utf8');
  await verifyBackup(format1Sql, legacy);

  seedCurrentDatabase(current);
  const sourceBackup = await createBackup(current);
  await verifyBackup(sourceBackup.sqlPath, current);
  assert.equal(sourceBackup.manifest.counts.schema_version, managedSchemaVersion);
  assert.equal(sourceBackup.manifest.counts.attempts, 5);
  assert.equal(sourceBackup.manifest.counts.answers, 3);
  assert.equal(sourceBackup.manifest.counts.attempt_questions, 3);
  assert.equal(sourceBackup.manifest.counts.outbox, 3);
  assert.equal(sourceBackup.manifest.counts.question_reviews, 1);
  assert.equal(sourceBackup.manifest.counts.bank_state, 1);
  assert.equal(sourceBackup.manifest.counts.question_version_links, 1);
  assert.equal(sourceBackup.manifest.counts.question_bank_change_events, 1);
  assert.equal(sourceBackup.manifest.counts.question_bank_mutations, 1);
  assert.equal(sourceBackup.manifest.counts.analytics_refresh_state, 1);
  assert.equal(sourceBackup.manifest.counts.analytics_report_aggregates, 1);

  const liveRuntime = await registerRuntimeLock({
    workspaceRoot: current.workspaceRoot,
    statePath: current.persistPath,
    port: 42_777,
  });
  try {
    await assert.rejects(
      restoreBackup({
        workspaceRoot: current.workspaceRoot,
        configPath: current.configPath,
        sourcePath: sourceBackup.sqlPath,
        checkServer: false,
        nowMs: now,
      }),
      /Stop every local/u,
      'restore must be blocked by a live wrapper on any port',
    );
    await assert.rejects(
      runRetention({
        workspaceRoot: current.workspaceRoot,
        configPath: current.configPath,
        argv: ['--apply'],
        nowMs: now,
        checkServer: false,
        log: () => undefined,
      }),
      /Stop every local/u,
      'retention apply must be blocked by a live wrapper on any port',
    );
    assert.equal(countRows(current, 'attempts'), 5, 'blocked operations must not mutate D1');
  } finally {
    await liveRuntime.release();
  }

  executeSql(current, `UPDATE attempts SET public_alias = 'MUTATED'
    WHERE id = ${sqlText(completedId)}`);
  executeSql(current, "DELETE FROM telegram_outbox WHERE id = 'outbox-completed'");
  const restored = await restoreBackup({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    sourcePath: sourceBackup.sqlPath,
    checkServer: false,
    nowMs: now,
  });
  assert.notEqual(restored.preRestore.sqlPath, sourceBackup.sqlPath);
  assert.equal(queryLocalD1<{ public_alias: string }>(
    `SELECT public_alias FROM attempts WHERE id = ${sqlText(completedId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.public_alias, 'Candidate C.');
  assert.equal(countRows(current, 'attempts'), 3, 'restore must purge stale active and aborted rows');
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attempts
      WHERE id IN (${sqlText(oldActiveId)}, ${sqlText(oldAbortedId)})`,
    current.persistPath,
    current.localD1,
  )[0]?.count, 0);
  assert.equal(queryLocalD1<{ candidate_name: string | null }>(
    `SELECT candidate_name FROM attempts WHERE id = ${sqlText(completedId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.candidate_name, null, 'restore must scrub stale completed PII');
  assert.deepEqual(queryLocalD1<{ status: string; payload_text: string }>(
    "SELECT status, payload_text FROM telegram_outbox WHERE id = 'outbox-completed'",
    current.persistPath,
    current.localD1,
  )[0], { status: 'dead', payload_text: '' });
  assert.deepEqual(queryLocalD1<{ answers: number; ledger: number }>(
    `SELECT
      (SELECT COUNT(*) FROM answers WHERE attempt_id = ${sqlText(completedId)}) AS answers,
      (SELECT COUNT(*) FROM attempt_questions
        WHERE attempt_id = ${sqlText(completedId)}) AS ledger`,
    current.persistPath,
    current.localD1,
  )[0], { answers: 1, ledger: 1 }, 'restore must retain completed facts indefinitely');
  assert.deepEqual(queryLocalD1<{
    current_revision: string;
    links: number;
    events: number;
    mutations: number;
  }>(`SELECT
      (SELECT current_revision FROM question_bank_state WHERE id = 1) AS current_revision,
      (SELECT COUNT(*) FROM question_version_links) AS links,
      (SELECT COUNT(*) FROM question_bank_change_events) AS events,
      (SELECT COUNT(*) FROM question_bank_mutations) AS mutations`,
    current.persistPath,
    current.localD1,
  )[0], {
    current_revision: revision,
    links: 1,
    events: 1,
    mutations: 1,
  }, 'restore must retain the managed bank revision and immutable edit history');
  assert.equal(countRows(current, 'telegram_outbox'), 1);
  await verifyBackup(sourceBackup.sqlPath, current);

  // Re-seed one abandoned attempt so the standalone purge workflow below is
  // still verified independently from restore-time policy enforcement.
  seedStaleActiveAttempt(current);

  const manualDryRun = await runRetention({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    argv: ['--attempt', freshAbortedId],
    nowMs: now,
    checkServer: false,
    log: () => undefined,
  });
  assert.equal(manualDryRun.applied, false);
  assert.equal(manualDryRun.counts.attempts, 1);
  assert.equal(countRows(current, 'attempts'), 4, 'manual dry-run must not mutate attempts');

  const automaticDryRun = await runRetention({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    argv: [],
    nowMs: now,
    checkServer: false,
    log: () => undefined,
  });
  assert.equal(automaticDryRun.counts.attempts, 1);
  assert.equal(automaticDryRun.counts.answers, 1);
  assert.equal(automaticDryRun.counts.attempt_questions, 1);
  assert.equal(automaticDryRun.counts.outbox, 1);

  const automaticApply = await runRetention({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    argv: ['--apply'],
    nowMs: now,
    checkServer: false,
    log: () => undefined,
  });
  assert.equal(automaticApply.applied, true);
  assert(automaticApply.backup, 'apply must return the verified pre-purge backup');
  await verifyBackup(automaticApply.backup.sqlPath, current);
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attempts WHERE id = ${sqlText(oldActiveId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.count, 0);
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attempts WHERE id = ${sqlText(completedId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.count, 1, 'automatic retention must keep completed attempts indefinitely');
  assert.equal(queryLocalD1<{ candidate_name: string | null }>(
    `SELECT candidate_name FROM attempts WHERE id = ${sqlText(completedId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.candidate_name, null, 'retention must scrub stale candidate names');
  assert.equal(queryLocalD1<{ payload_text: string }>(
    "SELECT payload_text FROM telegram_outbox WHERE id = 'outbox-completed'",
    current.persistPath,
    current.localD1,
  )[0]?.payload_text, '', 'retention must scrub delivered payload text after 24 hours');

  const beforeDryRun = await runRetention({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    argv: ['--before', '2026-08-28'],
    nowMs: now,
    checkServer: false,
    log: () => undefined,
  });
  assert.equal(beforeDryRun.applied, false);
  assert.equal(beforeDryRun.counts.attempts, 1);
  assert.equal(beforeDryRun.counts.reviews, 1);
  assert.equal(countRows(current, 'attempts'), 3, 'manual before dry-run must not mutate rows');

  await assert.rejects(
    runRetention({
      workspaceRoot: current.workspaceRoot,
      configPath: current.configPath,
      argv: ['--before', '2026-08-28', '--attempt', freshAbortedId, '--apply'],
      nowMs: now,
      checkServer: false,
      log: () => undefined,
    }),
    /either --before or --attempt/u,
  );
  assert.equal(countRows(current, 'attempts'), 3, 'invalid purge target must fail before mutation');

  const manualApply = await runRetention({
    workspaceRoot: current.workspaceRoot,
    configPath: current.configPath,
    argv: ['--attempt', freshAbortedId, '--apply'],
    nowMs: now,
    checkServer: false,
    log: () => undefined,
  });
  assert.equal(manualApply.applied, true);
  assert(manualApply.backup, 'manual purge apply must create a verified backup');
  await verifyBackup(manualApply.backup.sqlPath, current);
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attempts WHERE id = ${sqlText(freshAbortedId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.count, 0);
  assert.equal(queryLocalD1<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attempts WHERE id = ${sqlText(freshActiveId)}`,
    current.persistPath,
    current.localD1,
  )[0]?.count, 1, 'manual purge must not delete an unrelated attempt');
  assertLocalDatabaseIntegrity(current.persistPath, current.localD1);

  console.log('Ops integration tests passed.');
} finally {
  const resolvedRoot = path.resolve(integrationRoot);
  const resolvedTemp = path.resolve(tmpdir());
  assert(
    resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`)
      && path.basename(resolvedRoot).startsWith('candidate-check-ops-'),
    'refusing to clean up a path outside the dedicated temporary test root',
  );
  await rm(resolvedRoot, { recursive: true, force: true });
}
