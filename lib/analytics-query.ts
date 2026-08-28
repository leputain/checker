import {
  ANALYTICS_SAMPLE_GATES,
  type AnalyticsCandidatePolicy,
  type AnalyticsQualityStatus,
  type AnalyticsQuestionKind,
  type AnalyticsSampleGate,
} from './analytics-contract.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_PROFILE_ID,
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from './test-config.ts';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{1,96}$/u;
const MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;
const moscowDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export class AnalyticsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsQueryError';
  }
}

export type ParsedAnalyticsQuery = {
  from: string | null;
  to: string | null;
  fromMs: number | null;
  toExclusiveMs: number | null;
  bankRevision: string | null;
  scoringVersion: number;
  testConfigId: string;
  testProfileId: string;
  appVersion: string | null;
  topic: string | null;
  difficulty: string | null;
  questionKind: AnalyticsQuestionKind;
  qualityStatus: AnalyticsQualityStatus;
  minSample: AnalyticsSampleGate;
  candidatePolicy: AnalyticsCandidatePolicy;
  cursorOffset: number;
  limit: number;
  warnings: string[];
};

function moscowDateStart(value: string) {
  if (!DATE_PATTERN.test(value)) throw new AnalyticsQueryError('invalid_date');
  const timestamp = Date.parse(`${value}T00:00:00+03:00`);
  if (!Number.isFinite(timestamp)) throw new AnalyticsQueryError('invalid_date');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AnalyticsQueryError('invalid_date');
  }
  return timestamp;
}

function nextMoscowDateStart(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return moscowDateStart(nextDate);
}

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new AnalyticsQueryError(`duplicate_${name}`);
  return values[0]?.trim() || null;
}

function optionalIdentifier(value: string | null, name: string) {
  if (value === null) return null;
  if (!IDENTIFIER_PATTERN.test(value)) throw new AnalyticsQueryError(`invalid_${name}`);
  return value;
}

function parseCursor(value: string | null) {
  if (!value) return 0;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const payload = JSON.parse(decoded) as { offset?: unknown };
    if (!Number.isInteger(payload.offset) || (payload.offset as number) < 0) throw new Error();
    return payload.offset as number;
  } catch {
    throw new AnalyticsQueryError('invalid_cursor');
  }
}

