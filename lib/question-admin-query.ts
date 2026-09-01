import type {
  QuestionAdminDirection,
  QuestionAdminItemDto,
  QuestionAdminLifecycleStatus,
  QuestionAdminQualityFilter,
  QuestionAdminQualityStatus,
  QuestionAdminRevisionFilter,
  QuestionAdminSort,
  QuestionAdminStatusFilter,
} from './question-admin-contract.ts';
import { DIFFICULTIES, type Difficulty } from './test-config.ts';

export const QUESTION_ADMIN_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const MAX_QUESTION_ADMIN_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 160;
const MAX_TOPIC_LENGTH = 80;

export type QuestionAdminListQuery = {
  q: string;
  questionId: number | null;
  categoryId: number | null;
  topic: string | null;
  difficulty: Difficulty | null;
  status: QuestionAdminStatusFilter;
  revision: QuestionAdminRevisionFilter;
  quality: QuestionAdminQualityFilter;
  sort: QuestionAdminSort;
  direction: QuestionAdminDirection;
  offset: number;
  cursorRevision: string | null;
  cursorQueryKey: string | null;
  cursorQualityGeneration: number | null;
  limit: number;
};

type QuestionAdminCursor = {
  offset: number;
  revision: string;
  queryKey: string | null;
  qualityGeneration: number | null;
};

type QuestionAdminQueryError = Error & {
  code: 'invalid_request';
  status: 400;
  issues: string[];
};

function invalidQuery(issue: string): never {
  const error = new Error('invalid_request') as QuestionAdminQueryError;
  error.name = 'QuestionAdminQueryError';
  error.code = 'invalid_request';
  error.status = 400;
  error.issues = [issue];
  throw error;
}

function decodeCursor(value: string | null): QuestionAdminCursor {
  if (!value) {
    return {
      offset: 0,
      revision: '',
      queryKey: null,
      qualityGeneration: null,
    };
  }
  if (value.length > 4_096) return invalidQuery('Некорректный cursor');
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const cursor = JSON.parse(decoded) as {
      offset?: unknown;
      revision?: unknown;
      queryKey?: unknown;
      qualityGeneration?: unknown;
    };
    const queryKey = cursor.queryKey === undefined ? null : cursor.queryKey;
    const qualityGeneration = cursor.qualityGeneration === undefined
      ? null
      : cursor.qualityGeneration;
    if (
      !Number.isSafeInteger(cursor.offset)
      || Number(cursor.offset) < 0
      || typeof cursor.revision !== 'string'
      || !QUESTION_ADMIN_SHA256_PATTERN.test(cursor.revision)
      || (queryKey !== null && (typeof queryKey !== 'string' || queryKey.length > 1_000))
      || (
        qualityGeneration !== null
        && (!Number.isSafeInteger(qualityGeneration) || Number(qualityGeneration) < 0)
      )
    ) {
      throw new Error('invalid_cursor');
    }
    return {
      offset: Number(cursor.offset),
      revision: cursor.revision,
      queryKey: queryKey as string | null,
      qualityGeneration: qualityGeneration as number | null,
    };
  } catch {
    return invalidQuery('Некорректный cursor');
  }
}

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) return invalidQuery(`Параметр ${name} указан несколько раз`);
  return values[0] ?? null;
}

function aliased(params: URLSearchParams, primary: string, alias: string) {
  const primaryValue = one(params, primary);
  const aliasValue = one(params, alias);
  if (primaryValue !== null && aliasValue !== null) {
    return invalidQuery(`Используйте только один из параметров ${primary} или ${alias}`);
  }
  return primaryValue ?? aliasValue;
}

function positiveInteger(value: string | null, name: string) {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return invalidQuery(`${name} должен быть положительным целым числом`);
  }
  return parsed;
}

function normalizedText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function normalizedQuestionAdminSearch(value: string) {
  return normalizedText(value).toLocaleLowerCase('ru-RU');
}

export function questionAdminLifecycleStatus(
  active: boolean,
  successorId: number | null,
): QuestionAdminLifecycleStatus {
  if (successorId !== null) return 'superseded';
  return active ? 'active' : 'archived';
}

