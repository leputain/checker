import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Miniflare } from './miniflare-runtime.ts';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';
import {
  LEGACY_V2_TEST_CONFIG_ID, LEGACY_V2_TEST_CONFIG_JSON,
  TEST_CONFIG_ID, TEST_CONFIG_JSON, TEST_CONFIG, type Difficulty,
} from '../lib/test-config.ts';
import {
  SECURITY_CHALLENGE_CONFIG_ID, SECURITY_CHALLENGE_CONFIG_JSON,
} from '../lib/security-challenge-config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, '.data', 'security-upgrade', 'baseline-runtime');
const targetRequire = createRequire(path.join(ROOT, 'package.json'));
const targetVersion = (targetRequire('miniflare/package.json') as { version: string }).version;
assert.equal(targetVersion, '5.20261006.1-alpha', 'Persistence acceptance requires the reviewed exact Miniflare target.');
const SCRIPT = 'export default { fetch() { return new Response("synthetic persistence fixture") } }';
const NOW = Date.parse('2026-05-15T12:00:00Z');
const REVISION = createHash('sha256').update('synthetic-persistence-bank').digest('hex');
const BASE_IDS = Array.from({ length: 20 }, (_, index) => index + 1);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Runtime = { getD1Database(name: string): Promise<D1Database>; dispose(): Promise<void> };
type Manifest = {
  formatVersion: number;
  groups: Record<string, { tables: Record<string, { count: number; sha256: string }>;
    count: number; sha256: string; schemaSha256: string }>;
};

async function insert(db: D1Database, table: string, values: Record<string, string | number | null>) {
  const columns = Object.keys(values);
  assert.ok([table, ...columns].every((value) => /^[a-z_]+$/u.test(value)));
  await db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .bind(...Object.values(values)).run();
}

