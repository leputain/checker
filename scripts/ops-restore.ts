import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createBackup } from './ops-backup.ts';
import { verifyBackup } from './ops-backup-verify.ts';
import { executeLocalD1File, queryLocalD1 } from './local-d1.ts';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertInside(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Unsafe restore path.');
  }
}

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

const source = argument('--from');
const apply = process.argv.includes('--apply');
if (!source || !apply) {
  console.error('Использование: npm run ops:restore -- --from <backup.sql> --apply');
  process.exitCode = 2;
} else {
  if (await serverIsRunning()) throw new Error('Stop the application before restore.');
  const sourcePath = path.resolve(source);
  await verifyBackup(sourcePath);
  const preRestore = await createBackup();
  await verifyBackup(preRestore.sqlPath);

  const workspaceRoot = path.resolve('.');
  const statePath = path.resolve('.wrangler', 'state');
  const rollbackPath = path.resolve(
    'backups',
    `rollback-state-${new Date().toISOString().replaceAll(':', '-')}`,
  );
  assertInside(workspaceRoot, statePath);
  assertInside(workspaceRoot, rollbackPath);
  await access(statePath);
  await mkdir(path.dirname(rollbackPath), { recursive: true });
  await rename(statePath, rollbackPath);
  await mkdir(statePath, { recursive: true });
  try {
    executeLocalD1File(sourcePath, statePath);
    const check = queryLocalD1<{ quick_check: string }>('PRAGMA quick_check', statePath)[0];
    if (check?.quick_check !== 'ok') throw new Error('Restored database failed quick_check.');
    console.log(`Restore complete. Rollback state: ${path.relative(workspaceRoot, rollbackPath)}`);
  } catch (error) {
    assertInside(workspaceRoot, statePath);
    await rm(statePath, { recursive: true, force: true });
    await rename(rollbackPath, statePath);
    throw error;
  }
}
