import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  cachedAnalyticsReport,
  invalidateAnalyticsAggregates,
} from '../lib/analytics-cache.ts';
import {
  analyticsAggregateState,
  rebuildAnalyticsAggregates,
} from '../lib/analytics-aggregate-store.ts';
import {
  fetchDerivedCandidateListReport,
  fetchDerivedCandidatePrintReport,
  fetchDerivedDifficultyReport,
  fetchDerivedOverviewReport,
  fetchDerivedQuestionDetailReport,
  fetchDerivedQuestionListReport,
  fetchDerivedRevisionComparisonReport,
  fetchDerivedRevisionsReport,
  fetchDerivedTopicReport,
  fetchDerivedTrendsReport,
} from '../lib/analytics-derived.ts';
import {
  EXPECTED_SUCCESS_RANGES,
  analyticsReliability,
  interviewerRecommendations,
  median,
  pointBiserial,
  questionQuality,
  roundedRate,
  semicolonCsv,
  summarizeQuestionFacts,
} from '../lib/analytics-math.ts';
import {
  AnalyticsQueryError,
  applyCurrentModelDefaults,
  analyticsCursor,
  eligibleAttemptsCte,
  parseAnalyticsQuery,
} from '../lib/analytics-query.ts';
import {
  fetchCandidateListReport,
  fetchCandidatePrintReport,
  fetchDifficultyReport,
  fetchOverviewReport,
  fetchQuestionDetailReport,
  fetchQuestionListReport,
  fetchRevisionsReport,
  fetchTopicReport,
  fetchTrendsReport,
} from '../lib/analytics-direct.ts';
import {
  fetchAnalyticsAttempts,
  fetchAnalyticsFacts,
  fetchOverviewAttempts,
  fetchQuestionReviews,
  insertQuestionReview,
} from '../lib/analytics-repository.ts';
import {
  buildCandidateList,
  buildCandidatePrint,
  buildDifficultyList,
  buildOverview,
  buildQuestionDetail,
  buildQuestionList,
  buildRevisions,
  buildTopicList,
  buildTrends,
} from '../lib/analytics-service.ts';
import type {
  AnalyticsAttemptRow,
  AnalyticsFactRow,
  AnalyticsOverviewAttemptRow,
} from '../lib/analytics-repository.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_PROFILE_ID,
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from '../lib/test-config.ts';

const now = Date.parse('2026-08-28T12:00:00.000Z');
const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const revisionC = 'c'.repeat(64);

const defaults = parseAnalyticsQuery('http://localhost/api/admin/analytics/questions', now);
assert.equal(defaults.questionKind, 'base');
assert.equal(defaults.candidatePolicy, 'latest');
assert.equal(defaults.bankRevision, null, 'repository resolves the current revision');
assert.equal(defaults.scoringVersion, SCORING_VERSION);
assert.equal(defaults.testConfigId, TEST_CONFIG_ID);
assert.equal(defaults.testProfileId, TEST_PROFILE_ID);
assert.equal(defaults.from, '2026-07-30');
assert.equal(defaults.to, '2026-08-28');
assert.equal(defaults.toExclusiveMs! - defaults.fromMs!, 30 * 24 * 60 * 60 * 1_000);
const balancedDefaults = applyCurrentModelDefaults(
  defaults,
  'http://localhost/api/admin/analytics/questions',
  true,
);
assert.equal(balancedDefaults.testConfigId, BALANCED_TEST_CONFIG_ID);
assert.equal(balancedDefaults.testProfileId, BALANCED_TEST_PROFILE_ID);
const explicitModel = applyCurrentModelDefaults(
  parseAnalyticsQuery(
    `http://localhost/x?testConfigId=${TEST_CONFIG_ID}&testProfileId=${TEST_PROFILE_ID}`,
    now,
  ),
  `http://localhost/x?testConfigId=${TEST_CONFIG_ID}&testProfileId=${TEST_PROFILE_ID}`,
  true,
);
assert.equal(explicitModel.testConfigId, TEST_CONFIG_ID);
assert.equal(explicitModel.testProfileId, TEST_PROFILE_ID);

const cursor = analyticsCursor(25);
const aliases = parseAnalyticsQuery(
  `http://localhost/api/admin/analytics/questions?revision=${revisionA}&kind=additional&cursor=${cursor}`,
  now,
);
assert.equal(aliases.bankRevision, revisionA);
assert.equal(aliases.questionKind, 'additional');
assert.equal(aliases.cursorOffset, 25);
assert.deepEqual(aliases.warnings, ['deprecated_revision_filter', 'deprecated_kind_filter']);
assert.throws(
  () => parseAnalyticsQuery('http://localhost/x?from=2026-08-28&to=2026-08-27', now),
  AnalyticsQueryError,
);
assert.throws(
  () => parseAnalyticsQuery('http://localhost/x?candidatePolicy=first', now),
  AnalyticsQueryError,
);
assert.throws(
  () => parseAnalyticsQuery('http://localhost/x?limit=101', now),
  AnalyticsQueryError,
);
const latestSql = eligibleAttemptsCte(defaults).sql;
assert.match(
  latestSql,
  /PARTITION BY candidate_key, bank_revision, scoring_version, test_config_id, test_profile_id/u,
  'latest policy must not combine attempts from different immutable cohorts',
);

