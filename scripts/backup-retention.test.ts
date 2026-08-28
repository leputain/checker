import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  enforceBackupArtifactRetention,
  RAW_BACKUP_TTL_MS,
} from './backup-retention.ts';

function backupStamp(timestamp: number) {
  return new Date(timestamp).toISOString().replaceAll(':', '-').replace('.', '-');
}

function rollbackStamp(timestamp: number) {
  return new Date(timestamp).toISOString().replaceAll(':', '-');
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'candidate-check-backup-retention-'));
const backupRoot = path.join(workspaceRoot, 'backups');
const outsideFile = path.join(workspaceRoot, 'outside-sensitive.sql');
await mkdir(backupRoot, { recursive: true });
await writeFile(outsideFile, 'must remain', 'utf8');

try {
  const nowMs = Date.UTC(2026, 7, 28, 12, 0, 0, 0);
  const staleMs = nowMs - RAW_BACKUP_TTL_MS - 1;
  const freshMs = nowMs - RAW_BACKUP_TTL_MS + 1;

  const staleBase = `candidate-check-${backupStamp(staleMs)}-a1b2c3d4`;
  const staleSql = path.join(backupRoot, `${staleBase}.sql`);
  const staleManifest = path.join(backupRoot, `${staleBase}.manifest.json`);
  await writeFile(staleSql, 'sensitive', 'utf8');
  await writeFile(staleManifest, '{}', 'utf8');

  const orphanBase = `candidate-check-${backupStamp(staleMs)}-b1c2d3e4`;
  const staleOrphan = path.join(backupRoot, `${orphanBase}.sql`);
  await writeFile(staleOrphan, 'interrupted export', 'utf8');

  const legacyBase = `candidate-check-${new Date(staleMs).toISOString()
    .replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')}`;
  const staleLegacySql = path.join(backupRoot, `${legacyBase}.sql`);
  const staleLegacyManifest = path.join(backupRoot, `${legacyBase}.manifest.json`);
  await writeFile(staleLegacySql, 'legacy sensitive', 'utf8');
  await writeFile(staleLegacyManifest, '{}', 'utf8');

  const freshBase = `candidate-check-${backupStamp(freshMs)}-c1d2e3f4`;
  const freshSql = path.join(backupRoot, `${freshBase}.sql`);
  const freshManifest = path.join(backupRoot, `${freshBase}.manifest.json`);
  await writeFile(freshSql, 'fresh sensitive', 'utf8');
  await writeFile(freshManifest, '{}', 'utf8');

  const staleRollback = path.join(
    backupRoot,
    `rollback-state-${rollbackStamp(staleMs)}-d1e2f3a4`,
  );
  await mkdir(path.join(staleRollback, 'v3', 'd1'), { recursive: true });
  await writeFile(path.join(staleRollback, 'v3', 'd1', 'state.sqlite'), 'sensitive', 'utf8');

  const freshRollback = path.join(
    backupRoot,
    `rollback-state-${rollbackStamp(freshMs)}-e1f2a3b4`,
  );
  await mkdir(freshRollback, { recursive: true });
  await writeFile(path.join(freshRollback, 'state.sqlite'), 'fresh sensitive', 'utf8');

  const unrelated = path.join(backupRoot, 'candidate-check-manual.sql');
  await writeFile(unrelated, 'operator file', 'utf8');

  const dryRun = await enforceBackupArtifactRetention({ workspaceRoot, nowMs });
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.expiredBackupSets, 3);
  assert.equal(dryRun.expiredRollbackStates, 1);
  assert.equal(dryRun.removedEntries, 0);
  assert.equal(await exists(staleSql), true, 'dry-run must not remove backup SQL');
  assert.equal(await exists(staleRollback), true, 'dry-run must not remove rollback state');

  const applied = await enforceBackupArtifactRetention({ workspaceRoot, nowMs, apply: true });
  assert.equal(applied.expiredBackupSets, 3);
  assert.equal(applied.expiredRollbackStates, 1);
  assert.equal(applied.removedEntries, 6);
  assert.equal(await exists(staleSql), false);
  assert.equal(await exists(staleManifest), false);
  assert.equal(await exists(staleOrphan), false, 'stale interrupted export must not bypass TTL');
  assert.equal(await exists(staleLegacySql), false, 'legacy timestamp must respect TTL');
  assert.equal(await exists(staleLegacyManifest), false, 'legacy manifest must respect TTL');
  assert.equal(await exists(staleRollback), false);
  assert.equal(await exists(freshSql), true);
  assert.equal(await exists(freshManifest), true);
  assert.equal(await exists(freshRollback), true);
  assert.equal(await exists(unrelated), true, 'non-generated names must be preserved');

  const exactTtlBase = `candidate-check-${backupStamp(nowMs - RAW_BACKUP_TTL_MS)}-f1a2b3c4`;
  const exactTtlSql = path.join(backupRoot, `${exactTtlBase}.sql`);
  const exactTtlManifest = path.join(backupRoot, `${exactTtlBase}.manifest.json`);
  await writeFile(exactTtlSql, 'sensitive', 'utf8');
  await writeFile(exactTtlManifest, '{}', 'utf8');
  await enforceBackupArtifactRetention({ workspaceRoot, nowMs, apply: true });
  assert.equal(await exists(exactTtlSql), false, 'TTL boundary must be inclusive');
  assert.equal(await exists(exactTtlManifest), false);

  let symlinkCreated = false;
  const unsafeBase = `candidate-check-${backupStamp(staleMs)}-0a1b2c3d`;
  const unsafeSql = path.join(backupRoot, `${unsafeBase}.sql`);
  const unsafeManifest = path.join(backupRoot, `${unsafeBase}.manifest.json`);
  try {
    await symlink(outsideFile, unsafeSql, 'file');
    symlinkCreated = true;
    await writeFile(unsafeManifest, '{}', 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code)))) {
      throw error;
    }
  }
  if (symlinkCreated) {
    const unsafe = await enforceBackupArtifactRetention({ workspaceRoot, nowMs, apply: true });
    assert.ok(unsafe.skippedUnsafe >= 1);
    assert.equal(await exists(unsafeSql), true, 'symlink artifact must not be followed or removed');
    assert.equal(await exists(unsafeManifest), true, 'unsafe pair must remain intact');
    assert.equal(await exists(outsideFile), true);
  }

  await assert.rejects(
    enforceBackupArtifactRetention({
      workspaceRoot,
      backupRoot: path.join(workspaceRoot, 'not-backups'),
      nowMs,
      apply: true,
    }),
    /workspace backups directory/,
  );
  assert.equal(await exists(outsideFile), true, 'outside data must remain untouched');

  console.log('backup retention tests: PASS');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
