import { ANALYTICS_FACTS_VERSION } from './test-config.ts';
import {
  ANALYTICS_AUTO_REFRESH_COOLDOWN_MS,
  ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS,
  ANALYTICS_REFRESH_LEASE_MS,
  analyticsAutoRefreshEligibility,
} from './analytics-refresh-policy.ts';

const PRESENTED_ORIGINS_SQL = "'submitted','question_timeout','total_timeout_presented'";
const RESOLVED_ORIGINS_SQL = `${PRESENTED_ORIGINS_SQL},'total_timeout_unshown'`;

const RANKED_COMPLETED_CTE = `WITH ranked_completed AS (
  SELECT attempts.*,
    ROW_NUMBER() OVER (
      PARTITION BY candidate_key, bank_revision, scoring_version, test_config_id, test_profile_id
      ORDER BY completed_at DESC, id DESC
    ) AS candidate_rank
  FROM attempts
  WHERE status = 'completed' AND analytics_facts_version = ${ANALYTICS_FACTS_VERSION}
    AND bank_revision IS NOT NULL
)`;

const SELECTED_COMPLETED_CTE = `${RANKED_COMPLETED_CTE}, selected_completed AS (
  SELECT 'all' AS policy, * FROM ranked_completed
  UNION ALL
  SELECT 'latest' AS policy, * FROM ranked_completed WHERE candidate_rank = 1
)`;

const exactResolved = `a.fact_version = ${ANALYTICS_FACTS_VERSION}
  AND a.answer_origin IN (${RESOLVED_ORIGINS_SQL})`;

const INSERT_CANDIDATES_SQL = `${RANKED_COMPLETED_CTE}, selected_attempts AS (
  SELECT 'all' AS policy, ranked_completed.* FROM ranked_completed
  UNION ALL
  SELECT 'latest' AS policy, ranked_completed.*
  FROM ranked_completed WHERE candidate_rank = 1
  UNION ALL
  SELECT 'all' AS policy, attempts.*, NULL AS candidate_rank FROM attempts
  WHERE status = 'aborted' AND analytics_facts_version = ${ANALYTICS_FACTS_VERSION}
    AND bank_revision IS NOT NULL
)
INSERT INTO analytics_candidate_aggregates (
  policy, attempt_id, candidate_key, display_alias, day, bank_revision, app_version,
  scoring_version, test_config_id, test_profile_id, selection_version,
  selection_strategy, coverage_score, shadow_coverage_score, status, score, correct_count,
  wrong_count, verdict, completed_at, event_at, duration_seconds, base_answered,
  base_correct, additional_answered, additional_correct, timeout_count
)
SELECT selected.policy, selected.id, selected.candidate_key,
  'Кандидат ' || UPPER(SUBSTR(REPLACE(selected.id, '-', ''), 1, 8)),
  strftime('%Y-%m-%d', COALESCE(selected.completed_at, selected.started_at) / 1000,
    'unixepoch', '+3 hours'),
  selected.bank_revision, selected.app_version, selected.scoring_version,
  selected.test_config_id, selected.test_profile_id, selected.selection_version,
  selected.selection_strategy, selected.coverage_score, selected.shadow_coverage_score,
  selected.status, selected.score,
  selected.correct_count, selected.wrong_count, selected.verdict, selected.completed_at,
  COALESCE(selected.completed_at, selected.started_at), selected.duration_seconds,
  SUM(CASE WHEN aq.question_kind = 'base' AND ${exactResolved}
    THEN 1 ELSE 0 END),
  SUM(CASE WHEN aq.question_kind = 'base' AND ${exactResolved}
    AND a.is_correct = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN aq.question_kind = 'additional' AND ${exactResolved}
    THEN 1 ELSE 0 END),
  SUM(CASE WHEN aq.question_kind = 'additional' AND ${exactResolved}
    AND a.is_correct = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN ${exactResolved} AND a.timed_out = 1 THEN 1 ELSE 0 END)
FROM selected_attempts selected
LEFT JOIN attempt_questions aq ON aq.attempt_id = selected.id
LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
GROUP BY selected.policy, selected.id`;

