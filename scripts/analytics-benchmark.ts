import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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
  fetchOverviewReport,
  fetchQuestionListReport,
} from '../lib/analytics-direct.ts';
import { rebuildAnalyticsAggregates } from '../lib/analytics-aggregate-store.ts';
import { parseAnalyticsQuery } from '../lib/analytics-query.ts';
import {
  ANALYTICS_BENCHMARK_ANSWERS,
  ANALYTICS_BENCHMARK_ATTEMPTS,
  ANALYTICS_BENCHMARK_NOW,
  ANALYTICS_BENCHMARK_REVISION,
  benchmarkFixtureCounts,
  createAnalyticsBenchmarkFixture,
} from './analytics-benchmark-fixture.ts';

type BenchmarkObservation = {
  attempts: number;
  facts: number;
  resultItems: number;
};

type BenchmarkResult = {
  name: string;
  samplesMs: number[];
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
  warmupReadMs: number;
  observation: BenchmarkObservation;
};

const assertionMode = process.argv.includes('--assert');
const iterationsArgument = process.argv.find((argument) => argument.startsWith('--iterations='));
const thresholdArgument = process.argv.find((argument) => argument.startsWith('--threshold='));
const iterations = Number(iterationsArgument?.split('=')[1] ?? 5);
const thresholdMs = Number(
  thresholdArgument?.split('=')[1] ?? process.env.ANALYTICS_BENCHMARK_P95_MS ?? 500,
);
if (!Number.isInteger(iterations) || iterations < 3 || iterations > 20) {
  throw new Error('Use --iterations=3..20.');
}
if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
  throw new Error('The p95 threshold must be a positive number.');
}

function percentile(values: readonly number[], percentileValue: number) {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

async function measure(
  name: string,
  run: () => Promise<BenchmarkObservation>,
): Promise<BenchmarkResult> {
  const warmupStartedAt = performance.now();
  await run();
  const warmupReadMs = rounded(performance.now() - warmupStartedAt);
  const samplesMs: number[] = [];
  let observation: BenchmarkObservation = { attempts: 0, facts: 0, resultItems: 0 };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    observation = await run();
    samplesMs.push(rounded(performance.now() - startedAt));
  }
  return {
    name,
    samplesMs,
    medianMs: rounded(percentile(samplesMs, 50)),
    p95Ms: rounded(percentile(samplesMs, 95)),
    maximumMs: rounded(Math.max(...samplesMs)),
    warmupReadMs,
    observation,
  };
}

async function measureDirectEvidence(
  name: string,
  run: () => Promise<BenchmarkObservation>,
): Promise<BenchmarkResult> {
  const samplesMs: number[] = [];
  let observation: BenchmarkObservation = { attempts: 0, facts: 0, resultItems: 0 };
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const startedAt = performance.now();
    observation = await run();
    samplesMs.push(rounded(performance.now() - startedAt));
  }
  return {
    name,
    samplesMs,
    medianMs: rounded(percentile(samplesMs, 50)),
    p95Ms: rounded(percentile(samplesMs, 95)),
    maximumMs: rounded(Math.max(...samplesMs)),
    warmupReadMs: samplesMs[0],
    observation,
  };
}

