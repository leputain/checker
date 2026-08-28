import { calculateAccuracy } from './scoring.ts';
import { analyticsAggregateState } from './analytics-aggregate-store.ts';
import {
  analyticsCursor,
  type AnalyticsSql,
  type ParsedAnalyticsQuery,
} from './analytics-query.ts';
import {
  buildQuestionItemsFromAggregates,
  fetchCandidatePrintReport,
  type RawChoiceAggregate,
  type RawQuestionAnalyticsItem,
  type RawQuestionAggregate,
} from './analytics-direct.ts';
import {
  analyticsReliability,
  median,
  roundedRate,
} from './analytics-math.ts';
import {
  buildAnalyticsCohort,
  buildOverview,
  buildRevisions,
  buildTrends,
  adminCandidateAlias,
  type AnalyticsCohortCounts,
} from './analytics-service.ts';
import type {
  AnalyticsAttemptRow,
  AnalyticsOverviewAttemptRow,
} from './analytics-repository.ts';
import type {
  AnalyticsListDto,
  AnalyticsOverviewDto,
  AnalyticsRevisionItemDto,
  AnalyticsRevisionComparisonDto,
  AnalyticsRevisionComparisonSideDto,
  AnalyticsTrendItemDto,
  AnalyticsTrendDimensionDto,
  CandidateAnalyticsItemDto,
  CandidatePrintDto,
  GroupAnalyticsItemDto,
  QuestionAnalyticsDetailDto,
} from './analytics-contract.ts';

function bind(db: D1Database, statement: AnalyticsSql) {
  const prepared = db.prepare(statement.sql);
  return statement.bindings.length ? prepared.bind(...statement.bindings) : prepared;
}

async function derivedCohort(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  counts: AnalyticsCohortCounts,
  calibrationEnabled: boolean,
) {
  const state = await analyticsAggregateState(db);
  return buildAnalyticsCohort(
    query,
    counts,
    calibrationEnabled,
    state.builtAt ?? 0,
  );
}

function aggregateConditions(
  query: ParsedAnalyticsQuery,
  alias: string,
  options: { policy?: 'query' | 'all'; question?: boolean; ignorePeriod?: boolean } = {},
) {
  const conditions = [
    `${alias}.policy = ?`,
    `${alias}.scoring_version = ?`,
    `${alias}.test_config_id = ?`,
    `${alias}.test_profile_id = ?`,
  ];
  const bindings: Array<string | number> = [
    options.policy === 'all' ? 'all' : query.candidatePolicy,
    query.scoringVersion,
    query.testConfigId,
    query.testProfileId,
  ];
  if (query.bankRevision) {
    conditions.push(`${alias}.bank_revision = ?`);
    bindings.push(query.bankRevision);
  }
  if (query.from && !options.ignorePeriod) {
    conditions.push(`${alias}.day >= ?`);
    bindings.push(query.from);
  }
  if (query.to && !options.ignorePeriod) {
    conditions.push(`${alias}.day <= ?`);
    bindings.push(query.to);
  }
  if (query.appVersion) {
    conditions.push(`${alias}.app_version = ?`);
    bindings.push(query.appVersion);
  }
  if (options.question) {
    if (query.questionKind !== 'all') {
      conditions.push(`${alias}.question_kind = ?`);
      bindings.push(query.questionKind);
    }
    if (query.topic) {
      conditions.push(`${alias}.topic = ?`);
      bindings.push(query.topic);
    }
    if (query.difficulty) {
      conditions.push(`${alias}.difficulty = ?`);
      bindings.push(query.difficulty);
    }
  }
  return { sql: conditions.join(' AND '), bindings };
}

function dimensionExists(query: ParsedAnalyticsQuery, candidateAlias: string) {
  const conditions = [`dimension.policy = ${candidateAlias}.policy`, `dimension.attempt_id = ${candidateAlias}.attempt_id`];
  const bindings: Array<string | number> = [];
  if (query.topic) {
    conditions.push('dimension.topic = ?');
    bindings.push(query.topic);
  }
  if (query.difficulty) {
    conditions.push('dimension.difficulty = ?');
    bindings.push(query.difficulty);
  }
  if (query.questionKind !== 'all') {
    conditions.push('dimension.question_kind = ?');
    bindings.push(query.questionKind);
  }
  const required = Boolean(query.topic || query.difficulty || query.questionKind !== 'all');
  return {
    sql: required
      ? `EXISTS (SELECT 1 FROM analytics_candidate_dimensions dimension
          WHERE ${conditions.join(' AND ')})`
      : '1 = 1',
    bindings,
  };
}