const SELECTED_FACTS_CTE = `${SELECTED_COMPLETED_CTE}, base_scores AS (
  SELECT selected.policy, selected.id AS attempt_id,
    SUM(CASE WHEN aq.question_kind = 'base' AND ${exactResolved}
      THEN COALESCE(a.awarded_score, 0) ELSE 0 END) AS base_awarded
  FROM selected_completed selected
  JOIN attempt_questions aq ON aq.attempt_id = selected.id
  LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
  GROUP BY selected.policy, selected.id
), selected_facts AS (
  SELECT selected.policy,
    strftime('%Y-%m-%d', selected.completed_at / 1000, 'unixepoch', '+3 hours') AS day,
    selected.bank_revision, selected.app_version, selected.scoring_version,
    selected.test_config_id, selected.test_profile_id, selected.id AS attempt_id,
    selected.base_max_score, aq.question_id, aq.question_kind, aq.score_value,
    aq.presented_at, q.topic, q.difficulty, qri.active, q.correct_index,
    a.id AS answer_id, a.fact_version, a.answer_origin, a.canonical_selected_index,
    a.awarded_score, a.is_correct, a.timed_out, a.elapsed_seconds, a.answered_at,
    base_scores.base_awarded
  FROM selected_completed selected
  JOIN base_scores ON base_scores.policy = selected.policy
    AND base_scores.attempt_id = selected.id
  JOIN attempt_questions aq ON aq.attempt_id = selected.id
  JOIN questions q ON q.id = aq.question_id
  JOIN question_bank_revision_items qri
    ON qri.revision_hash = selected.bank_revision AND qri.question_id = aq.question_id
  LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
)`;

const restScore = `100.0 * (base_awarded - COALESCE(awarded_score, 0))
  / NULLIF(base_max_score - score_value, 0)`;

const INSERT_QUESTIONS_SQL = `${SELECTED_FACTS_CTE}
INSERT INTO analytics_daily_question_aggregates (
  policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, topic, difficulty, active,
  assigned_count, presented_count, outcome_count, correct_count, incorrect_count,
  timeout_count, response_count, elapsed_sum, elapsed_min, elapsed_max,
  last_presented_at, last_answered_at, earned_score, max_score,
  discrimination_n, discrimination_sum_x, discrimination_sum_y,
  discrimination_sum_y2, discrimination_sum_xy
)
SELECT policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, MIN(topic), MIN(difficulty), MIN(active),
  COUNT(*),
  SUM(CASE WHEN presented_at IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND is_correct = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND is_correct = 0
    AND timed_out = 0 THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND timed_out = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
    THEN 1 ELSE 0 END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
    THEN MIN(30, MAX(0, elapsed_seconds)) ELSE 0 END),
  MIN(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
    THEN MIN(30, MAX(0, elapsed_seconds)) END),
  MAX(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
    THEN MIN(30, MAX(0, elapsed_seconds)) END),
  MAX(presented_at),
  MAX(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) THEN answered_at END),
  SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
    THEN COALESCE(awarded_score, 0) ELSE 0 END),
  SUM(score_value),
  SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
    AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND base_max_score > score_value
    THEN 1 ELSE 0 END),
  SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
    AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND base_max_score > score_value
    THEN CASE WHEN is_correct = 1 THEN 1.0 ELSE 0.0 END ELSE 0 END),
  SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
    AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND base_max_score > score_value
    THEN ${restScore} ELSE 0 END),
  SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
    AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND base_max_score > score_value
    THEN (${restScore}) * (${restScore}) ELSE 0 END),
  SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
    AND fact_version = ${ANALYTICS_FACTS_VERSION}
    AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND base_max_score > score_value
    THEN (CASE WHEN is_correct = 1 THEN 1.0 ELSE 0.0 END) * (${restScore}) ELSE 0 END)
FROM selected_facts
GROUP BY policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind`;

