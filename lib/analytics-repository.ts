import { ANALYTICS_FACTS_VERSION } from './test-config.ts';
import {
  eligibleAttemptsCte,
  type ParsedAnalyticsQuery,
  type AnalyticsSql,
} from './analytics-query.ts';
import type {
  CreateQuestionReviewDto,
  QuestionReviewDecision,
  QuestionReviewDto,
} from './analytics-contract.ts';

export type AnalyticsAttemptRow = {
  id: string;
  alias: string;
  candidateName?: string | null;
  bankRevision: string;
  appVersion: string;
  score: number;
  correctCount: number;
  wrongCount: number;
  verdict: 'PASS' | 'REVIEW' | 'FAIL';
  completedAt: number;
  durationSeconds: number;
  baseMaxScore: number;
};

export type AnalyticsOverviewAttemptRow = AnalyticsAttemptRow & {
  candidateKey: string;
  status: 'completed' | 'aborted';
  eventAt: number;
  selectionVersion?: number;
  selectionStrategy?: string;
  coverageScore?: number | null;
  shadowCoverageScore?: number | null;
};

export type AnalyticsFactRow = {
  attemptId: string;
  questionId: number;
  questionKind: 'base' | 'additional';
  ordinal: number;
  scoreValue: number;
  assignedAt: number;
  presentedAt: number | null;
  topic: string;
  dedupeKey: string;
  difficulty: string;
  active: boolean;
  prompt: string;
  contextType: string | null;
  context: string | null;
  choiceCount: number;
  correctIndex: number;
  answerId: number | null;
  factVersion: number | null;
  answerOrigin: string | null;
  canonicalSelectedIndex: number | null;
  awardedScore: number | null;
  isCorrect: boolean;
  timedOut: boolean;
  elapsedSeconds: number | null;
  answeredAt: number | null;
};

export async function resolveCurrentBankRevision(
  db: D1Database,
  query: ParsedAnalyticsQuery,
) {
  if (query.bankRevision) return query;
  const row = await db.prepare(`SELECT current_revision AS hash
    FROM question_bank_state WHERE id = 1`).first<{ hash: string }>();
  return row?.hash ? { ...query, bankRevision: row.hash } : null;
}

type RawAttempt = {
  id: string;
  candidate_name: string | null;
  public_alias: string;
  bank_revision: string;
  app_version: string;
  score: number;
  correct_count: number;
  wrong_count: number;
  verdict: 'PASS' | 'REVIEW' | 'FAIL';
  completed_at: number;
  duration_seconds: number;
  base_max_score: number;
};

function bind(statement: D1PreparedStatement, bindings: Array<string | number>) {
  return bindings.length ? statement.bind(...bindings) : statement;
}

function mapAttempt(row: RawAttempt): AnalyticsAttemptRow {
  return {
    id: row.id,
    alias: row.public_alias,
    candidateName: row.candidate_name,
    bankRevision: row.bank_revision,
    appVersion: row.app_version,
    score: row.score,
    correctCount: row.correct_count,
    wrongCount: row.wrong_count,
    verdict: row.verdict,
    completedAt: row.completed_at,
    durationSeconds: row.duration_seconds,
    baseMaxScore: row.base_max_score,
  };
}

export async function fetchAnalyticsAttempts(
  db: D1Database,
  query: ParsedAnalyticsQuery,
) {
  const statement = analyticsAttemptsStatement(query);
  const rows = await bind(db.prepare(statement.sql), statement.bindings).all<RawAttempt>();
  return rows.results.map(mapAttempt);
}

export function analyticsAttemptsStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const cohort = eligibleAttemptsCte(query);
  return {
    sql: `${cohort.sql}
    SELECT id, candidate_name, public_alias, bank_revision, app_version, score, correct_count,
      wrong_count, verdict, completed_at, duration_seconds, base_max_score
    FROM eligible_attempts
    ORDER BY completed_at DESC, id DESC`,
    bindings: cohort.bindings,
  };
}