export async function fetchDerivedCohortCounts(
  db: D1Database,
  query: ParsedAnalyticsQuery,
): Promise<AnalyticsCohortCounts> {
  const candidate = aggregateConditions(query, 'candidate');
  const dimension = dimensionExists(query, 'candidate');
  const question = aggregateConditions(query, 'question_fact', { question: true });
  const [candidateRow, answerRow] = await Promise.all([
    bind(db, {
      sql: `SELECT COUNT(*) AS count FROM analytics_candidate_aggregates candidate
        WHERE ${candidate.sql} AND candidate.status = 'completed' AND ${dimension.sql}`,
      bindings: [...candidate.bindings, ...dimension.bindings],
    }).first<{ count: number }>(),
    bind(db, {
      sql: `SELECT COALESCE(SUM(question_fact.outcome_count), 0) AS count
        FROM analytics_daily_question_aggregates question_fact WHERE ${question.sql}`,
      bindings: question.bindings,
    }).first<{ count: number }>(),
  ]);
  return {
    eligibleAttempts: candidateRow?.count ?? 0,
    eligibleAnswers: answerRow?.count ?? 0,
  };
}

type TimingBucket = { key: string | number; elapsed_seconds: number; response_count: number };

function weightedMedian(rows: readonly TimingBucket[]) {
  const sorted = rows.toSorted((left, right) => left.elapsed_seconds - right.elapsed_seconds);
  const total = sorted.reduce((sum, row) => sum + row.response_count, 0);
  if (total === 0) return null;
  const leftTarget = Math.floor((total - 1) / 2) + 1;
  const rightTarget = Math.floor(total / 2) + 1;
  let cumulative = 0;
  let left: number | null = null;
  let right: number | null = null;
  for (const row of sorted) {
    cumulative += row.response_count;
    if (left === null && cumulative >= leftTarget) left = row.elapsed_seconds;
    if (right === null && cumulative >= rightTarget) {
      right = row.elapsed_seconds;
      break;
    }
  }
  return left === null || right === null ? null : Math.round(((left + right) / 2) * 10) / 10;
}

export function derivedQuestionAggregateStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const condition = aggregateConditions(query, 'daily', { question: true });
  return {
    sql: `SELECT daily.question_id, MIN(daily.topic) AS topic,
      MIN(daily.difficulty) AS difficulty, MIN(daily.active) AS active,
      MIN(q.prompt) AS prompt, MIN(q.context_type) AS context_type,
      MIN(q.context_text) AS context_text,
      json_array_length(MIN(q.choices_json)) AS choice_count,
      MIN(q.correct_index) AS correct_index,
      SUM(daily.assigned_count) AS assigned_count,
      SUM(daily.presented_count) AS presented_count,
      SUM(daily.outcome_count) AS outcome_count,
      SUM(daily.correct_count) AS correct_count,
      SUM(daily.timeout_count) AS timeout_count,
      SUM(daily.response_count) AS response_count,
      CASE WHEN SUM(daily.response_count) > 0
        THEN 1.0 * SUM(daily.elapsed_sum) / SUM(daily.response_count) END AS average_seconds,
      NULL AS median_seconds,
      MIN(daily.elapsed_min) AS min_seconds, MAX(daily.elapsed_max) AS max_seconds,
      MAX(daily.last_presented_at) AS last_presented_at,
      MAX(daily.last_answered_at) AS last_answered_at,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.assigned_count ELSE 0 END) AS base_assigned,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.presented_count ELSE 0 END) AS base_presented,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.outcome_count ELSE 0 END) AS base_resolved,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.correct_count ELSE 0 END) AS base_correct,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.incorrect_count ELSE 0 END) AS base_incorrect,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.timeout_count ELSE 0 END) AS base_timeout,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.earned_score ELSE 0 END) AS base_earned,
      SUM(CASE WHEN daily.question_kind = 'base' THEN daily.max_score ELSE 0 END) AS base_max,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.assigned_count ELSE 0 END) AS additional_assigned,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.presented_count ELSE 0 END) AS additional_presented,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.outcome_count ELSE 0 END) AS additional_resolved,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.correct_count ELSE 0 END) AS additional_correct,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.incorrect_count ELSE 0 END) AS additional_incorrect,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.timeout_count ELSE 0 END) AS additional_timeout,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.earned_score ELSE 0 END) AS additional_earned,
      SUM(CASE WHEN daily.question_kind = 'additional' THEN daily.max_score ELSE 0 END) AS additional_max,
      SUM(daily.discrimination_n) AS discrimination_n,
      SUM(daily.discrimination_sum_x) AS discrimination_sum_x,
      SUM(daily.discrimination_sum_y) AS discrimination_sum_y,
      SUM(daily.discrimination_sum_y2) AS discrimination_sum_y2,
      SUM(daily.discrimination_sum_xy) AS discrimination_sum_xy
    FROM analytics_daily_question_aggregates daily
    JOIN questions q ON q.id = daily.question_id
    WHERE ${condition.sql}
    GROUP BY daily.question_id ORDER BY daily.question_id`,
    bindings: condition.bindings,
  };
}

