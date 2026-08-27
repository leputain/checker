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
  },
  (table) => [index('idx_questions_pool').on(table.active, table.difficulty)],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    publicAlias: text('public_alias').notNull(),
    status: text('status').notNull().default('active'),
    startedAt: integer('started_at').notNull(),
    totalDeadlineAt: integer('total_deadline_at').notNull(),
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
    index('idx_attempts_leaderboard').on(
      table.status,
      table.score,
      table.wrongCount,
      table.durationSeconds,
    ),
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
