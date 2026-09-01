import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';
import {
  GENERAL_TOPIC_PLAN,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_CONFIG_JSON,
  TEST_PROFILE_ID,
  type Difficulty,
} from '../lib/test-config.ts';
import {
  clearDemoCandidates,
  DEMO_CANDIDATE_KEY_PREFIX,
  DEMO_TARGET_SQL_PREDICATE,
  parseDemoCliArguments,
  replaceDemoCandidates,
} from './demo-candidates.ts';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const REVISION = 'd'.repeat(64);
const TOPICS = Object.keys(GENERAL_TOPIC_PLAN);
const RENAMED_TOPIC = 'Сети и маршрутизация';
const CLEANUP_NEAR_MISS_IDS = [
  'near-miss-name',
  'near-miss-alias',
  'near-miss-uppercase-key',
  'near-miss-short-key',
  'near-miss-prefix',
] as const;

function displayTopic(selectionTopic: string) {
  return selectionTopic === TOPICS[0] ? RENAMED_TOPIC : selectionTopic;
}

function migrationStatements(sql: string) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigrations(db: D1Database) {
  const directory = new URL('../drizzle/', import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), 'utf8');
    await db.batch(migrationStatements(migration).map((statement) => db.prepare(statement)));
  }
}

async function seedQuestionBank(db: D1Database) {
  const categories = TOPICS.map((topic, index) => ({
    id: index + 1,
    name: displayTopic(topic),
    normalizedName: displayTopic(topic).toLocaleLowerCase('ru-RU'),
    selectionKey: topic,
  }));
  const perDifficulty: Record<Difficulty, number> = {
    easy: 12,
    medium: 12,
    hard: 12,
    expert: 8,
  };
  let nextId = 10_000;
  const questions = Object.entries(perDifficulty).flatMap(([difficulty, count]) => (
    Array.from({ length: count }, (_, index) => {
      const selectionTopic = TOPICS[index % TOPICS.length];
      nextId += 1;
      return {
        id: nextId,
        categoryId: TOPICS.indexOf(selectionTopic) + 1,
        difficulty,
        topic: displayTopic(selectionTopic),
        prompt: `Synthetic fixture question ${nextId}`,
        choicesJson: JSON.stringify(['A', 'B', 'C', 'D']),
        correctIndex: index % 4,
        weight: TEST_CONFIG.weights[difficulty as Difficulty],
        dedupeKey: `synthetic-fixture-${nextId}`,
      };
    })
  ));
  await db.batch([
    db.prepare(`INSERT INTO question_categories (
        id, name, normalized_name, selection_key, active, created_at, updated_at
      ) SELECT json_extract(value, '$.id'), json_extract(value, '$.name'),
        json_extract(value, '$.normalizedName'), json_extract(value, '$.selectionKey'),
        1, ?, ? FROM json_each(?)`)
      .bind(NOW, NOW, JSON.stringify(categories)),
    db.prepare(`INSERT INTO questions (
        id, category_id, difficulty, topic, prompt, context_type, context_text,
        choices_json, correct_index, weight, active, content_hash, dedupe_key
      ) SELECT json_extract(value, '$.id'), json_extract(value, '$.categoryId'),
        json_extract(value, '$.difficulty'), json_extract(value, '$.topic'),
        json_extract(value, '$.prompt'), NULL, NULL, json_extract(value, '$.choicesJson'),
        json_extract(value, '$.correctIndex'), json_extract(value, '$.weight'),
        1, NULL, json_extract(value, '$.dedupeKey') FROM json_each(?)`)
      .bind(JSON.stringify(questions)),
    db.prepare(`INSERT INTO question_bank_revisions (
        hash, applied_at, total_count, active_count, pools_json
      ) VALUES (?, ?, ?, ?, ?)`)
      .bind(REVISION, NOW, questions.length, questions.length, '{}'),
    db.prepare(`INSERT INTO question_bank_revision_items (revision_hash, question_id, active)
      SELECT ?, json_extract(value, '$.id'), 1 FROM json_each(?)`)
      .bind(REVISION, JSON.stringify(questions)),
    db.prepare(`INSERT INTO question_bank_state (id, current_revision, updated_at)
      VALUES (1, ?, ?)`).bind(REVISION, NOW),
    db.prepare(`INSERT INTO test_config_versions (id, scoring_version, config_json, created_at)
      VALUES (?, ?, ?, ?)`).bind(
      TEST_CONFIG_ID,
      SCORING_VERSION,
      TEST_CONFIG_JSON,
      NOW,
    ),
  ]);
}

