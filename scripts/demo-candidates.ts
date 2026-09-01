import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { calculateCoverageScore } from '../lib/balanced-selection.ts';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';
import { rebuildAnalyticsAggregates } from '../lib/analytics-aggregate-store.ts';
import {
  selectRemedialQuestion,
  selectUniqueQuestionPlan,
} from '../lib/question-selection.ts';
import { APP_RELEASE } from '../lib/release.ts';
import {
  calculateAccuracy,
  calculateVerdict,
  questionScoreValue,
} from '../lib/scoring.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BASE_QUESTION_COUNT,
  GENERAL_TOPIC_PLAN,
  LEGACY_SELECTION_STRATEGY,
  LEGACY_SELECTION_VERSION,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
  type Difficulty,
} from '../lib/test-config.ts';
import {
  readLocalD1DatabaseId,
  resolveOpsContext,
  type OpsContextOptions,
} from './ops-context.ts';
import { acquireDestructiveOperationGuard } from './runtime-lock.ts';

export const DEFAULT_DEMO_CANDIDATE_COUNT = 50;
export const DEFAULT_DEMO_SEED = 'candidate-check-v1.4-demo';
export const MAX_DEMO_CANDIDATE_COUNT = 500;
export const DEMO_CANDIDATE_KEY_PREFIX = 'demo:v1:';

const DAY_MS = 86_400_000;
const DEMO_INSERT_CHUNK_SIZE = 500;
export const DEMO_TARGET_SQL_PREDICATE = `substr(candidate_key, 1, 8) = '${DEMO_CANDIDATE_KEY_PREFIX}'
  AND length(candidate_key) = 72
  AND substr(candidate_key, 9) NOT GLOB '*[^0-9a-f]*'
  AND candidate_name IS NULL
  AND public_alias GLOB 'Демо-кандидат [0-9][0-9][0-9]'`;
const DEMO_TARGET_IDS = `SELECT id FROM attempts WHERE ${DEMO_TARGET_SQL_PREDICATE}`;

type DemoQuestion = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  analytics_topic: string;
  dedupe_key: string;
  weight: number;
  correct_index: number;
  choices_json: string;
};

type DemoAttemptInsert = {
  id: string;
  tokenHash: string;
  startKey: string;
  candidateKey: string;
  publicAlias: string;
  bankRevision: string;
  coverageScore: number;
  startedAt: number;
  totalDeadlineAt: number;
  questionDeadlineAt: number;
  askedQuestionIds: string;
  baseQuestionIds: string;
  score: number;
  correctCount: number;
  wrongCount: number;
  verdict: string;
  completedAt: number;
  durationSeconds: number;
};

type DemoLedgerInsert = {
  attemptId: string;
  questionId: number;
  questionKind: 'base' | 'additional';
  ordinal: number;
  sourceQuestionId: number | null;
  scoreValue: number;
  assignedAt: number;
  presentedAt: number;
};

type DemoAnswerInsert = {
  attemptId: string;
  questionId: number;
  selectedIndex: number | null;
  isCorrect: number;
  answeredAt: number;
  elapsedSeconds: number;
  timedOut: number;
  answerOrigin: 'submitted' | 'question_timeout';
  canonicalSelectedIndex: number | null;
  awardedScore: number;
};

type PlannedAnswer = {
  question: DemoQuestion;
  questionKind: 'base' | 'additional';
  ordinal: number;
  sourceQuestionId: number | null;
  correct: boolean;
  timedOut: boolean;
  elapsedSeconds: number;
  canonicalSelectedIndex: number | null;
};

export type DemoSeedOptions = {
  count?: number;
  seed?: string;
  nowMs?: number;
};

export type DemoSeedSummary = {
  candidates: number;
  baseAnswers: number;
  additionalAnswers: number;
  timeouts: number;
  verdicts: Record<'PASS' | 'REVIEW' | 'FAIL', number>;
  bankRevision: string;
  baseQuestionIds: number[];
  coverageScore: number;
  analyticsGeneration: number;
  replacedCandidates: number;
};