async function migrate(db: D1Database) {
  const directory = path.join(ROOT, 'drizzle');
  for (const filename of (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const sql = await readFile(path.join(directory, filename), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  await db.prepare('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)').run();
  for (let version = 1; version <= 19; version += 1) {
    await insert(db, 'schema_migrations', { version, name: `synthetic-managed-${version}`, applied_at: NOW });
  }
}

async function seed(db: D1Database) {
  await insert(db, 'question_categories', { id: 1, name: 'Synthetic topic', normalized_name: 'synthetic topic',
    selection_key: 'Synthetic topic', active: 1, created_at: NOW, updated_at: NOW });
  const difficulties = Object.entries(TEST_CONFIG.plan).flatMap(([difficulty, count]) => (
    Array.from({ length: count }, () => difficulty as Difficulty)
  ));
  difficulties.push('medium', 'medium', 'medium', 'medium', 'medium', 'easy');
  for (const [index, difficulty] of difficulties.entries()) {
    const id = index + 1;
    await insert(db, 'questions', { id, category_id: 1, difficulty, topic: 'Synthetic topic',
      prompt: `Synthetic question ${id}`, context_type: 'code', context_text: 'fixture-only UTF-8: тест',
      choices_json: '["correct synthetic answer","wrong synthetic answer"]', correct_index: 0,
      weight: TEST_CONFIG.weights[difficulty], active: 1, content_hash: hash(`question:${id}`),
      dedupe_key: `synthetic-question-${id}` });
  }
  await insert(db, 'question_bank_revisions', { hash: REVISION, applied_at: NOW,
    total_count: 26, active_count: 26, pools_json: '{"fixture":true}' });
  for (let questionId = 1; questionId <= 26; questionId += 1) {
    await insert(db, 'question_bank_revision_items', { revision_hash: REVISION, question_id: questionId, active: 1 });
  }
  await insert(db, 'question_bank_state', { id: 1, current_revision: REVISION, updated_at: NOW });
  for (const [version, id, json] of [[2, LEGACY_V2_TEST_CONFIG_ID, LEGACY_V2_TEST_CONFIG_JSON],
    [3, TEST_CONFIG_ID, TEST_CONFIG_JSON]] as const) {
    await insert(db, 'test_config_versions', { id, scoring_version: version, config_json: json, created_at: NOW });
  }

  for (const version of [2, 3]) {
    for (const completed of [false, true]) {
      const id = `synthetic-v${version}-${completed ? 'completed' : 'active'}`;
      const additionalIds = completed ? [21, 22, 23, 24, 25] : [26];
      await insert(db, 'attempts', {
        id, token_hash: hash(`token:${id}`), start_key: `synthetic-start-${id}`,
        candidate_name: 'Synthetic candidate', candidate_key: hash(`candidate:${id}`), public_alias: 'Synthetic alias',
        bank_revision: REVISION, scoring_version: version, app_version: '1.7.0',
        test_config_id: version === 2 ? LEGACY_V2_TEST_CONFIG_ID : TEST_CONFIG_ID,
        test_profile_id: 'general-v1', analytics_facts_version: 1, selection_version: 1,
        selection_strategy: 'random-difficulty-quota-v1', coverage_score: 0.75, shadow_coverage_score: null,
        status: completed ? 'completed' : 'active', started_at: NOW, total_deadline_at: NOW + 600_000,
        current_question_started_at: completed ? 0 : NOW + 2_000,
        question_deadline_at: completed ? NOW + 60_000 : NOW + 32_000,
        current_question_id: completed ? null : 2,
        pending_question_ids: JSON.stringify(completed ? [] : [...BASE_IDS.slice(2), 26]),
        asked_question_ids: JSON.stringify(completed ? [...BASE_IDS, ...additionalIds] : [1, 2]),
        base_question_ids: JSON.stringify(BASE_IDS), base_max_score: 100,
        score: completed ? version === 2 ? 90 : 80 : 0,
        correct_count: completed ? 20 : 0, wrong_count: completed ? 5 : 1,
        verdict: completed ? version === 2 ? 'PASS' : 'REVIEW' : null,
        completed_at: completed ? NOW + 60_000 : null, duration_seconds: completed ? 60 : null,
      });
      for (const questionId of [...BASE_IDS, ...additionalIds]) {
        const base = questionId <= 20;
        const difficulty = difficulties[questionId - 1];
        const value = TEST_CONFIG.weights[difficulty] * (base ? 2 : 1);
        const wrong = completed ? base && questionId >= 6 && questionId <= 10 : questionId === 1;
        const presented = completed || questionId <= 2;
        await insert(db, 'attempt_questions', { attempt_id: id, question_id: questionId,
          question_kind: base ? 'base' : 'additional', ordinal: base ? questionId : 21 + additionalIds.indexOf(questionId),
          source_question_id: base ? null : completed ? 6 + additionalIds.indexOf(questionId) : 1,
          score_value: value, assigned_at: NOW, presented_at: presented ? NOW + questionId * 1_000 : null });
        if (completed || questionId === 1) {
          await insert(db, 'answers', { attempt_id: id, question_id: questionId, selected_index: wrong ? 1 : 0,
            is_correct: wrong ? 0 : 1, answered_at: NOW + questionId * 1_000 + 500, elapsed_seconds: 1,
            timed_out: 0, fact_version: 1, answer_origin: 'submitted', canonical_selected_index: wrong ? 1 : 0,
            awarded_score: wrong ? 0 : value,
            penalty_score: wrong && version === 3 ? value / (base ? 2 : 1) : 0 });
        }
      }
    }
  }
  await insert(db, 'security_challenge_configs', { id: SECURITY_CHALLENGE_CONFIG_ID, scoring_version: 1,
    config_json: SECURITY_CHALLENGE_CONFIG_JSON, created_at: NOW });
  for (const completed of [false, true]) {
    const id = `synthetic-challenge-${completed ? 'completed' : 'active'}`;
    await insert(db, 'security_challenge_attempts', { id, token_hash: hash(`token:${id}`), start_key: `start:${id}`,
      nickname: 'Synthetic challenger', normalized_nickname: 'synthetic challenger', participant_key: hash(id),
      config_id: SECURITY_CHALLENGE_CONFIG_ID, scoring_version: 1, bank_revision: REVISION, pool_revision: REVISION,
      pool_question_ids: '[1,2]', status: completed ? 'completed' : 'active', completion_reason: completed ? 'manual' : null,
      started_at: NOW, total_deadline_at: NOW + 900_000, current_question_started_at: NOW,
      question_deadline_at: NOW + 60_000, current_question_id: completed ? null : 1, current_ordinal: 1,
      score_units: completed ? 300 : 0, correct_count: completed ? 1 : 0, incorrect_count: 0, timeout_count: 0,
      completed_at: completed ? NOW + 5_000 : null, duration_seconds: completed ? 5 : null });
    await insert(db, 'security_challenge_question_events', { id: completed ? 4002 : 4001, attempt_id: id,
      question_id: 1, ordinal: 1, difficulty: 'easy', choice_order_json: '[0,1]',
      selected_index: completed ? 0 : null, canonical_selected_index: completed ? 0 : null,
      outcome: completed ? 'correct' : 'pending', score_delta_units: completed ? 300 : 0,
      presented_at: NOW, resolved_at: completed ? NOW + 5_000 : null, elapsed_seconds: completed ? 5 : null });
  }
  await insert(db, 'security_challenge_feedback', { id: 'synthetic-feedback',
    attempt_id: 'synthetic-challenge-completed', question_event_id: 4002,
    participant_key: hash('synthetic-challenge-completed'), comment: 'Synthetic UTF-8 feedback: тест',
    status: 'open', resolution_note: null, created_at: NOW + 6_000, resolved_at: null,
    admin_session_fingerprint: null });
  for (const status of ['pending', 'sending']) {
    await insert(db, 'telegram_outbox', { id: `synthetic-outbox-${status}`, attempt_id: 'synthetic-v3-active',
      question_id: status === 'pending' ? 1 : 2, event_type: 'answer', payload_text: '<b>synthetic</b> payload\nтест',
      delivery_method: 'reply_root', parse_mode: 'HTML', silent: 1, status, attempt_count: status === 'sending' ? 1 : 0,
      next_attempt_at: NOW, lease_token: status === 'sending' ? 'synthetic-lease' : null,
      lease_until: status === 'sending' ? NOW + 120_000 : null, telegram_message_id: null,
      last_error_code: null, created_at: NOW, sent_at: null });
  }
  await insert(db, 'telegram_delivery_state', { id: 1, config_fingerprint: hash('synthetic-config'),
    status: 'ready', error_code: null, updated_at: NOW });
  await insert(db, 'question_bank_change_sets', { id: 'synthetic-draft', title: 'Synthetic draft',
    note: 'Synthetic note', status: 'draft', base_revision: REVISION, published_revision: null,
    created_at: NOW, updated_at: NOW, published_at: null, admin_session_fingerprint: hash('synthetic-admin') });
  await insert(db, 'question_bank_change_set_items', { change_set_id: 'synthetic-draft', question_id: 1,
    patch_json: '{"prompt":"Synthetic edited question"}', created_at: NOW });
  await insert(db, 'question_bank_mutations', { idempotency_key: 'synthetic-mutation', operation: 'fixture',
    expected_revision: REVISION, request_hash: hash('synthetic-request'), response_json: '{"fixture":true}', created_at: NOW });
  await insert(db, 'question_bank_change_events', { event_type: 'created', question_id: 1,
    bank_revision: REVISION, created_at: NOW, note: 'Synthetic event', admin_session_fingerprint: null });
  await insert(db, 'question_version_links', { predecessor_question_id: 1, successor_question_id: 2,
    bank_revision: REVISION, created_at: NOW, admin_session_fingerprint: null });
  await insert(db, 'question_review_history', { question_id: 1, bank_revision: REVISION,
    decision: 'keep', note: 'Synthetic review', created_at: NOW, admin_session_fingerprint: null });
  await db.prepare('UPDATE analytics_refresh_state SET generation = 2, built_generation = 1, updated_at = ? WHERE id = 1').bind(NOW).run();
  await insert(db, 'analytics_report_aggregates', { cache_key: 'synthetic-cache', report_type: 'overview',
    generation: 1, period_from: null, period_to: null, payload_json: '{"fixture":true}', generated_at: NOW });
}

async function assertRepresentativeState(db: D1Database, postCutover = false) {
  assert.deepEqual((await db.prepare('SELECT scoring_version, status, score, verdict FROM attempts ORDER BY id').all()).results, [
    { scoring_version: 2, status: 'active', score: 0, verdict: null },
    { scoring_version: 2, status: 'completed', score: 90, verdict: 'PASS' },
    { scoring_version: 3, status: 'active', score: 0, verdict: null },
    { scoring_version: 3, status: 'completed', score: 80, verdict: 'REVIEW' },
  ]);
  assert.equal((await db.prepare(ANALYTICS_FACTS_INTEGRITY_QUERY).first<{ violations: number }>())?.violations, 0);
  assert.equal((await db.prepare('SELECT MAX(version) AS version FROM schema_migrations').first<{ version: number }>())?.version, 19);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM security_challenge_attempts').first<{ count: number }>())?.count, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM telegram_outbox WHERE status IN ('pending','sending')").first<{ count: number }>())?.count, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM question_bank_change_sets WHERE status = 'draft'").first<{ count: number }>())?.count, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM security_challenge_feedback').first<{ count: number }>())?.count, postCutover ? 2 : 1);
}

