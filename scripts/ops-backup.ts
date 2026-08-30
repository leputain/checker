import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryLocalD1, runWrangler } from './local-d1.ts';
import { APP_RELEASE } from '../lib/release.ts';
import { resolveOpsContext, type OpsContextOptions } from './ops-context.ts';
import {
  enforceBackupRetentionBestEffort,
  RAW_BACKUP_TTL_MS,
} from './backup-retention.ts';

type Counts = {
  attempts: number;
  answers: number;
  attempt_questions: number;
  questions: number;
  outbox: number;
  test_config_versions: number;
  bank_revisions: number;
  bank_revision_items: number;
  bank_state: number;
  question_version_links: number;
  question_bank_change_events: number;
  question_bank_mutations: number;
  question_reviews: number;
  analytics_refresh_state: number;
  analytics_report_aggregates: number;
  analytics_candidate_aggregates: number;
  analytics_daily_question_aggregates: number;
  analytics_daily_choice_aggregates: number;
  analytics_daily_timing_aggregates: number;
  analytics_candidate_dimensions: number;
  schema_version: number;
  bank_revision: string | null;
};

function timestamp(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replace('.', '-');
}

export type BackupOptions = OpsContextOptions & {
  backupDirectory?: string;
};

export async function createBackup(options: BackupOptions = {}) {
  const context = resolveOpsContext(options);
  const backupDirectory = path.resolve(
    options.backupDirectory ?? path.join(context.workspaceRoot, 'backups'),
  );
  await enforceBackupRetentionBestEffort({
    workspaceRoot: context.workspaceRoot,
    backupRoot: backupDirectory,
    apply: true,
  });
  await mkdir(backupDirectory, { recursive: true });
  const createdAt = new Date();
  const base = `candidate-check-${timestamp(createdAt)}-${randomUUID().slice(0, 8)}`;
  const sqlPath = path.join(backupDirectory, `${base}.sql`);
  const manifestPath = path.join(backupDirectory, `${base}.manifest.json`);

  // Wrangler's export command uses the configured default local D1 path and,
  // unlike `d1 execute`, does not accept `--persist-to`.
  runWrangler(
    ['d1', 'export', 'DB', '--skip-confirmation', '--output', sqlPath],
    null,
    context.localD1,
  );
  const bytes = await readFile(sqlPath);
  const tableRows = queryLocalD1<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    context.persistPath,
    context.localD1,
  );
  const tables = new Set(tableRows.map((row) => row.name));
  const count = (table: string) => tables.has(table) ? `(SELECT COUNT(*) FROM ${table})` : '0';
  const counts = queryLocalD1<Counts>(`
    SELECT
      ${count('attempts')} AS attempts,
      ${count('answers')} AS answers,
      ${count('attempt_questions')} AS attempt_questions,
      ${count('questions')} AS questions,
      ${count('telegram_outbox')} AS outbox,
      ${count('test_config_versions')} AS test_config_versions,
      ${count('question_bank_revisions')} AS bank_revisions,
      ${count('question_bank_revision_items')} AS bank_revision_items,
      ${count('question_bank_state')} AS bank_state,
      ${count('question_version_links')} AS question_version_links,
      ${count('question_bank_change_events')} AS question_bank_change_events,
      ${count('question_bank_mutations')} AS question_bank_mutations,
      ${count('question_review_history')} AS question_reviews,
      ${count('analytics_refresh_state')} AS analytics_refresh_state,
      ${count('analytics_report_aggregates')} AS analytics_report_aggregates,
      ${count('analytics_candidate_aggregates')} AS analytics_candidate_aggregates,
      ${count('analytics_daily_question_aggregates')} AS analytics_daily_question_aggregates,
      ${count('analytics_daily_choice_aggregates')} AS analytics_daily_choice_aggregates,
      ${count('analytics_daily_timing_aggregates')} AS analytics_daily_timing_aggregates,
      ${count('analytics_candidate_dimensions')} AS analytics_candidate_dimensions,
      ${tables.has('schema_migrations')
        ? '(SELECT COALESCE(MAX(version), 0) FROM schema_migrations)'
        : '0'} AS schema_version,
      ${tables.has('question_bank_state')
        ? '(SELECT current_revision FROM question_bank_state WHERE id = 1)'
        : tables.has('question_bank_revisions')
          ? '(SELECT hash FROM question_bank_revisions ORDER BY applied_at DESC LIMIT 1)'
        : 'NULL'} AS bank_revision
  `, context.persistPath, context.localD1)[0];
  const manifest = {
    format: 3,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + RAW_BACKUP_TTL_MS).toISOString(),
    containsSensitiveData: true,
    appVersion: APP_RELEASE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    counts,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await enforceBackupRetentionBestEffort({
    workspaceRoot: context.workspaceRoot,
    backupRoot: backupDirectory,
    apply: true,
  });
  console.log(`Backup created: ${path.relative(context.workspaceRoot, sqlPath)}`);
  return { sqlPath, manifestPath, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createBackup().catch(() => {
    console.error('Backup failed. Application data was not changed.');
    process.exitCode = 1;
  });
}
