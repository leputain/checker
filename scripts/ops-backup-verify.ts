import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalD1File, queryLocalD1 } from './local-d1.ts';
import { resolveOpsContext, type OpsContextOptions } from './ops-context.ts';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';
import {
  normalizeQuestionCategoryName,
  validateQuestionCategoryName,
} from '../lib/question-categories.ts';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export type BackupVerificationOptions = OpsContextOptions & {
  verificationRoot?: string;
};

export async function verifyBackup(
  inputPath: string,
  options: BackupVerificationOptions = {},
) {
  const context = resolveOpsContext(options);
  const sqlPath = path.resolve(inputPath);
  if (!sqlPath.toLowerCase().endsWith('.sql')) throw new Error('Expected a .sql backup file.');
  const manifestPath = sqlPath.replace(/\.sql$/i, '.manifest.json');
  const sqlBytes = await readFile(sqlPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    format?: number;
    sha256: string;
    counts: Record<string, number | string | null>;
  };
  const digest = createHash('sha256').update(sqlBytes).digest('hex');
  if (digest !== manifest.sha256) throw new Error('Backup checksum mismatch.');

  const verificationRoot = path.resolve(
    options.verificationRoot
      ?? path.join(context.workspaceRoot, '.data', 'backup-verification'),
  );
  await mkdir(verificationRoot, { recursive: true });
  const persistTo = await mkdtemp(path.join(verificationRoot, 'run-'));
  try {
    executeLocalD1File(sqlPath, persistTo, context.localD1);
    assertLocalDatabaseIntegrity(persistTo, context.localD1);
    const tables = new Set(queryLocalD1<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
      persistTo,
      context.localD1,
    ).map((row) => row.name));
    const count = (table: string) => tables.has(table) ? `(SELECT COUNT(*) FROM ${table})` : '0';
    const expressions: Record<string, string> = {
      attempts: count('attempts'),
      answers: count('answers'),
      attempt_questions: count('attempt_questions'),
      questions: count('questions'),
      outbox: count('telegram_outbox'),
      test_config_versions: count('test_config_versions'),
      bank_revisions: count('question_bank_revisions'),
      bank_revision_items: count('question_bank_revision_items'),
      bank_state: count('question_bank_state'),
      question_version_links: count('question_version_links'),
      question_bank_change_events: count('question_bank_change_events'),
      question_bank_mutations: count('question_bank_mutations'),
      question_categories: count('question_categories'),
      question_bank_change_sets: count('question_bank_change_sets'),
      question_bank_change_set_items: count('question_bank_change_set_items'),
      question_reviews: count('question_review_history'),
      analytics_refresh_state: count('analytics_refresh_state'),
      analytics_report_aggregates: count('analytics_report_aggregates'),
      analytics_candidate_aggregates: count('analytics_candidate_aggregates'),
      analytics_daily_question_aggregates: count('analytics_daily_question_aggregates'),
      analytics_daily_choice_aggregates: count('analytics_daily_choice_aggregates'),
      analytics_daily_timing_aggregates: count('analytics_daily_timing_aggregates'),
      analytics_candidate_dimensions: count('analytics_candidate_dimensions'),
      security_challenge_configs: count('security_challenge_configs'),
      security_challenge_attempts: count('security_challenge_attempts'),
      security_challenge_question_events: count('security_challenge_question_events'),
      security_challenge_feedback: count('security_challenge_feedback'),
      schema_version: tables.has('schema_migrations')
        ? '(SELECT COALESCE(MAX(version), 0) FROM schema_migrations)'
        : '0',
      bank_revision: tables.has('question_bank_state')
        ? '(SELECT current_revision FROM question_bank_state WHERE id = 1)'
        : tables.has('question_bank_revisions')
          ? '(SELECT hash FROM question_bank_revisions ORDER BY applied_at DESC LIMIT 1)'
        : 'NULL',
    };
    const keys = Object.keys(manifest.counts).filter((key) => key in expressions);
    const counts = queryLocalD1<Record<string, number | string | null>>(
      `SELECT ${keys.map((key) => `${expressions[key]} AS ${key}`).join(', ')}`,
      persistTo,
      context.localD1,
    )[0];
    for (const key of keys) {
      if (counts[key] !== manifest.counts[key]) throw new Error(`Backup count mismatch: ${key}.`);
    }
    console.log(`Backup verified: ${path.relative(context.workspaceRoot, sqlPath)}`);
  } finally {
    const resolved = path.resolve(persistTo);
    if (!resolved.startsWith(`${verificationRoot}${path.sep}`)) {
      throw new Error('Unsafe verification cleanup path.');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export function assertLocalDatabaseIntegrity(
  persistTo?: string,
  localD1 = resolveOpsContext().localD1,
) {
  const quickCheck = queryLocalD1<{ quick_check: string }>(
    'PRAGMA quick_check',
    persistTo,
    localD1,
  )[0];
  if (quickCheck?.quick_check !== 'ok') throw new Error('SQLite quick_check failed.');
  const foreignKeyViolations = queryLocalD1<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>('PRAGMA foreign_key_check', persistTo, localD1);
  if (foreignKeyViolations.length > 0) {
    throw new Error(`SQLite foreign_key_check failed: ${foreignKeyViolations.length}.`);
  }
  const tables = new Set(queryLocalD1<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    persistTo,
    localD1,
  ).map((row) => row.name));
  if (tables.has('schema_migrations')) {
    const schemaVersion = queryLocalD1<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
      persistTo,
      localD1,
    )[0]?.version ?? 0;
    if (schemaVersion >= 11) {
      if (!tables.has('analytics_refresh_state') || !tables.has('analytics_report_aggregates')) {
        throw new Error('Analytics aggregate schema is incomplete.');
      }
      const refreshState = queryLocalD1<{ count: number; min_generation: number }>(
        `SELECT COUNT(*) AS count, COALESCE(MIN(generation), 0) AS min_generation
          FROM analytics_refresh_state WHERE id = 1`,
        persistTo,
        localD1,
      )[0];
      if (refreshState?.count !== 1 || refreshState.min_generation < 1) {
        throw new Error('Analytics refresh state is invalid.');
      }
    }
    if (schemaVersion >= 12) {
      for (const table of [
        'analytics_candidate_aggregates',
        'analytics_daily_question_aggregates',
        'analytics_daily_choice_aggregates',
        'analytics_daily_timing_aggregates',
      ]) {
        if (!tables.has(table)) throw new Error(`Analytics derived table is missing: ${table}.`);
      }
    }
    if (schemaVersion >= 13 && !tables.has('analytics_candidate_dimensions')) {
      throw new Error('Analytics candidate dimensions table is missing.');
    }
    if (schemaVersion >= 14) {
      const indexes = new Set(queryLocalD1<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
        persistTo,
        localD1,
      ).map((row) => row.name));
      for (const indexName of [
        'idx_attempts_facts_readiness',
        'idx_attempts_retention_started',
        'idx_attempts_retention_completed',
        'idx_telegram_outbox_retention',
        'idx_telegram_outbox_attempt_status',
      ]) {
        if (!indexes.has(indexName)) throw new Error(`Operational index is missing: ${indexName}.`);
      }
    }
    if (schemaVersion >= 16) {
      for (const table of [
        'question_bank_state',
        'question_version_links',
        'question_bank_change_events',
        'question_bank_mutations',
      ]) {
        if (!tables.has(table)) throw new Error(`Question bank admin table is missing: ${table}.`);
      }
      const bankIntegrity = queryLocalD1<{
        state_count: number;
        current_bank_count: number;
        question_count: number;
        revision_count: number;
        snapshot_count_mismatch: number;
        snapshot_active_mismatch: number;
        current_membership_mismatch: number;
        invalid_links: number;
        invalid_events: number;
        invalid_mutations: number;
      }>(`WITH current_bank AS (
          SELECT state.current_revision, revisions.total_count, revisions.active_count
          FROM question_bank_state AS state
          JOIN question_bank_revisions AS revisions ON revisions.hash = state.current_revision
          WHERE state.id = 1
        )
        SELECT
          (SELECT COUNT(*) FROM question_bank_state) AS state_count,
          (SELECT COUNT(*) FROM current_bank) AS current_bank_count,
          (SELECT COUNT(*) FROM questions) AS question_count,
          (SELECT COUNT(*) FROM question_bank_revisions) AS revision_count,
          (SELECT COUNT(*) FROM current_bank
            WHERE (SELECT COUNT(*) FROM question_bank_revision_items AS items
              WHERE items.revision_hash = current_bank.current_revision) != current_bank.total_count
          ) AS snapshot_count_mismatch,
          (SELECT COUNT(*) FROM current_bank
            WHERE (SELECT COALESCE(SUM(items.active), 0) FROM question_bank_revision_items AS items
              WHERE items.revision_hash = current_bank.current_revision) != current_bank.active_count
          ) AS snapshot_active_mismatch,
          (SELECT COUNT(*) FROM current_bank
            JOIN question_bank_revision_items AS items
              ON items.revision_hash = current_bank.current_revision
            JOIN questions ON questions.id = items.question_id
            WHERE questions.active != items.active
          ) AS current_membership_mismatch,
          (SELECT COUNT(*) FROM question_version_links
            WHERE predecessor_question_id = successor_question_id
              OR successor_question_id <= predecessor_question_id
          ) AS invalid_links,
          (SELECT COUNT(*) FROM question_bank_change_events
            WHERE event_type NOT IN ('created', 'revised', 'activated', 'deactivated')
              OR LENGTH(COALESCE(note, '')) > 500
          ) AS invalid_events,
          (SELECT COUNT(*) FROM question_bank_mutations AS mutations
            LEFT JOIN question_bank_revisions AS expected
              ON expected.hash = mutations.expected_revision
            WHERE mutations.operation NOT IN (
              'create', 'revise', 'toggle', 'bulk',
              'category-create', 'category-rename', 'category-merge',
              'change-set-create', 'change-set-update',
              'change-set-publish', 'change-set-discard', 'import-apply'
            )
              OR expected.hash IS NULL
              OR LENGTH(mutations.idempotency_key) NOT BETWEEN 8 AND 128
              OR LENGTH(mutations.request_hash) != 64
              OR NOT json_valid(mutations.response_json)
          ) AS invalid_mutations`, persistTo, localD1)[0];
      if (
        !(
          (
            bankIntegrity?.state_count === 1
            && bankIntegrity.current_bank_count === 1
          )
          || (
            bankIntegrity?.state_count === 0
            && bankIntegrity.current_bank_count === 0
            && bankIntegrity.question_count === 0
            && bankIntegrity.revision_count === 0
          )
        )
        || bankIntegrity.snapshot_count_mismatch !== 0
        || bankIntegrity.snapshot_active_mismatch !== 0
        || bankIntegrity.current_membership_mismatch !== 0
        || bankIntegrity.invalid_links !== 0
        || bankIntegrity.invalid_events !== 0
        || bankIntegrity.invalid_mutations !== 0
      ) {
        throw new Error('Question bank admin integrity failed.');
      }
      type IntegrityQuestion = {
        id: number;
        difficulty: string;
        topic: string;
        prompt: string;
        context_type: string | null;
        context_text: string | null;
        choices_json: string;
        correct_index: number;
        weight: number;
        active?: number;
        content_hash: string | null;
        dedupe_key: string;
      };
      const canonicalQuestion = (row: IntegrityQuestion) => ({
        id: row.id,
        difficulty: row.difficulty,
        topic: row.topic,
        prompt: row.prompt,
        ...(row.context_type && row.context_text !== null
          ? { contextType: row.context_type, context: row.context_text }
          : {}),
        choices: JSON.parse(row.choices_json) as unknown,
        correctIndex: row.correct_index,
        weight: row.weight,
      });
      const questionRows = queryLocalD1<IntegrityQuestion>(`SELECT id, difficulty, topic,
          prompt, context_type, context_text, choices_json, correct_index, weight,
          content_hash, dedupe_key
        FROM questions ORDER BY id`, persistTo, localD1);
      for (const row of questionRows) {
        const expected = createHash('sha256').update(JSON.stringify({
          ...canonicalQuestion(row),
          dedupeKey: row.dedupe_key,
        })).digest('hex');
        if (row.content_hash !== expected) {
          throw new Error(`Question content hash mismatch: ${row.id}.`);
        }
      }
      if (bankIntegrity.current_bank_count === 1) {
        const currentRows = queryLocalD1<IntegrityQuestion & { active: number }>(`SELECT
            questions.id, questions.difficulty, questions.topic, questions.prompt,
            questions.context_type, questions.context_text, questions.choices_json,
            questions.correct_index, questions.weight, questions.content_hash,
            questions.dedupe_key, membership.active
          FROM question_bank_state state
          JOIN question_bank_revision_items membership
            ON membership.revision_hash = state.current_revision
          JOIN questions ON questions.id = membership.question_id
          WHERE state.id = 1
          ORDER BY questions.id`, persistTo, localD1);
        const expectedRevision = createHash('sha256').update(JSON.stringify(currentRows.map((row) => ({
          ...canonicalQuestion(row),
          active: row.active === 1,
          dedupeKey: row.dedupe_key,
        })))).digest('hex');
        const storedRevision = queryLocalD1<{ current_revision: string }>(
          'SELECT current_revision FROM question_bank_state WHERE id = 1',
          persistTo,
          localD1,
        )[0]?.current_revision;
        if (storedRevision !== expectedRevision) throw new Error('Question bank revision hash mismatch.');
      }
    }
    if (schemaVersion >= 17) {
      for (const table of [
        'question_categories',
        'question_bank_change_sets',
        'question_bank_change_set_items',
      ]) {
        if (!tables.has(table)) throw new Error(`Question bank workflow table is missing: ${table}.`);
      }
      const indexes = new Set(queryLocalD1<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
        persistTo,
        localD1,
      ).map((row) => row.name));
      for (const indexName of [
        'idx_question_categories_normalized_name',
        'idx_question_categories_selection_key',
        'idx_question_categories_active_name',
        'idx_question_bank_change_sets_status_updated',
        'idx_question_bank_change_sets_base_revision',
        'idx_question_bank_change_set_items_question',
        'idx_question_bank_change_set_items_change_set',
      ]) {
        if (!indexes.has(indexName)) throw new Error(`Question bank workflow index is missing: ${indexName}.`);
      }
      const workflowIntegrity = queryLocalD1<{
        invalid_categories: number;
        missing_current_categories: number;
        invalid_change_sets: number;
        invalid_change_set_items: number;
      }>(`SELECT
          (SELECT COUNT(*) FROM question_categories
            WHERE active NOT IN (0, 1)
              OR LENGTH(TRIM(name)) NOT BETWEEN 1 AND 80
              OR LENGTH(TRIM(normalized_name)) = 0
              OR LENGTH(TRIM(selection_key)) NOT BETWEEN 1 AND 80
          ) AS invalid_categories,
          (SELECT COUNT(*)
            FROM question_bank_state AS state
            JOIN question_bank_revision_items AS membership
              ON membership.revision_hash = state.current_revision
            JOIN questions ON questions.id = membership.question_id
            LEFT JOIN question_version_links AS successor
              ON successor.predecessor_question_id = questions.id
            LEFT JOIN question_categories AS categories
              ON categories.id = questions.category_id AND categories.active = 1
            WHERE state.id = 1
              AND successor.successor_question_id IS NULL
              AND categories.id IS NULL
          ) AS missing_current_categories,
          (SELECT COUNT(*) FROM question_bank_change_sets
            WHERE status NOT IN ('draft', 'published', 'discarded')
              OR LENGTH(TRIM(title)) NOT BETWEEN 1 AND 120
              OR LENGTH(COALESCE(note, '')) > 500
              OR (status = 'draft' AND (published_revision IS NOT NULL OR published_at IS NOT NULL))
              OR (status = 'published' AND (published_revision IS NULL OR published_at IS NULL))
          ) AS invalid_change_sets,
          (SELECT COUNT(*) FROM question_bank_change_set_items AS items
            WHERE NOT json_valid(items.patch_json)
              OR json_type(items.patch_json) != 'object'
              OR NOT EXISTS (SELECT 1 FROM json_each(items.patch_json))
              OR EXISTS (
                SELECT 1 FROM json_each(items.patch_json)
                WHERE json_each.key NOT IN ('topic', 'difficulty', 'active')
              )
          ) AS invalid_change_set_items`, persistTo, localD1)[0];
      if (
        workflowIntegrity.invalid_categories !== 0
        || workflowIntegrity.missing_current_categories !== 0
        || workflowIntegrity.invalid_change_sets !== 0
        || workflowIntegrity.invalid_change_set_items !== 0
      ) {
        throw new Error('Question bank workflow integrity failed.');
      }
      const storedCategories = queryLocalD1<{
        id: number;
        name: string;
        normalized_name: string;
        selection_key: string;
      }>('SELECT id, name, normalized_name, selection_key FROM question_categories ORDER BY id', persistTo, localD1);
      const categoryIdentities = new Set<string>();
      const selectionKeys = new Set<string>();
      for (const category of storedCategories) {
        const validated = validateQuestionCategoryName(category.name);
        const validatedSelectionKey = validateQuestionCategoryName(category.selection_key);
        const normalized = normalizeQuestionCategoryName(category.name);
        const normalizedSelectionKey = normalizeQuestionCategoryName(category.selection_key);
        if (
          !validated
          || !validatedSelectionKey
          || validated.name !== category.name
          || validatedSelectionKey.name !== category.selection_key
          || normalized !== category.normalized_name
          || categoryIdentities.has(normalized)
          || selectionKeys.has(normalizedSelectionKey)
        ) {
          throw new Error(`Question category identity is invalid: ${category.id}.`);
        }
        categoryIdentities.add(normalized);
        selectionKeys.add(normalizedSelectionKey);
      }
      for (const category of storedCategories) {
        const normalizedSelectionKey = normalizeQuestionCategoryName(category.selection_key);
        const conflictingCategory = storedCategories.find((candidate) => (
          candidate.id !== category.id
          && candidate.normalized_name === normalizedSelectionKey
        ));
        if (conflictingCategory) {
          throw new Error(
            `Question category selection identity conflicts with category ${conflictingCategory.id}: ${category.id}.`,
          );
        }
      }
      const currentLeafCategories = queryLocalD1<{
        id: number;
        topic: string;
        category_name: string;
      }>(`SELECT questions.id, questions.topic, category.name AS category_name
          FROM question_bank_state AS state
          JOIN question_bank_revision_items AS membership
            ON membership.revision_hash = state.current_revision
          JOIN questions ON questions.id = membership.question_id
          LEFT JOIN question_version_links AS successor
            ON successor.predecessor_question_id = questions.id
          JOIN question_categories AS category
            ON category.id = questions.category_id AND category.active = 1
          WHERE state.id = 1 AND successor.successor_question_id IS NULL`,
      persistTo, localD1);
      const mismatchedCurrentLeaf = currentLeafCategories.find((question) => (
        normalizeQuestionCategoryName(question.topic)
        !== normalizeQuestionCategoryName(question.category_name)
      ));
      if (mismatchedCurrentLeaf) {
        throw new Error(`Question current category does not match topic: ${mismatchedCurrentLeaf.id}.`);
      }
      const questionsWithoutCategory = queryLocalD1<{ count: number }>(
        `SELECT COUNT(*) AS count
          FROM questions
          LEFT JOIN question_categories AS category ON category.id = questions.category_id
          WHERE questions.category_id IS NULL OR category.id IS NULL`,
        persistTo,
        localD1,
      )[0]?.count ?? 0;
      if (questionsWithoutCategory > 0) {
        throw new Error(`Question category assignment is missing: ${questionsWithoutCategory}.`);
      }
    }
  }
  const attemptColumns = queryLocalD1<{ name: string }>(
    'PRAGMA table_info(attempts)',
    persistTo,
    localD1,
  );
  if (!attemptColumns.some((column) => column.name === 'analytics_facts_version')) return;
  const facts = queryLocalD1<{ violations: number }>(
    ANALYTICS_FACTS_INTEGRITY_QUERY,
    persistTo,
    localD1,
  )[0];
  if ((facts?.violations ?? 0) > 0) {
    throw new Error(`Analytics facts integrity failed: ${facts.violations}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const source = argument('--from');
  if (!source) {
    console.error('Использование: npm run ops:backup:verify -- --from <backup.sql>');
    process.exitCode = 2;
  } else {
    verifyBackup(source).catch(() => {
      console.error('Backup verification failed.');
      process.exitCode = 1;
    });
  }
}