const INSERT_CANDIDATE_DIMENSIONS_SQL = `${SELECTED_COMPLETED_CTE}
INSERT INTO analytics_candidate_dimensions (
  policy, attempt_id, topic, difficulty, question_kind
)
SELECT DISTINCT selected.policy, selected.id, q.topic, q.difficulty, aq.question_kind
FROM selected_completed selected
JOIN attempt_questions aq ON aq.attempt_id = selected.id
JOIN questions q ON q.id = aq.question_id`;

const INSERT_CHOICES_SQL = `${SELECTED_FACTS_CTE}
INSERT INTO analytics_daily_choice_aggregates (
  policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, canonical_index, selected_count
)
SELECT policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, canonical_selected_index, COUNT(*)
FROM selected_facts
WHERE presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
  AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
GROUP BY policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, canonical_selected_index`;

const INSERT_TIMINGS_SQL = `${SELECTED_FACTS_CTE}
INSERT INTO analytics_daily_timing_aggregates (
  policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, elapsed_seconds, response_count
)
SELECT policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind,
  MIN(30, MAX(0, elapsed_seconds)), COUNT(*)
FROM selected_facts
WHERE presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
  AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
GROUP BY policy, day, bank_revision, app_version, scoring_version, test_config_id,
  test_profile_id, question_id, question_kind, MIN(30, MAX(0, elapsed_seconds))`;

export type AnalyticsAggregateState = {
  generation: number;
  builtGeneration: number;
  updatedAt: number;
  builtAt: number | null;
  refreshAttemptedAt: number | null;
  refreshLeaseUntil: number | null;
  ready: boolean;
};

export async function analyticsAggregateState(db: D1Database): Promise<AnalyticsAggregateState> {
  const row = await db.prepare(`SELECT generation, built_generation, updated_at, built_at,
      refresh_attempted_at, refresh_lease_until
    FROM analytics_refresh_state WHERE id = 1`).first<{
      generation: number;
      built_generation: number;
      updated_at: number;
      built_at: number | null;
      refresh_attempted_at: number | null;
      refresh_lease_until: number | null;
    }>();
  if (!row) throw new Error('analytics_refresh_state_missing');
  return {
    generation: row.generation,
    builtGeneration: row.built_generation,
    updatedAt: row.updated_at,
    builtAt: row.built_at,
    refreshAttemptedAt: row.refresh_attempted_at,
    refreshLeaseUntil: row.refresh_lease_until,
    ready: row.generation === row.built_generation,
  };
}

export type AnalyticsRefreshClaim = {
  token: string;
  generation: number;
  startedAt: number;
  leaseUntil: number;
};

export class AnalyticsRefreshBusyError extends Error {
  constructor() {
    super('analytics_aggregate_refresh_in_progress');
    this.name = 'AnalyticsRefreshBusyError';
  }
}

export class AnalyticsRefreshGenerationChangedError extends Error {
  constructor() {
    super('analytics_aggregate_generation_changed');
    this.name = 'AnalyticsRefreshGenerationChangedError';
  }
}

type RefreshClaimOptions = {
  now: number;
  mode: 'auto' | 'manual';
  debounceMs?: number;
  cooldownMs?: number;
  leaseMs?: number;
};