async function insertUnrelatedAttempt(db: D1Database) {
  await db.prepare(`INSERT INTO attempts (
      id, token_hash, start_key, candidate_name, candidate_key, public_alias, bank_revision,
      scoring_version, app_version, test_config_id, test_profile_id, analytics_facts_version,
      selection_version, selection_strategy, status, started_at, total_deadline_at,
      current_question_started_at, question_deadline_at, current_question_id,
      pending_question_ids, asked_question_ids, base_question_ids, base_max_score
    ) VALUES (
      'unrelated-attempt', ?, NULL, NULL, 'unrelated-candidate', 'Не demo', ?,
      ?, '1.4.0', ?, ?, 1, 1, 'random-difficulty-quota-v1',
      'active', ?, ?, ?, ?, NULL, '[]', '[]', '[]', 0
    )`).bind(
    'a'.repeat(64),
    REVISION,
    SCORING_VERSION,
    TEST_CONFIG_ID,
    TEST_PROFILE_ID,
    NOW,
    NOW + TEST_CONFIG.totalTimeSeconds * 1_000,
    NOW,
    NOW + TEST_CONFIG.questionTimeSeconds * 1_000,
  ).run();
}

async function insertCleanupNearMisses(db: D1Database) {
  const records = [
    {
      id: CLEANUP_NEAR_MISS_IDS[0],
      candidateName: 'Не удалять',
      candidateKey: `${DEMO_CANDIDATE_KEY_PREFIX}${'1'.repeat(64)}`,
      publicAlias: 'Демо-кандидат 901',
    },
    {
      id: CLEANUP_NEAR_MISS_IDS[1],
      candidateName: null,
      candidateKey: `${DEMO_CANDIDATE_KEY_PREFIX}${'2'.repeat(64)}`,
      publicAlias: 'Контрольная запись',
    },
    {
      id: CLEANUP_NEAR_MISS_IDS[2],
      candidateName: null,
      candidateKey: `${DEMO_CANDIDATE_KEY_PREFIX}${'A'.repeat(64)}`,
      publicAlias: 'Демо-кандидат 902',
    },
    {
      id: CLEANUP_NEAR_MISS_IDS[3],
      candidateName: null,
      candidateKey: `${DEMO_CANDIDATE_KEY_PREFIX}${'3'.repeat(63)}`,
      publicAlias: 'Демо-кандидат 903',
    },
    {
      id: CLEANUP_NEAR_MISS_IDS[4],
      candidateName: null,
      candidateKey: `real:v1:${'4'.repeat(64)}`,
      publicAlias: 'Демо-кандидат 904',
    },
  ];
  await db.batch([
    db.prepare(`INSERT INTO attempts (
        id, token_hash, start_key, candidate_name, candidate_key, public_alias, bank_revision,
        scoring_version, app_version, test_config_id, test_profile_id, analytics_facts_version,
        selection_version, selection_strategy, status, started_at, total_deadline_at,
        current_question_started_at, question_deadline_at, current_question_id,
        pending_question_ids, asked_question_ids, base_question_ids, base_max_score
      ) SELECT json_extract(value, '$.id'), ?, NULL,
        json_extract(value, '$.candidateName'), json_extract(value, '$.candidateKey'),
        json_extract(value, '$.publicAlias'), ?, ?, '1.4.0', ?, ?, 0, 1,
        'random-difficulty-quota-v1', 'active', ?, ?, ?, ?, NULL, '[]', '[]', '[]', 0
      FROM json_each(?)`).bind(
      'b'.repeat(64),
      REVISION,
      SCORING_VERSION,
      TEST_CONFIG_ID,
      TEST_PROFILE_ID,
      NOW,
      NOW + TEST_CONFIG.totalTimeSeconds * 1_000,
      NOW,
      NOW + TEST_CONFIG.questionTimeSeconds * 1_000,
      JSON.stringify(records),
    ),
    db.prepare(`INSERT INTO telegram_outbox (
        id, attempt_id, question_id, event_type, payload_text, next_attempt_at, created_at
      ) SELECT 'outbox-' || json_extract(value, '$.id'), json_extract(value, '$.id'),
        NULL, 'summary', 'near-miss', ?, ? FROM json_each(?)`)
      .bind(NOW, NOW, JSON.stringify(records)),
  ]);
}