export type DemoClearSummary = {
  removedCandidates: number;
  removedAnswers: number;
  removedLedgerRows: number;
  removedOutboxRows: number;
  analyticsGeneration: number;
};

function hashHex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unitInterval(value: string) {
  const bytes = createHash('sha256').update(value).digest();
  return bytes.readUInt32BE(0) / 0x1_0000_0000;
}

function choicePermutation(attemptId: string, questionId: number, length: number) {
  let state = createHash('sha256')
    .update(`${attemptId}:${questionId}`)
    .digest()
    .readUInt32BE(0) || 1;
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

function validateCount(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DEMO_CANDIDATE_COUNT) {
    throw new Error(`--count must be an integer from 1 to ${MAX_DEMO_CANDIDATE_COUNT}.`);
  }
  return count;
}

function validateSeed(seed: string) {
  const normalized = seed.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('--seed must contain 1-128 printable characters.');
  }
  return normalized;
}

function exactPlanCounts(questions: readonly DemoQuestion[]) {
  const difficulty = new Map<string, number>();
  const topic = new Map<string, number>();
  for (const question of questions) {
    difficulty.set(question.difficulty, (difficulty.get(question.difficulty) ?? 0) + 1);
    topic.set(question.topic, (topic.get(question.topic) ?? 0) + 1);
  }
  return {
    difficulty: Object.fromEntries(difficulty),
    topic: Object.fromEntries(topic),
  };
}

function assertExactDemoPlan(questions: readonly DemoQuestion[]) {
  if (questions.length !== BASE_QUESTION_COUNT) throw new Error('demo_base_plan_size_mismatch');
  const counts = exactPlanCounts(questions);
  for (const [difficulty, expected] of Object.entries(TEST_CONFIG.plan)) {
    if ((counts.difficulty[difficulty] ?? 0) !== expected) {
      throw new Error('demo_base_plan_difficulty_mismatch');
    }
  }
  for (const [topic, expected] of Object.entries(GENERAL_TOPIC_PLAN)) {
    if ((counts.topic[topic] ?? 0) !== expected) throw new Error('demo_base_plan_topic_mismatch');
  }
  const baseMaxScore = questions.reduce(
    (total, question) => total + questionScoreValue(question.weight, 'base'),
    0,
  );
  if (baseMaxScore !== 100) throw new Error('demo_base_plan_score_mismatch');
}

async function currentQuestionPool(db: D1Database) {
  const state = await db.prepare(`SELECT state.current_revision
      FROM question_bank_state state
      JOIN test_config_versions config ON config.id = ?
        AND config.scoring_version = ?
      WHERE state.id = 1`)
    .bind(TEST_CONFIG_ID, SCORING_VERSION)
    .first<{ current_revision: string }>();
  if (!state?.current_revision) throw new Error('demo_question_bank_not_ready');
  const rows = await db.prepare(`SELECT questions.id, questions.difficulty,
      category.selection_key AS topic, questions.topic AS analytics_topic,
      questions.dedupe_key, questions.weight, questions.correct_index,
      questions.choices_json
    FROM questions
    JOIN question_bank_revision_items membership ON membership.question_id = questions.id
    JOIN question_categories category ON category.id = questions.category_id
    WHERE membership.revision_hash = ? AND membership.active = 1
      AND category.active = 1
    ORDER BY questions.id`)
    .bind(state.current_revision)
    .all<DemoQuestion>();
  if (rows.results.length === 0) throw new Error('demo_question_pool_empty');
  for (const question of rows.results) {
    const choices = JSON.parse(question.choices_json) as unknown;
    if (
      !Array.isArray(choices)
      || choices.length < 2
      || !Number.isInteger(question.correct_index)
      || question.correct_index < 0
      || question.correct_index >= choices.length
      || question.weight !== TEST_CONFIG.weights[question.difficulty]
      || !question.topic
      || !question.analytics_topic
    ) {
      throw new Error(`demo_question_contract_invalid:${question.id}`);
    }
  }
  return { revision: state.current_revision, questions: rows.results };
}