type RawFact = {
  attempt_id: string;
  question_id: number;
  question_kind: 'base' | 'additional';
  ordinal: number;
  score_value: number;
  assigned_at: number;
  presented_at: number | null;
  topic: string;
  dedupe_key: string;
  difficulty: string;
  active: number;
  prompt: string;
  context_type: string | null;
  context_text: string | null;
  choice_count: number;
  correct_index: number;
  answer_id: number | null;
  fact_version: number | null;
  answer_origin: string | null;
  canonical_selected_index: number | null;
  awarded_score: number | null;
  is_correct: number | null;
  timed_out: number | null;
  elapsed_seconds: number | null;
  answered_at: number | null;
};

export async function fetchAnalyticsFacts(
  db: D1Database,
  query: ParsedAnalyticsQuery,
) {
  const statement = analyticsFactsStatement(query);
  const rows = await bind(db.prepare(statement.sql), statement.bindings).all<RawFact>();
  return rows.results.map((row): AnalyticsFactRow => ({
    attemptId: row.attempt_id,
    questionId: row.question_id,
    questionKind: row.question_kind,
    ordinal: row.ordinal,
    scoreValue: row.score_value,
    assignedAt: row.assigned_at,
    presentedAt: row.presented_at,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    difficulty: row.difficulty,
    active: row.active === 1,
    prompt: row.prompt,
    contextType: row.context_type,
    context: row.context_text,
    choiceCount: row.choice_count,
    correctIndex: row.correct_index,
    answerId: row.answer_id,
    factVersion: row.fact_version,
    answerOrigin: row.answer_origin,
    canonicalSelectedIndex: row.canonical_selected_index,
    awardedScore: row.awarded_score,
    isCorrect: row.is_correct === 1,
    timedOut: row.timed_out === 1,
    elapsedSeconds: row.elapsed_seconds,
    answeredAt: row.answered_at,
  }));
}

export function analyticsFactsStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const cohort = eligibleAttemptsCte(query);
  return {
    sql: `${cohort.sql}
    SELECT aq.attempt_id, aq.question_id, aq.question_kind, aq.ordinal,
      aq.score_value, aq.assigned_at, aq.presented_at,
      q.topic, q.dedupe_key, q.difficulty, qri.active,
      q.prompt, q.context_type, q.context_text,
      json_array_length(q.choices_json) AS choice_count, q.correct_index,
      a.id AS answer_id, a.fact_version, a.answer_origin,
      a.canonical_selected_index, a.awarded_score, a.is_correct, a.timed_out,
      a.elapsed_seconds, a.answered_at
    FROM eligible_attempts ea
    JOIN attempt_questions aq ON aq.attempt_id = ea.id
    JOIN questions q ON q.id = aq.question_id
    JOIN question_bank_revision_items qri
      ON qri.revision_hash = ea.bank_revision AND qri.question_id = aq.question_id
    LEFT JOIN answers a
      ON a.attempt_id = aq.attempt_id
      AND a.question_id = aq.question_id
      AND a.fact_version = ?
    ORDER BY aq.attempt_id, aq.ordinal`,
    bindings: [
      ...cohort.bindings,
      ANALYTICS_FACTS_VERSION,
    ],
  };
}

function overviewConditions(query: ParsedAnalyticsQuery) {
  const conditions = [
    "status IN ('completed','aborted')",
    'analytics_facts_version = ?',
    'scoring_version = ?',
    'test_config_id = ?',
    'test_profile_id = ?',
  ];
  const bindings: Array<string | number> = [
    ANALYTICS_FACTS_VERSION,
    query.scoringVersion,
    query.testConfigId,
    query.testProfileId,
  ];
  if (query.bankRevision) {
    conditions.push('bank_revision = ?');
    bindings.push(query.bankRevision);
  }
  if (query.appVersion) {
    conditions.push('app_version = ?');
    bindings.push(query.appVersion);
  }
  return { conditions, bindings };
}