assert.equal(roundedRate(2, 3), 66.7);
assert.equal(roundedRate(1, 0), null);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([]), null);
assert.equal(pointBiserial([
  { correct: true, restScore: 90 },
  { correct: true, restScore: 80 },
  { correct: false, restScore: 20 },
  { correct: false, restScore: 10 },
]), 0.99);
assert.equal(pointBiserial([{ correct: true, restScore: 10 }]), null);
assert.equal(pointBiserial([
  { correct: true, restScore: 10 },
  { correct: true, restScore: 20 },
]), null, 'discrimination is undefined without both outcome groups');
assert.equal(pointBiserial([
  { correct: true, restScore: 10 },
  { correct: false, restScore: 90 },
]), -1);
assert.equal(analyticsReliability(29), 'insufficient');
assert.equal(analyticsReliability(30), 'descriptive');
assert.equal(analyticsReliability(50), 'directional');
assert.equal(analyticsReliability(100), 'stable');
assert.deepEqual(EXPECTED_SUCCESS_RANGES, {
  easy: { min: 75, max: 95 },
  medium: { min: 55, max: 80 },
  hard: { min: 30, max: 60 },
  expert: { min: 10, max: 40 },
});

const hundredFacts = Array.from({ length: 100 }, (_, index) => ({
  correct: index < 50,
  timedOut: false,
  elapsedSeconds: 8 + (index % 5),
  selectedIndex: index < 50 ? 1 : 0,
  restScore: index < 50 ? 90 : 10,
  submitted: true,
}));
const stableSummary = summarizeQuestionFacts(hundredFacts, 4, 1, 30);
assert.equal(stableSummary.sampleSize, 100);
assert.equal(stableSummary.successRate, 50);
assert.equal(stableSummary.discrimination, 1);
assert.equal(stableSummary.responseCount, 100);
assert.equal(stableSummary.deadDistractors, 2);
assert.equal(stableSummary.functioningDistractorCount, 1);
assert.deepEqual(
  Object.keys(stableSummary.choices[0]).toSorted(),
  ['canonicalIndex', 'selectedCount', 'selectedRate'],
  'choice DTO must not disclose the key or a per-choice distractor marker',
);
assert.equal(summarizeQuestionFacts(hundredFacts.slice(0, 99), 4, 1, 30).discrimination, null);

const healthyPartial = questionQuality({
  difficulty: 'medium',
  sampleSize: 50,
  successRate: 70,
  timeoutRate: 5,
  medianSeconds: 12,
  peerMedianSeconds: 12,
  functioningDistractors: 3,
  distractorCount: 3,
  discrimination: null,
});
assert.deepEqual(
  {
    earned: healthyPartial.quality.earned,
    maxAvailable: healthyPartial.quality.maxAvailable,
    partial: healthyPartial.quality.partial,
    status: healthyPartial.quality.status,
  },
  { earned: 80, maxAvailable: 80, partial: true, status: 'good' },
  'partial quality is not secretly normalized to 100',
);
const criticalQuality = questionQuality({
  difficulty: 'hard',
  sampleSize: 100,
  successRate: 45,
  timeoutRate: 45,
  medianSeconds: 20,
  peerMedianSeconds: 10,
  functioningDistractors: 2,
  distractorCount: 3,
  discrimination: -0.2,
});
assert.equal(criticalQuality.quality.critical, true);
assert.equal(criticalQuality.quality.status, 'review');
assert.deepEqual(
  criticalQuality.warnings,
  ['high_timeout', 'slow', 'negative_discrimination'],
);
assert.equal(questionQuality({
  difficulty: 'easy',
  sampleSize: 29,
  successRate: 100,
  timeoutRate: 0,
  medianSeconds: 1,
  peerMedianSeconds: 1,
  functioningDistractors: 0,
  distractorCount: 3,
  discrimination: null,
}).quality.status, 'insufficient');
const slowAtBoundary = questionQuality({
  difficulty: 'medium',
  sampleSize: 50,
  successRate: 65,
  timeoutRate: 5,
  medianSeconds: 15,
  peerMedianSeconds: 10,
  functioningDistractors: 3,
  distractorCount: 3,
  discrimination: null,
});
assert.ok(slowAtBoundary.warnings.includes('slow'), 'exactly 1.5× peer median is slow');
assert.equal(
  slowAtBoundary.quality.components.find((component) => component.key === 'timing_consistency')?.earned,
  0,
);