function selectedBasePlan(pool: readonly DemoQuestion[], seedDigest: string, nowMs: number) {
  for (let salt = 0; salt < 10_000; salt += 1) {
    const ordered = [...pool].sort((left, right) => hashHex(
      `${seedDigest}:base-plan:${salt}:${left.id}`,
    ).localeCompare(hashHex(
      `${seedDigest}:base-plan:${salt}:${right.id}`,
    )));
    const selected = selectUniqueQuestionPlan(ordered, TEST_CONFIG.plan, 1);
    if (!selected) break;
    const counts = exactPlanCounts(selected);
    const exactTopics = Object.entries(GENERAL_TOPIC_PLAN).every(
      ([topic, expected]) => (counts.topic[topic] ?? 0) === expected,
    );
    if (!exactTopics) continue;
    assertExactDemoPlan(selected);
    const coverageScore = calculateCoverageScore(selected, new Map(), nowMs);
    return { questions: selected, coverageScore };
  }
  throw new Error('demo_topic_balanced_legacy_plan_unavailable');
}

function correctnessProbability(difficulty: Difficulty, ability: number, additional: boolean) {
  const [floor, spread] = {
    easy: [0.55, 0.45],
    medium: [0.25, 0.70],
    hard: [0.10, 0.65],
    expert: [0.03, 0.50],
  }[difficulty];
  return Math.max(0.02, Math.min(0.99, floor + spread * ability + (additional ? 0.06 : 0)));
}

function submittedElapsedSeconds(
  seedDigest: string,
  candidateNumber: number,
  question: DemoQuestion,
  ability: number,
  questionKind: 'base' | 'additional',
) {
  const lower = { easy: 5, medium: 7, hard: 9, expert: 11 }[question.difficulty];
  const difficultyRoom = { easy: 3, medium: 4, hard: 5, expert: 6 }[question.difficulty];
  const jitter = unitInterval(
    `${seedDigest}:elapsed:${candidateNumber}:${question.id}:${questionKind}`,
  );
  return Math.min(17, Math.round(lower + (1 - ability) * difficultyRoom + jitter * 3));
}

function plannedOutcome(
  seedDigest: string,
  candidateNumber: number,
  question: DemoQuestion,
  ability: number,
  questionKind: 'base' | 'additional',
  timedOutCount: number,
) {
  const timeoutProbability = 0.015 + (1 - ability) * 0.075;
  const timeout = timedOutCount < 3 && unitInterval(
    `${seedDigest}:timeout:${candidateNumber}:${question.id}:${questionKind}`,
  ) < timeoutProbability;
  const correct = !timeout && unitInterval(
    `${seedDigest}:correct:${candidateNumber}:${question.id}:${questionKind}`,
  ) < correctnessProbability(question.difficulty, ability, questionKind === 'additional');
  const choices = JSON.parse(question.choices_json) as string[];
  let canonicalSelectedIndex: number | null = null;
  if (!timeout) {
    if (correct) {
      canonicalSelectedIndex = question.correct_index;
    } else {
      const wrongIndexes = choices
        .map((_, index) => index)
        .filter((index) => index !== question.correct_index);
      const choice = Math.floor(unitInterval(
        `${seedDigest}:choice:${candidateNumber}:${question.id}:${questionKind}`,
      ) * wrongIndexes.length);
      canonicalSelectedIndex = wrongIndexes[Math.min(choice, wrongIndexes.length - 1)];
    }
  }
  return {
    correct,
    timedOut: timeout,
    elapsedSeconds: timeout
      ? TEST_CONFIG.questionTimeSeconds
      : submittedElapsedSeconds(
          seedDigest,
          candidateNumber,
          question,
          ability,
          questionKind,
        ),
    canonicalSelectedIndex,
  };
}

