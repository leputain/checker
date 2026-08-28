import { Miniflare } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, type BackupOptions } from './ops-backup.ts';
import { verifyBackup } from './ops-backup-verify.ts';
import { queryLocalD1 } from './local-d1.ts';
import {
  readLocalD1DatabaseId,
  resolveOpsContext,
  type OpsContextOptions,
} from './ops-context.ts';
import { acquireDestructiveOperationGuard } from './runtime-lock.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

function argument(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function manualPurgeTarget(argv: string[], abandonedCutoff: number) {
  const before = argument(argv, '--before');
  const attempt = argument(argv, '--attempt');
  if (before && attempt) throw new Error('Use either --before or --attempt, not both.');
  if (before) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(before)) throw new Error('Invalid --before date.');
    const cutoff = Date.parse(`${before}T00:00:00.000Z`);
    if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().slice(0, 10) !== before) {
      throw new Error('Invalid --before date.');
    }
    return {
      mode: 'manual-before' as const,
      predicate: 'COALESCE(completed_at, started_at) < ?',
      bindings: [cutoff] as const,
      dryRunPredicate: `COALESCE(completed_at, started_at) < ${cutoff}`,
      reviewCutoff: cutoff,
    };
  }
  if (attempt) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(attempt)) {
      throw new Error('Invalid --attempt UUID.');
    }
    return {
      mode: 'manual-attempt' as const,
      predicate: 'id = ?',
      bindings: [attempt] as const,
      dryRunPredicate: `id = '${attempt}'`,
      reviewCutoff: null,
    };
  }
  return {
    mode: 'automatic' as const,
    predicate: "status IN ('active','aborted') AND COALESCE(completed_at, started_at) < ?",
    bindings: [abandonedCutoff] as const,
    dryRunPredicate: `status IN ('active','aborted') AND COALESCE(completed_at, started_at) < ${abandonedCutoff}`,
    reviewCutoff: null,
  };
}

export type RetentionRunOptions = OpsContextOptions & {
  argv?: string[];
  nowMs?: number;
  checkServer?: boolean;
  log?: (message: string) => void;
  backupDirectory?: string;
};

export type RetentionCounts = {
  attempts: number;
  answers: number;
  attempt_questions: number;
  outbox: number;
  reviews: number;
};

export async function runRetention(options: RetentionRunOptions = {}) {
  const context = resolveOpsContext(options);
  const argv = options.argv ?? process.argv.slice(2);
  const nowMs = options.nowMs ?? Date.now();
  const abandonedCutoff = nowMs - DAY_MS;
  const apply = argv.includes('--apply');
  const target = manualPurgeTarget(argv, abandonedCutoff);
  const log = options.log ?? console.log;
  const counts = queryLocalD1<RetentionCounts>(
    `WITH targets AS (SELECT id FROM attempts WHERE ${target.dryRunPredicate})
      SELECT
        (SELECT COUNT(*) FROM targets) AS attempts,
        (SELECT COUNT(*) FROM answers WHERE attempt_id IN (SELECT id FROM targets)) AS answers,
        (SELECT COUNT(*) FROM attempt_questions WHERE attempt_id IN (SELECT id FROM targets))
          AS attempt_questions,
        (SELECT COUNT(*) FROM telegram_outbox WHERE attempt_id IN (SELECT id FROM targets))
          AS outbox,
        ${target.reviewCutoff === null
          ? '0'
          : `(SELECT COUNT(*) FROM question_review_history
              WHERE created_at < ${target.reviewCutoff})`}
          AS reviews`,
    context.persistPath,
    context.localD1,
  )[0] ?? {
    attempts: 0,
    answers: 0,
    attempt_questions: 0,
    outbox: 0,
    reviews: 0,
  };

  log(
    `Purge dry-run (${target.mode}): attempts=${counts.attempts}, answers=${counts.answers}, `
    + `ledger=${counts.attempt_questions}, outbox=${counts.outbox}, reviews=${counts.reviews}`,
  );
  if (!apply) {
    log('Изменений нет. Для применения добавьте --apply.');
    return { applied: false, mode: target.mode, counts, backup: null };
  }

  const runtimeGuard = await acquireDestructiveOperationGuard({
    workspaceRoot: context.workspaceRoot,
    probeFallbackPorts: options.checkServer !== false,
  });
  try {
    const backupOptions: BackupOptions = {
      workspaceRoot: context.workspaceRoot,
      configPath: context.configPath,
      backupDirectory: options.backupDirectory,
    };
    const backup = await createBackup(backupOptions);
    await verifyBackup(backup.sqlPath, context);
    const databaseId = await readLocalD1DatabaseId(context);
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: databaseId },
      d1Persist: path.join(context.persistPath, 'v3', 'd1'),
    });
    try {
      const db = await miniflare.getD1Database('DB');
      const targetSql = `SELECT id FROM attempts WHERE ${target.predicate}`;
      const childDelete = (table: string) => db.prepare(
        `DELETE FROM ${table} WHERE attempt_id IN (${targetSql})`,
      ).bind(...target.bindings);
      const statements: D1PreparedStatement[] = [
        childDelete('answers'),
        childDelete('attempt_questions'),
        childDelete('telegram_outbox'),
        db.prepare(`DELETE FROM attempts WHERE ${target.predicate}`).bind(...target.bindings),
      ];
      if (target.reviewCutoff !== null) {
        statements.push(
          db.prepare('DELETE FROM question_review_history WHERE created_at < ?')
            .bind(target.reviewCutoff),
        );
      }
      statements.push(
        db.prepare(`UPDATE telegram_outbox SET payload_text = ''
          WHERE created_at < ? AND payload_text != ''`).bind(abandonedCutoff),
        db.prepare(`UPDATE attempts SET candidate_name = NULL
          WHERE started_at < ? AND candidate_name IS NOT NULL`).bind(abandonedCutoff),
        db.prepare('DELETE FROM analytics_report_aggregates'),
        db.prepare('DELETE FROM analytics_candidate_dimensions'),
        db.prepare('DELETE FROM analytics_daily_timing_aggregates'),
        db.prepare('DELETE FROM analytics_daily_choice_aggregates'),
        db.prepare('DELETE FROM analytics_daily_question_aggregates'),
        db.prepare('DELETE FROM analytics_candidate_aggregates'),
        db.prepare(`UPDATE analytics_refresh_state
          SET built_generation = 0, built_at = NULL, updated_at = ? WHERE id = 1`).bind(nowMs),
      );
      await db.batch(statements);
      log('Purge applied after verified logical backup.');
      return { applied: true, mode: target.mode, counts, backup };
    } finally {
      await miniflare.dispose();
    }
  } finally {
    await runtimeGuard.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runRetention().catch(() => {
    console.error('Purge failed. Application data was not changed when backup verification failed.');
    process.exitCode = 1;
  });
}
