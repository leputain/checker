import assert from 'node:assert/strict';
import {
  AnalyticsRefreshBusyError,
  AnalyticsRefreshGenerationChangedError,
  analyticsAggregateState,
  claimAnalyticsAggregateRefresh,
  maintainAnalyticsAggregates,
  rebuildAnalyticsAggregates,
  rebuildClaimedAnalyticsAggregates,
} from '../lib/analytics-aggregate-store.ts';
import {
  ANALYTICS_AUTO_REFRESH_COOLDOWN_MS,
  ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS,
  ANALYTICS_REFRESH_LEASE_MS,
} from '../lib/analytics-refresh-policy.ts';
import { readFeatureFlags } from '../lib/feature-flags.ts';
import {
  ANALYTICS_BENCHMARK_NOW,
  createAnalyticsBenchmarkFixture,
} from './analytics-benchmark-fixture.ts';

const now = ANALYTICS_BENCHMARK_NOW + 10 * 60_000;

assert.equal(
  readFeatureFlags({ ANALYTICS_ENABLED: '0' }).analytics,
  false,
  'the maintenance route uses the shared analytics feature flag',
);

async function withFixture(run: (db: D1Database) => Promise<void>) {
  const fixture = await createAnalyticsBenchmarkFixture({ seed: false });
  try {
    await run(fixture.db);
  } finally {
    await fixture.miniflare.dispose();
  }
}

async function setRefreshState(
  db: D1Database,
  values: {
    generation: number;
    builtGeneration: number;
    updatedAt?: number;
    builtAt?: number | null;
    refreshAttemptedAt?: number | null;
  },
) {
  await db.prepare(`UPDATE analytics_refresh_state
      SET generation = ?, built_generation = ?, updated_at = ?, built_at = ?,
        refresh_token = NULL, refresh_generation = NULL,
        refresh_attempted_at = ?, refresh_lease_until = NULL
      WHERE id = 1`)
    .bind(
      values.generation,
      values.builtGeneration,
      values.updatedAt ?? now - ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS - 1,
      values.builtAt ?? null,
      values.refreshAttemptedAt ?? null,
    )
    .run();
}

async function seedPreviousSnapshot(db: D1Database) {
  await db.prepare(`INSERT INTO analytics_daily_timing_aggregates (
      policy, day, bank_revision, app_version, scoring_version, test_config_id,
      test_profile_id, question_id, question_kind, elapsed_seconds, response_count
    ) VALUES ('latest', '2026-08-28', ?, '1.0.0', 2, 'config', 'general-v1',
      1, 'base', 10, 7)`)
    .bind('a'.repeat(64))
    .run();
}

async function snapshotRows(db: D1Database) {
  const row = await db.prepare(`SELECT COUNT(*) AS count
    FROM analytics_daily_timing_aggregates`).first<{ count: number }>();
  return row?.count ?? 0;
}

// 1. A fresh generation is a cheap no-op.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 4, builtGeneration: 4 });
  const result = await maintainAnalyticsAggregates(db, { now });
  assert.deepEqual(result, { status: 'fresh', generation: 4 });
  assert.equal((await analyticsAggregateState(db)).refreshAttemptedAt, null);
});

// 2. An eligible stale generation is rebuilt exactly to its claimed generation.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 2, builtGeneration: 1 });
  const result = await maintainAnalyticsAggregates(db, { now });
  assert.equal(result.status, 'rebuilt');
  assert.equal(result.generation, 2);
  assert.equal((await analyticsAggregateState(db)).ready, true);
});

// 3. A completion immediately after a refresh is debounced/cooldown-limited.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 2, builtGeneration: 1 });
  assert.equal((await maintainAnalyticsAggregates(db, { now })).status, 'rebuilt');
  await db.prepare(`UPDATE analytics_refresh_state
    SET generation = generation + 1, updated_at = ? WHERE id = 1`).bind(now).run();
  const secondRunAt = now + ANALYTICS_AUTO_REFRESH_DEBOUNCE_MS + 1;
  const second = await maintainAnalyticsAggregates(db, { now: secondRunAt });
  assert.deepEqual(second, {
    status: 'deferred',
    generation: 3,
    nextEligibleAt: now + ANALYTICS_AUTO_REFRESH_COOLDOWN_MS,
  });
  assert.equal((await analyticsAggregateState(db)).builtGeneration, 2);
});