function orderedRemedialPool(
  pool: readonly DemoQuestion[],
  seedDigest: string,
  candidateNumber: number,
  sourceQuestionId: number,
) {
  return [...pool].sort((left, right) => hashHex(
    `${seedDigest}:remedial:${candidateNumber}:${sourceQuestionId}:${left.id}`,
  ).localeCompare(hashHex(
    `${seedDigest}:remedial:${candidateNumber}:${sourceQuestionId}:${right.id}`,
  )));
}

function buildCandidateFacts(options: {
  candidateNumber: number;
  count: number;
  abilityRank: number;
  seedDigest: string;
  revision: string;
  baseQuestions: readonly DemoQuestion[];
  pool: readonly DemoQuestion[];
  coverageScore: number;
  anchorDay: number;
}) {
  const ability = options.count === 1
    ? 0.6
    : 0.18 + 0.80 * (options.abilityRank / (options.count - 1));
  const attemptId = deterministicUuid(
    `${options.seedDigest}:attempt:${options.candidateNumber}`,
  );
  const baseAnswers: PlannedAnswer[] = [];
  let timedOutCount = 0;
  for (const [index, question] of options.baseQuestions.entries()) {
    const outcome = plannedOutcome(
      options.seedDigest,
      options.candidateNumber,
      question,
      ability,
      'base',
      timedOutCount,
    );
    if (outcome.timedOut) timedOutCount += 1;
    baseAnswers.push({
      question,
      questionKind: 'base',
      ordinal: index + 1,
      sourceQuestionId: null,
      ...outcome,
    });
  }

  const excludedIds = new Set(options.baseQuestions.map((question) => question.id));
  const excludedDedupeKeys = new Set(options.baseQuestions.map(
    (question) => question.dedupe_key || `question:${question.id}`,
  ));
  const additionalAnswers: PlannedAnswer[] = [];
  for (const source of baseAnswers) {
    if (source.correct || additionalAnswers.length >= TEST_CONFIG.maxAdditionalQuestions) continue;
    const remedial = selectRemedialQuestion(
      orderedRemedialPool(
        options.pool,
        options.seedDigest,
        options.candidateNumber,
        source.question.id,
      ),
      source.question.difficulty,
      source.question.topic,
      excludedIds,
      excludedDedupeKeys,
    );
    if (!remedial) continue;
    excludedIds.add(remedial.id);
    excludedDedupeKeys.add(remedial.dedupe_key || `question:${remedial.id}`);
    const outcome = plannedOutcome(
      options.seedDigest,
      options.candidateNumber,
      remedial,
      ability,
      'additional',
      timedOutCount,
    );
    if (outcome.timedOut) timedOutCount += 1;
    additionalAnswers.push({
      question: remedial,
      questionKind: 'additional',
      ordinal: BASE_QUESTION_COUNT + additionalAnswers.length + 1,
      sourceQuestionId: source.question.id,
      ...outcome,
    });
  }

  const answers = [...baseAnswers, ...additionalAnswers];
  const dayOffset = (options.candidateNumber - 1) % 25;
  const slot = Math.floor((options.candidateNumber - 1) / 25);
  const startedAt = options.anchorDay - dayOffset * DAY_MS
    + (8 * 60 + slot * 40) * 60 * 1_000;
  let cursor = startedAt;
  let score = 0;
  let correctCount = 0;
  let wrongCount = 0;
  const ledger: DemoLedgerInsert[] = [];
  const storedAnswers: DemoAnswerInsert[] = [];
  const answeredAtByQuestion = new Map<number, number>();
  for (const answer of answers) {
    const presentedAt = cursor;
    const answeredAt = presentedAt + answer.elapsedSeconds * 1_000;
    const scoreValue = questionScoreValue(answer.question.weight, answer.questionKind);
    const awardedScore = answer.correct ? Math.min(scoreValue, 100 - score) : 0;
    score += awardedScore;
    correctCount += answer.correct ? 1 : 0;
    wrongCount += answer.correct ? 0 : 1;
    const choices = JSON.parse(answer.question.choices_json) as string[];
    const permutation = choicePermutation(attemptId, answer.question.id, choices.length);
    ledger.push({
      attemptId,
      questionId: answer.question.id,
      questionKind: answer.questionKind,
      ordinal: answer.ordinal,
      sourceQuestionId: answer.sourceQuestionId,
      scoreValue,
      assignedAt: answer.questionKind === 'base'
        ? startedAt
        : answeredAtByQuestion.get(answer.sourceQuestionId!)!,
      presentedAt,
    });
    storedAnswers.push({
      attemptId,
      questionId: answer.question.id,
      selectedIndex: answer.canonicalSelectedIndex === null
        ? null
        : permutation.indexOf(answer.canonicalSelectedIndex),
      isCorrect: answer.correct ? 1 : 0,
      answeredAt,
      elapsedSeconds: answer.elapsedSeconds,
      timedOut: answer.timedOut ? 1 : 0,
      answerOrigin: answer.timedOut ? 'question_timeout' : 'submitted',
      canonicalSelectedIndex: answer.canonicalSelectedIndex,
      awardedScore,
    });
    answeredAtByQuestion.set(answer.question.id, answeredAt);
    cursor = answeredAt + 1_000;
  }
  const completedAt = storedAnswers.at(-1)!.answeredAt;
  const durationSeconds = Math.ceil((completedAt - startedAt) / 1_000);
  if (durationSeconds > TEST_CONFIG.totalTimeSeconds) throw new Error('demo_duration_exceeded');
  if (completedAt >= options.anchorDay + DAY_MS) throw new Error('demo_timestamp_in_future');
  const accuracy = calculateAccuracy(correctCount, wrongCount);
  const verdict = calculateVerdict(score, accuracy);
  const alias = `Демо-кандидат ${String(options.candidateNumber).padStart(3, '0')}`;
  const attempt: DemoAttemptInsert = {
    id: attemptId,
    tokenHash: hashHex(`${options.seedDigest}:token:${options.candidateNumber}`),
    startKey: deterministicUuid(`${options.seedDigest}:start:${options.candidateNumber}`),
    candidateKey: `${DEMO_CANDIDATE_KEY_PREFIX}${hashHex(
      `${options.seedDigest}:candidate:${options.candidateNumber}`,
    )}`,
    publicAlias: alias,
    bankRevision: options.revision,
    coverageScore: options.coverageScore,
    startedAt,
    totalDeadlineAt: startedAt + TEST_CONFIG.totalTimeSeconds * 1_000,
    questionDeadlineAt: completedAt,
    askedQuestionIds: JSON.stringify(answers.map((answer) => answer.question.id)),
    baseQuestionIds: JSON.stringify(options.baseQuestions.map((question) => question.id)),
    score,
    correctCount,
    wrongCount,
    verdict,
    completedAt,
    durationSeconds,
  };
  return { attempt, ledger, answers: storedAnswers };
}

