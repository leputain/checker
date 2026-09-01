import { loadAttemptQuestionReview } from '../db/attempt-review.ts';
import { calculateAccuracy } from './scoring.ts';
import {
  analyticsCursor,
  eligibleAttemptsCte,
  questionAnalyticsMatches,
  sortQuestionAnalyticsItems,
  type AnalyticsSql,
  type ParsedAnalyticsQuery,
} from './analytics-query.ts';
import {
  analyticsReliability,
  median,
  observedQuestionMetrics,
  pointBiserialFromSums,
  questionAnalyticsSignals,
  questionAnalyticsSummary,
  questionPromptPreview,
  questionQuality,
  questionRecommendation,
  questionSample,
  roundedRate,
} from './analytics-math.ts';
import {
  buildAnalyticsCohort,
  buildCandidatePrint,
  buildOverview,
  buildRevisions,
  buildTrends,
  adminCandidateAlias,
  type AnalyticsCohortCounts,
} from './analytics-service.ts';
import {
  fetchAnalyticsAttempts,
  fetchAnalyticsFacts,
  fetchOverviewAttempts,
  type AnalyticsAttemptRow,
  type AnalyticsFactRow,
} from './analytics-repository.ts';
import { ANALYTICS_FACTS_VERSION } from './test-config.ts';
import type {
  AnalyticsListDto,
  AnalyticsOverviewDto,
  AnalyticsRevisionItemDto,
  AnalyticsTrendItemDto,
  CandidateAnalyticsItemDto,
  CandidatePrintDto,
  GroupAnalyticsItemDto,
  QuestionAnalyticsDetailDto,
  QuestionAnalyticsItemDto,
  QuestionAnalyticsListDto,
  QuestionChoiceAnalyticsDto,
  QuestionKindSplitDto,
} from './analytics-contract.ts';
import { QUESTION_ANALYTICS_MODEL_VERSION } from './analytics-contract.ts';

const PRESENTED_ORIGINS_SQL = "'submitted','question_timeout','total_timeout_presented'";
const RESOLVED_ORIGINS_SQL = `${PRESENTED_ORIGINS_SQL},'total_timeout_unshown'`;

function bind(db: D1Database, statement: AnalyticsSql) {
  const prepared = db.prepare(statement.sql);
  return statement.bindings.length ? prepared.bind(...statement.bindings) : prepared;
}

function filters(query: ParsedAnalyticsQuery, questionAlias = 'q', ledgerAlias = 'aq') {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (query.questionKind !== 'all') {
    conditions.push(`${ledgerAlias}.question_kind = ?`);
    bindings.push(query.questionKind);
  }
  if (query.topic) {
    conditions.push(`${questionAlias}.topic = ?`);
    bindings.push(query.topic);
  }
  if (query.difficulty) {
    conditions.push(`${questionAlias}.difficulty = ?`);
    bindings.push(query.difficulty);
  }
  return { sql: conditions.length ? conditions.join(' AND ') : '1 = 1', bindings };
}

function exactResolved(answerAlias = 'a') {
  return `${answerAlias}.fact_version = ${ANALYTICS_FACTS_VERSION}
    AND ${answerAlias}.answer_origin IN (${RESOLVED_ORIGINS_SQL})`;
}

function round1(value: number | null) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

export async function fetchCohortCounts(
  db: D1Database,
  query: ParsedAnalyticsQuery,
): Promise<AnalyticsCohortCounts> {
  const cohort = eligibleAttemptsCte(query);
  const filter = filters(query);
  const row = await bind(db, {
    sql: `${cohort.sql}, filtered_facts AS (
      SELECT aq.attempt_id, aq.presented_at, a.fact_version, a.answer_origin
      FROM eligible_attempts ea
      JOIN attempt_questions aq ON aq.attempt_id = ea.id
      JOIN questions q ON q.id = aq.question_id
      LEFT JOIN answers a
        ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      WHERE ${filter.sql}
    )
    SELECT
      CASE WHEN ? = 1 THEN (SELECT COUNT(*) FROM eligible_attempts)
        ELSE (SELECT COUNT(DISTINCT attempt_id) FROM filtered_facts) END AS eligible_attempts,
      (SELECT COUNT(*) FROM filtered_facts
        WHERE presented_at IS NOT NULL AND fact_version = ?
          AND answer_origin IN (${PRESENTED_ORIGINS_SQL})) AS eligible_answers`,
    bindings: [
      ...cohort.bindings,
      ...filter.bindings,
      query.topic === null && query.difficulty === null && query.questionKind === 'all' ? 1 : 0,
      ANALYTICS_FACTS_VERSION,
    ],
  }).first<{ eligible_attempts: number; eligible_answers: number }>();
  return {
    eligibleAttempts: row?.eligible_attempts ?? 0,
    eligibleAnswers: row?.eligible_answers ?? 0,
  };
}