// 4. Several completed attempts coalesce into one generation rebuild.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 7, builtGeneration: 3 });
  const first = await maintainAnalyticsAggregates(db, { now });
  const second = await maintainAnalyticsAggregates(db, { now: now + 1 });
  assert.equal(first.status, 'rebuilt');
  assert.deepEqual(second, { status: 'fresh', generation: 7 });
  const state = await analyticsAggregateState(db);
  assert.equal(state.builtGeneration, 7);
  assert.equal(state.refreshAttemptedAt, now);
});

// 5–6. A failed batch is contained, preserves the previous snapshot and can
// be retried by a later maintenance cycle after the controlled cooldown.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 2, builtGeneration: 1 });
  await seedPreviousSnapshot(db);
  await db.prepare(`CREATE TRIGGER force_analytics_rebuild_failure
    BEFORE DELETE ON analytics_daily_timing_aggregates
    BEGIN SELECT RAISE(ABORT, 'forced_rebuild_failure'); END`).run();
  const failed = await maintainAnalyticsAggregates(db, { now });
  assert.deepEqual(failed, {
    status: 'failed',
    generation: 2,
    nextEligibleAt: now + ANALYTICS_AUTO_REFRESH_COOLDOWN_MS,
  });
  assert.equal(await snapshotRows(db), 1, 'the prior complete snapshot survives a batch failure');
  const failedState = await db.prepare(`SELECT refresh_token, refresh_attempted_at
    FROM analytics_refresh_state WHERE id = 1`).first<{
      refresh_token: string | null;
      refresh_attempted_at: number | null;
    }>();
  assert.deepEqual(failedState, { refresh_token: null, refresh_attempted_at: now });

  await db.prepare('DROP TRIGGER force_analytics_rebuild_failure').run();
  const retried = await maintainAnalyticsAggregates(db, {
    now: now + ANALYTICS_AUTO_REFRESH_COOLDOWN_MS + 1,
  });
  assert.equal(retried.status, 'rebuilt');
  assert.equal((await analyticsAggregateState(db)).ready, true);
});

// 7. A generation change after claim aborts before replacing the persisted snapshot.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 2, builtGeneration: 1 });
  await seedPreviousSnapshot(db);
  const claim = await claimAnalyticsAggregateRefresh(db, { mode: 'auto', now });
  assert.ok(claim);
  await db.prepare(`UPDATE analytics_refresh_state
    SET generation = generation + 1, updated_at = ? WHERE id = 1`).bind(now + 1).run();
  await assert.rejects(
    rebuildClaimedAnalyticsAggregates(db, claim, now),
    AnalyticsRefreshGenerationChangedError,
  );
  assert.equal(await snapshotRows(db), 1, 'the optimistic generation guard is atomic');
  const state = await analyticsAggregateState(db);
  assert.equal(state.generation, 3);
  assert.equal(state.builtGeneration, 1);
  assert.equal(state.ready, false);
});

// Manual and automatic rebuilds share one persisted lease, so two heavyweight
// batches cannot start concurrently. Manual refresh remains available afterward.
await withFixture(async (db) => {
  await setRefreshState(db, { generation: 2, builtGeneration: 1 });
  const claim = await claimAnalyticsAggregateRefresh(db, {
    mode: 'auto',
    now,
    leaseMs: ANALYTICS_REFRESH_LEASE_MS,
  });
  assert.ok(claim);
  await assert.rejects(
    rebuildAnalyticsAggregates(db, now + 1),
    AnalyticsRefreshBusyError,
  );
  await rebuildClaimedAnalyticsAggregates(db, claim, now + 2);
  const manual = await rebuildAnalyticsAggregates(db, now + 3);
  assert.equal(manual.generation, 2);
});

console.log('Analytics auto-refresh tests passed.');