async function targetCounts(db: D1Database) {
  return db.prepare(`WITH targets AS (${DEMO_TARGET_IDS}) SELECT
      (SELECT COUNT(*) FROM targets) AS candidates,
      (SELECT COUNT(*) FROM answers WHERE attempt_id IN (SELECT id FROM targets)) AS answers,
      (SELECT COUNT(*) FROM attempt_questions
        WHERE attempt_id IN (SELECT id FROM targets)) AS ledger,
      (SELECT COUNT(*) FROM telegram_outbox
        WHERE attempt_id IN (SELECT id FROM targets)) AS outbox`)
    .first<{ candidates: number; answers: number; ledger: number; outbox: number }>();
}

function deleteDemoStatements(db: D1Database) {
  return [
    db.prepare(`DELETE FROM answers WHERE attempt_id IN (${DEMO_TARGET_IDS})`),
    db.prepare(`DELETE FROM attempt_questions WHERE attempt_id IN (${DEMO_TARGET_IDS})`),
    db.prepare(`DELETE FROM telegram_outbox WHERE attempt_id IN (${DEMO_TARGET_IDS})`),
    db.prepare(`DELETE FROM attempts WHERE ${DEMO_TARGET_SQL_PREDICATE}`),
  ];
}

function chunks<T>(items: readonly T[]) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += DEMO_INSERT_CHUNK_SIZE) {
    result.push(items.slice(index, index + DEMO_INSERT_CHUNK_SIZE));
  }
  return result;
}