export type RawQuestionAggregate = {
  question_id: number;
  topic: string;
  difficulty: string;
  active: number;
  prompt: string;
  context_type: string | null;
  context_text: string | null;
  choice_count: number;
  correct_index: number;
  assigned_count: number;
  presented_count: number;
  outcome_count: number;
  correct_count: number;
  timeout_count: number;
  response_count: number;
  average_seconds: number | null;
  median_seconds: number | null;
  min_seconds: number | null;
  max_seconds: number | null;
  last_presented_at: number | null;
  last_answered_at: number | null;
  base_assigned: number;
  base_presented: number;
  base_resolved: number;
  base_correct: number;
  base_incorrect: number;
  base_timeout: number;
  base_earned: number;
  base_max: number;
  additional_assigned: number;
  additional_presented: number;
  additional_resolved: number;
  additional_correct: number;
  additional_incorrect: number;
  additional_timeout: number;
  additional_earned: number;
  additional_max: number;
  discrimination_n: number | null;
  discrimination_sum_x: number | null;
  discrimination_sum_y: number | null;
  discrimination_sum_y2: number | null;
  discrimination_sum_xy: number | null;
};

export type RawChoiceAggregate = {
  question_id: number;
  canonical_index: number;
  selected_count: number;
};

export type RawQuestionAnalyticsItem = QuestionAnalyticsItemDto & {
  prompt: string;
  contextType: string | null;
  context: string | null;
  responseCount: number;
  choices: QuestionChoiceAnalyticsDto[];
};