export function analyticsCursor(offset: number) {
  if (!Number.isInteger(offset) || offset < 0) throw new AnalyticsQueryError('invalid_cursor');
  return btoa(JSON.stringify({ offset }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function parseAnalyticsQuery(input: URL | string, now = Date.now()): ParsedAnalyticsQuery {
  const url = typeof input === 'string' ? new URL(input) : input;
  const params = url.searchParams;
  const warnings: string[] = [];
  const explicitTo = one(params, 'to');
  const to = explicitTo ?? moscowDateFormatter.format(new Date(now));
  const defaultToExclusive = nextMoscowDateStart(to);
  const from = one(params, 'from')
    ?? moscowDateFormatter.format(new Date(defaultToExclusive - 30 * DAY_MS));
  const fromMs = from ? moscowDateStart(from) : null;
  const toExclusiveMs = to ? nextMoscowDateStart(to) : null;
  if (fromMs !== null && toExclusiveMs !== null && fromMs >= toExclusiveMs) {
    throw new AnalyticsQueryError('invalid_period');
  }

  const bankRevisionValue = one(params, 'bankRevision');
  const legacyRevision = one(params, 'revision');
  if (bankRevisionValue && legacyRevision) throw new AnalyticsQueryError('duplicate_revision_filter');
  if (legacyRevision) warnings.push('deprecated_revision_filter');
  const bankRevision = bankRevisionValue ?? legacyRevision;
  if (bankRevision && !SHA256_PATTERN.test(bankRevision)) {
    throw new AnalyticsQueryError('invalid_bankRevision');
  }

  const questionKindValue = one(params, 'questionKind');
  const legacyKind = one(params, 'kind');
  if (questionKindValue && legacyKind) throw new AnalyticsQueryError('duplicate_kind_filter');
  if (legacyKind) warnings.push('deprecated_kind_filter');
  const questionKind = (questionKindValue ?? legacyKind ?? 'base') as AnalyticsQuestionKind;
  if (!['all', 'base', 'additional'].includes(questionKind)) {
    throw new AnalyticsQueryError('invalid_questionKind');
  }

  const qualityStatus = (one(params, 'qualityStatus') ?? 'all') as AnalyticsQualityStatus;
  if (!['all', 'needs_review', 'healthy', 'insufficient'].includes(qualityStatus)) {
    throw new AnalyticsQueryError('invalid_qualityStatus');
  }
  const minSampleValue = Number(one(params, 'minSample') ?? 30);
  if (!ANALYTICS_SAMPLE_GATES.includes(minSampleValue as AnalyticsSampleGate)) {
    throw new AnalyticsQueryError('invalid_minSample');
  }
  const candidatePolicy = (one(params, 'candidatePolicy') ?? 'latest') as AnalyticsCandidatePolicy;
  if (candidatePolicy !== 'latest' && candidatePolicy !== 'all') {
    throw new AnalyticsQueryError('invalid_candidatePolicy');
  }

  const scoringVersion = Number(one(params, 'scoringVersion') ?? SCORING_VERSION);
  if (!Number.isInteger(scoringVersion) || scoringVersion < 1 || scoringVersion > 1_000) {
    throw new AnalyticsQueryError('invalid_scoringVersion');
  }
  const testConfigId = one(params, 'testConfigId') ?? TEST_CONFIG_ID;
  if (!SHA256_PATTERN.test(testConfigId)) throw new AnalyticsQueryError('invalid_testConfigId');
  const testProfileId = optionalIdentifier(
    one(params, 'testProfileId') ?? TEST_PROFILE_ID,
    'testProfileId',
  )!;
  const appVersion = optionalIdentifier(one(params, 'appVersion'), 'appVersion');
  const topic = one(params, 'topic');
  if (topic && (topic.length > 100 || /[\u0000-\u001f]/u.test(topic))) {
    throw new AnalyticsQueryError('invalid_topic');
  }
  const difficulty = optionalIdentifier(one(params, 'difficulty'), 'difficulty');
  const limit = Number(one(params, 'limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AnalyticsQueryError('invalid_limit');
  }

  return {
    from,
    to,
    fromMs,
    toExclusiveMs,
    bankRevision,
    scoringVersion,
    testConfigId,
    testProfileId,
    appVersion,
    topic,
    difficulty,
    questionKind,
    qualityStatus,
    minSample: minSampleValue as AnalyticsSampleGate,
    candidatePolicy,
    cursorOffset: parseCursor(one(params, 'cursor')),
    limit,
    warnings,
  };
}

export function applyCurrentModelDefaults(
  query: ParsedAnalyticsQuery,
  input: URL | string,
  balancedSelection: boolean,
) {
  if (!balancedSelection) return query;
  const url = typeof input === 'string' ? new URL(input) : input;
  return {
    ...query,
    testConfigId: url.searchParams.has('testConfigId')
      ? query.testConfigId
      : BALANCED_TEST_CONFIG_ID,
    testProfileId: url.searchParams.has('testProfileId')
      ? query.testProfileId
      : BALANCED_TEST_PROFILE_ID,
  };
}

export type AnalyticsSql = { sql: string; bindings: Array<string | number> };

export function eligibleAttemptsCte(query: ParsedAnalyticsQuery): AnalyticsSql {
  const immutableConditions = [
    "status = 'completed'",
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
    immutableConditions.push('bank_revision = ?');
    bindings.push(query.bankRevision);
  }
  const periodConditions: string[] = [];
  const periodBindings: Array<string | number> = [];
  if (query.fromMs !== null) {
    periodConditions.push('completed_at >= ?');
    periodBindings.push(query.fromMs);
  }
  if (query.toExclusiveMs !== null) {
    periodConditions.push('completed_at < ?');
    periodBindings.push(query.toExclusiveMs);
  }
  if (query.appVersion) {
    periodConditions.push('app_version = ?');
    periodBindings.push(query.appVersion);
  }
  const selectedConditions = [
    ...(query.candidatePolicy === 'latest' ? ['candidate_rank = 1'] : []),
    ...periodConditions,
  ];
  const selectedWhere = selectedConditions.length
    ? `WHERE ${selectedConditions.join(' AND ')}`
    : '';
  if (query.candidatePolicy === 'all') {
    return {
      sql: `WITH eligible_attempts AS (
        SELECT id, candidate_key, public_alias, bank_revision, app_version, scoring_version,
          test_config_id, test_profile_id, score, correct_count, wrong_count, verdict,
          completed_at, duration_seconds, base_max_score
        FROM attempts
        WHERE ${[...immutableConditions, ...periodConditions].join('\n          AND ')}
      )`,
      bindings: [...bindings, ...periodBindings],
    };
  }
  return {
    sql: `WITH ranked_attempts AS (
      SELECT id, candidate_key, public_alias, bank_revision, app_version, scoring_version,
        test_config_id, test_profile_id, score, correct_count, wrong_count, verdict,
        completed_at, duration_seconds, base_max_score,
        ROW_NUMBER() OVER (
          PARTITION BY candidate_key, bank_revision, scoring_version, test_config_id, test_profile_id
          ORDER BY completed_at DESC, id DESC
        ) AS candidate_rank
      FROM attempts
      WHERE ${immutableConditions.join('\n        AND ')}
    ), eligible_attempts AS (
      SELECT * FROM ranked_attempts ${selectedWhere}
    )`,
    bindings: [...bindings, ...periodBindings],
  };
}

export function cohortFactConditions(query: ParsedAnalyticsQuery, alias = 'aq') {
  const conditions = [`${alias}.presented_at IS NOT NULL`];
  const bindings: Array<string | number> = [];
  if (query.questionKind !== 'all') {
    conditions.push(`${alias}.question_kind = ?`);
    bindings.push(query.questionKind);
  }
  if (query.topic) {
    conditions.push('q.topic = ?');
    bindings.push(query.topic);
  }
  if (query.difficulty) {
    conditions.push('q.difficulty = ?');
    bindings.push(query.difficulty);
  }
  return { sql: conditions.join(' AND '), bindings };
}