async function assertCleanupNearMissesPreserved(db: D1Database) {
  const attempts = await db.prepare(`SELECT COUNT(*) AS count FROM attempts
    WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(CLEANUP_NEAR_MISS_IDS))
    .first<{ count: number }>();
  const outbox = await db.prepare(`SELECT COUNT(*) AS count FROM telegram_outbox
    WHERE attempt_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(CLEANUP_NEAR_MISS_IDS))
    .first<{ count: number }>();
  assert.equal(attempts?.count, CLEANUP_NEAR_MISS_IDS.length);
  assert.equal(outbox?.count, CLEANUP_NEAR_MISS_IDS.length);
}

async function deterministicSnapshot(db: D1Database) {
  const attempts = await db.prepare(`SELECT id, candidate_key, started_at, completed_at,
      score, correct_count, wrong_count, verdict, duration_seconds, base_question_ids
    FROM attempts WHERE ${DEMO_TARGET_SQL_PREDICATE} ORDER BY id`)
    .all();
  const answers = await db.prepare(`SELECT answers.attempt_id, answers.question_id,
      answers.selected_index, answers.is_correct, answers.answered_at,
      answers.elapsed_seconds, answers.timed_out, answers.answer_origin,
      answers.canonical_selected_index, answers.awarded_score
    FROM answers JOIN attempts ON attempts.id = answers.attempt_id
    WHERE ${DEMO_TARGET_SQL_PREDICATE}
    ORDER BY answers.attempt_id, answers.question_id`)
    .all();
  return { attempts: attempts.results, answers: answers.results };
}

assert.deepEqual(parseDemoCliArguments([]), { clear: false });
assert.deepEqual(parseDemoCliArguments(['--count', '12', '--seed', 'fixture']), {
  clear: false,
  count: 12,
  seed: 'fixture',
});
assert.deepEqual(parseDemoCliArguments(['--clear']), { clear: true });
assert.throws(() => parseDemoCliArguments(['--count', '0']), /--count/u);
assert.throws(() => parseDemoCliArguments(['--clear', '--seed', 'x']), /cannot be combined/u);
assert.throws(() => parseDemoCliArguments(['--unknown']), /Unknown argument/u);

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});

