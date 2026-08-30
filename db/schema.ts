import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const questions = sqliteTable(
  'questions',
  {
    id: integer('id').primaryKey(),
    difficulty: text('difficulty').notNull(),
    topic: text('topic').notNull().default('general'),
    prompt: text('prompt').notNull(),
    contextType: text('context_type'),
    contextText: text('context_text'),
    choicesJson: text('choices_json').notNull(),
    correctIndex: integer('correct_index').notNull(),
    weight: integer('weight').notNull(),
    active: integer('active').notNull().default(1),
    contentHash: text('content_hash'),
    dedupeKey: text('dedupe_key').notNull().default(''),
  },
  (table) => [index('idx_questions_pool').on(table.active, table.difficulty)],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    startKey: text('start_key'),
    candidateName: text('candidate_name'),
    candidateKey: text('candidate_key').notNull().default(''),
    publicAlias: text('public_alias').notNull(),
    bankRevision: text('bank_revision'),
    scoringVersion: integer('scoring_version').notNull().default(0),
    appVersion: text('app_version').notNull().default('legacy-unknown'),
    testConfigId: text('test_config_id').notNull().default('legacy-unknown'),
    testProfileId: text('test_profile_id').notNull().default('legacy-unknown'),
    analyticsFactsVersion: integer('analytics_facts_version').notNull().default(0),
    selectionVersion: integer('selection_version').notNull().default(0),
    selectionStrategy: text('selection_strategy').notNull().default('unknown'),
    coverageScore: real('coverage_score'),
    shadowCoverageScore: real('shadow_coverage_score'),
    telegramRootMessageId: integer('telegram_root_message_id'),
    status: text('status').notNull().default('active'),
    startedAt: integer('started_at').notNull(),
    totalDeadlineAt: integer('total_deadline_at').notNull(),
    currentQuestionStartedAt: integer('current_question_started_at').notNull().default(0),
    questionDeadlineAt: integer('question_deadline_at').notNull(),
    currentQuestionId: integer('current_question_id'),
    pendingQuestionIds: text('pending_question_ids').notNull(),
    askedQuestionIds: text('asked_question_ids').notNull(),
    baseQuestionIds: text('base_question_ids').notNull().default('[]'),
    baseMaxScore: integer('base_max_score').notNull().default(0),
    score: integer('score').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    wrongCount: integer('wrong_count').notNull().default(0),
    verdict: text('verdict'),
    completedAt: integer('completed_at'),
    durationSeconds: integer('duration_seconds'),
  },
  (table) => [
    // Drizzle 0.45 SQLite metadata cannot express index direction. Migration 0002
    // and runtime initialization create score DESC / wrong_count ASC / duration ASC.
    // Keep the same columns here so db:generate remains stable without churn.
    index('idx_attempts_leaderboard').on(
      table.status,
      table.score,
      table.wrongCount,
      table.durationSeconds,
    ),
    uniqueIndex('idx_attempts_start_key').on(table.startKey),
    index('idx_attempts_analytics_cohort').on(
      table.status,
      table.scoringVersion,
      table.testConfigId,
      table.testProfileId,
      table.completedAt,
    ),
    index('idx_attempts_analytics_latest').on(
      table.analyticsFactsVersion,
      table.status,
      table.scoringVersion,
      table.testConfigId,
      table.testProfileId,
      table.bankRevision,
      table.candidateKey,
      table.completedAt,
    ),
    index('idx_attempts_facts_readiness').on(
      table.analyticsFactsVersion,
      table.status,
      table.completedAt,
    ),
    index('idx_attempts_retention_started').on(table.status, table.startedAt),
    index('idx_attempts_retention_completed').on(table.status, table.completedAt),
  ],
);

export const answers = sqliteTable(
  'answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    attemptId: text('attempt_id').notNull(),
    questionId: integer('question_id').notNull(),
    selectedIndex: integer('selected_index'),
    isCorrect: integer('is_correct').notNull(),
    answeredAt: integer('answered_at').notNull(),
    elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
    timedOut: integer('timed_out').notNull().default(0),
    factVersion: integer('fact_version').notNull().default(0),
    answerOrigin: text('answer_origin').notNull().default('unknown'),
    canonicalSelectedIndex: integer('canonical_selected_index'),
    awardedScore: integer('awarded_score'),
  },
  (table) => [
    uniqueIndex('idx_answers_attempt_question').on(table.attemptId, table.questionId),
    index('idx_answers_question_id').on(table.questionId),
  ],
);