const fixture = await createAnalyticsBenchmarkFixture();
try {
  const counts = await benchmarkFixtureCounts(fixture.db);
  assert.deepEqual(counts, {
    attempts: ANALYTICS_BENCHMARK_ATTEMPTS,
    answers: ANALYTICS_BENCHMARK_ANSWERS,
    ledger: ANALYTICS_BENCHMARK_ANSWERS,
  });
  const latestQuery = parseAnalyticsQuery(
    `http://localhost/api/admin/analytics/questions?from=2026-07-30&to=2026-08-28` +
      `&bankRevision=${ANALYTICS_BENCHMARK_REVISION}&candidatePolicy=latest` +
      '&questionKind=base&minSample=30&limit=100',
    ANALYTICS_BENCHMARK_NOW,
  );
  const allQuery = parseAnalyticsQuery(
    `http://localhost/api/admin/analytics/questions?from=2026-07-30&to=2026-08-28` +
      `&bankRevision=${ANALYTICS_BENCHMARK_REVISION}&candidatePolicy=all` +
      '&questionKind=all&minSample=30&limit=100',
    ANALYTICS_BENCHMARK_NOW,
  );

  // Evidence only: raw facts are measured before the explicit rebuild and are
  // deliberately not held to the persisted-read SLA. Three samples retain the
  // first uncached read and document why stale reports require a controlled rebuild.
  const directEvidence = [
    await measureDirectEvidence('direct_overview_10k_attempts', async () => {
      const report = await fetchOverviewReport(fixture.db, latestQuery, ANALYTICS_BENCHMARK_NOW);
      assert.equal(report.allTime.attempts, ANALYTICS_BENCHMARK_ATTEMPTS);
      return { attempts: ANALYTICS_BENCHMARK_ATTEMPTS, facts: 0, resultItems: report.allTime.attempts };
    }),
    await measureDirectEvidence('direct_questions_all_300k_facts', async () => {
      const report = await fetchQuestionListReport(fixture.db, allQuery);
      assert.equal(report.items.length, 30);
      return {
        attempts: ANALYTICS_BENCHMARK_ATTEMPTS,
        facts: ANALYTICS_BENCHMARK_ANSWERS,
        resultItems: report.items.length,
      };
    }),
  ];

  const aggregateRebuild = await rebuildAnalyticsAggregates(
    fixture.db,
    ANALYTICS_BENCHMARK_NOW,
  );

  const results: BenchmarkResult[] = [];
  results.push(await measure('questions_latest_150k_facts', async () => {
    const report = await fetchDerivedQuestionListReport(fixture.db, latestQuery);
    assert.equal(report.items.length, 20);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('overview_latest_150k_facts', async () => {
    const report = await fetchDerivedOverviewReport(
      fixture.db,
      latestQuery,
      ANALYTICS_BENCHMARK_NOW,
    );
    assert.equal(report.allTime.attempts, ANALYTICS_BENCHMARK_ATTEMPTS);
    return {
      attempts: ANALYTICS_BENCHMARK_ATTEMPTS,
      facts: 150_000,
      resultItems: report.allTime.attempts,
    };
  }));
  results.push(await measure('questions_all_300k_facts', async () => {
    const report = await fetchDerivedQuestionListReport(fixture.db, allQuery);
    assert.equal(report.items.length, 30);
    return {
      attempts: ANALYTICS_BENCHMARK_ATTEMPTS,
      facts: ANALYTICS_BENCHMARK_ANSWERS,
      resultItems: report.items.length,
    };
  }));
  results.push(await measure('question_detail_latest', async () => {
    const report = await fetchDerivedQuestionDetailReport(fixture.db, latestQuery, 1);
    assert.ok(report);
    return { attempts: 5_000, facts: 150_000, resultItems: 1 };
  }));
  results.push(await measure('candidate_list_latest', async () => {
    const report = await fetchDerivedCandidateListReport(fixture.db, latestQuery);
    assert.equal(report.items.length, latestQuery.limit);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('candidate_detail_latest', async () => {
    const report = await fetchDerivedCandidatePrintReport(
      fixture.db,
      latestQuery,
      'attempt-10000',
    );
    assert.ok(report);
    return { attempts: 1, facts: 30, resultItems: 1 };
  }));
  results.push(await measure('topics_latest', async () => {
    const report = await fetchDerivedTopicReport(fixture.db, latestQuery);
    assert.equal(report.items.length, 4);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('difficulty_latest', async () => {
    const report = await fetchDerivedDifficultyReport(fixture.db, latestQuery);
    assert.equal(report.items.length, 4);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('trends_latest', async () => {
    const report = await fetchDerivedTrendsReport(fixture.db, latestQuery);
    assert.ok(report.items.length > 0);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('revisions_latest', async () => {
    const report = await fetchDerivedRevisionsReport(fixture.db, latestQuery);
    assert.equal(report.items.length, 1);
    return { attempts: 5_000, facts: 150_000, resultItems: report.items.length };
  }));
  results.push(await measure('revision_comparison', async () => {
    const report = await fetchDerivedRevisionComparisonReport(
      fixture.db,
      { ...latestQuery, bankRevision: null },
      ANALYTICS_BENCHMARK_REVISION,
      'e'.repeat(64),
    );
    assert.equal(report.left.attempts, 5_000);
    assert.equal(report.right.attempts, 0);
    return { attempts: 5_000, facts: 150_000, resultItems: 2 };
  }));

  const report = {
    dataset: counts,
    seedDurationMs: rounded(fixture.seedDurationMs),
    aggregateRebuild,
    directEvidence,
    iterations,
    p95ThresholdMs: thresholdMs,
    passed: results.every((result) => result.p95Ms <= thresholdMs),
    results,
  };
  console.table(results.map((result) => ({
    workload: result.name,
    facts: result.observation.facts,
    medianMs: result.medianMs,
    p95Ms: result.p95Ms,
    warmupReadMs: result.warmupReadMs,
    thresholdMs,
    passed: result.p95Ms <= thresholdMs,
  })));
  console.table(directEvidence.map((result) => ({
    evidence: result.name,
    facts: result.observation.facts,
    medianMs: result.medianMs,
    p95Ms: result.p95Ms,
    firstReadMs: result.warmupReadMs,
    gated: false,
  })));
  console.log(JSON.stringify(report, null, 2));
  if (assertionMode) {
    for (const result of results) {
      assert.ok(
        result.p95Ms <= thresholdMs,
        `${result.name}: p95 ${result.p95Ms} ms exceeds ${thresholdMs} ms`,
      );
    }
  }
} finally {
  await fixture.miniflare.dispose();
}