export function questionAggregateStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const cohort = eligibleAttemptsCte(query);
  const filter = filters(query);
  const resolved = exactResolved();
  return {
    sql: `${cohort.sql}, base_scores AS (
      SELECT ea.id AS attempt_id,
        SUM(CASE WHEN aq.question_kind = 'base' AND ${resolved}
          THEN COALESCE(a.awarded_score, 0) ELSE 0 END) AS base_awarded
      FROM eligible_attempts ea
      JOIN attempt_questions aq ON aq.attempt_id = ea.id
      LEFT JOIN answers a
        ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      GROUP BY ea.id
    ), filtered_facts AS (
      SELECT ea.id AS attempt_id, ea.base_max_score, aq.question_id,
        aq.question_kind, aq.score_value, aq.presented_at,
        q.topic, q.difficulty, q.prompt, q.context_type, q.context_text,
        json_array_length(q.choices_json) AS choice_count, q.correct_index,
        qri.active, a.id AS answer_id, a.fact_version, a.answer_origin,
        a.canonical_selected_index, a.awarded_score, a.is_correct, a.timed_out,
        a.elapsed_seconds, a.answered_at, bs.base_awarded
      FROM eligible_attempts ea
      JOIN base_scores bs ON bs.attempt_id = ea.id
      JOIN attempt_questions aq ON aq.attempt_id = ea.id
      JOIN questions q ON q.id = aq.question_id
      JOIN question_bank_revision_items qri
        ON qri.revision_hash = ea.bank_revision AND qri.question_id = aq.question_id
      LEFT JOIN answers a
        ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      WHERE ${filter.sql}
    ), submitted_times AS (
      SELECT question_id, elapsed_seconds,
        ROW_NUMBER() OVER (
          PARTITION BY question_id ORDER BY elapsed_seconds, answer_id
        ) AS time_rank,
        COUNT(*) OVER (PARTITION BY question_id) AS time_count
      FROM filtered_facts aq
      WHERE aq.presented_at IS NOT NULL AND aq.fact_version = ${ANALYTICS_FACTS_VERSION}
        AND aq.answer_origin = 'submitted' AND aq.canonical_selected_index IS NOT NULL
        AND aq.elapsed_seconds IS NOT NULL
    ), median_times AS (
      SELECT question_id, AVG(elapsed_seconds) AS median_seconds
      FROM submitted_times
      WHERE time_rank IN ((time_count + 1) / 2, (time_count + 2) / 2)
      GROUP BY question_id
    ), discrimination_observations AS (
      SELECT question_id, CASE WHEN is_correct = 1 THEN 1.0 ELSE 0.0 END AS x,
        100.0 * (base_awarded - COALESCE(awarded_score, 0))
          / NULLIF(base_max_score - score_value, 0) AS y
      FROM filtered_facts aq
      WHERE question_kind = 'base' AND aq.presented_at IS NOT NULL
        AND aq.fact_version = ${ANALYTICS_FACTS_VERSION}
        AND aq.answer_origin IN (${PRESENTED_ORIGINS_SQL})
        AND base_max_score > score_value
    ), discrimination_sums AS (
      SELECT question_id, COUNT(*) AS n, SUM(x) AS sum_x, SUM(y) AS sum_y,
        SUM(y * y) AS sum_y2, SUM(x * y) AS sum_xy
      FROM discrimination_observations GROUP BY question_id
    ), aggregates AS (
      SELECT question_id, MIN(topic) AS topic, MIN(difficulty) AS difficulty,
        MIN(active) AS active, MIN(prompt) AS prompt,
        MIN(context_type) AS context_type, MIN(context_text) AS context_text,
        MIN(choice_count) AS choice_count, MIN(correct_index) AS correct_index,
        COUNT(*) AS assigned_count,
        SUM(CASE WHEN presented_at IS NOT NULL THEN 1 ELSE 0 END) AS presented_count,
        SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) THEN 1 ELSE 0 END) AS outcome_count,
        SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND is_correct = 1
          THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) AND timed_out = 1
          THEN 1 ELSE 0 END) AS timeout_count,
        SUM(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
          THEN 1 ELSE 0 END) AS response_count,
        AVG(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
          THEN elapsed_seconds END) AS average_seconds,
        MIN(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
          THEN elapsed_seconds END) AS min_seconds,
        MAX(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin = 'submitted' AND canonical_selected_index IS NOT NULL
          THEN elapsed_seconds END) AS max_seconds,
        MAX(presented_at) AS last_presented_at,
        MAX(CASE WHEN presented_at IS NOT NULL AND fact_version = ${ANALYTICS_FACTS_VERSION}
          AND answer_origin IN (${PRESENTED_ORIGINS_SQL}) THEN answered_at END) AS last_answered_at,
        SUM(CASE WHEN question_kind = 'base' THEN 1 ELSE 0 END) AS base_assigned,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL THEN 1 ELSE 0 END) AS base_presented,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          THEN 1 ELSE 0 END) AS base_resolved,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND is_correct = 1 THEN 1 ELSE 0 END) AS base_correct,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND is_correct = 0 AND timed_out = 0 THEN 1 ELSE 0 END) AS base_incorrect,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND timed_out = 1 THEN 1 ELSE 0 END) AS base_timeout,
        SUM(CASE WHEN question_kind = 'base' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          THEN COALESCE(awarded_score, 0) ELSE 0 END) AS base_earned,
        SUM(CASE WHEN question_kind = 'base' THEN score_value ELSE 0 END) AS base_max,
        SUM(CASE WHEN question_kind = 'additional' THEN 1 ELSE 0 END) AS additional_assigned,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL THEN 1 ELSE 0 END) AS additional_presented,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          THEN 1 ELSE 0 END) AS additional_resolved,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND is_correct = 1 THEN 1 ELSE 0 END) AS additional_correct,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND is_correct = 0 AND timed_out = 0 THEN 1 ELSE 0 END) AS additional_incorrect,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          AND timed_out = 1 THEN 1 ELSE 0 END) AS additional_timeout,
        SUM(CASE WHEN question_kind = 'additional' AND presented_at IS NOT NULL
          AND fact_version = ${ANALYTICS_FACTS_VERSION} AND answer_origin IN (${PRESENTED_ORIGINS_SQL})
          THEN COALESCE(awarded_score, 0) ELSE 0 END) AS additional_earned,
        SUM(CASE WHEN question_kind = 'additional' THEN score_value ELSE 0 END) AS additional_max
      FROM filtered_facts GROUP BY question_id
    )
    SELECT aggregates.*, median_times.median_seconds,
      discrimination_sums.n AS discrimination_n,
      discrimination_sums.sum_x AS discrimination_sum_x,
      discrimination_sums.sum_y AS discrimination_sum_y,
      discrimination_sums.sum_y2 AS discrimination_sum_y2,
      discrimination_sums.sum_xy AS discrimination_sum_xy
    FROM aggregates
    LEFT JOIN median_times USING (question_id)
    LEFT JOIN discrimination_sums USING (question_id)
    ORDER BY question_id`,
    bindings: [...cohort.bindings, ...filter.bindings],
  };
}