export const testConfigVersions = sqliteTable('test_config_versions', {
  id: text('id').primaryKey(),
  scoringVersion: integer('scoring_version').notNull(),
  configJson: text('config_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const attemptQuestions = sqliteTable(
  'attempt_questions',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id),
    questionKind: text('question_kind').notNull(),
    ordinal: integer('ordinal').notNull(),
    sourceQuestionId: integer('source_question_id').references(() => questions.id),
    scoreValue: integer('score_value').notNull(),
    assignedAt: integer('assigned_at').notNull(),
    presentedAt: integer('presented_at'),
  },
  (table) => [
    primaryKey({ columns: [table.attemptId, table.questionId] }),
    uniqueIndex('idx_attempt_questions_attempt_ordinal').on(table.attemptId, table.ordinal),
    index('idx_attempt_questions_question_presentation').on(table.questionId, table.presentedAt),
  ],
);

export const questionBankRevisions = sqliteTable('question_bank_revisions', {
  hash: text('hash').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
  totalCount: integer('total_count').notNull(),
  activeCount: integer('active_count').notNull(),
  poolsJson: text('pools_json').notNull(),
});

export const questionBankRevisionItems = sqliteTable(
  'question_bank_revision_items',
  {
    revisionHash: text('revision_hash')
      .notNull()
      .references(() => questionBankRevisions.hash, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id),
    active: integer('active').notNull(),
  },
  (table) => [primaryKey({ columns: [table.revisionHash, table.questionId] })],
);

export const questionBankState = sqliteTable('question_bank_state', {
  id: integer('id').primaryKey(),
  currentRevision: text('current_revision')
    .notNull()
    .references(() => questionBankRevisions.hash, { onDelete: 'restrict' }),
  updatedAt: integer('updated_at').notNull(),
});

export const questionVersionLinks = sqliteTable(
  'question_version_links',
  {
    predecessorQuestionId: integer('predecessor_question_id')
      .primaryKey()
      .references(() => questions.id, { onDelete: 'restrict' }),
    successorQuestionId: integer('successor_question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    bankRevision: text('bank_revision')
      .notNull()
      .references(() => questionBankRevisions.hash, { onDelete: 'restrict' }),
    adminSessionFingerprint: text('admin_session_fingerprint'),
  },
  (table) => [uniqueIndex('idx_question_version_links_successor').on(table.successorQuestionId)],
);

export const questionBankChangeEvents = sqliteTable(
  'question_bank_change_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type').notNull(),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    predecessorQuestionId: integer('predecessor_question_id')
      .references(() => questions.id, { onDelete: 'restrict' }),
    successorQuestionId: integer('successor_question_id')
      .references(() => questions.id, { onDelete: 'restrict' }),
    bankRevision: text('bank_revision')
      .notNull()
      .references(() => questionBankRevisions.hash, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull(),
    note: text('note'),
    adminSessionFingerprint: text('admin_session_fingerprint'),
  },
  (table) => [
    index('idx_question_bank_change_events_question').on(table.questionId, table.createdAt),
    index('idx_question_bank_change_events_predecessor').on(
      table.predecessorQuestionId,
      table.createdAt,
    ),
    index('idx_question_bank_change_events_successor').on(
      table.successorQuestionId,
      table.createdAt,
    ),
  ],
);

export const questionBankMutations = sqliteTable(
  'question_bank_mutations',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    operation: text('operation').notNull(),
    expectedRevision: text('expected_revision').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_question_bank_mutations_created_at').on(table.createdAt)],
);

export const questionReviewHistory = sqliteTable(
  'question_review_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id),
    bankRevision: text('bank_revision')
      .notNull()
      .references(() => questionBankRevisions.hash),
    decision: text('decision').notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    adminSessionFingerprint: text('admin_session_fingerprint'),
  },
  (table) => [index('idx_question_review_history_question').on(table.questionId, table.createdAt)],
);

