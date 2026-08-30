import { QUESTION_LIMITS } from './question-bank-validation.ts';

const UNSAFE_UNICODE_CATEGORY = /\p{C}/u;

/**
 * Category identity is Unicode-aware and therefore computed in TypeScript,
 * never with SQLite's ASCII-only `lower()`. The runtime migration bootstrap
 * writes this exact value into the unique `normalized_name` column.
 */
export function normalizeQuestionCategoryName(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU');
}

export function validateQuestionCategoryName(value: unknown) {
  if (typeof value !== 'string') return null;
  const unicode = value.normalize('NFKC');
  if (UNSAFE_UNICODE_CATEGORY.test(unicode)) return null;
  const name = unicode.trim().replace(/\s+/gu, ' ');
  if (
    !name
    || name.length > QUESTION_LIMITS.topicLength
  ) return null;
  return {
    name,
    normalizedName: normalizeQuestionCategoryName(name),
  };
}

export type QuestionCategoryBootstrapInput = {
  id: number;
  topic: string;
  currentLeaf: boolean;
};

export type QuestionCategoryBootstrapPlan = {
  categories: Array<{
    name: string;
    normalizedName: string;
    selectionKey: string;
    active: number;
  }>;
};

export function planQuestionCategoryBootstrap(
  questions: readonly QuestionCategoryBootstrapInput[],
): QuestionCategoryBootstrapPlan {
  const categories = new Map<string, QuestionCategoryBootstrapPlan['categories'][number]>();
  for (const question of questions) {
    const parsed = validateQuestionCategoryName(question.topic);
    if (!parsed) throw new Error('question_category_seed_invalid_name');
    const existing = categories.get(parsed.normalizedName);
    const candidateIsPreferred = !existing
      || (question.currentLeaf && existing.active === 0)
      || ((question.currentLeaf ? 1 : 0) === existing.active
        && parsed.name.localeCompare(existing.name, 'ru-RU') < 0);
    const canonicalName = candidateIsPreferred ? parsed.name : existing.name;
    categories.set(parsed.normalizedName, {
      name: canonicalName,
      normalizedName: parsed.normalizedName,
      selectionKey: canonicalName,
      active: Math.max(existing?.active ?? 0, question.currentLeaf ? 1 : 0),
    });
  }
  return {
    categories: [...categories.values()].sort((left, right) => (
      left.normalizedName < right.normalizedName
        ? -1
        : left.normalizedName > right.normalizedName ? 1 : 0
    )),
  };
}

export async function activeQuestionCategory(
  db: D1Database,
  name: string,
) {
  return db.prepare(`SELECT id, name, normalized_name, selection_key, active
    FROM question_categories WHERE normalized_name = ? AND active = 1`)
    .bind(normalizeQuestionCategoryName(name))
    .first<{
      id: number;
      name: string;
      normalized_name: string;
      selection_key: string;
      active: number;
    }>();
}

export type QuestionCategoryDependency = {
  id: number;
  name: string;
  selectionKey: string;
};

export function normalizeQuestionCategoryDependencies(
  dependencies: readonly QuestionCategoryDependency[],
) {
  const byId = new Map<number, QuestionCategoryDependency>();
  for (const dependency of dependencies) {
    const existing = byId.get(dependency.id);
    if (
      existing
      && (existing.name !== dependency.name || existing.selectionKey !== dependency.selectionKey)
    ) throw new Error('question_category_dependency_conflict');
    byId.set(dependency.id, dependency);
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

/**
 * D1 batch guard for category rows consumed by a question mutation. Assigning
 * NULL to the NOT NULL `active` column aborts and rolls back the whole batch
 * when a concurrent catalog mutation changed any dependency after pre-read.
 */
export function questionCategoryDependencyGuardStatement(
  db: D1Database,
  dependencies: readonly QuestionCategoryDependency[],
) {
  const normalized = normalizeQuestionCategoryDependencies(dependencies);
  if (normalized.length === 0) return null;
  const payload = JSON.stringify(normalized);
  return db.prepare(`UPDATE question_categories
    SET active = CASE
      WHEN active = 1 AND EXISTS (
        SELECT 1 FROM json_each(?) dependency
        WHERE CAST(json_extract(dependency.value, '$.id') AS INTEGER) = question_categories.id
          AND json_extract(dependency.value, '$.name') = question_categories.name
          AND json_extract(dependency.value, '$.selectionKey') = question_categories.selection_key
      ) THEN active ELSE NULL END
    WHERE id IN (
      SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?)
    )`).bind(payload, payload);
}