export function choiceAggregateStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const cohort = eligibleAttemptsCte(query);
  const filter = filters(query);
  return {
    sql: `${cohort.sql}
    SELECT aq.question_id, a.canonical_selected_index AS canonical_index,
      COUNT(*) AS selected_count
    FROM eligible_attempts ea
    JOIN attempt_questions aq ON aq.attempt_id = ea.id
    JOIN questions q ON q.id = aq.question_id
    JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
    WHERE ${filter.sql} AND aq.presented_at IS NOT NULL
      AND a.fact_version = ? AND a.answer_origin = 'submitted'
      AND a.canonical_selected_index IS NOT NULL
    GROUP BY aq.question_id, a.canonical_selected_index
    ORDER BY aq.question_id, a.canonical_selected_index`,
    bindings: [...cohort.bindings, ...filter.bindings, ANALYTICS_FACTS_VERSION],
  };
}

function split(row: RawQuestionAggregate, prefix: 'base' | 'additional', minSample: number) {
  const resolved = row[`${prefix}_resolved`];
  const correct = row[`${prefix}_correct`];
  return {
    assigned: row[`${prefix}_assigned`],
    presented: row[`${prefix}_presented`],
    resolved,
    correct,
    incorrect: row[`${prefix}_incorrect`],
    timedOut: row[`${prefix}_timeout`],
    earned: row[`${prefix}_earned`],
    max: row[`${prefix}_max`],
    successRate: resolved >= minSample ? roundedRate(correct, resolved) : null,
  } satisfies QuestionKindSplitDto;
}

function questionDiscrimination(row: RawQuestionAggregate) {
  if ((row.discrimination_n ?? 0) < 100) return null;
  return pointBiserialFromSums({
    n: row.discrimination_n!,
    sumX: row.discrimination_sum_x ?? 0,
    sumY: row.discrimination_sum_y ?? 0,
    sumY2: row.discrimination_sum_y2 ?? 0,
    sumXY: row.discrimination_sum_xy ?? 0,
  });
}

async function directQuestionItems(
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
      directQuestionItems(db, { ...query, qualityStatus: 'all' }, false),
      directQuestionItems(
        db,
        { ...query, questionKind: 'base', qualityStatus: 'all' },
        true,
      ),
    ]);
    const baseById = new Map(baseItems.map((item) => [item.questionId, item]));
    return sortQuestionAnalyticsItems(query, displayItems.map((item) => {
      const calibration = baseById.get(item.questionId);
      return calibration ? {
        ...item,
        discrimination: calibration.discrimination,
        quality: calibration.quality,
        qualityWarnings: calibration.qualityWarnings,
        recommendation: calibration.recommendation,
        signals: calibration.signals,
      } : item;
    }).filter((item) => questionAnalyticsMatches({ ...query, q: null }, item, item.prompt)));
  }
  const [aggregateResult, choiceResult] = await Promise.all([
    bind(db, questionAggregateStatement(query)).all<RawQuestionAggregate>(),
    bind(db, choiceAggregateStatement(query)).all<RawChoiceAggregate>(),
  ]);
  return buildQuestionItemsFromAggregates(
    query,
    aggregateResult.results,
    choiceResult.results,
    calibrationEnabled,
  );
}