async function sqlitePath(state: string) {
  const candidates: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      // The newer workerd adds this separate vendor metadata DB. It is not the
      // application D1, and its appearance must not change the app locator.
      else if (entry.name === 'metadata.sqlite') continue;
      else if (entry.name.endsWith('.sqlite')) candidates.push(filename);
    }
  };
  await visit(path.join(state, 'v3', 'd1'));
  assert.equal(candidates.length, 1, 'Both toolchains must address one canonical D1 file.');
  return candidates[0];
}

function captureManifest(databasePath: string): Manifest {
  const result = spawnSync(process.env.CANDIDATE_CHECK_PYTHON ?? 'python', [
    '-B', path.join(ROOT, 'scripts', 'sqlite-business-manifest.py'), 'capture', databasePath,
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'Synthetic manifest capture must succeed.');
  return JSON.parse(result.stdout) as Manifest;
}

function assertPreserved(before: Manifest, after: Manifest) {
  for (const group of ['business', 'derived', 'runtime']) {
    assert.deepEqual(after.groups[group], before.groups[group], `${group} fingerprints must match.`);
  }
  assert.equal(Object.keys(after.groups.business.tables).length, 21);
  assert.equal(Object.keys(after.groups.derived.tables).length, 7);
  assert.equal(Object.keys(after.groups.runtime.tables).length, 1);
}

const baselineRequire = createRequire(path.join(BASELINE, 'package.json'));
const { Miniflare: BaselineMiniflare } = baselineRequire('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => Runtime;
};
async function checkedFixturePath(state: string) {
  const absoluteState = await realpath(state);
  const absoluteTemp = await realpath(os.tmpdir());
  const relative = path.relative(absoluteTemp, absoluteState);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.basename(absoluteState).startsWith('candidate-toolchain-persistence-'), 'Refuse non-fixture state.');
  return absoluteState;
}

