import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalD1File, queryLocalD1 } from './local-d1.ts';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function verifyBackup(inputPath: string) {
  const sqlPath = path.resolve(inputPath);
  if (!sqlPath.toLowerCase().endsWith('.sql')) throw new Error('Expected a .sql backup file.');
  const manifestPath = sqlPath.replace(/\.sql$/i, '.manifest.json');
  const sqlBytes = await readFile(sqlPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    sha256: string;
    counts: Record<string, number | string | null>;
  };
  const digest = createHash('sha256').update(sqlBytes).digest('hex');
  if (digest !== manifest.sha256) throw new Error('Backup checksum mismatch.');

  const verificationRoot = path.resolve('.data', 'backup-verification');
  await mkdir(verificationRoot, { recursive: true });
  const persistTo = await mkdtemp(path.join(verificationRoot, 'run-'));
  try {
    executeLocalD1File(sqlPath, persistTo);
    const quickCheck = queryLocalD1<{ quick_check: string }>('PRAGMA quick_check', persistTo)[0];
    if (quickCheck?.quick_check !== 'ok') throw new Error('SQLite quick_check failed.');
    const counts = queryLocalD1<Record<string, number>>(`
      SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM answers) AS answers,
        (SELECT COUNT(*) FROM questions) AS questions,
        (SELECT COUNT(*) FROM telegram_outbox) AS outbox,
        (SELECT COALESCE(MAX(version), 0) FROM schema_migrations) AS schema_version
    `, persistTo)[0];
    for (const key of ['attempts', 'answers', 'questions', 'outbox', 'schema_version']) {
      if (counts[key] !== manifest.counts[key]) throw new Error(`Backup count mismatch: ${key}.`);
    }
    console.log(`Backup verified: ${path.relative(process.cwd(), sqlPath)}`);
  } finally {
    const resolved = path.resolve(persistTo);
    if (!resolved.startsWith(`${verificationRoot}${path.sep}`)) {
      throw new Error('Unsafe verification cleanup path.');
    }
    await rm(resolved, { recursive: true, force: true });
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
