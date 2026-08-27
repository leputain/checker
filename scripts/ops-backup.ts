import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryLocalD1, runWrangler } from './local-d1.ts';
import { APP_RELEASE } from '../lib/release.ts';

type Counts = {
  attempts: number;
  answers: number;
  questions: number;
  outbox: number;
  schema_version: number;
  bank_revision: string | null;
};

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

export async function createBackup() {
  const backupDirectory = path.resolve('backups');
  await mkdir(backupDirectory, { recursive: true });
  const base = `candidate-check-${timestamp()}`;
  const sqlPath = path.join(backupDirectory, `${base}.sql`);
  const manifestPath = path.join(backupDirectory, `${base}.manifest.json`);

  // Wrangler's export command uses the configured default local D1 path and,
  // unlike `d1 execute`, does not accept `--persist-to`.
  runWrangler(['d1', 'export', 'DB', '--skip-confirmation', '--output', sqlPath], null);
  const bytes = await readFile(sqlPath);
  const counts = queryLocalD1<Counts>(`
    SELECT
      (SELECT COUNT(*) FROM attempts) AS attempts,
      (SELECT COUNT(*) FROM answers) AS answers,
      (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM telegram_outbox) AS outbox,
      (SELECT COALESCE(MAX(version), 0) FROM schema_migrations) AS schema_version,
      (SELECT hash FROM question_bank_revisions ORDER BY applied_at DESC LIMIT 1) AS bank_revision
  `)[0];
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    appVersion: APP_RELEASE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    counts,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Backup created: ${path.relative(process.cwd(), sqlPath)}`);
  return { sqlPath, manifestPath, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createBackup().catch(() => {
    console.error('Backup failed. Application data was not changed.');
    process.exitCode = 1;
  });
}
