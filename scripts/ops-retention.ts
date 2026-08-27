import { Miniflare } from 'miniflare';
import path from 'node:path';
import { createBackup } from './ops-backup.ts';
import { verifyBackup } from './ops-backup-verify.ts';
import { queryLocalD1 } from './local-d1.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = Date.now();
const completedCutoff = now - 180 * DAY_MS;
const abandonedCutoff = now - DAY_MS;
const apply = process.argv.includes('--apply');

async function serverIsRunning() {
  try {
    const response = await fetch('http://localhost:3001/api/health/live', {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const counts = queryLocalD1<{ completed: number; abandoned: number }>(`
  SELECT
    SUM(CASE WHEN status = 'completed' AND completed_at < ${completedCutoff} THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status = 'active' AND started_at < ${abandonedCutoff} THEN 1 ELSE 0 END) AS abandoned
  FROM attempts
`)[0] ?? { completed: 0, abandoned: 0 };

console.log(`Retention dry-run: completed=${counts.completed ?? 0}, abandoned=${counts.abandoned ?? 0}`);
if (!apply) {
  console.log('Изменений нет. Для применения добавьте --apply.');
} else {
  if (await serverIsRunning()) throw new Error('Stop the application before retention apply.');
  const backup = await createBackup();
  await verifyBackup(backup.sqlPath);
  const persistPath = path.resolve('.wrangler', 'state');
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'site-creator-d1' },
    d1Persist: persistPath,
  });
  try {
    const db = await miniflare.getD1Database('DB');
    await db.batch([
      db.prepare(`DELETE FROM answers WHERE attempt_id IN (
        SELECT id FROM attempts
        WHERE (status = 'completed' AND completed_at < ?)
          OR (status = 'active' AND started_at < ?)
      )`).bind(completedCutoff, abandonedCutoff),
      db.prepare(`DELETE FROM telegram_outbox WHERE attempt_id IN (
        SELECT id FROM attempts
        WHERE (status = 'completed' AND completed_at < ?)
          OR (status = 'active' AND started_at < ?)
      )`).bind(completedCutoff, abandonedCutoff),
      db.prepare(`DELETE FROM attempts
        WHERE (status = 'completed' AND completed_at < ?)
          OR (status = 'active' AND started_at < ?)`)
        .bind(completedCutoff, abandonedCutoff),
      db.prepare(`UPDATE telegram_outbox SET payload_text = ''
        WHERE created_at < ? AND payload_text != ''`).bind(abandonedCutoff),
      db.prepare(`UPDATE attempts SET candidate_name = NULL
        WHERE started_at < ? AND candidate_name IS NOT NULL`).bind(abandonedCutoff),
    ]);
    console.log('Retention applied after verified logical backup.');
  } finally {
    await miniflare.dispose();
  }
}