export function derivedTimingStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const condition = aggregateConditions(query, 'timing');
  const filters = [...condition.bindings];
  const extra: string[] = [];
  if (query.questionKind !== 'all') {
    extra.push('timing.question_kind = ?');
    filters.push(query.questionKind);
  }
  if (query.topic) {
    extra.push('q.topic = ?');
    filters.push(query.topic);
  }
  if (query.difficulty) {
    extra.push('q.difficulty = ?');
    filters.push(query.difficulty);
  }
  return {
    sql: `SELECT timing.question_id AS key, timing.elapsed_seconds,
      SUM(timing.response_count) AS response_count
    FROM analytics_daily_timing_aggregates timing
    JOIN questions q ON q.id = timing.question_id
    WHERE ${condition.sql}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}
    GROUP BY timing.question_id, timing.elapsed_seconds
    ORDER BY timing.question_id, timing.elapsed_seconds`,
    bindings: filters,
  };
}

export function derivedChoiceStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const condition = aggregateConditions(query, 'choice');
  const bindings = [...condition.bindings];
  const extra: string[] = [];
  if (query.questionKind !== 'all') {
    extra.push('choice.question_kind = ?');
    bindings.push(query.questionKind);
  }
  if (query.topic) {
    extra.push('q.topic = ?');
    bindings.push(query.topic);
  }
  if (query.difficulty) {
    extra.push('q.difficulty = ?');
    bindings.push(query.difficulty);
  }
  return {
    sql: `SELECT choice.question_id, choice.canonical_index,
      SUM(choice.selected_count) AS selected_count
    FROM analytics_daily_choice_aggregates choice
    JOIN questions q ON q.id = choice.question_id
    WHERE ${condition.sql}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}
    GROUP BY choice.question_id, choice.canonical_index
    ORDER BY choice.question_id, choice.canonical_index`,
    bindings,
  };
}

async function derivedQuestionItems(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled: boolean,
): Promise<RawQuestionAnalyticsItem[]> {
  if (
    calibrationEnabled
    && query.candidatePolicy === 'latest'
    && query.questionKind === 'all'
  ) {
    const [displayItems, baseItems] = await Promise.all([
      derivedQuestionItems(db, { ...query, qualityStatus: 'all' }, false),
      derivedQuestionItems(
        db,
        { ...query, questionKind: 'base', qualityStatus: 'all' },
        true,
      ),
    ]);
    const baseById = new Map(baseItems.map((item) => [item.questionId, item]));
    return displayItems.map((item) => {
      const calibration = baseById.get(item.questionId);
      return calibration ? {
        ...item,
        discrimination: calibration.discrimination,
        quality: calibration.quality,
        qualityWarnings: calibration.qualityWarnings,
        recommendation: calibration.recommendation,
      } : item;
    }).filter((item) => {
      if (query.qualityStatus === 'all') return true;
      if (query.qualityStatus === 'insufficient') return item.quality.status === 'insufficient';
      if (query.qualityStatus === 'healthy') return item.quality.status === 'good';
      return item.quality.status === 'observe' || item.quality.status === 'review';
    });
  }
  const [aggregateResult, timingResult, choiceResult] = await Promise.all([
    bind(db, derivedQuestionAggregateStatement(query)).all<RawQuestionAggregate>(),
    bind(db, derivedTimingStatement(query)).all<TimingBucket>(),
    bind(db, derivedChoiceStatement(query)).all<RawChoiceAggregate>(),
  ]);
  const timings = new Map<number, TimingBucket[]>();
  for (const row of timingResult.results) {
    const key = Number(row.key);
    const values = timings.get(key) ?? [];
    values.push(row);
    timings.set(key, values);
  }
  const rows = aggregateResult.results.map((row) => ({
    ...row,
    median_seconds: weightedMedian(timings.get(row.question_id) ?? []),
  }));
  return buildQuestionItemsFromAggregates(query, rows, choiceResult.results, calibrationEnabled);
}

export async function fetchDerivedQuestionListReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  const [allItems, counts] = await Promise.all([
    derivedQuestionItems(db, query, calibrationEnabled),
    fetchDerivedCohortCounts(db, query),
  ]);
  const items = allItems.slice(query.cursorOffset, query.cursorOffset + query.limit)
    .map((item) => {
      const { prompt, contextType, context, responseCount, choices, ...publicItem } = item;
      void [prompt, contextType, context, responseCount, choices];
      return publicItem;
    });
  const nextOffset = query.cursorOffset + items.length;
  return {
    cohort: await derivedCohort(db, query, counts, calibrationEnabled),
    items,
    nextCursor: nextOffset < allItems.length ? analyticsCursor(nextOffset) : null,
  };
}

export async function fetchDerivedQuestionDetailReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  questionId: number,
  calibrationEnabled = true,
): Promise<Omit<QuestionAnalyticsDetailDto, 'reviewHistory'> | null> {
  const items = await derivedQuestionItems(
    db,
    { ...query, qualityStatus: 'all' },
    calibrationEnabled,
  );
  const item = items.find((candidate) => candidate.questionId === questionId);
  return item ? { ...item, bankRevision: query.bankRevision! } : null;
}

type CandidateAggregateRow = {
  attempt_id: string;
  candidate_key: string;
  bank_revision: string;
  app_version: string;
  selection_version: number;
  selection_strategy: string;
  coverage_score: number | null;
  shadow_coverage_score: number | null;
  status: 'completed' | 'aborted';
  score: number;
  correct_count: number;
  wrong_count: number;
  verdict: 'PASS' | 'REVIEW' | 'FAIL' | null;
  completed_at: number | null;
  event_at: number;
  duration_seconds: number | null;
  base_answered: number;
  base_correct: number;
  additional_answered: number;
  additional_correct: number;
  timeout_count: number;
  total_count?: number;
};

export function derivedCandidateRowsStatement(
  query: ParsedAnalyticsQuery,
  options: {
    page?: boolean;
    policy?: 'query' | 'all';
    completedOnly?: boolean;
    ignorePeriod?: boolean;
  } = {},
) {
  const condition = aggregateConditions(query, 'candidate', {
    policy: options.policy,
    ignorePeriod: options.ignorePeriod,
  });
  const dimension = dimensionExists(query, 'candidate');
  const status = options.completedOnly === false ? '' : "AND candidate.status = 'completed'";
  const page = options.page
    ? 'ORDER BY candidate.completed_at DESC, candidate.attempt_id DESC LIMIT ? OFFSET ?'
    : 'ORDER BY candidate.event_at DESC, candidate.attempt_id DESC';
  return {
    sql: `SELECT candidate.attempt_id, candidate.candidate_key,
      candidate.bank_revision, candidate.app_version, candidate.status,
      candidate.selection_version, candidate.selection_strategy,
      candidate.coverage_score, candidate.shadow_coverage_score,
      candidate.score, candidate.correct_count, candidate.wrong_count,
      candidate.verdict, candidate.completed_at, candidate.event_at,
      candidate.duration_seconds, candidate.base_answered, candidate.base_correct,
      candidate.additional_answered, candidate.additional_correct,
      candidate.timeout_count${options.page ? ', COUNT(*) OVER () AS total_count' : ''}
      FROM analytics_candidate_aggregates candidate
      WHERE ${condition.sql} ${status} AND ${dimension.sql} ${page}`,
    bindings: [
      ...condition.bindings,
      ...dimension.bindings,
      ...(options.page ? [query.limit, query.cursorOffset] : []),
    ],
  } satisfies AnalyticsSql;
}