export function buildQuestionItemsFromAggregates(
  query: ParsedAnalyticsQuery,
  aggregateRows: readonly RawQuestionAggregate[],
  choiceRows: readonly RawChoiceAggregate[],
  calibrationEnabled = true,
): RawQuestionAnalyticsItem[] {
  const effectiveCalibration = calibrationEnabled
    && query.candidatePolicy === 'latest'
    && query.questionKind === 'base';
  const choicesByQuestion = new Map<number, Map<number, number>>();
  for (const row of choiceRows) {
    const counts = choicesByQuestion.get(row.question_id) ?? new Map<number, number>();
    counts.set(row.canonical_index, row.selected_count);
    choicesByQuestion.set(row.question_id, counts);
  }
  const peerGroups = new Map<string, Array<{ questionId: number; value: number }>>();
  for (const difficulty of new Set(aggregateRows.map((row) => row.difficulty))) {
    const values = aggregateRows.flatMap((row) => (
      row.difficulty === difficulty && row.outcome_count >= 30 && row.median_seconds !== null
        ? [{ questionId: row.question_id, value: row.median_seconds }]
        : []
    ));
    peerGroups.set(`${difficulty}\u0000${query.questionKind}`, values);
  }

  const items = aggregateRows.map((row) => {
    const counts = choicesByQuestion.get(row.question_id) ?? new Map<number, number>();
    const choices: QuestionChoiceAnalyticsDto[] = Array.from(
      { length: row.choice_count },
      (_, canonicalIndex) => ({
        canonicalIndex,
        selectedCount: counts.get(canonicalIndex) ?? 0,
        selectedRate: roundedRate(counts.get(canonicalIndex) ?? 0, row.response_count),
      }),
    );
    const distractorRates = choices
      .filter((choice) => choice.canonicalIndex !== row.correct_index)
      .map((choice) => choice.selectedRate);
    const functioningDistractors = row.outcome_count < 50
      ? 0
      : distractorRates.filter((rate) => rate !== null && rate >= 5).length;
    const deadDistractors = row.outcome_count < 50
      ? 0
      : distractorRates.length - functioningDistractors;
    const discrimination = effectiveCalibration ? questionDiscrimination(row) : null;
    const rawSuccessRate = roundedRate(row.correct_count, row.outcome_count);
    const rawTimeoutRate = roundedRate(row.timeout_count, row.outcome_count);
    const peers = (peerGroups.get(`${row.difficulty}\u0000${query.questionKind}`) ?? [])
      .filter((peer) => peer.questionId !== row.question_id)
      .map((peer) => peer.value);
    const peerMedianSeconds = median(peers);
    const sample = questionSample(row.outcome_count);
    const qualityResult = effectiveCalibration
      ? questionQuality({
          difficulty: row.difficulty,
          sampleSize: row.outcome_count,
          successRate: rawSuccessRate,
          timeoutRate: rawTimeoutRate,
          medianSeconds: round1(row.median_seconds),
          peerMedianSeconds,
          peerCount: peers.length,
          functioningDistractors,
          distractorCount: distractorRates.length,
          discrimination,
        })
      : null;
    const item: RawQuestionAnalyticsItem = {
      questionId: row.question_id,
      promptPreview: questionPromptPreview(row.prompt),
      topic: row.topic,
      difficulty: row.difficulty,
      active: row.active === 1,
      kind: query.questionKind,
      assignedCount: row.assigned_count,
      presentedCount: row.presented_count,
      outcomeCount: row.outcome_count,
      sampleSize: row.outcome_count,
      reliability: analyticsReliability(row.outcome_count),
      completionRate: roundedRate(row.outcome_count, row.presented_count),
      successRate: row.outcome_count >= query.minSample ? rawSuccessRate : null,
      timeoutRate: row.outcome_count >= query.minSample ? rawTimeoutRate : null,
      averageSeconds: row.outcome_count >= query.minSample ? round1(row.average_seconds) : null,
      medianSeconds: row.outcome_count >= query.minSample ? round1(row.median_seconds) : null,
      minSeconds: row.outcome_count >= query.minSample ? row.min_seconds : null,
      maxSeconds: row.outcome_count >= query.minSample ? row.max_seconds : null,
      lastPresentedAt: row.last_presented_at === null
        ? null : new Date(row.last_presented_at).toISOString(),
      lastAnsweredAt: row.last_answered_at === null
        ? null : new Date(row.last_answered_at).toISOString(),
      discrimination,
      base: split(row, 'base', query.minSample),
      additional: split(row, 'additional', query.minSample),
      quality: qualityResult?.quality ?? {
        enabled: false,
        earned: null,
        maxAvailable: null,
        partial: true,
        status: 'disabled',
        critical: false,
        components: [],
      },
      qualityWarnings: qualityResult?.warnings ?? [],
      recommendation: effectiveCalibration ? questionRecommendation({
          sampleSize: row.outcome_count,
          correctRate: rawSuccessRate,
          timeoutRate: rawTimeoutRate,
          discrimination,
          deadDistractors,
        }) : null,
      observed: observedQuestionMetrics({
        assignedCount: row.assigned_count,
        presentedCount: row.presented_count,
        outcomeCount: row.outcome_count,
        submittedCount: row.response_count,
        correctCount: row.correct_count,
        timeoutCount: row.timeout_count,
        averageSeconds: round1(row.average_seconds),
        medianSeconds: round1(row.median_seconds),
        minSeconds: row.min_seconds,
        maxSeconds: row.max_seconds,
      }),
      sample,
      signals: effectiveCalibration ? questionAnalyticsSignals({
        difficulty: row.difficulty,
        sample,
        successRate: rawSuccessRate,
        timeoutRate: rawTimeoutRate,
        medianSeconds: round1(row.median_seconds),
        peerMedianSeconds,
        peerCount: peers.length,
        discrimination,
      }) : questionAnalyticsSignals({
        difficulty: row.difficulty,
        sample,
        successRate: null,
        timeoutRate: null,
        medianSeconds: null,
        peerMedianSeconds: null,
        peerCount: 0,
        discrimination: null,
      }),
      prompt: row.prompt,
      contextType: row.context_type,
      context: row.context_text,
      responseCount: row.response_count,
      choices,
    };
    return item;
  });
  return sortQuestionAnalyticsItems(
    query,
    items.filter((item) => questionAnalyticsMatches(
      query,
      item,
      `${item.prompt}\n${item.context ?? ''}`,
    )),
  );
}