function insertAttemptsStatements(db: D1Database, attempts: readonly DemoAttemptInsert[]) {
  return chunks(attempts).map((chunk) => db.prepare(`INSERT INTO attempts (
      id, token_hash, start_key, candidate_name, candidate_key, public_alias, bank_revision,
      scoring_version, app_version, test_config_id, test_profile_id, analytics_facts_version,
      selection_version, selection_strategy, coverage_score, shadow_coverage_score,
      status, started_at, total_deadline_at, current_question_started_at,
      question_deadline_at, current_question_id, pending_question_ids, asked_question_ids,
      base_question_ids, base_max_score, score, correct_count, wrong_count, verdict,
      completed_at, duration_seconds
    ) SELECT
      json_extract(value, '$.id'), json_extract(value, '$.tokenHash'),
      json_extract(value, '$.startKey'), NULL, json_extract(value, '$.candidateKey'),
      json_extract(value, '$.publicAlias'), json_extract(value, '$.bankRevision'),
      ?, ?, ?, ?, ?, ?, ?, json_extract(value, '$.coverageScore'), NULL,
      'completed', json_extract(value, '$.startedAt'),
      json_extract(value, '$.totalDeadlineAt'), 0,
      json_extract(value, '$.questionDeadlineAt'), NULL, '[]',
      json_extract(value, '$.askedQuestionIds'), json_extract(value, '$.baseQuestionIds'),
      100, json_extract(value, '$.score'), json_extract(value, '$.correctCount'),
      json_extract(value, '$.wrongCount'), json_extract(value, '$.verdict'),
      json_extract(value, '$.completedAt'), json_extract(value, '$.durationSeconds')
    FROM json_each(?)`)
    .bind(
      SCORING_VERSION,
      APP_RELEASE,
      TEST_CONFIG_ID,
      TEST_PROFILE_ID,
      ANALYTICS_FACTS_VERSION,
      LEGACY_SELECTION_VERSION,
      LEGACY_SELECTION_STRATEGY,
      JSON.stringify(chunk),
    ));
}

function insertLedgerStatements(db: D1Database, ledger: readonly DemoLedgerInsert[]) {
  return chunks(ledger).map((chunk) => db.prepare(`INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, source_question_id,
      score_value, assigned_at, presented_at
    ) SELECT json_extract(value, '$.attemptId'), json_extract(value, '$.questionId'),
      json_extract(value, '$.questionKind'), json_extract(value, '$.ordinal'),
      json_extract(value, '$.sourceQuestionId'), json_extract(value, '$.scoreValue'),
      json_extract(value, '$.assignedAt'), json_extract(value, '$.presentedAt')
    FROM json_each(?)`).bind(JSON.stringify(chunk)));
}

function insertAnswersStatements(db: D1Database, answers: readonly DemoAnswerInsert[]) {
  return chunks(answers).map((chunk) => db.prepare(`INSERT INTO answers (
      attempt_id, question_id, selected_index, is_correct, answered_at,
      elapsed_seconds, timed_out, fact_version, answer_origin,
      canonical_selected_index, awarded_score
    ) SELECT json_extract(value, '$.attemptId'), json_extract(value, '$.questionId'),
      json_extract(value, '$.selectedIndex'), json_extract(value, '$.isCorrect'),
      json_extract(value, '$.answeredAt'), json_extract(value, '$.elapsedSeconds'),
      json_extract(value, '$.timedOut'), ?, json_extract(value, '$.answerOrigin'),
      json_extract(value, '$.canonicalSelectedIndex'), json_extract(value, '$.awardedScore')
    FROM json_each(?)`).bind(ANALYTICS_FACTS_VERSION, JSON.stringify(chunk)));
}

