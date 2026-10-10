import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare } from './miniflare-runtime.ts';
import { queryLocalD1 } from './local-d1.ts';

const fixturePrefix = 'candidate-miniflare-compat-';
const fixtureRoot = await mkdtemp(path.join(tmpdir(), fixturePrefix));
const stateRoot = path.join(fixtureRoot, 'state');
const databaseId = '00000000-0000-4000-8000-000000000001';
const configPath = path.join(fixtureRoot, 'wrangler.json');

function createFixtureRuntime() {
  return new Miniflare({
    modules: true,
    compatibilityDate: '2026-05-15',
    script: 'export default { fetch() { return new Response("fixture") } }',
    d1Databases: { DB: databaseId },
    resourcePersistencePath: path.join(stateRoot, 'v3'),
  });
}

async function d1DataFiles() {
  return (await readdir(stateRoot, { recursive: true })).filter((file) => (
    /^v3\/d1\/miniflare-D1DatabaseObject\/[a-f0-9]{64}\.sqlite$/u.test(file.replaceAll('\\', '/'))
  ));
}

try {
  assert.throws(() => Reflect.construct(Miniflare, [{
    modules: true,
    script: 'export default {}',
    d1Databases: { DB: databaseId },
    d1Persist: path.join(stateRoot, 'v3', 'd1'),
  }]), /miniflare_d1_persist_use_project_resource_path/u,
  'mixed project/plugin path options must fail before opening a different ledger');
  assert.throws(() => new Miniflare({
    modules: true, script: 'export default {}',
    resourcePersistencePath: '.wrangler/state/v3',
  }), /miniflare_resource_persistence_path_must_be_absolute/u);
  await writeFile(configPath, JSON.stringify({
    name: 'candidate-miniflare-compat',
    compatibility_date: '2026-05-15',
    d1_databases: [{ binding: 'DB', database_name: 'compat-fixture', database_id: databaseId }],
  }));

  const first = createFixtureRuntime();
  try {
    const db = await first.getD1Database('DB');
    await db.batch([
      db.prepare('CREATE TABLE answers (id INTEGER PRIMARY KEY, awarded_score INTEGER, penalty_score INTEGER)'),
      db.prepare('INSERT INTO answers VALUES (1, 90, 10)'),
    ]);
  } finally {
    await first.dispose();
  }
  const originalDataFiles = await d1DataFiles();
  assert.equal(originalDataFiles.length, 1);

  const second = createFixtureRuntime();
  try {
    const row = await (await second.getD1Database('DB')).prepare(
      'SELECT awarded_score, penalty_score FROM answers WHERE id = 1',
    ).first<{ awarded_score: number; penalty_score: number }>();
    assert.deepEqual(row, { awarded_score: 90, penalty_score: 10 },
      'a new adapter instance must reopen the same persisted ledger');
  } finally {
    await second.dispose();
  }

  const wranglerRows = queryLocalD1<{ awarded_score: number; penalty_score: number }>(
    'SELECT awarded_score, penalty_score FROM answers WHERE id = 1',
    stateRoot,
    { cwd: fixtureRoot, configPath },
  );
  assert.deepEqual(wranglerRows, [{ awarded_score: 90, penalty_score: 10 }],
    'Wrangler --persist-to must read the exact same D1 ledger');
  assert.deepEqual(await d1DataFiles(), originalDataFiles,
    'SDK 5 official conversion and Wrangler must retain the same single hashed D1 ledger path');
  console.log('Miniflare persistence compatibility tests: PASS');
} finally {
  const relativeRoot = path.relative(tmpdir(), fixtureRoot);
  assert.ok(relativeRoot.startsWith(fixturePrefix) && !relativeRoot.includes(path.sep),
    'cleanup must stay within the temporary fixture directory');
  await rm(fixtureRoot, { recursive: true, force: true });
}