try {
  const db = await miniflare.getD1Database('DB');
  await applyMigrations(db);
  await seedQuestionBank(db);
  await insertUnrelatedAttempt(db);
  await insertCleanupNearMisses(db);

  const first = await replaceDemoCandidates(db, {
    count: 50,
    seed: 'repeatable-fixture',
    nowMs: NOW,
  });
  assert.equal(first.candidates, 50);
  assert.equal(first.baseAnswers, 1_000);
  assert.ok(first.additionalAnswers > 0);
  assert.ok(first.additionalAnswers <= 500);
  assert.equal(first.coverageScore, 100);
  assert.equal(first.baseQuestionIds.length, 20);
  assert.ok(first.verdicts.PASS > 0);
  assert.ok(first.verdicts.REVIEW > 0);
  assert.ok(first.verdicts.FAIL > 0);
  await assertCleanupNearMissesPreserved(db);

  const exactIntegrity = await db.prepare(ANALYTICS_FACTS_INTEGRITY_QUERY)
    .first<{ violations: number }>();
  assert.equal(exactIntegrity?.violations, 0);
  const outbox = await db.prepare(`SELECT COUNT(*) AS count FROM telegram_outbox
    WHERE attempt_id IN (
      SELECT id FROM attempts WHERE ${DEMO_TARGET_SQL_PREDICATE}
    )`).first<{ count: number }>();
  assert.equal(outbox?.count, 0);

  const baseSamples = await db.prepare(`SELECT aq.question_id, COUNT(*) AS sample
    FROM attempt_questions aq
    JOIN attempts ON attempts.id = aq.attempt_id
    JOIN answers ON answers.attempt_id = aq.attempt_id
      AND answers.question_id = aq.question_id
    WHERE substr(attempts.candidate_key, 1, 8) = ? AND aq.question_kind = 'base'
    GROUP BY aq.question_id ORDER BY aq.question_id`)
    .bind(DEMO_CANDIDATE_KEY_PREFIX)
    .all<{ question_id: number; sample: number }>();
  assert.equal(baseSamples.results.length, 20);
  assert.ok(baseSamples.results.every((row) => row.sample === 50));

  const difficultyPlan = await db.prepare(`SELECT questions.difficulty, COUNT(*) AS count
    FROM questions WHERE id IN (${first.baseQuestionIds.map(() => '?').join(',')})
    GROUP BY questions.difficulty ORDER BY questions.difficulty`)
    .bind(...first.baseQuestionIds)
    .all<{ difficulty: Difficulty; count: number }>();
  assert.deepEqual(
    Object.fromEntries(difficultyPlan.results.map((row) => [row.difficulty, row.count])),
    { easy: 5, expert: 1, hard: 7, medium: 7 },
  );
  const topicPlan = await db.prepare(`SELECT questions.topic, COUNT(*) AS count
    FROM questions WHERE id IN (${first.baseQuestionIds.map(() => '?').join(',')})
    GROUP BY questions.topic ORDER BY questions.topic`)
    .bind(...first.baseQuestionIds)
    .all<{ topic: string; count: number }>();
  assert.deepEqual(
    Object.fromEntries(topicPlan.results.map((row) => [row.topic, row.count])),
    Object.fromEntries(Object.entries(GENERAL_TOPIC_PLAN).map(([topic, count]) => [
      displayTopic(topic),
      count,
    ])),
  );

  const aggregateState = await db.prepare(`SELECT generation, built_generation
    FROM analytics_refresh_state WHERE id = 1`)
    .first<{ generation: number; built_generation: number }>();
  assert.equal(aggregateState?.generation, aggregateState?.built_generation);
  const latestCandidates = await db.prepare(`SELECT COUNT(*) AS count
    FROM analytics_candidate_aggregates
    WHERE policy = 'latest' AND substr(candidate_key, 1, 8) = ?`)
    .bind(DEMO_CANDIDATE_KEY_PREFIX)
    .first<{ count: number }>();
  assert.equal(latestCandidates?.count, 50);
  const aggregateQuestionSamples = await db.prepare(`SELECT question_id,
      SUM(outcome_count) AS sample
    FROM analytics_daily_question_aggregates
    WHERE policy = 'latest' AND question_kind = 'base'
      AND question_id IN (${first.baseQuestionIds.map(() => '?').join(',')})
    GROUP BY question_id`)
    .bind(...first.baseQuestionIds)
    .all<{ question_id: number; sample: number }>();
  assert.equal(aggregateQuestionSamples.results.length, 20);
  assert.ok(aggregateQuestionSamples.results.every((row) => row.sample === 50));

  const snapshot = await deterministicSnapshot(db);
  const repeated = await replaceDemoCandidates(db, {
    count: 50,
    seed: 'repeatable-fixture',
    nowMs: NOW,
  });
  assert.equal(repeated.replacedCandidates, 50);
  assert.deepEqual(await deterministicSnapshot(db), snapshot);

  const resized = await replaceDemoCandidates(db, {
    count: 12,
    seed: 'different-fixture',
    nowMs: NOW,
  });
  assert.equal(resized.candidates, 12);
  assert.equal(resized.replacedCandidates, 50);
  const demoCount = await db.prepare(`SELECT COUNT(*) AS count FROM attempts
    WHERE ${DEMO_TARGET_SQL_PREDICATE}`)
    .first<{ count: number }>();
  assert.equal(demoCount?.count, 12);

  const maximum = await replaceDemoCandidates(db, {
    count: 500,
    seed: 'maximum-boundary-fixture',
    nowMs: NOW,
  });
  assert.equal(maximum.candidates, 500);
  const latestDemoCompletion = await db.prepare(`SELECT MAX(completed_at) AS completed_at
    FROM attempts WHERE ${DEMO_TARGET_SQL_PREDICATE}`)
    .first<{ completed_at: number }>();
  assert.ok((latestDemoCompletion?.completed_at ?? Number.POSITIVE_INFINITY) <= NOW);

  const cleared = await clearDemoCandidates(db);
  assert.equal(cleared.removedCandidates, 500);
  await assertCleanupNearMissesPreserved(db);
  assert.equal((await clearDemoCandidates(db)).removedCandidates, 0);
  const unrelated = await db.prepare(`SELECT status FROM attempts
    WHERE id = 'unrelated-attempt'`).first<{ status: string }>();
  assert.equal(unrelated?.status, 'active');
  const remainingDemo = await db.prepare(`SELECT COUNT(*) AS count FROM attempts
    WHERE ${DEMO_TARGET_SQL_PREDICATE}`)
    .first<{ count: number }>();
  assert.equal(remainingDemo?.count, 0);
} finally {
  await miniflare.dispose();
}

console.log('Demo candidate seed tests passed.');