async function phase(phaseName: string, state: string, databaseId: string) {
  await checkedFixturePath(state);
  assert.match(databaseId, /^[0-9a-f-]{36}$/iu);
  assert.ok(['old-seed', 'new-read', 'new-write', 'old-read', 'old-initialize', 'new-initialize', 'new-reopen'].includes(phaseName));
  const common = { modules: true, script: SCRIPT, d1Databases: { DB: databaseId }, compatibilityDate: '2026-05-15' };
  const runtime: Runtime = phaseName.startsWith('old-')
    ? new BaselineMiniflare({ ...common, d1Persist: path.join(state, 'v3', 'd1') })
    : new Miniflare({ ...common, resourcePersistencePath: path.join(state, 'v3') });
  try {
    const db = await runtime.getD1Database('DB');
    if (phaseName.endsWith('-initialize')) {
      await db.prepare('SELECT 1').first();
      return;
    }
    if (phaseName === 'old-seed') {
      await migrate(db);
      await seed(db);
    }
    await assertRepresentativeState(db, phaseName === 'old-read' || phaseName === 'new-reopen');
    if (phaseName === 'new-read') {
      // A replay cannot overwrite an existing answer or its retained penalty.
      await db.prepare(`INSERT OR IGNORE INTO answers (attempt_id, question_id, selected_index,
        is_correct, answered_at, elapsed_seconds, timed_out, fact_version, answer_origin,
        canonical_selected_index, awarded_score, penalty_score)
        VALUES ('synthetic-v3-active', 1, 0, 1, ?, 1, 0, 1, 'submitted', 0, 2, 0)`).bind(NOW).run();
    } else if (phaseName === 'new-write') {
      await db.prepare("UPDATE security_challenge_feedback SET resolution_note = 'synthetic post-cutover resolution' WHERE id = 'synthetic-feedback'").run();
      await insert(db, 'security_challenge_feedback', { id: 'synthetic-new-feedback',
        attempt_id: 'synthetic-challenge-active', question_event_id: 4001,
        participant_key: hash('synthetic-challenge-active'), comment: 'Synthetic post-cutover feedback',
        status: 'open', created_at: NOW + 7_000 });
    } else if (phaseName === 'old-read') {
      assert.equal((await db.prepare("SELECT resolution_note FROM security_challenge_feedback WHERE id = 'synthetic-feedback'").first<{ resolution_note: string }>())?.resolution_note,
        'synthetic post-cutover resolution');
    }
  } finally {
    await runtime.dispose();
  }
}