export const analyticsRefreshState = sqliteTable('analytics_refresh_state', {
  id: integer('id').primaryKey(),
  generation: integer('generation').notNull().default(1),
  builtGeneration: integer('built_generation').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
  builtAt: integer('built_at'),
  refreshToken: text('refresh_token'),
  refreshGeneration: integer('refresh_generation'),
  refreshAttemptedAt: integer('refresh_attempted_at'),
  refreshLeaseUntil: integer('refresh_lease_until'),
});

export const analyticsReportAggregates = sqliteTable(
  'analytics_report_aggregates',
  {
    cacheKey: text('cache_key').primaryKey(),
    reportType: text('report_type').notNull(),
    generation: integer('generation').notNull(),
    periodFrom: text('period_from'),
    periodTo: text('period_to'),
    payloadJson: text('payload_json').notNull(),
    generatedAt: integer('generated_at').notNull(),
  },
  (table) => [
    index('idx_analytics_report_aggregates_type_period').on(
      table.reportType,
      table.periodFrom,
      table.periodTo,
    ),
  ],
);

export const analyticsCandidateAggregates = sqliteTable(
  'analytics_candidate_aggregates',
  {
    policy: text('policy').notNull(),
    attemptId: text('attempt_id').notNull(),
    candidateKey: text('candidate_key').notNull(),
    displayAlias: text('display_alias').notNull(),
    day: text('day').notNull(),
    bankRevision: text('bank_revision').notNull(),
    appVersion: text('app_version').notNull(),
    scoringVersion: integer('scoring_version').notNull(),
    testConfigId: text('test_config_id').notNull(),
    testProfileId: text('test_profile_id').notNull(),
    selectionVersion: integer('selection_version').notNull(),
    selectionStrategy: text('selection_strategy').notNull(),
    coverageScore: real('coverage_score'),
    shadowCoverageScore: real('shadow_coverage_score'),
    status: text('status').notNull(),
    score: integer('score').notNull(),
    correctCount: integer('correct_count').notNull(),
    wrongCount: integer('wrong_count').notNull(),
    verdict: text('verdict'),
    completedAt: integer('completed_at'),
    eventAt: integer('event_at').notNull(),
    durationSeconds: integer('duration_seconds'),
    baseAnswered: integer('base_answered').notNull(),
    baseCorrect: integer('base_correct').notNull(),
    additionalAnswered: integer('additional_answered').notNull(),
    additionalCorrect: integer('additional_correct').notNull(),
    timeoutCount: integer('timeout_count').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.policy, table.attemptId] }),
    index('idx_analytics_candidates_cohort_day').on(
      table.policy,
      table.scoringVersion,
      table.testConfigId,
      table.testProfileId,
      table.bankRevision,
      table.day,
      table.completedAt,
    ),
  ],
);

export const analyticsCandidateDimensions = sqliteTable(
  'analytics_candidate_dimensions',
  {
    policy: text('policy').notNull(),
    attemptId: text('attempt_id').notNull(),
    topic: text('topic').notNull(),
    difficulty: text('difficulty').notNull(),
    questionKind: text('question_kind').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.policy,
        table.attemptId,
        table.topic,
        table.difficulty,
        table.questionKind,
      ],
    }),
    index('idx_analytics_candidate_dimensions_filter').on(
      table.policy,
      table.topic,
      table.difficulty,
      table.questionKind,
      table.attemptId,
    ),
  ],
);

