import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeQuestionCategoryName,
  normalizeQuestionCategoryDependencies,
  planQuestionCategoryBootstrap,
  validateQuestionCategoryName,
} from '../lib/question-categories.ts';

assert.equal(normalizeQuestionCategoryName('Сети'), 'сети');
assert.equal(normalizeQuestionCategoryName('сети'), 'сети');
assert.equal(
  normalizeQuestionCategoryName('  Сети\u00a0\u00a0и   протоколы  '),
  'сети и протоколы',
  'Unicode whitespace and repeated spaces must not create another category identity',
);
assert.equal(
  normalizeQuestionCategoryName('Ｆｉｒｅｗａｌｌ'),
  'firewall',
  'NFKC-equivalent names must share one identity',
);
assert.equal(
  new Set(['Сети', 'сети', '  СЕТИ  '].map(normalizeQuestionCategoryName)).size,
  1,
  'case variants of a Russian category must collide',
);

assert.deepEqual(validateQuestionCategoryName('  Сети\u00a0  и  протоколы '), {
  name: 'Сети и протоколы',
  normalizedName: 'сети и протоколы',
});
assert.equal(validateQuestionCategoryName(''), null);
assert.equal(validateQuestionCategoryName('   '), null);
assert.equal(validateQuestionCategoryName('Сети\nLinux'), null);
assert.equal(validateQuestionCategoryName('x'.repeat(81)), null);
assert.equal(validateQuestionCategoryName(42), null);

const bootstrap = planQuestionCategoryBootstrap([
  { id: 7, topic: '  Сети  ', currentLeaf: false },
  { id: 8, topic: 'сети', currentLeaf: true },
  { id: 9, topic: 'Legacy only', currentLeaf: false },
  { id: 10, topic: 'Ｌｉｎｕｘ', currentLeaf: true },
  { id: 11, topic: 'Linux', currentLeaf: false },
]);
assert.deepEqual(bootstrap.categories, [
  {
    name: 'Legacy only',
    normalizedName: 'legacy only',
    selectionKey: 'Legacy only',
    active: 0,
  },
  {
    name: 'Linux',
    normalizedName: 'linux',
    selectionKey: 'Linux',
    active: 1,
  },
  {
    name: 'сети',
    normalizedName: 'сети',
    selectionKey: 'сети',
    active: 1,
  },
], 'bootstrap must coalesce Unicode identities and keep historical-only topics inactive');
assert.deepEqual(
  planQuestionCategoryBootstrap([
    { id: 2, topic: 'Сети\u00a0 и протоколы', currentLeaf: false },
    { id: 1, topic: 'сети  и  протоколы', currentLeaf: true },
  ]).categories.length,
  1,
  'NFKC/whitespace variants must never seed phantom categories',
);
assert.throws(
  () => planQuestionCategoryBootstrap([{ id: 1, topic: '\n', currentLeaf: true }]),
  /question_category_seed_invalid_name/u,
);

assert.deepEqual(normalizeQuestionCategoryDependencies([
  { id: 4, name: 'Linux', selectionKey: 'Linux' },
  { id: 2, name: 'Сети', selectionKey: 'Сети' },
  { id: 4, name: 'Linux', selectionKey: 'Linux' },
]), [
  { id: 2, name: 'Сети', selectionKey: 'Сети' },
  { id: 4, name: 'Linux', selectionKey: 'Linux' },
], 'category dependencies must be deterministic and deduplicated for one set-based guard');
assert.throws(() => normalizeQuestionCategoryDependencies([
  { id: 4, name: 'Linux', selectionKey: 'Linux' },
  { id: 4, name: 'Linux/Unix', selectionKey: 'Linux' },
]), /question_category_dependency_conflict/u);

const attemptRouteSource = readFileSync(
  new URL('../app/api/attempts/route.ts', import.meta.url),
  'utf8',
);
const frozenRevisionCandidateQuery = attemptRouteSource.match(
  /SELECT questions\.id[\s\S]*?ORDER BY RANDOM\(\)/u,
)?.[0];
assert(frozenRevisionCandidateQuery, 'attempt candidate query must remain discoverable');
assert.match(
  frozenRevisionCandidateQuery,
  /JOIN question_categories category\s+ON category\.id = questions\.category_id/u,
);
assert.doesNotMatch(
  frozenRevisionCandidateQuery,
  /category\.active/u,
  'a revision-frozen source pool must survive a later category merge/deactivation',
);

const qualityQueueRouteSource = readFileSync(
  new URL('../app/api/admin/questions/quality-queue/route.ts', import.meta.url),
  'utf8',
);
assert.match(
  qualityQueueRouteSource,
  /limit:\s*Number\.MAX_SAFE_INTEGER/u,
  'quality queue must request the complete materialized derived set',
);
assert.doesNotMatch(
  qualityQueueRouteSource,
  /MAX_CHANGE_SET_OPERATIONS|limit:\s*250/u,
  'mutation batch limits must not truncate the quality queue',
);
assert.match(
  qualityQueueRouteSource,
  /totalCount:\s*items\.length/u,
  'quality queue total must describe every actionable returned item',
);

const runtimeSource = readFileSync(new URL('../db/runtime.ts', import.meta.url), 'utf8');
assert.match(
  runtimeSource,
  /INSERT OR IGNORE INTO question_categories/u,
  'parallel Worker bootstraps must converge instead of failing on duplicate category inserts',
);
assert.match(
  runtimeSource,
  /if \(statements\.length > 0\) await db\.batch\(statements\);[\s\S]*?resolvedCategories[\s\S]*?question_category_current_leaf_integrity/u,
  'bootstrap must re-read persisted categories and verify current-leaf integrity after the idempotent insert',
);

console.log('Question bank workflow unit tests: PASS');