function runPhase(phaseName: string, state: string, databaseId: string, allowRuntimeFailure = false) {
  // Different releases run as different processes in deployment. Separating
  // phases also rules out cross-version SDK globals as an explanation of failure.
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url),
    '--phase', phaseName, state, databaseId], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    if (allowRuntimeFailure && result.stderr.includes('ERR_RUNTIME_FAILURE')) return false;
    process.stderr.write(result.stderr);
    throw new Error(`Synthetic persistence phase failed: ${phaseName}`);
  }
  return true;
}

function exportPrivateSql(databasePath: string, outputPath: string): Manifest {
  const result = spawnSync(process.env.CANDIDATE_CHECK_PYTHON ?? 'python', [
    '-B', path.join(ROOT, 'scripts', 'sqlite-business-manifest.py'), 'export', databasePath, outputPath,
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'Synthetic private SQL export must succeed.');
  return JSON.parse(result.stdout) as Manifest;
}

async function importSyntheticSql(state: string, sqlFile: string) {
  await checkedFixturePath(state);
  const databasePath = await sqlitePath(state);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(await readFile(sqlFile, 'utf8'));
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0, 'Imported synthetic foreign keys must be valid.');
  } finally {
    database.close();
  }
}

async function removeClonedVendorMetadata(state: string) {
  await checkedFixturePath(state);
  const vendorDirectory = path.dirname(await sqlitePath(state));
  let removed = 0;
  for (const entry of await readdir(vendorDirectory)) {
    if (['metadata.sqlite', 'metadata.sqlite-wal', 'metadata.sqlite-shm'].includes(entry)) {
      await rm(path.join(vendorDirectory, entry), { force: true });
      removed += 1;
    }
  }
  assert.ok(removed > 0, 'Diagnostic clone must contain the reviewed vendor metadata.');
}