/** @internal Shared by the maintenance path and generation-race integration tests. */
export async function claimAnalyticsAggregateRefresh(
  db: D1Database,
  options: RefreshClaimOptions,
): Promise<AnalyticsRefreshClaim | null> {
  const debounceMs = options.debounceMs ?? ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS;
  const cooldownMs = options.cooldownMs ?? ANALYTICS_AUTO_REFRESH_COOLDOWN_MS;
  const leaseMs = options.leaseMs ?? ANALYTICS_REFRESH_LEASE_MS;
  const token = crypto.randomUUID();
  const leaseUntil = options.now + leaseMs;
  const modePredicate = options.mode === 'auto'
    ? `AND generation <> built_generation
      AND updated_at <= ?
      AND COALESCE(refresh_attempted_at, 0) <= ?`
    : '';
  const bindings: unknown[] = [
    token,
    options.now,
    leaseUntil,
    options.now,
  ];
  if (options.mode === 'auto') {
    bindings.push(options.now - debounceMs, options.now - cooldownMs);
  }
  const row = await db.prepare(`UPDATE analytics_refresh_state
      SET refresh_token = ?, refresh_generation = generation,
        refresh_attempted_at = ?, refresh_lease_until = ?
      WHERE id = 1
        AND (refresh_token IS NULL OR refresh_lease_until IS NULL OR refresh_lease_until <= ?)
        ${modePredicate}
      RETURNING generation`)
    .bind(...bindings)
    .first<{ generation: number }>();
  return row
    ? { token, generation: row.generation, startedAt: options.now, leaseUntil }
    : null;
}

async function releaseAnalyticsRefreshClaim(db: D1Database, claim: AnalyticsRefreshClaim) {
  await db.prepare(`UPDATE analytics_refresh_state
      SET refresh_token = NULL, refresh_generation = NULL, refresh_lease_until = NULL
      WHERE id = 1 AND refresh_token = ?`)
    .bind(claim.token)
    .run();
}

function refreshClaimGuard(db: D1Database, claim: AnalyticsRefreshClaim) {
  // A failed optimistic guard deliberately violates the singleton primary key.
  // Because D1 batch is transactional, this aborts before a stale worker can
  // replace the last complete persisted snapshot.
  return db.prepare(`INSERT INTO analytics_refresh_state (
      id, generation, built_generation, updated_at
    )
    SELECT 1, 0, 0, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM analytics_refresh_state
      WHERE id = 1 AND generation = ? AND refresh_generation = ? AND refresh_token = ?
    )`).bind(claim.generation, claim.generation, claim.token);
}

/** @internal The caller must own the persisted refresh claim. */
export async function rebuildClaimedAnalyticsAggregates(
  db: D1Database,
  claim: AnalyticsRefreshClaim,
  now = Date.now(),
) {
  const startedAt = performance.now();
  try {
    await db.batch([
      refreshClaimGuard(db, claim),
      db.prepare('DELETE FROM analytics_candidate_aggregates'),
      db.prepare('DELETE FROM analytics_candidate_dimensions'),
      db.prepare('DELETE FROM analytics_daily_question_aggregates'),
      db.prepare('DELETE FROM analytics_daily_choice_aggregates'),
      db.prepare('DELETE FROM analytics_daily_timing_aggregates'),
      db.prepare(INSERT_CANDIDATES_SQL),
      db.prepare(INSERT_CANDIDATE_DIMENSIONS_SQL),
      db.prepare(INSERT_QUESTIONS_SQL),
      db.prepare(INSERT_CHOICES_SQL),
      db.prepare(INSERT_TIMINGS_SQL),
      refreshClaimGuard(db, claim),
      db.prepare(`UPDATE analytics_refresh_state
        SET built_generation = ?, built_at = ?, refresh_token = NULL,
          refresh_generation = NULL, refresh_lease_until = NULL
        WHERE id = 1 AND generation = ? AND refresh_generation = ? AND refresh_token = ?`)
        .bind(claim.generation, now, claim.generation, claim.generation, claim.token),
      db.prepare('DELETE FROM analytics_report_aggregates'),
    ]);
  } catch (error) {
    const state = await db.prepare(`SELECT generation, refresh_generation, refresh_token
      FROM analytics_refresh_state WHERE id = 1`).first<{
        generation: number;
        refresh_generation: number | null;
        refresh_token: string | null;
      }>();
    if (
      !state ||
      state.generation !== claim.generation ||
      state.refresh_generation !== claim.generation ||
      state.refresh_token !== claim.token
    ) {
      throw new AnalyticsRefreshGenerationChangedError();
    }
    throw error;
  }
  const state = await analyticsAggregateState(db);
  if (!state.ready || state.builtGeneration !== claim.generation) {
    throw new AnalyticsRefreshGenerationChangedError();
  }
  const [candidates, dimensions, questions, choices, timings] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM analytics_candidate_aggregates')
      .first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM analytics_candidate_dimensions')
      .first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM analytics_daily_question_aggregates')
      .first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM analytics_daily_choice_aggregates')
      .first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM analytics_daily_timing_aggregates')
      .first<{ count: number }>(),
  ]);
  return {
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    generation: state.generation,
    rows: {
      candidates: candidates?.count ?? 0,
      dimensions: dimensions?.count ?? 0,
      questions: questions?.count ?? 0,
      choices: choices?.count ?? 0,
      timings: timings?.count ?? 0,
    },
  };
}