export async function fetchQuestionListReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
): Promise<QuestionAnalyticsListDto> {
  const [allItems, summaryItems, counts] = await Promise.all([
    directQuestionItems(db, query, calibrationEnabled),
    query.qualityStatus === 'all'
      ? Promise.resolve(null)
      : directQuestionItems(db, { ...query, qualityStatus: 'all' }, calibrationEnabled),
    fetchCohortCounts(db, query),
  ]);
  const items = allItems.slice(query.cursorOffset, query.cursorOffset + query.limit)
    .map((item) => {
      const { prompt, contextType, context, responseCount, choices, ...publicItem } = item;
      void [prompt, contextType, context, responseCount, choices];
      return publicItem;
    });
  const nextOffset = query.cursorOffset + items.length;
  return {
    questionAnalyticsModelVersion: QUESTION_ANALYTICS_MODEL_VERSION,
    cohort: buildAnalyticsCohort(query, counts, calibrationEnabled),
    items,
    totalCount: allItems.length,
    summary: questionAnalyticsSummary(summaryItems ?? allItems),
    nextCursor: nextOffset < allItems.length ? analyticsCursor(nextOffset) : null,
  };
}

export async function fetchQuestionDetailReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  questionId: number,
  calibrationEnabled = true,
): Promise<Omit<QuestionAnalyticsDetailDto, 'reviewHistory'> | null> {
  const items = await directQuestionItems(
    db,
    { ...query, qualityStatus: 'all' },
    calibrationEnabled,
  );
  const item = items.find((candidate) => candidate.questionId === questionId);
  return item ? { ...item, bankRevision: query.bankRevision! } : null;
}

type RawCandidate = {
  id: string;
  candidate_name: string | null;
  score: number;
  correct_count: number;
  wrong_count: number;
  verdict: 'PASS' | 'REVIEW' | 'FAIL';
  completed_at: number;
  duration_seconds: number;
  base_answered: number;
  base_correct: number;
  additional_answered: number;
  additional_correct: number;
  timeout_count: number;
  total_count: number;
};

export function candidateListStatement(query: ParsedAnalyticsQuery): AnalyticsSql {
  const cohort = eligibleAttemptsCte(query);
  const filter = filters(query, 'filter_q', 'filter_aq');
  const hasFilter = query.topic !== null || query.difficulty !== null || query.questionKind !== 'all';
  return {
    sql: `${cohort.sql}, filtered_attempts AS (
      SELECT ea.* FROM eligible_attempts ea
      WHERE ? = 0 OR EXISTS (
        SELECT 1 FROM attempt_questions filter_aq
        JOIN questions filter_q ON filter_q.id = filter_aq.question_id
        WHERE filter_aq.attempt_id = ea.id AND ${filter.sql}
      )
    ), paged_attempts AS (
      SELECT *, COUNT(*) OVER () AS total_count
      FROM filtered_attempts ORDER BY completed_at DESC, id DESC LIMIT ? OFFSET ?
    )
    SELECT pa.id, pa.candidate_name, pa.score, pa.correct_count, pa.wrong_count,
      pa.verdict, pa.completed_at, pa.duration_seconds, pa.total_count,
      SUM(CASE WHEN aq.question_kind = 'base' AND ${exactResolved()}
        THEN 1 ELSE 0 END) AS base_answered,
      SUM(CASE WHEN aq.question_kind = 'base' AND ${exactResolved()}
        AND a.is_correct = 1 THEN 1 ELSE 0 END) AS base_correct,
      SUM(CASE WHEN aq.question_kind = 'additional' AND ${exactResolved()}
        THEN 1 ELSE 0 END) AS additional_answered,
      SUM(CASE WHEN aq.question_kind = 'additional' AND ${exactResolved()}
        AND a.is_correct = 1 THEN 1 ELSE 0 END) AS additional_correct,
      SUM(CASE WHEN ${exactResolved()} AND a.timed_out = 1 THEN 1 ELSE 0 END) AS timeout_count
    FROM paged_attempts pa
    LEFT JOIN attempt_questions aq ON aq.attempt_id = pa.id
    LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
    GROUP BY pa.id, pa.candidate_name, pa.score, pa.correct_count, pa.wrong_count,
      pa.verdict, pa.completed_at, pa.duration_seconds, pa.total_count
    ORDER BY pa.completed_at DESC, pa.id DESC`,
    bindings: [
      ...cohort.bindings,
      hasFilter ? 1 : 0,
      ...filter.bindings,
      query.limit,
      query.cursorOffset,
    ],
  };
}