function candidateDto(row: CandidateAggregateRow): CandidateAnalyticsItemDto {
  return {
    attemptId: row.attempt_id,
    alias: adminCandidateAlias(row.attempt_id),
    completedAt: new Date(row.completed_at!).toISOString(),
    score: row.score,
    accuracy: calculateAccuracy(row.correct_count, row.wrong_count),
    verdict: row.verdict!,
    durationSeconds: row.duration_seconds ?? 0,
    baseAnswered: row.base_answered,
    baseCorrect: row.base_correct,
    additionalAnswered: row.additional_answered,
    additionalCorrect: row.additional_correct,
    timeoutCount: row.timeout_count,
  };
}

export async function fetchDerivedCandidateListReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  const [result, counts] = await Promise.all([
    bind(db, derivedCandidateRowsStatement(query, { page: true })).all<CandidateAggregateRow>(),
    fetchDerivedCohortCounts(db, query),
  ]);
  const items = result.results.map(candidateDto);
  const total = result.results[0]?.total_count ?? 0;
  const nextOffset = query.cursorOffset + items.length;
  return {
    cohort: await derivedCohort(db, query, counts, calibrationEnabled),
    items,
    nextCursor: nextOffset < total ? analyticsCursor(nextOffset) : null,
  };
}

export function fetchDerivedCandidatePrintReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  attemptId: string,
): Promise<CandidatePrintDto | null> {
  return fetchCandidatePrintReport(db, query, attemptId);
}

async function fetchDerivedGroupReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  dimension: 'topic' | 'difficulty',
  calibrationEnabled: boolean,
): Promise<AnalyticsListDto<GroupAnalyticsItemDto>> {
  const condition = aggregateConditions(query, 'daily', { question: true });
  const column = dimension === 'topic' ? 'daily.topic' : 'daily.difficulty';
  const aggregates = await bind(db, {
    sql: `SELECT ${column} AS group_key,
      SUM(daily.outcome_count) AS sample_size,
      SUM(daily.correct_count) AS correct_count,
      SUM(daily.timeout_count) AS timeout_count
    FROM analytics_daily_question_aggregates daily WHERE ${condition.sql}
    GROUP BY ${column} ORDER BY ${column}`,
    bindings: condition.bindings,
  }).all<{ group_key: string; sample_size: number; correct_count: number; timeout_count: number }>();
  const timingCondition = aggregateConditions(query, 'timing');
  const timingBindings = [...timingCondition.bindings];
  const extra: string[] = [];
  if (query.questionKind !== 'all') {
    extra.push('timing.question_kind = ?');
    timingBindings.push(query.questionKind);
  }
  if (query.topic) {
    extra.push('q.topic = ?');
    timingBindings.push(query.topic);
  }
  if (query.difficulty) {
    extra.push('q.difficulty = ?');
    timingBindings.push(query.difficulty);
  }
  const groupColumn = dimension === 'topic' ? 'q.topic' : 'q.difficulty';
  const timingRows = await bind(db, {
    sql: `SELECT ${groupColumn} AS key, timing.elapsed_seconds,
      SUM(timing.response_count) AS response_count
    FROM analytics_daily_timing_aggregates timing
    JOIN questions q ON q.id = timing.question_id
    WHERE ${timingCondition.sql}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}
    GROUP BY ${groupColumn}, timing.elapsed_seconds
    ORDER BY ${groupColumn}, timing.elapsed_seconds`,
    bindings: timingBindings,
  }).all<TimingBucket>();
  const timings = new Map<string, TimingBucket[]>();
  for (const row of timingRows.results) {
    const key = String(row.key);
    const values = timings.get(key) ?? [];
    values.push(row);
    timings.set(key, values);
  }
  const counts = await fetchDerivedCohortCounts(db, query);
  return {
    cohort: await derivedCohort(db, query, counts, calibrationEnabled),
    items: aggregates.results.map((row) => ({
      key: row.group_key,
      kind: query.questionKind,
      sampleSize: row.sample_size,
      successRate: row.sample_size >= query.minSample
        ? roundedRate(row.correct_count, row.sample_size) : null,
      timeoutRate: row.sample_size >= query.minSample
        ? roundedRate(row.timeout_count, row.sample_size) : null,
      medianSeconds: row.sample_size >= query.minSample
        ? weightedMedian(timings.get(row.group_key) ?? []) : null,
      reliability: analyticsReliability(row.sample_size),
    })),
  };
}

