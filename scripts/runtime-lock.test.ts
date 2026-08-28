import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireDestructiveOperationGuard,
  registerRuntimeLock,
} from './runtime-lock.ts';

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'candidate-check-runtime-lock-'));
const statePath = path.join(workspaceRoot, '.wrangler', 'state');
const lockDirectory = path.join(workspaceRoot, '.data', 'runtime-locks');

try {
  await assert.rejects(
    registerRuntimeLock({
      workspaceRoot,
      statePath: path.join(workspaceRoot, '..', 'outside-state'),
      port: 41_111,
    }),
    /state path/u,
  );

  const live = await registerRuntimeLock({ workspaceRoot, statePath, port: 41_111 });
  assert.equal(await exists(live.filePath), true);
  await assert.rejects(
    acquireDestructiveOperationGuard({ workspaceRoot, probeFallbackPorts: false }),
    /Stop every local/u,
    'a live wrapper on a non-default port must block destructive operations',
  );
  live.releaseSync();
  assert.equal(await exists(live.filePath), false, 'graceful synchronous cleanup must remove the lock');

  const stale = await registerRuntimeLock({ workspaceRoot, statePath, port: 41_112 });
  const staleGuard = await acquireDestructiveOperationGuard({
    workspaceRoot,
    probeFallbackPorts: false,
    processAlive: () => false,
  });
  assert.equal(await exists(stale.filePath), false, 'only a valid stale lock may be cleaned');
  await staleGuard.release();
  await stale.release();

  await mkdir(lockDirectory, { recursive: true });
  const invalidLock = path.join(lockDirectory, `runtime-${process.pid}-${'a'.repeat(32)}.json`);
  await writeFile(invalidLock, '{"not":"a-valid-lock"}\n', 'utf8');
  await assert.rejects(
    acquireDestructiveOperationGuard({
      workspaceRoot,
      probeFallbackPorts: false,
      processAlive: () => false,
    }),
    /lock is invalid/u,
  );
  assert.equal(await exists(invalidLock), true, 'an invalid lock must never be deleted automatically');
  await rm(invalidLock);

  const probed: number[] = [];
  await assert.rejects(
    acquireDestructiveOperationGuard({
      workspaceRoot,
      probePort: async (port) => {
        probed.push(port);
        return port === 3_001;
      },
    }),
    /Stop the local/u,
  );
  assert.deepEqual(probed.toSorted((left, right) => left - right), [3_000, 3_001]);

  const operation = await acquireDestructiveOperationGuard({
    workspaceRoot,
    probeFallbackPorts: false,
  });
  await assert.rejects(
    registerRuntimeLock({ workspaceRoot, statePath, port: 41_113 }),
    /destructive local operation/u,
    'a wrapper must not start while destructive maintenance owns the guard',
  );
  await operation.release();

  assert.deepEqual(
    (await readdir(lockDirectory)).filter((name) => name.endsWith('.json')),
    [],
    'successful release must not leave lock files behind',
  );
  console.log('runtime lock tests: PASS');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
