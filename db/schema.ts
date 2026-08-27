import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const questions = sqliteTable(
  'questions',
  {
    id: integer('id').primaryKey(),
    difficulty: text('difficulty').notNull(),
    topic: text('topic').notNull().default('general'),
    prompt: text('prompt').notNull(),
    choicesJson: text('choices_json').notNull(),
    correctIndex: integer('correct_index').notNull(),
    weight: integer('weight').notNull(),
    active: integer('active').notNull().default(1),
    contentHash: text('content_hash'),
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
    publicAlias: text('public_alias').notNull(),
    bankRevision: text('bank_revision'),
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
  },
  (table) => [
    uniqueIndex('idx_answers_attempt_question').on(table.attemptId, table.questionId),
    index('idx_answers_question_id').on(table.questionId),
  ],
);

export const questionBankRevisions = sqliteTable('question_bank_revisions', {
  hash: text('hash').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
  totalCount: integer('total_count').notNull(),
  activeCount: integer('active_count').notNull(),
  poolsJson: text('pools_json').notNull(),
});

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