export function fetchDerivedTopicReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  return fetchDerivedGroupReport(db, query, 'topic', calibrationEnabled);
}

export function fetchDerivedDifficultyReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  return fetchDerivedGroupReport(db, query, 'difficulty', calibrationEnabled);
}

function aggregateAttempt(row: CandidateAggregateRow): AnalyticsAttemptRow {
  return {
    id: row.attempt_id,
    alias: adminCandidateAlias(row.attempt_id),
    bankRevision: row.bank_revision,
    appVersion: row.app_version,
    score: row.score,
    correctCount: row.correct_count,
    wrongCount: row.wrong_count,
    verdict: row.verdict ?? 'FAIL',
    completedAt: row.completed_at ?? 0,
    durationSeconds: row.duration_seconds ?? 0,
    baseMaxScore: 100,
  };
}

export async function fetchDerivedOverviewReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  now = Date.now(),
  calibrationEnabled = true,
): Promise<AnalyticsOverviewDto> {
  const [rows, counts] = await Promise.all([
    bind(db, derivedCandidateRowsStatement(query, {
      policy: 'all',
      completedOnly: false,
      ignorePeriod: true,
    }))
      .all<CandidateAggregateRow>(),
    fetchDerivedCohortCounts(db, query),
  ]);
  const overviewRows: AnalyticsOverviewAttemptRow[] = rows.results.map((row) => ({
    ...aggregateAttempt(row),
    candidateKey: row.candidate_key,
    status: row.status,
    eventAt: row.event_at,
    selectionVersion: row.selection_version,
    selectionStrategy: row.selection_strategy,
    coverageScore: row.coverage_score,
    shadowCoverageScore: row.shadow_coverage_score,
  }));
  const report = buildOverview(query, [], [], overviewRows, now, calibrationEnabled);
  return { ...report, cohort: await derivedCohort(db, query, counts, calibrationEnabled) };
}

export async function fetchDerivedTrendsReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
): Promise<AnalyticsListDto<AnalyticsTrendItemDto>> {
  const dailyCondition = aggregateConditions(query, 'daily', { question: true });
  const [rows, dailyRows, counts] = await Promise.all([
    bind(db, derivedCandidateRowsStatement(query)).all<CandidateAggregateRow>(),
    bind(db, {
      sql: `SELECT daily.day, daily.topic, daily.difficulty,
        SUM(daily.outcome_count) AS outcome_count,
        SUM(daily.correct_count) AS correct_count,
        SUM(daily.timeout_count) AS timeout_count
      FROM analytics_daily_question_aggregates daily
      WHERE ${dailyCondition.sql}
      GROUP BY daily.day, daily.topic, daily.difficulty
      ORDER BY daily.day, daily.topic, daily.difficulty`,
      bindings: dailyCondition.bindings,
    }).all<{
      day: string;
      topic: string;
      difficulty: string;
      outcome_count: number;
      correct_count: number;
      timeout_count: number;
    }>(),
    fetchDerivedCohortCounts(db, query),
  ]);
  const report = buildTrends(query, rows.results.map(aggregateAttempt), [], calibrationEnabled);
  const dimensions = (field: 'topic' | 'difficulty') => {
    const byDay = new Map<string, Map<string, {
      outcomes: number;
      correct: number;
      timeout: number;
    }>>();
    for (const row of dailyRows.results) {
      const groups = byDay.get(row.day) ?? new Map();
      const key = row[field];
      const aggregate = groups.get(key) ?? { outcomes: 0, correct: 0, timeout: 0 };
      aggregate.outcomes += row.outcome_count;
      aggregate.correct += row.correct_count;
      aggregate.timeout += row.timeout_count;
      groups.set(key, aggregate);
      byDay.set(row.day, groups);
    }
    return new Map([...byDay].map(([day, groups]) => [
      day,
      [...groups].map(([key, aggregate]): AnalyticsTrendDimensionDto => ({
        key,
        outcomeCount: aggregate.outcomes,
        successRate: aggregate.outcomes >= query.minSample
          ? roundedRate(aggregate.correct, aggregate.outcomes) : null,
        timeoutRate: aggregate.outcomes >= query.minSample
          ? roundedRate(aggregate.timeout, aggregate.outcomes) : null,
      })).toSorted((left, right) => left.key.localeCompare(right.key, 'ru')),
    ]));
  };
  const topics = dimensions('topic');
  const difficulties = dimensions('difficulty');
  return {
    ...report,
    cohort: await derivedCohort(db, query, counts, calibrationEnabled),
    items: report.items.map((item) => ({
      ...item,
      topics: topics.get(item.date) ?? [],
      difficulties: difficulties.get(item.date) ?? [],
    })),
  };
}

export async function fetchDerivedRevisionsReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
): Promise<AnalyticsListDto<AnalyticsRevisionItemDto>> {
  const historyQuery: ParsedAnalyticsQuery = {
    ...query,
    from: null,
    to: null,
    fromMs: null,
    toExclusiveMs: null,
    bankRevision: null,
    questionKind: 'all',
    qualityStatus: 'all',
  };
  const [rows, counts] = await Promise.all([
    bind(db, derivedCandidateRowsStatement(historyQuery, { ignorePeriod: true }))
      .all<CandidateAggregateRow>(),
    fetchDerivedCohortCounts(db, historyQuery),
  ]);
  const report = buildRevisions(
    historyQuery,
    rows.results.map(aggregateAttempt),
    [],
    calibrationEnabled,
  );
  return {
    ...report,
    cohort: await derivedCohort(db, historyQuery, counts, calibrationEnabled),
  };
}

function roundMean(values: readonly number[]) {
  return values.length === 0
    ? null
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function revisionComparisonSide(
  revision: string,
  rows: readonly CandidateAggregateRow[],
): AnalyticsRevisionComparisonSideDto {
  const scores = rows.map((row) => row.score);
  const accuracies = rows.map((row) => calculateAccuracy(row.correct_count, row.wrong_count));
  const durations = rows.map((row) => row.duration_seconds ?? 0);
  return {
    revision,
    attempts: rows.length,
    meanScore: roundMean(scores),
    medianScore: median(scores),
    meanAccuracy: roundMean(accuracies),
    medianAccuracy: median(accuracies),
    meanDurationSeconds: roundMean(durations),
    medianDurationSeconds: median(durations),
    verdicts: {
      PASS: rows.filter((row) => row.verdict === 'PASS').length,
      REVIEW: rows.filter((row) => row.verdict === 'REVIEW').length,
      FAIL: rows.filter((row) => row.verdict === 'FAIL').length,
    },
  };
}

function nullableDelta(right: number | null, left: number | null) {
  return right === null || left === null ? null : Math.round((right - left) * 10) / 10;
}

export async function fetchDerivedRevisionComparisonReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  leftRevision: string,
  rightRevision: string,
  calibrationEnabled = true,
): Promise<AnalyticsRevisionComparisonDto> {
  const comparisonQuery = {
    ...query,
    bankRevision: null,
    questionKind: 'all' as const,
    qualityStatus: 'all' as const,
  };
  const [leftRows, rightRows, counts] = await Promise.all([
    bind(db, derivedCandidateRowsStatement({ ...comparisonQuery, bankRevision: leftRevision }))
      .all<CandidateAggregateRow>(),
    bind(db, derivedCandidateRowsStatement({ ...comparisonQuery, bankRevision: rightRevision }))
      .all<CandidateAggregateRow>(),
    fetchDerivedCohortCounts(db, comparisonQuery),
  ]);
  const left = revisionComparisonSide(leftRevision, leftRows.results);
  const right = revisionComparisonSide(rightRevision, rightRows.results);
  return {
    cohort: await derivedCohort(db, comparisonQuery, counts, calibrationEnabled),
    left,
    right,
    deltas: {
      attempts: right.attempts - left.attempts,
      meanScore: nullableDelta(right.meanScore, left.meanScore),
      medianScore: nullableDelta(right.medianScore, left.medianScore),
      meanAccuracy: nullableDelta(right.meanAccuracy, left.meanAccuracy),
      medianAccuracy: nullableDelta(right.medianAccuracy, left.medianAccuracy),
      meanDurationSeconds: nullableDelta(right.meanDurationSeconds, left.meanDurationSeconds),
      medianDurationSeconds: nullableDelta(right.medianDurationSeconds, left.medianDurationSeconds),
      verdicts: {
        PASS: right.verdicts.PASS - left.verdicts.PASS,
        REVIEW: right.verdicts.REVIEW - left.verdicts.REVIEW,
        FAIL: right.verdicts.FAIL - left.verdicts.FAIL,
      },
    },
  };
}