export const analyticsDailyQuestionAggregates = sqliteTable(
  'analytics_daily_question_aggregates',
  {
    policy: text('policy').notNull(),
    day: text('day').notNull(),
    bankRevision: text('bank_revision').notNull(),
    appVersion: text('app_version').notNull(),
    scoringVersion: integer('scoring_version').notNull(),
    testConfigId: text('test_config_id').notNull(),
    testProfileId: text('test_profile_id').notNull(),
    questionId: integer('question_id').notNull(),
    questionKind: text('question_kind').notNull(),
    topic: text('topic').notNull(),
    difficulty: text('difficulty').notNull(),
    active: integer('active').notNull(),
    assignedCount: integer('assigned_count').notNull(),
    presentedCount: integer('presented_count').notNull(),
    outcomeCount: integer('outcome_count').notNull(),
    correctCount: integer('correct_count').notNull(),
    incorrectCount: integer('incorrect_count').notNull(),
    timeoutCount: integer('timeout_count').notNull(),
    responseCount: integer('response_count').notNull(),
    elapsedSum: integer('elapsed_sum').notNull(),
    elapsedMin: integer('elapsed_min'),
    elapsedMax: integer('elapsed_max'),
    lastPresentedAt: integer('last_presented_at'),
    lastAnsweredAt: integer('last_answered_at'),
    earnedScore: integer('earned_score').notNull(),
    maxScore: integer('max_score').notNull(),
    discriminationN: integer('discrimination_n').notNull(),
    discriminationSumX: real('discrimination_sum_x').notNull(),
    discriminationSumY: real('discrimination_sum_y').notNull(),
    discriminationSumY2: real('discrimination_sum_y2').notNull(),
    discriminationSumXy: real('discrimination_sum_xy').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.policy,
        table.day,
        table.bankRevision,
        table.appVersion,
        table.scoringVersion,
        table.testConfigId,
        table.testProfileId,
        table.questionId,
        table.questionKind,
      ],
    }),
    index('idx_analytics_daily_questions_cohort').on(
      table.policy,
      table.scoringVersion,
      table.testConfigId,
      table.testProfileId,
      table.bankRevision,
      table.day,
    ),
  ],
);

export const analyticsDailyChoiceAggregates = sqliteTable(
  'analytics_daily_choice_aggregates',
  {
    policy: text('policy').notNull(),
    day: text('day').notNull(),
    bankRevision: text('bank_revision').notNull(),
    appVersion: text('app_version').notNull(),
    scoringVersion: integer('scoring_version').notNull(),
    testConfigId: text('test_config_id').notNull(),
    testProfileId: text('test_profile_id').notNull(),
    questionId: integer('question_id').notNull(),
    questionKind: text('question_kind').notNull(),
    canonicalIndex: integer('canonical_index').notNull(),
    selectedCount: integer('selected_count').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.policy,
        table.day,
        table.bankRevision,
        table.appVersion,
        table.scoringVersion,
        table.testConfigId,
        table.testProfileId,
        table.questionId,
        table.questionKind,
        table.canonicalIndex,
      ],
    }),
  ],
);

export const analyticsDailyTimingAggregates = sqliteTable(
  'analytics_daily_timing_aggregates',
  {
    policy: text('policy').notNull(),
    day: text('day').notNull(),
    bankRevision: text('bank_revision').notNull(),
    appVersion: text('app_version').notNull(),
    scoringVersion: integer('scoring_version').notNull(),
    testConfigId: text('test_config_id').notNull(),
    testProfileId: text('test_profile_id').notNull(),
    questionId: integer('question_id').notNull(),
    questionKind: text('question_kind').notNull(),
    elapsedSeconds: integer('elapsed_seconds').notNull(),
    responseCount: integer('response_count').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.policy,
        table.day,
        table.bankRevision,
        table.appVersion,
        table.scoringVersion,
        table.testConfigId,
        table.testProfileId,
        table.questionId,
        table.questionKind,
        table.elapsedSeconds,
      ],
    }),
  ],
);

export const telegramOutbox = sqliteTable(
  'telegram_outbox',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    questionId: integer('question_id'),
    eventType: text('event_type').notNull(),
    payloadText: text('payload_text').notNull(),
    deliveryMethod: text('delivery_method').notNull().default('send'),
    parseMode: text('parse_mode'),
    silent: integer('silent').notNull().default(0),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until'),
    telegramMessageId: integer('telegram_message_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at'),
  },
  (table) => [
    uniqueIndex('idx_telegram_outbox_attempt_event').on(
      table.attemptId,
      table.questionId,
      table.eventType,
    ),
    index('idx_telegram_outbox_pending').on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index('idx_telegram_outbox_retention').on(table.status, table.createdAt),
    index('idx_telegram_outbox_attempt_status').on(table.attemptId, table.status),
  ],
);

export const telegramDeliveryState = sqliteTable('telegram_delivery_state', {
  id: integer('id').primaryKey(),
  configFingerprint: text('config_fingerprint').notNull(),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  updatedAt: integer('updated_at').notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: integer('applied_at').notNull(),
});