async function assertFactsIntegrity(db: D1Database) {
  const integrity = await db.prepare(ANALYTICS_FACTS_INTEGRITY_QUERY)
    .first<{ violations: number }>();
  if ((integrity?.violations ?? 0) !== 0) throw new Error('demo_analytics_facts_integrity_failed');
}

export async function replaceDemoCandidates(
  db: D1Database,
  options: DemoSeedOptions = {},
): Promise<DemoSeedSummary> {
  const count = validateCount(options.count ?? DEFAULT_DEMO_CANDIDATE_COUNT);
  const seed = validateSeed(options.seed ?? DEFAULT_DEMO_SEED);
  const seedDigest = hashHex(seed);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < DAY_MS) throw new Error('Invalid seed timestamp.');
  await assertFactsIntegrity(db);
  const before = await targetCounts(db);
  const { revision, questions: pool } = await currentQuestionPool(db);
  const plan = selectedBasePlan(pool, seedDigest, nowMs);
  const abilityOrder = Array.from({ length: count }, (_, index) => index + 1)
    .sort((left, right) => hashHex(`${seedDigest}:ability:${left}`)
      .localeCompare(hashHex(`${seedDigest}:ability:${right}`)));
  const abilityRank = new Map(abilityOrder.map((candidate, rank) => [candidate, rank]));
  const anchorDay = Math.floor((nowMs - DAY_MS) / DAY_MS) * DAY_MS;
  const generated = Array.from({ length: count }, (_, index) => buildCandidateFacts({
    candidateNumber: index + 1,
    count,
    abilityRank: abilityRank.get(index + 1)!,
    seedDigest,
    revision,
    baseQuestions: plan.questions,
    pool,
    coverageScore: plan.coverageScore,
    anchorDay,
  }));
  const attempts = generated.map((item) => item.attempt);
  const ledger = generated.flatMap((item) => item.ledger);
  const answers = generated.flatMap((item) => item.answers);
  await db.batch([
    ...deleteDemoStatements(db),
    ...insertAttemptsStatements(db, attempts),
    ...insertLedgerStatements(db, ledger),
    ...insertAnswersStatements(db, answers),
    db.prepare(`UPDATE analytics_refresh_state
      SET refresh_token = NULL, refresh_generation = NULL, refresh_lease_until = NULL
      WHERE id = 1`),
  ]);
  await assertFactsIntegrity(db);
  const aggregate = await rebuildAnalyticsAggregates(db, nowMs);
  const after = await targetCounts(db);
  if (
    after?.candidates !== count
    || after.outbox !== 0
    || after.ledger !== ledger.length
    || after.answers !== answers.length
  ) {
    throw new Error('demo_seed_postcondition_failed');
  }
  const verdicts = attempts.reduce<Record<'PASS' | 'REVIEW' | 'FAIL', number>>(
    (result, attempt) => {
      result[attempt.verdict as 'PASS' | 'REVIEW' | 'FAIL'] += 1;
      return result;
    },
    { PASS: 0, REVIEW: 0, FAIL: 0 },
  );
  return {
    candidates: count,
    baseAnswers: count * BASE_QUESTION_COUNT,
    additionalAnswers: answers.length - count * BASE_QUESTION_COUNT,
    timeouts: answers.filter((answer) => answer.timedOut === 1).length,
    verdicts,
    bankRevision: revision,
    baseQuestionIds: plan.questions.map((question) => question.id),
    coverageScore: plan.coverageScore,
    analyticsGeneration: aggregate.generation,
    replacedCandidates: before?.candidates ?? 0,
  };
}