type RawOverviewAttempt = Omit<RawAttempt, 'completed_at' | 'duration_seconds' | 'verdict'> & {
  candidate_key: string;
  status: 'completed' | 'aborted';
  completed_at: number | null;
  duration_seconds: number | null;
  verdict: 'PASS' | 'REVIEW' | 'FAIL' | null;
  event_at: number;
  selection_version: number;
  selection_strategy: string;
  coverage_score: number | null;
  shadow_coverage_score: number | null;
};

export async function fetchOverviewAttempts(
  db: D1Database,
  query: ParsedAnalyticsQuery,
) {
  const statement = overviewAttemptsStatement(query);
  const rows = await bind(db.prepare(statement.sql), statement.bindings)
    .all<RawOverviewAttempt>();
  return rows.results.map((row): AnalyticsOverviewAttemptRow => ({
    ...mapAttempt({
      ...row,
      completed_at: row.completed_at ?? 0,
      duration_seconds: row.duration_seconds ?? 0,
      verdict: row.verdict ?? 'FAIL',
    }),
    candidateKey: row.candidate_key,
    status: row.status,
    eventAt: row.event_at,
    selectionVersion: row.selection_version,
    selectionStrategy: row.selection_strategy,
    coverageScore: row.coverage_score,
    shadowCoverageScore: row.shadow_coverage_score,
  }));
}

export function overviewAttemptsStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const filter = overviewConditions(query);
  return {
    sql: `SELECT id, candidate_key, public_alias,
      bank_revision, app_version, score, correct_count, wrong_count, verdict,
      completed_at, duration_seconds, base_max_score, status,
      selection_version, selection_strategy, coverage_score, shadow_coverage_score,
      COALESCE(completed_at, started_at) AS event_at
    FROM attempts
    WHERE ${filter.conditions.join(' AND ')}
    ORDER BY COALESCE(completed_at, started_at) DESC, id DESC`,
    bindings: filter.bindings,
  };
}

function reviewRow(row: {
  id: number;
  bank_revision: string;
  decision: QuestionReviewDecision;
  note: string | null;
  created_at: number;
}): QuestionReviewDto {
  return {
    id: row.id,
    revision: row.bank_revision,
    decision: row.decision,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function fetchQuestionReviews(db: D1Database, questionId: number) {
  try {
    const rows = await db.prepare(`SELECT id, bank_revision, decision, note, created_at
      FROM question_review_history WHERE question_id = ?
      ORDER BY created_at DESC, id DESC`).bind(questionId).all<{
        id: number;
        bank_revision: string;
        decision: QuestionReviewDecision;
        note: string | null;
        created_at: number;
      }>();
    return rows.results.map(reviewRow);
  } catch {
    return [];
  }
}

export async function insertQuestionReview(
  db: D1Database,
  questionId: number,
  input: CreateQuestionReviewDto,
  sessionFingerprint: string | null,
  now = Date.now(),
) {
  const result = await db.prepare(`INSERT INTO question_review_history (
      question_id, bank_revision, decision, note, created_at, admin_session_fingerprint
    ) SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM questions WHERE id = ?)
        AND EXISTS (SELECT 1 FROM question_bank_revisions WHERE hash = ?)
        AND EXISTS (
          SELECT 1 FROM question_bank_revision_items
          WHERE revision_hash = ? AND question_id = ?
        )`)
    .bind(
      questionId,
      input.revision,
      input.decision,
      input.note ?? null,
      now,
      sessionFingerprint,
      questionId,
      input.revision,
      input.revision,
      questionId,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  const id = Number(result.meta.last_row_id);
  const row = await db.prepare(`SELECT id, bank_revision, decision, note, created_at
    FROM question_review_history WHERE id = ?`).bind(id).first<{
      id: number;
      bank_revision: string;
      decision: QuestionReviewDecision;
      note: string | null;
      created_at: number;
    }>();
  return row ? reviewRow(row) : null;
}
