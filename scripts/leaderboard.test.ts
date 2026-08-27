import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  moscowDayBounds,
  selectBestLeaderboardEntries,
  type CandidateLeaderboardEntry,
} from '../lib/leaderboard.ts';
import { candidateKey } from '../lib/candidate-key.ts';

const august = moscowDayBounds(Date.parse('2026-08-27T12:00:00.000Z'));
assert.equal(new Date(august.startMs).toISOString(), '2026-08-26T21:00:00.000Z');
assert.equal(new Date(august.endMs).toISOString(), '2026-08-27T21:00:00.000Z');

const beforeMoscowMidnight = moscowDayBounds(Date.parse('2026-08-26T20:59:59.000Z'));
assert.equal(
  new Date(beforeMoscowMidnight.startMs).toISOString(),
  '2026-08-25T21:00:00.000Z',
);

function entry(overrides: Partial<CandidateLeaderboardEntry>): CandidateLeaderboardEntry {
  return {
    candidateKey: 'candidate-a',
    alias: 'Кандидат К.',
    verdict: 'REVIEW',
    score: 30,
    baseMaxScore: 50,
    accuracy: 70,
    wrongCount: 5,
    durationSeconds: 300,
    completedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

const selected = selectBestLeaderboardEntries([
  entry({ score: 25, completedAt: '2026-08-27T09:00:00.000Z' }),
  entry({ score: 35, completedAt: '2026-08-27T10:00:00.000Z' }),
  entry({ candidateKey: 'candidate-b', alias: 'Другой Д.', verdict: 'PASS', score: 34, wrongCount: 3 }),
  entry({ candidateKey: 'candidate-c', alias: 'Третий Т.', verdict: 'FAIL', score: 40, wrongCount: 8 }),
  entry({ candidateKey: 'candidate-d', alias: 'Кандидат К.', score: 31, wrongCount: 4 }),
]);

assert.equal(selected.length, 4, 'different candidates with the same public alias must remain separate');
assert.equal(selected[0].alias, 'Другой Д.', 'verdict order must match the leaderboard');
assert.equal(selected[1].score, 35, 'the higher-scoring duplicate attempt must be selected');
assert.equal(selected.filter((item) => item.alias === 'Кандидат К.').length, 2);
assert.equal(selected[3].alias, 'Третий Т.');
assert.equal('candidateKey' in selected[0], false, 'candidate key must not leave the server helper');

const normalizedKey = await candidateKey('  Анна\u00a0Петрова  ');
assert.match(normalizedKey, /^[a-f0-9]{64}$/);
assert.equal(normalizedKey, await candidateKey('АННА ПЕТРОВА'));
assert.notEqual(normalizedKey, await candidateKey('Анна Павлова'));

const migrationMiniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});
try {
  const db = await migrationMiniflare.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE attempts (id TEXT PRIMARY KEY NOT NULL)'),
    db.prepare("INSERT INTO attempts (id) VALUES ('legacy-a'), ('legacy-b')"),
  ]);
  const migration = await readFile(
    new URL('../drizzle/0008_lowly_mentor.sql', import.meta.url),
    'utf8',
  );
  await db.batch(migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  const legacyRows = await db
    .prepare('SELECT id, candidate_key FROM attempts ORDER BY id')
    .all<{ id: string; candidate_key: string }>();
  assert.deepEqual(legacyRows.results, [
    { id: 'legacy-a', candidate_key: 'legacy:legacy-a' },
    { id: 'legacy-b', candidate_key: 'legacy:legacy-b' },
  ]);
  const candidateKeyColumn = (await db
    .prepare('PRAGMA table_info(attempts)')
    .all<{ name: string; notnull: number; dflt_value: string | null }>())
    .results
    .find((column) => column.name === 'candidate_key');
  assert.equal(candidateKeyColumn?.notnull, 1);
  assert.equal(candidateKeyColumn?.dflt_value, "''");
  assert.equal(
    new Set(legacyRows.results.map((row) => row.candidate_key)).size,
    legacyRows.results.length,
    'legacy attempts must not be merged without a reliable full-name identity',
  );
} finally {
  await migrationMiniflare.dispose();
}

console.log('leaderboard tests: PASS');