const csv = semicolonCsv(
  ['topic', 'value'],
  [['=HYPERLINK("https://invalid")', 1], ['normal;topic', 2]],
);
assert.ok(csv.startsWith('\uFEFF'));
assert.match(csv, /'=HYPERLINK/u, 'spreadsheet formulas must be neutralized');
assert.match(csv, /"normal;topic";2\r\n/u);

const recommendationCandidate = {
  attemptId: 'candidate-attempt',
  alias: 'Кандидат К.',
  completedAt: new Date(now).toISOString(),
  score: 40,
  accuracy: 40,
  verdict: 'FAIL' as const,
  durationSeconds: 300,
  baseAnswered: 20,
  baseCorrect: 8,
  additionalAnswered: 2,
  additionalCorrect: 1,
  timeoutCount: 2,
};
const recommendations = interviewerRecommendations({
  candidate: recommendationCandidate,
  weaknesses: Array.from({ length: 7 }, (_, index) => ({
    topic: `Тема ${index + 1}`,
    dedupeKey: `key-${index + 1}`,
    lostScore: 20 - index,
    wrongCount: 1,
    timeoutCount: index === 0 ? 1 : 0,
  })),
});
assert.equal(recommendations.length, 5);
assert.ok(recommendations.every((item) => !('questionId' in item)));

function attempt(id: string, overrides: Partial<AnalyticsAttemptRow> = {}): AnalyticsAttemptRow {
  return {
    id,
    alias: 'Кандидат К.',
    bankRevision: revisionA,
    appVersion: '0.8.0',
    score: 60,
    correctCount: 18,
    wrongCount: 12,
    verdict: 'REVIEW',
    completedAt: now - 60_000,
    durationSeconds: 240,
    baseMaxScore: 100,
    ...overrides,
  };
}

function fact(overrides: Partial<AnalyticsFactRow> = {}): AnalyticsFactRow {
  return {
    attemptId: 'attempt-1',
    questionId: 101,
    questionKind: 'base',
    ordinal: 1,
    scoreValue: 2,
    assignedAt: now - 300_000,
    presentedAt: now - 290_000,
    topic: 'Сети',
    dedupeKey: 'network-basics',
    difficulty: 'easy',
    active: true,
    prompt: 'Какой протокол используется?',
    contextType: null,
    context: null,
    choiceCount: 4,
    correctIndex: 1,
    answerId: 1,
    factVersion: ANALYTICS_FACTS_VERSION,
    answerOrigin: 'submitted',
    canonicalSelectedIndex: 1,
    awardedScore: 2,
    isCorrect: true,
    timedOut: false,
    elapsedSeconds: 10,
    answeredAt: now - 280_000,
    ...overrides,
  };
}

const serviceAttempts = Array.from({ length: 30 }, (_, index) => attempt(`attempt-${index + 1}`, {
  score: index < 18 ? 70 : 40,
  correctCount: index < 18 ? 1 : 0,
  wrongCount: index < 18 ? 0 : 1,
}));
const serviceFacts = serviceAttempts.map((item, index) => fact({
  attemptId: item.id,
  answerId: index + 1,
  canonicalSelectedIndex: index < 18 ? 1 : 0,
  awardedScore: index < 18 ? 2 : 0,
  isCorrect: index < 18,
}));
serviceFacts.push(fact({
  attemptId: serviceAttempts[0].id,
  answerId: 500,
  answerOrigin: 'total_timeout_unshown',
  presentedAt: null,
  canonicalSelectedIndex: null,
  awardedScore: 0,
  isCorrect: false,
  timedOut: true,
  answeredAt: now - 100_000,
}));
const serviceQuery = parseAnalyticsQuery(
  `http://localhost/x?bankRevision=${revisionA}&from=2026-07-30&to=2026-08-28&questionKind=base`,
  now,
);
const questionList = buildQuestionList(serviceQuery, serviceAttempts, serviceFacts);
assert.equal(questionList.items.length, 1);
assert.deepEqual(
  {
    assigned: questionList.items[0].assignedCount,
    presented: questionList.items[0].presentedCount,
    outcomes: questionList.items[0].outcomeCount,
    completion: questionList.items[0].completionRate,
    success: questionList.items[0].successRate,
  },
  { assigned: 31, presented: 30, outcomes: 30, completion: 100, success: 60 },
  'materialized unshown timeout is assigned but not a presented outcome',
);
const questionDetail = buildQuestionDetail(
  serviceQuery,
  serviceAttempts,
  serviceFacts,
  101,
);
assert.ok(questionDetail);
assert.equal(questionDetail.bankRevision, revisionA);
const serializedDetail = JSON.stringify(questionDetail);
assert.doesNotMatch(serializedDetail, /correctIndex|functioningDistractor|answerOrigin|selectedAnswer/u);
assert.match(serializedDetail, /canonicalIndex/u);

const candidateAttempt = attempt('candidate-print', {
  score: 67,
  correctCount: 2,
  wrongCount: 1,
});
const candidateFacts = [
  fact({ attemptId: candidateAttempt.id, questionId: 201, answerId: 201, ordinal: 1 }),
  fact({ attemptId: candidateAttempt.id, questionId: 202, answerId: 202, ordinal: 2 }),
  fact({
    attemptId: candidateAttempt.id,
    questionId: 203,
    answerId: 203,
    ordinal: 3,
    canonicalSelectedIndex: 0,
    awardedScore: 0,
    isCorrect: false,
  }),
  fact({
    attemptId: candidateAttempt.id,
    questionId: 204,
    answerId: 204,
    ordinal: 4,
    questionKind: 'additional',
    answerOrigin: 'question_timeout',
    canonicalSelectedIndex: null,
    awardedScore: 0,
    isCorrect: false,
    timedOut: true,
  }),
];
const print = buildCandidatePrint([candidateAttempt], candidateFacts, candidateAttempt.id);
assert.ok(print);
assert.equal(print.alias, 'Кандидат CANDIDAT');
assert.equal(print.topics[0].classification, 'normal');
assert.equal(print.topics[0].base.resolved, 3);
assert.equal(print.topics[0].base.accuracy, 66.7);
assert.equal(print.topics[0].additional.timedOut, 1);
assert.equal(print.interviewerRecommendations.length, 1);
assert.doesNotMatch(
  JSON.stringify(print),
  /candidateKey|candidate_name|correctIndex|canonicalSelectedIndex|answerOrigin/u,
);

const overviewRows: AnalyticsOverviewAttemptRow[] = [
  {
    ...attempt('overview-completed', { score: 49, verdict: 'FAIL' }),
    candidateKey: 'candidate-a',
    status: 'completed',
    eventAt: now - 1_000,
    selectionVersion: 1,
    selectionStrategy: 'random-difficulty-quota-v1',
    coverageScore: 60,
    shadowCoverageScore: 72,
  },
  {
    ...attempt('overview-repeat', { score: 90, verdict: 'PASS' }),
    candidateKey: 'candidate-a',
    status: 'completed',
    eventAt: now - 2_000,
    selectionVersion: 1,
    selectionStrategy: 'random-difficulty-quota-v1',
    coverageScore: 80,
    shadowCoverageScore: null,
  },
  {
    ...attempt('overview-aborted'),
    candidateKey: 'candidate-b',
    status: 'aborted',
    eventAt: now - 3_000,
  },
];
const overview = buildOverview(serviceQuery, serviceAttempts, serviceFacts, overviewRows, now);
assert.deepEqual(
  {
    attempts: overview.last30Days.attempts,
    completed: overview.last30Days.completedAttempts,
    aborted: overview.last30Days.abortedAttempts,
    unique: overview.last30Days.uniqueCandidates,
    repeats: overview.last30Days.repeatAttempts,
  },
  { attempts: 3, completed: 2, aborted: 1, unique: 2, repeats: 1 },
);
assert.deepEqual(
  overview.last30Days.scoreHistogram.map((bucket) => [bucket.from, bucket.to, bucket.count]),
  [[0, 49, 1], [50, 59, 0], [60, 69, 0], [70, 79, 0], [80, 89, 0], [90, 100, 1]],
);
assert.deepEqual(overview.last30Days.selectionComparison, {
  eligibleAttempts: 2,
  sampleSize: 1,
  actualCoverage: 60,
  shadowCoverage: 72,
  delta: 12,
  fallbackOrNullCount: 1,
  fallbackOrNullRate: 50,
});

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});
try {
  const db = await miniflare.getD1Database('DB');
  const statements = [
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
    `CREATE TABLE question_bank_revisions (hash TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
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
      ordinal INTEGER NOT NULL, score_value INTEGER NOT NULL, assigned_at INTEGER NOT NULL,
      presented_at INTEGER, PRIMARY KEY (attempt_id, question_id)
    )`,
    `CREATE TABLE answers (
      id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL,
      fact_version INTEGER NOT NULL, answer_origin TEXT NOT NULL,
      canonical_selected_index INTEGER, awarded_score INTEGER,
      is_correct INTEGER NOT NULL, timed_out INTEGER NOT NULL,
      elapsed_seconds INTEGER, answered_at INTEGER
    )`,
    `CREATE TABLE question_review_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL,
      bank_revision TEXT NOT NULL, decision TEXT NOT NULL, note TEXT,
      created_at INTEGER NOT NULL, admin_session_fingerprint TEXT
    )`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
  for (const migrationName of [
    '0012_silent_union_jack.sql',
    '0013_productive_darkstar.sql',
    '0014_supreme_domino.sql',
  ]) {
    const aggregateMigration = await readFile(
      new URL(`../drizzle/${migrationName}`, import.meta.url),
      'utf8',
    );
    await db.batch(aggregateMigration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement)));
  }
  await db.batch([
    db.prepare('INSERT INTO question_bank_revisions (hash, applied_at) VALUES (?, ?), (?, ?), (?, ?)')
      .bind(revisionA, now - 2_000, revisionB, now - 1_000, revisionC, now - 3_000),
    db.prepare(`INSERT INTO questions (
      id, topic, dedupe_key, difficulty, active, prompt, choices_json, correct_index
    ) VALUES (101, 'Сети', 'net', 'easy', 0, 'Вопрос', '["A","B","C","D"]', 1)`),
    db.prepare(`INSERT INTO question_bank_revision_items (revision_hash, question_id, active)
      VALUES (?, 101, 1), (?, 101, 0), (?, 101, 1)`).bind(revisionA, revisionB, revisionC),
  ]);
  const emptyQuery = parseAnalyticsQuery(
    `http://localhost/x?bankRevision=${revisionB}&from=2026-07-30&to=2026-08-28`,
    now,
  );
  const emptyAttempts = await fetchAnalyticsAttempts(db, emptyQuery);
  const emptyFacts = await fetchAnalyticsFacts(db, emptyQuery);
  assert.deepEqual(emptyAttempts, []);
  assert.deepEqual(emptyFacts, []);
  assert.deepEqual(
    buildQuestionList(emptyQuery, emptyAttempts, emptyFacts).items,
    [],
    'a ready bank without attempts returns honest empty analytics',
  );
  const insertAttempt = db.prepare(`INSERT INTO attempts (
    id, candidate_key, public_alias, bank_revision, app_version, scoring_version,
    test_config_id, test_profile_id, score, correct_count, wrong_count, verdict,
    completed_at, duration_seconds, base_max_score, status, analytics_facts_version, started_at
  ) VALUES (?, 'same-candidate', 'Иван Иванов', ?, '0.8.0', ?, ?, ?, ?, 1, 0,
    'PASS', ?, 30, 100, 'completed', ?, ?)`);
  await db.batch([
    insertAttempt.bind('old-a', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 60, now - 5_000, ANALYTICS_FACTS_VERSION, now - 10_000),
    insertAttempt.bind('new-a', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 70, now - 4_000, ANALYTICS_FACTS_VERSION, now - 10_000),
    insertAttempt.bind('only-b', revisionB, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 80, now - 3_000, ANALYTICS_FACTS_VERSION, now - 10_000),
    insertAttempt.bind('additional-a', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 55, now - 3_500, ANALYTICS_FACTS_VERSION, now - 10_000),
    insertAttempt.bind('old-history', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 90, now - 40 * 24 * 60 * 60 * 1_000, ANALYTICS_FACTS_VERSION, now - 40 * 24 * 60 * 60 * 1_000 - 10_000),
    insertAttempt.bind('old-revision-c', revisionC, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 88, now - 45 * 24 * 60 * 60 * 1_000, ANALYTICS_FACTS_VERSION, now - 45 * 24 * 60 * 60 * 1_000 - 10_000),
    insertAttempt.bind('rank-old', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 65, now - 6_000, ANALYTICS_FACTS_VERSION, now - 10_000),
    insertAttempt.bind('rank-new', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 75, now + 2 * 24 * 60 * 60 * 1_000, ANALYTICS_FACTS_VERSION, now + 2 * 24 * 60 * 60 * 1_000 - 10_000),
    insertAttempt.bind('legacy', revisionA, SCORING_VERSION, TEST_CONFIG_ID, TEST_PROFILE_ID, 99, now - 2_000, 0, now - 10_000),
    db.prepare("UPDATE attempts SET candidate_key = 'other-candidate' WHERE id = 'additional-a'"),
    db.prepare("UPDATE attempts SET candidate_key = 'historical-candidate' WHERE id = 'old-history'"),
    db.prepare("UPDATE attempts SET candidate_key = 'revision-c-candidate' WHERE id = 'old-revision-c'"),
    db.prepare("UPDATE attempts SET candidate_key = 'rank-candidate' WHERE id IN ('rank-old', 'rank-new')"),
    db.prepare("UPDATE attempts SET coverage_score = 55, shadow_coverage_score = 65 WHERE id = 'new-a'"),
    db.prepare("UPDATE attempts SET coverage_score = 60, shadow_coverage_score = NULL WHERE id = 'additional-a'"),
  ]);
  await db.batch([
    db.prepare(`INSERT INTO attempt_questions (
      attempt_id, question_id, question_kind, ordinal, score_value, assigned_at, presented_at
    ) VALUES ('new-a', 101, 'base', 1, 2, ?, ?), ('only-b', 101, 'base', 1, 2, ?, ?),
      ('additional-a', 101, 'additional', 1, 2, ?, ?)`)
      .bind(now - 9_000, now - 8_000, now - 9_000, now - 8_000, now - 9_000, now - 8_000),
    db.prepare(`INSERT INTO answers (
      id, attempt_id, question_id, fact_version, answer_origin, canonical_selected_index,
      awarded_score, is_correct, timed_out, elapsed_seconds, answered_at
    ) VALUES (1, 'new-a', 101, 1, 'submitted', 1, 2, 1, 0, 9, ?),
      (2, 'only-b', 101, 1, 'submitted', 0, 0, 0, 0, 10, ?),
      (3, 'additional-a', 101, 1, 'submitted', 0, 0, 0, 0, 30, ?)`)
      .bind(now - 7_000, now - 7_000, now - 7_000),
  ]);
  const rebuilt = await rebuildAnalyticsAggregates(db, now);
  assert.ok(rebuilt.rows.candidates >= 3);
  assert.equal((await analyticsAggregateState(db)).ready, true);
  const aggregateColumns = await db.prepare(
    'PRAGMA table_info(analytics_candidate_aggregates)',
  ).all<{ name: string }>();
  assert.ok(aggregateColumns.results.some((column) => column.name === 'display_alias'));
  assert.ok(!aggregateColumns.results.some((column) => column.name === 'public_alias'));
  const storedAliases = await db.prepare(
    'SELECT DISTINCT display_alias FROM analytics_candidate_aggregates',
  ).all<{ display_alias: string }>();
  assert.ok(storedAliases.results.every((row) => /^Кандидат [A-Z0-9]{1,8}$/u.test(row.display_alias)));
  assert.doesNotMatch(JSON.stringify(storedAliases.results), /Иван Иванов/u);

  const repositoryQuery = {
    ...parseAnalyticsQuery('http://localhost/x?from=2026-07-30&to=2026-08-28', now),
    bankRevision: null,
  };
  const repositoryAttempts = await fetchAnalyticsAttempts(db, repositoryQuery);
  assert.deepEqual(
    repositoryAttempts.map((item) => item.id).toSorted(),
    ['additional-a', 'new-a', 'only-b'],
    'latest keeps one attempt per candidate within each immutable cohort and excludes legacy facts',
  );
  const repositoryFacts = await fetchAnalyticsFacts(db, repositoryQuery);
  assert.equal(repositoryFacts.length, 3);
  assert.equal(
    repositoryFacts.find((row) => row.attemptId === 'new-a')?.active,
    true,
    'historical active state comes from the selected bank revision, not current question state',
  );
  assert.equal(repositoryFacts.find((row) => row.attemptId === 'only-b')?.active, false);

  const equivalenceQuery = {
    ...repositoryQuery,
    bankRevision: revisionA,
    questionKind: 'base' as const,
  };
  const equivalenceAttempts = await fetchAnalyticsAttempts(db, equivalenceQuery);
  const equivalenceFacts = await fetchAnalyticsFacts(db, equivalenceQuery);
  const directQuestions = await fetchQuestionListReport(db, equivalenceQuery);
  assert.deepEqual(
    directQuestions.items,
    buildQuestionList(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
    'direct question aggregation must remain equivalent to the reference pure builder',
  );
  const derivedQuestions = await fetchDerivedQuestionListReport(db, equivalenceQuery);
  assert.deepEqual(derivedQuestions.items, directQuestions.items);
  assert.deepEqual(
    await fetchDerivedQuestionDetailReport(db, equivalenceQuery, 101),
    await fetchQuestionDetailReport(db, equivalenceQuery, 101),
  );
  const directDetail = await fetchQuestionDetailReport(db, equivalenceQuery, 101);
  assert.deepEqual(
    directDetail,
    buildQuestionDetail(equivalenceQuery, equivalenceAttempts, equivalenceFacts, 101),
  );
  const directCandidates = await fetchCandidateListReport(db, equivalenceQuery);
  assert.deepEqual(
    directCandidates.items,
    buildCandidateList(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
  );
  const derivedCandidates = await fetchDerivedCandidateListReport(db, equivalenceQuery);
  assert.deepEqual(derivedCandidates.items, directCandidates.items);
  assert.ok(derivedCandidates.items.every((item) => item.alias.startsWith('Кандидат ')));
  assert.doesNotMatch(JSON.stringify(derivedCandidates), /Иван Иванов|Кандидат К\./u);
  const firstCandidatePage = await fetchDerivedCandidateListReport(
    db,
    { ...equivalenceQuery, questionKind: 'all', limit: 1, cursorOffset: 0 },
  );
  assert.ok(firstCandidatePage.nextCursor);
  const secondCandidatePage = await fetchDerivedCandidateListReport(
    db,
    { ...equivalenceQuery, questionKind: 'all', limit: 1, cursorOffset: 1 },
  );
  assert.notEqual(firstCandidatePage.items[0].attemptId, secondCandidatePage.items[0].attemptId);
  assert.equal(secondCandidatePage.nextCursor, null);
  assert.deepEqual(
    (await fetchTopicReport(db, equivalenceQuery)).items,
    buildTopicList(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
  );
  assert.deepEqual(
    (await fetchDerivedTopicReport(db, equivalenceQuery)).items,
    (await fetchTopicReport(db, equivalenceQuery)).items,
  );
  assert.deepEqual(
    (await fetchDifficultyReport(db, equivalenceQuery)).items,
    buildDifficultyList(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
  );
  assert.deepEqual(
    (await fetchDerivedDifficultyReport(db, equivalenceQuery)).items,
    (await fetchDifficultyReport(db, equivalenceQuery)).items,
  );
  assert.deepEqual(
    (await fetchTrendsReport(db, equivalenceQuery)).items,
    buildTrends(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
  );
  const attemptLevelQuery = { ...equivalenceQuery, questionKind: 'all' as const };
  const derivedTrends = await fetchDerivedTrendsReport(db, attemptLevelQuery);
  assert.deepEqual(
    derivedTrends.items,
    (await fetchTrendsReport(db, attemptLevelQuery)).items,
  );
  assert.equal(derivedTrends.items[0].medianScore, 62.5);
  assert.deepEqual(derivedTrends.items[0].verdicts, { PASS: 2, REVIEW: 0, FAIL: 0 });
  assert.equal(derivedTrends.items[0].medianDurationSeconds, 30);
  assert.equal(derivedTrends.items[0].topics[0].key, 'Сети');
  assert.equal(derivedTrends.items[0].difficulties[0].key, 'easy');
  assert.deepEqual(
    (await fetchRevisionsReport(db, equivalenceQuery)).items,
    buildRevisions(equivalenceQuery, equivalenceAttempts, equivalenceFacts).items,
  );
  const historyQuery = {
    ...attemptLevelQuery,
    from: null,
    to: null,
    fromMs: null,
    toExclusiveMs: null,
    bankRevision: null,
  };
  const revisionHistory = await fetchDerivedRevisionsReport(db, attemptLevelQuery);
  assert.deepEqual(
    revisionHistory.items,
    (await fetchRevisionsReport(db, historyQuery)).items,
  );
  assert.ok(
    revisionHistory.items.some((item) => item.revision === revisionC),
    'revision history is not truncated to the parser default 30-day period',
  );
  const overviewAttempts = await fetchOverviewAttempts(db, attemptLevelQuery);
  const directOverview = await fetchOverviewReport(db, attemptLevelQuery, now);
  const pureOverview = buildOverview(
    attemptLevelQuery,
    equivalenceAttempts,
    equivalenceFacts,
    overviewAttempts,
    now,
  );
  assert.deepEqual(directOverview.last30Days, pureOverview.last30Days);
  assert.deepEqual(directOverview.allTime, pureOverview.allTime);
  const derivedOverview = await fetchDerivedOverviewReport(db, attemptLevelQuery, now);
  assert.deepEqual(derivedOverview.last30Days, directOverview.last30Days);
  assert.deepEqual(derivedOverview.allTime, directOverview.allTime);
  assert.equal(derivedOverview.last30Days.attempts, 4);
  assert.equal(derivedOverview.allTime.attempts, 5, 'all-time ignores the selected 30-day window');
  assert.deepEqual(derivedOverview.last30Days.selectionComparison, {
    eligibleAttempts: 2,
    sampleSize: 1,
    actualCoverage: 55,
    shadowCoverage: 65,
    delta: 10,
    fallbackOrNullCount: 1,
    fallbackOrNullRate: 50,
  });
  const directPrint = await fetchCandidatePrintReport(db, equivalenceQuery, 'new-a');
  const purePrint = buildCandidatePrint(equivalenceAttempts, equivalenceFacts, 'new-a');
  assert.ok(directPrint && purePrint);
  assert.deepEqual(
    { ...directPrint, generatedAt: 'stable' },
    { ...purePrint, generatedAt: 'stable' },
  );
  const derivedPrint = await fetchDerivedCandidatePrintReport(db, equivalenceQuery, 'new-a');
  assert.deepEqual(derivedPrint, directPrint);
  assert.deepEqual(
    await fetchDerivedCandidatePrintReport(db, equivalenceQuery, 'new-a'),
    derivedPrint,
    'candidate JSON is byte-stable for an immutable attempt',
  );

  const allKindsQuery = { ...equivalenceQuery, questionKind: 'all' as const };
  const allKinds = await fetchDerivedQuestionListReport(db, allKindsQuery);
  const additionalOnly = await fetchDerivedQuestionListReport(
    db,
    { ...equivalenceQuery, questionKind: 'additional' as const },
  );
  assert.equal(allKinds.items[0].outcomeCount, 2);
  assert.equal(allKinds.items[0].base.resolved, 1);
  assert.equal(allKinds.items[0].additional.resolved, 1);
  assert.ok(allKinds.items[0].recommendation, 'all roles reuse base-only calibration');
  assert.equal(additionalOnly.items[0].quality.enabled, false);
  assert.equal(additionalOnly.items[0].discrimination, null);
  assert.equal(additionalOnly.items[0].recommendation, null);
  const allAttemptsCalibration = await fetchDerivedQuestionListReport(
    db,
    { ...equivalenceQuery, candidatePolicy: 'all' as const },
  );
  assert.equal(allAttemptsCalibration.items[0].quality.enabled, false);
  assert.equal(allAttemptsCalibration.items[0].discrimination, null);
  assert.equal(allAttemptsCalibration.items[0].recommendation, null);
  assert.deepEqual(
    await fetchDerivedQuestionListReport(db, allKindsQuery),
    allKinds,
    'aggregate reports reuse a deterministic builtAt generation timestamp',
  );
  const revisionComparison = await fetchDerivedRevisionComparisonReport(
    db,
    { ...allKindsQuery, bankRevision: null },
    revisionA,
    revisionB,
  );
  assert.equal(revisionComparison.left.attempts, 2);
  assert.equal(revisionComparison.right.attempts, 1);
  assert.equal(revisionComparison.left.meanScore, 62.5);
  assert.equal(revisionComparison.right.meanScore, 80);
  assert.equal(revisionComparison.deltas.meanScore, 17.5);

  const createdReview = await insertQuestionReview(db, 101, {
    revision: revisionA,
    decision: 'observe',
    note: 'Повторно проверить после 100 ответов.',
  }, 'session-fingerprint', now);
  assert.ok(createdReview);
  assert.equal(createdReview.decision, 'observe');
  assert.equal(await insertQuestionReview(db, 999, {
    revision: revisionA,
    decision: 'keep',
  }, null, now), null);
  const reviews = await fetchQuestionReviews(db, 101);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].revision, revisionA);
  assert.equal('admin_session_fingerprint' in reviews[0], false);

  let cacheBuilds = 0;
  const cachedProducer = async () => {
    cacheBuilds += 1;
    return { safeAggregate: cacheBuilds };
  };
  const firstCache = await cachedAnalyticsReport(
    db,
    'test-report',
    equivalenceQuery,
    cachedProducer,
  );
  const secondCache = await cachedAnalyticsReport(
    db,
    'test-report',
    equivalenceQuery,
    cachedProducer,
  );
  assert.equal(firstCache.cacheStatus, 'miss');
  assert.equal(secondCache.cacheStatus, 'hit');
  assert.deepEqual(secondCache.value, firstCache.value);
  assert.equal(cacheBuilds, 1);
  await invalidateAnalyticsAggregates(db, now + 1);
  const afterInvalidation = await cachedAnalyticsReport(
    db,
    'test-report',
    equivalenceQuery,
    cachedProducer,
  );
  assert.equal(afterInvalidation.cacheStatus, 'miss');
  assert.equal(cacheBuilds, 2, 'generation invalidation forces an idempotent rebuild');
  const generationBeforeMutation = await db.prepare(`SELECT generation
    FROM analytics_refresh_state WHERE id = 1`).first<{ generation: number }>();
  await db.prepare(`UPDATE attempts SET score = score + 1 WHERE id = 'new-a'`).run();
  const generationAfterMutation = await db.prepare(`SELECT generation
    FROM analytics_refresh_state WHERE id = 1`).first<{ generation: number }>();
  assert.equal(
    generationAfterMutation!.generation,
    generationBeforeMutation!.generation + 1,
    'completed-attempt trigger invalidates materialized reports',
  );
} finally {
  await miniflare.dispose();
}

console.log('Admin analytics tests passed.');