export async function fetchCandidateListReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  const [result, counts] = await Promise.all([
    bind(db, candidateListStatement(query)).all<RawCandidate>(),
    fetchCohortCounts(db, query),
  ]);
  const items = result.results.map((row): CandidateAnalyticsItemDto => ({
    attemptId: row.id,
    alias: adminCandidateAlias(row.id),
    candidateName: row.candidate_name,
    completedAt: new Date(row.completed_at).toISOString(),
    score: row.score,
    accuracy: calculateAccuracy(row.correct_count, row.wrong_count),
    verdict: row.verdict,
    durationSeconds: row.duration_seconds,
    baseAnswered: row.base_answered,
    baseCorrect: row.base_correct,
    additionalAnswered: row.additional_answered,
    additionalCorrect: row.additional_correct,
    timeoutCount: row.timeout_count,
  }));
  const total = result.results[0]?.total_count ?? 0;
  const nextOffset = query.cursorOffset + items.length;
  return {
    cohort: buildAnalyticsCohort(query, counts, calibrationEnabled),
    items,
    nextCursor: nextOffset < total ? analyticsCursor(nextOffset) : null,
  };
}

async function fetchCandidateAttempt(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  attemptId: string,
) {
  const cohort = eligibleAttemptsCte(query);
  const row = await bind(db, {
    sql: `${cohort.sql}
      SELECT id, candidate_name, bank_revision, app_version, score, correct_count,
        wrong_count, verdict, completed_at, duration_seconds, base_max_score
      FROM eligible_attempts WHERE id = ? LIMIT 1`,
    bindings: [...cohort.bindings, attemptId],
  }).first<{
    id: string; candidate_name: string | null; bank_revision: string; app_version: string;
    score: number; correct_count: number; wrong_count: number;
    verdict: 'PASS' | 'REVIEW' | 'FAIL'; completed_at: number;
    duration_seconds: number; base_max_score: number;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    alias: adminCandidateAlias(row.id),
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
  } satisfies AnalyticsAttemptRow;
}