export async function clearDemoCandidates(db: D1Database): Promise<DemoClearSummary> {
  const before = await targetCounts(db) ?? { candidates: 0, answers: 0, ledger: 0, outbox: 0 };
  if (before.candidates === 0) {
    const state = await db.prepare('SELECT generation FROM analytics_refresh_state WHERE id = 1')
      .first<{ generation: number }>();
    if (!state) throw new Error('analytics_refresh_state_missing');
    return {
      removedCandidates: 0,
      removedAnswers: 0,
      removedLedgerRows: 0,
      removedOutboxRows: 0,
      analyticsGeneration: state.generation,
    };
  }
  await db.batch([
    ...deleteDemoStatements(db),
    db.prepare(`UPDATE analytics_refresh_state
      SET refresh_token = NULL, refresh_generation = NULL, refresh_lease_until = NULL
      WHERE id = 1`),
  ]);
  await assertFactsIntegrity(db);
  const aggregate = await rebuildAnalyticsAggregates(db);
  const after = await targetCounts(db);
  if ((after?.candidates ?? 0) !== 0 || (after?.outbox ?? 0) !== 0) {
    throw new Error('demo_clear_postcondition_failed');
  }
  return {
    removedCandidates: before.candidates,
    removedAnswers: before.answers,
    removedLedgerRows: before.ledger,
    removedOutboxRows: before.outbox,
    analyticsGeneration: aggregate.generation,
  };
}

type DemoCliOptions = DemoSeedOptions & { clear: boolean };

export function parseDemoCliArguments(argv: string[]): DemoCliOptions {
  const result: DemoCliOptions = { clear: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--clear') {
      result.clear = true;
      continue;
    }
    if (argument === '--count' || argument === '--seed') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      if (argument === '--count') result.count = validateCount(Number(value));
      else result.seed = validateSeed(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.clear && (result.count !== undefined || result.seed !== undefined)) {
    throw new Error('--clear cannot be combined with --count or --seed.');
  }
  return result;
}

export type RunDemoCandidatesOptions = OpsContextOptions & {
  argv?: string[];
  checkServer?: boolean;
  nowMs?: number;
  log?: (message: string) => void;
};

export async function runDemoCandidates(options: RunDemoCandidatesOptions = {}) {
  const context = resolveOpsContext(options);
  const cli = parseDemoCliArguments(options.argv ?? process.argv.slice(2));
  const log = options.log ?? console.log;
  const runtimeGuard = await acquireDestructiveOperationGuard({
    workspaceRoot: context.workspaceRoot,
    probeFallbackPorts: options.checkServer !== false,
  });
  try {
    const databaseId = await readLocalD1DatabaseId(context);
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: databaseId },
      d1Persist: path.join(context.persistPath, 'v3', 'd1'),
    });
    try {
      const db = await miniflare.getD1Database('DB');
      if (cli.clear) {
        const summary = await clearDemoCandidates(db);
        log(`Demo cleanup: candidates=${summary.removedCandidates}, answers=${summary.removedAnswers}, `
          + `ledger=${summary.removedLedgerRows}, outbox=${summary.removedOutboxRows}.`);
        return summary;
      }
      const summary = await replaceDemoCandidates(db, {
        count: cli.count,
        seed: cli.seed,
        nowMs: options.nowMs,
      });
      log(`Demo seed complete: candidates=${summary.candidates}, base_answers=${summary.baseAnswers}, `
        + `additional_answers=${summary.additionalAnswers}, timeouts=${summary.timeouts}.`);
      log(`Verdicts: PASS=${summary.verdicts.PASS}, REVIEW=${summary.verdicts.REVIEW}, `
        + `FAIL=${summary.verdicts.FAIL}; coverage=${summary.coverageScore}.`);
      log(`Analytics generation=${summary.analyticsGeneration}; bank=${summary.bankRevision.slice(0, 12)}.`);
      return summary;
    } finally {
      await miniflare.dispose();
    }
  } finally {
    await runtimeGuard.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDemoCandidates().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.error(`Demo seed failed: ${message}`);
    process.exitCode = 1;
  });
}
