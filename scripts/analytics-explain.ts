import assert from 'node:assert/strict';
import {
  analyticsAttemptsStatement,
  analyticsFactsStatement,
  overviewAttemptsStatement,
} from '../lib/analytics-repository.ts';
import {
  choiceAggregateStatement,
  questionAggregateStatement,
} from '../lib/analytics-direct.ts';
import {
  derivedCandidateRowsStatement,
  derivedChoiceStatement,
  derivedQuestionAggregateStatement,
  derivedTimingStatement,
} from '../lib/analytics-derived.ts';
import { parseAnalyticsQuery, type AnalyticsSql } from '../lib/analytics-query.ts';
import {
  ANALYTICS_BENCHMARK_NOW,
  ANALYTICS_BENCHMARK_REVISION,
  createAnalyticsBenchmarkFixture,
} from './analytics-benchmark-fixture.ts';

type ExplainRow = {
  id: number;
  parent: number;
  notused: number;
  detail: string;
};

async function explain(db: D1Database, statement: AnalyticsSql) {
  const prepared = db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`);
  const rows = await (statement.bindings.length
    ? prepared.bind(...statement.bindings)
    : prepared).all<ExplainRow>();
  return rows.results.map((row) => row.detail);
}

function requirePlan(name: string, details: readonly string[], required: readonly RegExp[]) {
  for (const pattern of required) {
    assert.ok(
      details.some((detail) => pattern.test(detail)),
      `${name}: query plan does not use ${pattern}; plan: ${details.join(' | ')}`,
    );
  }
  const directTableScans = details.filter((detail) => (
    /^SCAN (attempts|attempt_questions|answers|question_bank_revision_items)$/u.test(detail)
  ));
  assert.deepEqual(directTableScans, [], `${name}: unindexed table scan detected`);
}

const fixture = await createAnalyticsBenchmarkFixture({ seed: false });
try {
  const query = parseAnalyticsQuery(
    `http://localhost/api/admin/analytics/questions?from=2026-07-30&to=2026-08-28` +
      `&bankRevision=${ANALYTICS_BENCHMARK_REVISION}&candidatePolicy=latest` +
      '&questionKind=base&minSample=30',
    ANALYTICS_BENCHMARK_NOW,
  );
  const plans = {
    attempts: await explain(fixture.db, analyticsAttemptsStatement(query)),
    facts: await explain(fixture.db, analyticsFactsStatement(query)),
    overview: await explain(fixture.db, overviewAttemptsStatement(query)),
    questionAggregate: await explain(fixture.db, questionAggregateStatement(query)),
    choiceAggregate: await explain(fixture.db, choiceAggregateStatement(query)),
    derivedQuestions: await explain(fixture.db, derivedQuestionAggregateStatement(query)),
    derivedChoices: await explain(fixture.db, derivedChoiceStatement(query)),
    derivedTiming: await explain(fixture.db, derivedTimingStatement(query)),
    derivedCandidates: await explain(fixture.db, derivedCandidateRowsStatement(query, { page: true })),
  };
  const cohortIndex = /idx_attempts_analytics_(?:cohort|latest)/u;
  requirePlan('attempts', plans.attempts, [cohortIndex]);
  requirePlan('facts', plans.facts, [
    cohortIndex,
    /attempt_questions.*attempt_id/u,
    /question_bank_revision_items.*revision_hash.*question_id/u,
    /idx_answers_attempt_question/u,
  ]);
  requirePlan('overview', plans.overview, [cohortIndex]);
  requirePlan('questionAggregate', plans.questionAggregate, [
    cohortIndex,
    /attempt_questions.*attempt_id/u,
    /idx_answers_attempt_question/u,
  ]);
  requirePlan('choiceAggregate', plans.choiceAggregate, [
    cohortIndex,
    /attempt_questions.*attempt_id/u,
    /idx_answers_attempt_question/u,
  ]);
  requirePlan('derivedQuestions', plans.derivedQuestions, [/idx_analytics_daily_questions_cohort/u]);
  requirePlan('derivedChoices', plans.derivedChoices, [/analytics_daily_choice_aggregates/u]);
  requirePlan('derivedTiming', plans.derivedTiming, [/analytics_daily_timing_aggregates/u]);
  requirePlan('derivedCandidates', plans.derivedCandidates, [/idx_analytics_candidates_cohort_day/u]);
  console.log(JSON.stringify(plans, null, 2));
  console.log('Analytics EXPLAIN checks passed.');
} finally {
  await fixture.miniflare.dispose();
}