export async function rebuildAnalyticsAggregates(db: D1Database, now = Date.now()) {
  const claim = await claimAnalyticsAggregateRefresh(db, { mode: 'manual', now });
  if (!claim) throw new AnalyticsRefreshBusyError();
  try {
    return await rebuildClaimedAnalyticsAggregates(db, claim, now);
  } finally {
    await releaseAnalyticsRefreshClaim(db, claim);
  }
}

export type AnalyticsAutoRefreshResult =
  | { status: 'fresh'; generation: number }
  | { status: 'deferred'; generation: number; nextEligibleAt: number }
  | { status: 'busy'; generation: number; nextEligibleAt: number }
  | { status: 'rebuilt'; generation: number; durationMs: number }
  | { status: 'failed'; generation: number; nextEligibleAt: number };

export async function maintainAnalyticsAggregates(
  db: D1Database,
  options: {
    now?: number;
    debounceMs?: number;
    cooldownMs?: number;
    leaseMs?: number;
  } = {},
): Promise<AnalyticsAutoRefreshResult> {
  const now = options.now ?? Date.now();
  const debounceMs = options.debounceMs ?? ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS;
  const cooldownMs = options.cooldownMs ?? ANALYTICS_AUTO_REFRESH_COOLDOWN_MS;
  let state = await analyticsAggregateState(db);
  let eligibility = analyticsAutoRefreshEligibility({
    ...state,
    now,
    debounceMs,
    cooldownMs,
  });
  if (!eligibility.eligible) {
    if (eligibility.reason === 'fresh') {
      return { status: 'fresh', generation: state.generation };
    }
    return {
      status: 'deferred',
      generation: state.generation,
      nextEligibleAt: eligibility.nextEligibleAt,
    };
  }

  const claim = await claimAnalyticsAggregateRefresh(db, {
    mode: 'auto',
    now,
    debounceMs,
    cooldownMs,
    leaseMs: options.leaseMs,
  });
  if (!claim) {
    state = await analyticsAggregateState(db);
    eligibility = analyticsAutoRefreshEligibility({
      ...state,
      now,
      debounceMs,
      cooldownMs,
    });
    if (!eligibility.eligible) {
      if (eligibility.reason === 'fresh') {
        return { status: 'fresh', generation: state.generation };
      }
      return {
        status: 'deferred',
        generation: state.generation,
        nextEligibleAt: eligibility.nextEligibleAt,
      };
    }
    return {
      status: 'busy',
      generation: state.generation,
      nextEligibleAt: Math.max(state.refreshLeaseUntil ?? now, now),
    };
  }

  try {
    const rebuilt = await rebuildClaimedAnalyticsAggregates(db, claim, now);
    return {
      status: 'rebuilt',
      generation: rebuilt.generation,
      durationMs: rebuilt.durationMs,
    };
  } catch {
    await releaseAnalyticsRefreshClaim(db, claim);
    state = await analyticsAggregateState(db);
    return {
      status: 'failed',
      generation: state.generation,
      nextEligibleAt: Math.max(
        state.updatedAt + debounceMs,
        (state.refreshAttemptedAt ?? now) + cooldownMs,
      ),
    };
  }
}
