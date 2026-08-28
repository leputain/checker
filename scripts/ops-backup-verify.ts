import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalD1File, queryLocalD1 } from './local-d1.ts';
import { resolveOpsContext, type OpsContextOptions } from './ops-context.ts';
import { ANALYTICS_FACTS_INTEGRITY_QUERY } from '../lib/analytics-facts-integrity.ts';

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
      bank_revision_items: count('question_bank_revision_items'),
      question_reviews: count('question_review_history'),
      analytics_refresh_state: count('analytics_refresh_state'),
      analytics_report_aggregates: count('analytics_report_aggregates'),
      analytics_candidate_aggregates: count('analytics_candidate_aggregates'),
      analytics_daily_question_aggregates: count('analytics_daily_question_aggregates'),
      analytics_daily_choice_aggregates: count('analytics_daily_choice_aggregates'),
      analytics_daily_timing_aggregates: count('analytics_daily_timing_aggregates'),
      analytics_candidate_dimensions: count('analytics_candidate_dimensions'),
      schema_version: tables.has('schema_migrations')
        ? '(SELECT COALESCE(MAX(version), 0) FROM schema_migrations)'
        : '0',
      bank_revision: tables.has('question_bank_revisions')
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