export function questionAdminQueryKey(query: Pick<QuestionAdminListQuery,
  | 'q'
  | 'questionId'
  | 'categoryId'
  | 'topic'
  | 'difficulty'
  | 'status'
  | 'revision'
  | 'quality'
  | 'sort'
  | 'direction'
  | 'limit'
>) {
  return JSON.stringify([
    query.q,
    query.questionId,
    query.categoryId,
    query.topic,
    query.difficulty,
    query.status,
    query.revision,
    query.quality,
    query.sort,
    query.direction,
    query.limit,
  ]);
}

/** @internal Exported so the opaque cursor contract can be unit-tested. */
export function encodeQuestionAdminCursor(
  revision: string,
  offset: number,
  query: QuestionAdminListQuery,
  qualityGeneration: number | null,
) {
  if (
    !QUESTION_ADMIN_SHA256_PATTERN.test(revision)
    || !Number.isSafeInteger(offset)
    || offset < 0
    || (
      qualityGeneration !== null
      && (!Number.isSafeInteger(qualityGeneration) || qualityGeneration < 0)
    )
  ) {
    return invalidQuery('Некорректные данные cursor');
  }
  return btoa(JSON.stringify({
    revision,
    offset,
    queryKey: questionAdminQueryKey(query),
    qualityGeneration,
  }))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

export function parseQuestionAdminListQuery(input: Request | URL | string): QuestionAdminListQuery {
  const url = input instanceof Request
    ? new URL(input.url)
    : input instanceof URL ? input : new URL(input);
  const params = url.searchParams;
  const cursor = decodeCursor(one(params, 'cursor'));

  const rawQ = one(params, 'q') ?? '';
  if (rawQ.length > MAX_SEARCH_LENGTH * 4) {
    return invalidQuery(`q должен содержать не более ${MAX_SEARCH_LENGTH} символов`);
  }
  const q = normalizedText(rawQ);
  if (q.length > MAX_SEARCH_LENGTH || /[\u0000-\u001f\u007f]/u.test(q)) {
    return invalidQuery(`q должен содержать не более ${MAX_SEARCH_LENGTH} символов без управляющих знаков`);
  }

  const rawTopic = aliased(params, 'topic', 'category');
  if (rawTopic !== null && rawTopic.length > MAX_TOPIC_LENGTH * 4) {
    return invalidQuery(`topic должен содержать не более ${MAX_TOPIC_LENGTH} символов`);
  }
  const topic = rawTopic === null || !rawTopic.trim() ? null : normalizedText(rawTopic);
  if (
    topic !== null
    && (topic.length > MAX_TOPIC_LENGTH || /[\u0000-\u001f\u007f]/u.test(topic))
  ) {
    return invalidQuery(`topic должен содержать не более ${MAX_TOPIC_LENGTH} символов`);
  }

  const difficultyValue = one(params, 'difficulty')?.trim() || null;
  const difficulty = difficultyValue && DIFFICULTIES.includes(difficultyValue as Difficulty)
    ? difficultyValue as Difficulty
    : null;
  if (difficultyValue && !difficulty) return invalidQuery('Некорректная difficulty');

  const statusValue = (one(params, 'status')?.trim() || 'all') as QuestionAdminStatusFilter;
  if (!['all', 'active', 'inactive', 'archived', 'superseded'].includes(statusValue)) {
    return invalidQuery('Некорректный status');
  }

  const rawRevision = aliased(params, 'revision', 'scope')?.trim() || null;
  const revisionAliases: Record<string, QuestionAdminRevisionFilter> = {
    current: 'current',
    leaf: 'current',
    all: 'all',
    historical: 'historical',
    superseded: 'historical',
  };
  const revision = rawRevision
    ? revisionAliases[rawRevision]
    : statusValue === 'superseded' ? 'historical' : 'current';
  if (!revision) return invalidQuery('Некорректный revision/scope');

  const rawQuality = aliased(params, 'quality', 'qualityStatus')?.trim() || 'all';
  const quality = (rawQuality === 'healthy' ? 'good' : rawQuality) as QuestionAdminQualityFilter;
  if (![
    'all', 'good', 'observe', 'review', 'insufficient', 'disabled', 'needs_review',
  ].includes(quality)) {
    return invalidQuery('Некорректный quality');
  }

  const sortValue = (one(params, 'sort')?.trim() || 'id') as QuestionAdminSort;
  if (!['id', 'topic', 'difficulty', 'status', 'quality', 'usage', 'revision'].includes(sortValue)) {
    return invalidQuery('Некорректный sort');
  }
  const directionValue = (one(params, 'direction')?.trim() || 'desc') as QuestionAdminDirection;
  if (directionValue !== 'asc' && directionValue !== 'desc') {
    return invalidQuery('Некорректный direction');
  }
  const limitValue = Number(one(params, 'limit') ?? 40);
  if (
    !Number.isInteger(limitValue)
    || limitValue < 1
    || limitValue > MAX_QUESTION_ADMIN_PAGE_SIZE
  ) {
    return invalidQuery(`limit должен быть от 1 до ${MAX_QUESTION_ADMIN_PAGE_SIZE}`);
  }

  const query: QuestionAdminListQuery = {
    q,
    questionId: positiveInteger(aliased(params, 'questionId', 'id'), 'questionId'),
    categoryId: positiveInteger(one(params, 'categoryId'), 'categoryId'),
    topic,
    difficulty,
    status: statusValue,
    revision,
    quality,
    sort: sortValue,
    direction: directionValue,
    offset: cursor.offset,
    cursorRevision: cursor.revision || null,
    cursorQueryKey: cursor.queryKey,
    cursorQualityGeneration: cursor.qualityGeneration,
    limit: limitValue,
  };
  if (query.cursorQueryKey && query.cursorQueryKey !== questionAdminQueryKey(query)) {
    return invalidQuery('Cursor относится к другому набору фильтров или сортировке');
  }
  return query;
}

function qualityRank(value: QuestionAdminQualityStatus | null) {
  if (value === 'review') return 0;
  if (value === 'observe') return 1;
  if (value === 'insufficient') return 2;
  if (value === 'good') return 3;
  if (value === 'disabled') return 4;
  return 5;
}

function statusRank(value: QuestionAdminLifecycleStatus) {
  if (value === 'superseded') return 0;
  if (value === 'archived') return 1;
  return 2;
}

export function compareQuestionAdminItems(
  left: QuestionAdminItemDto,
  right: QuestionAdminItemDto,
  sort: QuestionAdminSort,
  direction: QuestionAdminDirection,
) {
  let primary = 0;
  if (sort === 'topic') primary = left.topic.localeCompare(right.topic, 'ru-RU');
  else if (sort === 'difficulty') {
    primary = DIFFICULTIES.indexOf(left.difficulty) - DIFFICULTIES.indexOf(right.difficulty);
  } else if (sort === 'status') {
    primary = statusRank(left.lifecycleStatus) - statusRank(right.lifecycleStatus);
  } else if (sort === 'quality') {
    primary = qualityRank(left.qualityStatus) - qualityRank(right.qualityStatus);
  } else if (sort === 'usage') primary = left.usageCount - right.usageCount;
  else if (sort === 'revision') {
    primary = (left.introducedAt ?? -1) - (right.introducedAt ?? -1);
  } else primary = left.id - right.id;
  if (primary !== 0) return primary * (direction === 'asc' ? 1 : -1);
  // A direction-independent ID tie-breaker keeps cursor pages deterministic.
  return left.id - right.id;
}

function qualityMatches(
  filter: QuestionAdminQualityFilter,
  value: QuestionAdminQualityStatus | null,
) {
  if (filter === 'all') return true;
  if (filter === 'needs_review') return value === 'review' || value === 'observe';
  return value === filter;
}

export function questionAdminItemMatchesQuery(
  item: QuestionAdminItemDto,
  query: QuestionAdminListQuery,
) {
  if (
    query.revision === 'current'
    && (!item.currentRevisionMember || item.lifecycleStatus === 'superseded')
  ) return false;
  if (query.revision === 'historical' && item.lifecycleStatus !== 'superseded') return false;
  if (query.status === 'inactive' && item.active) return false;
  if (
    query.status !== 'all'
    && query.status !== 'inactive'
    && item.lifecycleStatus !== query.status
  ) return false;
  if (query.questionId !== null && item.id !== query.questionId) return false;
  if (query.categoryId !== null && item.categoryId !== query.categoryId) return false;
  if (query.topic !== null && item.topic !== query.topic) return false;
  if (query.difficulty !== null && item.difficulty !== query.difficulty) return false;
  if (!qualityMatches(query.quality, item.qualityStatus)) return false;
  if (!query.q) return true;
  const needle = normalizedQuestionAdminSearch(query.q);
  return [
    String(item.id),
    item.topic,
    item.prompt,
    item.context ?? '',
    item.dedupeKey,
    ...item.choices,
  ].some((value) => normalizedQuestionAdminSearch(value).includes(needle));
}
