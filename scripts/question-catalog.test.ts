import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { QuestionAdminItemDto } from '../lib/question-admin-contract.ts';
import {
  compareQuestionAdminItems,
  encodeQuestionAdminCursor,
  parseQuestionAdminListQuery,
  questionAdminItemMatchesQuery,
  questionAdminLifecycleStatus,
} from '../lib/question-admin-query.ts';

const revision = 'a'.repeat(64);

const defaults = parseQuestionAdminListQuery('http://localhost/api/admin/questions');
assert.equal(defaults.revision, 'current');
assert.equal(defaults.status, 'all');
assert.equal(defaults.quality, 'all');
assert.equal(defaults.limit, 40);

const uiFilters = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?scope=leaf&status=archived&category=%D0%A1%D0%B5%D1%82%D0%B8&difficulty=hard&sort=revision&direction=asc',
);
assert.equal(uiFilters.revision, 'current');
assert.equal(uiFilters.status, 'archived');
assert.equal(uiFilters.topic, 'Сети');
assert.equal(uiFilters.difficulty, 'hard');
assert.equal(uiFilters.sort, 'revision');

const historical = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?status=superseded',
);
assert.equal(historical.revision, 'historical');
assert.equal(historical.status, 'superseded');

const aliases = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?revision=all&status=inactive&qualityStatus=healthy&id=42&categoryId=7',
);
assert.equal(aliases.revision, 'all');
assert.equal(aliases.status, 'inactive');
assert.equal(aliases.quality, 'good');
assert.equal(aliases.questionId, 42);
assert.equal(aliases.categoryId, 7);

assert.throws(
  () => parseQuestionAdminListQuery('http://localhost/api/admin/questions?scope=leaf&revision=all'),
  /invalid_request/u,
);
assert.throws(
  () => parseQuestionAdminListQuery(`http://localhost/api/admin/questions?q=${'x'.repeat(161)}`),
  /invalid_request/u,
);
assert.throws(
  () => parseQuestionAdminListQuery('http://localhost/api/admin/questions?status=deleted'),
  /invalid_request/u,
);

const firstPageQuery = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?q=linux&scope=all&status=all&limit=20',
);
const cursor = encodeQuestionAdminCursor(revision, 20, firstPageQuery, null);
const secondPageQuery = parseQuestionAdminListQuery(
  `http://localhost/api/admin/questions?q=linux&scope=all&status=all&limit=20&cursor=${encodeURIComponent(cursor)}`,
);
assert.equal(secondPageQuery.offset, 20);
assert.equal(secondPageQuery.cursorRevision, revision);
const qualityCursorQuery = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?quality=needs_review&sort=quality&limit=10',
);
const qualityCursor = encodeQuestionAdminCursor(revision, 10, qualityCursorQuery, 7);
const qualitySecondPage = parseQuestionAdminListQuery(
  `http://localhost/api/admin/questions?quality=needs_review&sort=quality&limit=10&cursor=${encodeURIComponent(qualityCursor)}`,
);
assert.equal(qualitySecondPage.cursorQualityGeneration, 7);
assert.throws(
  () => parseQuestionAdminListQuery(
    `http://localhost/api/admin/questions?q=windows&scope=all&status=all&limit=20&cursor=${encodeURIComponent(cursor)}`,
  ),
  /invalid_request/u,
  'cursor must not be reusable with another search/filter set',
);

assert.equal(questionAdminLifecycleStatus(true, null), 'active');
assert.equal(questionAdminLifecycleStatus(false, null), 'archived');
assert.equal(questionAdminLifecycleStatus(false, 101), 'superseded');
assert.equal(
  questionAdminLifecycleStatus(true, 101),
  'superseded',
  'a successor always wins over a corrupted/stale active flag in lifecycle presentation',
);

function item(overrides: Partial<QuestionAdminItemDto> = {}): QuestionAdminItemDto {
  return {
    id: 1,
    categoryId: 7,
    difficulty: 'easy',
    topic: 'Сети',
    prompt: 'Как проверить Linux-узел?',
    promptPreview: 'Как проверить Linux-узел?',
    contextType: null,
    context: null,
    choices: ['ping', 'format'],
    active: true,
    weight: 1,
    dedupeKey: 'linux:ping',
    predecessorId: null,
    successorId: null,
    usageCount: 10,
    lifecycleStatus: 'active',
    currentRevisionMember: true,
    introducedBankRevision: revision,
    introducedAt: 100,
    qualityStatus: 'good',
    ...overrides,
  };
}

const unicodeSearch = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?q=LINUX&scope=leaf&status=active',
);
assert.equal(questionAdminItemMatchesQuery(item(), unicodeSearch), true);
assert.equal(
  questionAdminItemMatchesQuery(item({ currentRevisionMember: false }), unicodeSearch),
  false,
  'current leaf scope must not expose an orphan outside the current revision snapshot',
);
assert.equal(
  questionAdminItemMatchesQuery(
    item({ active: false, lifecycleStatus: 'archived', qualityStatus: 'disabled' }),
    unicodeSearch,
  ),
  false,
);
const archivedAlias = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?status=inactive',
);
assert.equal(
  questionAdminItemMatchesQuery(
    item({ active: false, lifecycleStatus: 'archived', qualityStatus: 'disabled' }),
    archivedAlias,
  ),
  true,
);
assert.equal(
  questionAdminItemMatchesQuery(
    item({ active: false, lifecycleStatus: 'superseded', successorId: 2, qualityStatus: 'disabled' }),
    archivedAlias,
  ),
  false,
  'default current scope still hides historical revisions from legacy inactive',
);
const allInactive = parseQuestionAdminListQuery(
  'http://localhost/api/admin/questions?status=inactive&scope=all',
);
assert.equal(
  questionAdminItemMatchesQuery(
    item({ active: false, lifecycleStatus: 'superseded', successorId: 2, qualityStatus: 'disabled' }),
    allInactive,
  ),
  true,
  'legacy inactive keeps its pre-lifecycle meaning when all revisions are requested',
);

const sameTopic = [item({ id: 9 }), item({ id: 2 })];
sameTopic.sort((left, right) => compareQuestionAdminItems(left, right, 'topic', 'desc'));
assert.deepEqual(
  sameTopic.map((entry) => entry.id),
  [2, 9],
  'ID is the stable direction-independent tie-breaker',
);

const serviceSource = readFileSync(
  new URL('../lib/question-admin-service.ts', import.meta.url),
  'utf8',
);
assert.doesNotMatch(
  serviceSource,
  /DELETE\s+FROM\s+questions/iu,
  'question lifecycle must never physically delete immutable or referenced rows',
);
assert.match(
  serviceSource,
  /ensureActiveQuestionCategory\(db, row\.topic\)/u,
  'reactivation must keep the active-category guard',
);

console.log('Question catalog tests: PASS');
