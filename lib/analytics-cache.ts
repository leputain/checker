import type { ParsedAnalyticsQuery } from './analytics-query.ts';

export type AnalyticsCacheStatus = 'hit' | 'miss' | 'refresh';

export type CachedAnalyticsResult<T> = {
  value: T;
  cacheStatus: AnalyticsCacheStatus;
  generation: number;
};

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(
  reportType: string,
  query: ParsedAnalyticsQuery,
  variant: string,
) {
  const canonical = JSON.stringify({
    reportType,
    variant,
    from: query.from,
    to: query.to,
    bankRevision: query.bankRevision,
    scoringVersion: query.scoringVersion,
    testConfigId: query.testConfigId,
    testProfileId: query.testProfileId,
    appVersion: query.appVersion,
    topic: query.topic,
    difficulty: query.difficulty,
    questionKind: query.questionKind,
    qualityStatus: query.qualityStatus,
    minSample: query.minSample,
    candidatePolicy: query.candidatePolicy,
    cursorOffset: query.cursorOffset,
    limit: query.limit,
  });
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

async function currentGeneration(db: D1Database) {
  const row = await db.prepare(`SELECT generation FROM analytics_refresh_state
    WHERE id = 1`).first<{ generation: number }>();
  if (!row) throw new Error('analytics_refresh_state_missing');
  return row.generation;
}

export async function cachedAnalyticsReport<T>(
  db: D1Database,
  reportType: string,
  query: ParsedAnalyticsQuery,
  producer: () => Promise<T>,
  options: { variant?: string; forceRefresh?: boolean } = {},
): Promise<CachedAnalyticsResult<T>> {
  const variant = options.variant ?? '';
  const key = await cacheKey(reportType, query, variant);
  const generation = await currentGeneration(db);
  if (!options.forceRefresh) {
    const cached = await db.prepare(`SELECT payload_json FROM analytics_report_aggregates
      WHERE cache_key = ? AND generation = ?`).bind(key, generation)
      .first<{ payload_json: string }>();
    if (cached) {
      try {
        return { value: JSON.parse(cached.payload_json) as T, cacheStatus: 'hit', generation };
      } catch {
        await db.prepare('DELETE FROM analytics_report_aggregates WHERE cache_key = ?')
          .bind(key).run();
      }
    }
  }

  const value = await producer();
  const finalGeneration = await currentGeneration(db);
  if (finalGeneration === generation) {
    await db.prepare(`INSERT INTO analytics_report_aggregates (
        cache_key, report_type, generation, period_from, period_to, payload_json, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        report_type = excluded.report_type,
        generation = excluded.generation,
        period_from = excluded.period_from,
        period_to = excluded.period_to,
        payload_json = excluded.payload_json,
        generated_at = excluded.generated_at`)
      .bind(
        key,
        reportType,
        generation,
        query.from,
        query.to,
        JSON.stringify(value),
        Date.now(),
      )
      .run();
  }
  return {
    value,
    cacheStatus: options.forceRefresh ? 'refresh' : 'miss',
    generation: finalGeneration,
  };
}

export async function invalidateAnalyticsAggregates(db: D1Database, now = Date.now()) {
  await db.batch([
    db.prepare(`UPDATE analytics_refresh_state
      SET generation = generation + 1, updated_at = ? WHERE id = 1`).bind(now),
    db.prepare('DELETE FROM analytics_report_aggregates'),
  ]);
  return currentGeneration(db);
}