async function fetchCandidateFacts(
  db: D1Database,
  attemptId: string,
): Promise<AnalyticsFactRow[]> {
  const rows = await db.prepare(`SELECT aq.attempt_id, aq.question_id, aq.question_kind,
      aq.ordinal, aq.score_value, aq.assigned_at, aq.presented_at,
      q.topic, q.dedupe_key, q.difficulty, qri.active, q.prompt,
      q.context_type, q.context_text, json_array_length(q.choices_json) AS choice_count,
      q.correct_index, a.id AS answer_id, a.fact_version, a.answer_origin,
      a.canonical_selected_index, a.awarded_score, a.is_correct, a.timed_out,
      a.elapsed_seconds, a.answered_at
    FROM attempt_questions aq
    JOIN attempts attempt ON attempt.id = aq.attempt_id
    JOIN questions q ON q.id = aq.question_id
    JOIN question_bank_revision_items qri
      ON qri.revision_hash = attempt.bank_revision AND qri.question_id = aq.question_id
    LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
    WHERE aq.attempt_id = ? ORDER BY aq.ordinal`).bind(attemptId).all<{
      attempt_id: string; question_id: number; question_kind: 'base' | 'additional';
      ordinal: number; score_value: number; assigned_at: number; presented_at: number | null;
      topic: string; dedupe_key: string; difficulty: string; active: number; prompt: string;
      context_type: string | null; context_text: string | null; choice_count: number;
      correct_index: number; answer_id: number | null; fact_version: number | null;
      answer_origin: string | null; canonical_selected_index: number | null;
      awarded_score: number | null; is_correct: number | null; timed_out: number | null;
      elapsed_seconds: number | null; answered_at: number | null;
    }>();
  return rows.results.map((row) => ({
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

export async function fetchCandidatePrintReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  attemptId: string,
): Promise<CandidatePrintDto | null> {
  const attempt = await fetchCandidateAttempt(db, query, attemptId);
  if (!attempt) return null;
  const [facts, questions] = await Promise.all([
    fetchCandidateFacts(db, attemptId),
    loadAttemptQuestionReview(db, attemptId),
  ]);
  const report = buildCandidatePrint([attempt], facts, attemptId);
  return report ? { ...report, questions } : null;
}

type RawGroup = {
  group_key: string;
  sample_size: number;
  correct_count: number;
  timeout_count: number;
  median_seconds: number | null;
};

async function fetchGroupReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  dimension: 'topic' | 'difficulty',
  calibrationEnabled: boolean,
): Promise<AnalyticsListDto<GroupAnalyticsItemDto>> {
  const cohort = eligibleAttemptsCte(query);
  const filter = filters(query);
  const column = dimension === 'topic' ? 'q.topic' : 'q.difficulty';
  const result = await bind(db, {
    sql: `${cohort.sql}, outcomes AS (
      SELECT ${column} AS group_key, a.is_correct, a.timed_out,
        CASE WHEN a.answer_origin = 'submitted' AND a.canonical_selected_index IS NOT NULL
          THEN a.elapsed_seconds END AS submitted_seconds,
        a.id AS answer_id
      FROM eligible_attempts ea
      JOIN attempt_questions aq ON aq.attempt_id = ea.id
      JOIN questions q ON q.id = aq.question_id
      JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      WHERE ${filter.sql} AND aq.presented_at IS NOT NULL AND a.fact_version = ?
        AND a.answer_origin IN (${PRESENTED_ORIGINS_SQL})
    ), ranked_times AS (
      SELECT group_key, submitted_seconds,
        ROW_NUMBER() OVER (
          PARTITION BY group_key ORDER BY submitted_seconds, answer_id
        ) AS time_rank,
        COUNT(*) OVER (PARTITION BY group_key) AS time_count
      FROM outcomes WHERE submitted_seconds IS NOT NULL
    ), medians AS (
      SELECT group_key, AVG(submitted_seconds) AS median_seconds
      FROM ranked_times
      WHERE time_rank IN ((time_count + 1) / 2, (time_count + 2) / 2)
      GROUP BY group_key
    ), aggregates AS (
      SELECT group_key, COUNT(*) AS sample_size,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END) AS timeout_count
      FROM outcomes GROUP BY group_key
    )
    SELECT aggregates.*, medians.median_seconds FROM aggregates
    LEFT JOIN medians USING (group_key) ORDER BY group_key`,
    bindings: [...cohort.bindings, ...filter.bindings, ANALYTICS_FACTS_VERSION],
  }).all<RawGroup>();
  const counts = await fetchCohortCounts(db, query);
  return {
    cohort: buildAnalyticsCohort(query, counts, calibrationEnabled),
    items: result.results.map((row) => ({
      key: row.group_key,
      kind: query.questionKind,
      sampleSize: row.sample_size,
      successRate: roundedRate(row.correct_count, row.sample_size),
      timeoutRate: roundedRate(row.timeout_count, row.sample_size),
      medianSeconds: round1(row.median_seconds),
      reliability: analyticsReliability(row.sample_size),
    })),
  };
}

export function fetchTopicReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  return fetchGroupReport(db, query, 'topic', calibrationEnabled);
}

export function fetchDifficultyReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
) {
  return fetchGroupReport(db, query, 'difficulty', calibrationEnabled);
}

export async function fetchOverviewReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  now = Date.now(),
  calibrationEnabled = true,
): Promise<AnalyticsOverviewDto> {
  const [overviewAttempts, counts] = await Promise.all([
    fetchOverviewAttempts(db, query),
    fetchCohortCounts(db, query),
  ]);
  const report = buildOverview(query, [], [], overviewAttempts, now, calibrationEnabled);
  return { ...report, cohort: buildAnalyticsCohort(query, counts, calibrationEnabled) };
}

export async function fetchTrendsReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
): Promise<AnalyticsListDto<AnalyticsTrendItemDto>> {
  const attempts = await fetchAnalyticsAttempts(db, query);
  const facts = await fetchAnalyticsFacts(db, query);
  const counts = await fetchCohortCounts(db, query);
  const report = buildTrends(query, attempts, facts, calibrationEnabled);
  return { ...report, cohort: buildAnalyticsCohort(query, counts, calibrationEnabled) };
}

export async function fetchRevisionsReport(
  db: D1Database,
  query: ParsedAnalyticsQuery,
  calibrationEnabled = true,
): Promise<AnalyticsListDto<AnalyticsRevisionItemDto>> {
  const [attempts, counts] = await Promise.all([
    fetchAnalyticsAttempts(db, query),
    fetchCohortCounts(db, query),
  ]);
  const report = buildRevisions(query, attempts, [], calibrationEnabled);
  return { ...report, cohort: buildAnalyticsCohort(query, counts, calibrationEnabled) };
}