if (process.argv[2] === '--phase') {
  await phase(process.argv[3], process.argv[4], process.argv[5]);
} else {
  const state = await mkdtemp(path.join(os.tmpdir(), 'candidate-toolchain-persistence-'));
  const temporaryStates = [state];
  const databaseId = randomUUID();
  try {
    runPhase('old-seed', state, databaseId);
    const canonicalFile = await sqlitePath(state);
    const before = captureManifest(canonicalFile);
    runPhase('new-read', state, databaseId);
    assert.equal(await sqlitePath(state), canonicalFile);
    assertPreserved(before, captureManifest(canonicalFile));
    runPhase('new-write', state, databaseId);
    const postCutover = captureManifest(canonicalFile);
    assert.notEqual(postCutover.groups.business.sha256, before.groups.business.sha256);
    const directRollbackCompatible = runPhase('old-read', state, databaseId, true);
    assertPreserved(postCutover, captureManifest(canonicalFile));

    // Diagnose the metadata filename hypothesis on a copy, never by deleting
    // anything from the original new state. This is not the rollback procedure.
    let metadataDiagnostic = 'not-needed';
    if (!directRollbackCompatible) {
      const clone = await mkdtemp(path.join(os.tmpdir(), 'candidate-toolchain-persistence-'));
      temporaryStates.push(clone);
      await cp(state, clone, { recursive: true });
      assertPreserved(postCutover, captureManifest(await sqlitePath(clone)));
      await removeClonedVendorMetadata(clone);
      metadataDiagnostic = runPhase('old-read', clone, databaseId, true) ? 'removal-restores-old-reader' : 'removal-does-not-restore-old-reader';
      assertPreserved(postCutover, captureManifest(await sqlitePath(clone)));
    }

    // Verified rollback imports the latest data into fresh old-toolchain state.
    // The source new state and its vendor metadata stay intact.
    const sqlFile = path.join(state, 'synthetic-private-transfer.sql');
    const exported = exportPrivateSql(canonicalFile, sqlFile);
    assertPreserved(postCutover, exported);
    for (const target of ['old', 'new']) {
      const fresh = await mkdtemp(path.join(os.tmpdir(), 'candidate-toolchain-persistence-'));
      temporaryStates.push(fresh);
      runPhase(`${target}-initialize`, fresh, databaseId);
      await importSyntheticSql(fresh, sqlFile);
      const imported = captureManifest(await sqlitePath(fresh));
      assertPreserved(postCutover, imported);
      assert.deepEqual(imported.groups.internal.tables.sqlite_sequence,
        postCutover.groups.internal.tables.sqlite_sequence, 'SQL transfer preserves autoincrement high water.');
      runPhase(target === 'old' ? 'old-read' : 'new-reopen', fresh, databaseId);
      assertPreserved(postCutover, captureManifest(await sqlitePath(fresh)));
    }
    console.log(JSON.stringify({ targetMiniflare: targetVersion, directRollbackCompatible, metadataDiagnostic,
      sqlTransferToFreshOldVerified: true, sqlTransferToFreshNewVerified: true,
      preservedBusinessTables: 21, preservedDerivedTables: 7, preservedRuntimeTables: 1 }));
    // Exact reviewed target creates vendor metadata that the May runtime
    // cannot scan. Keep this negative proof; production rollback uses latest
    // SQL in fresh old state, not an old binary against newer persistence.
    assert.equal(directRollbackCompatible, false, 'Reviewed target requires the proven fresh-SQL rollback path.');
  } finally {
    for (const temporary of temporaryStates) {
      await rm(await checkedFixturePath(temporary), { recursive: true, force: true });
    }
  }
  console.log('Toolchain persistence tests passed: current SQL → fresh old and new state; 29 application tables preserved.');
}
