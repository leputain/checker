import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNewTransferDirectory, initializeTransferState } from './initialize-transfer-state.ts';

const prefix = 'candidate-transfer-claim-';
const fixture = await mkdtemp(path.join(tmpdir(), prefix));
const databaseId = '00000000-0000-4000-8000-000000000001';
try {
  const target = path.join(fixture, 'parent', 'state');
  const contenders = await Promise.allSettled([
    createNewTransferDirectory(target), createNewTransferDirectory(target),
  ]);
  assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = contenders.find((result) => result.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /existing state is never overwritten/u);

  const marker = path.join(target, 'existing-state-marker');
  await writeFile(marker, 'unchanged fixture');
  await assert.rejects(initializeTransferState([target, databaseId]), /existing state is never overwritten/u);
  assert.equal(await readFile(marker, 'utf8'), 'unchanged fixture');
  assert.deepEqual(await readdir(target), ['existing-state-marker'],
    'rejected initialization must not start an SDK or create D1 files');

  const invalidTarget = path.join(fixture, 'invalid-state');
  await assert.rejects(initializeTransferState([invalidTarget, databaseId, '--unknown', fixture]), /Unknown initialization option/u);
  await assert.rejects(stat(invalidTarget), { code: 'ENOENT' });
  const invalidSdk = path.join(fixture, 'invalid-sdk');
  await mkdir(invalidSdk);
  await writeFile(path.join(invalidSdk, 'package.json'), JSON.stringify({ name: 'different-package', version: '4.0.0' }));
  await assert.rejects(initializeTransferState([invalidTarget, databaseId, '--sdk-package', invalidSdk]), /recorded Miniflare 4/u);
  await assert.rejects(stat(invalidTarget), { code: 'ENOENT' }, 'SDK validation must precede directory creation');
  console.log('Transfer state atomic claim tests: PASS');
} finally {
  const relative = path.relative(tmpdir(), fixture);
  assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep));
  await rm(fixture, { recursive: true, force: true });
}
