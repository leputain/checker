import {
  lstat,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAW_BACKUP_TTL_MS = 24 * 60 * 60 * 1_000;

const BACKUP_ARTIFACT_PATTERN = /^(candidate-check-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)(?:-[a-f0-9]{8})?)\.(sql|manifest\.json)$/;
const ROLLBACK_STATE_PATTERN = /^rollback-state-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)-[a-f0-9]{8}$/;

type BackupSet = {
  createdAtMs: number;
  sql?: string;
  manifest?: string;
};

export type BackupRetentionOptions = {
  workspaceRoot?: string;
  backupRoot?: string;
  nowMs?: number;
  apply?: boolean;
};

export type BackupRetentionSummary = {
  apply: boolean;
  expiredBackupSets: number;
  expiredRollbackStates: number;
  removedEntries: number;
  skippedUnsafe: number;
  keptFresh: number;
};

function isNotFound(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function comparable(value: string) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertAllowedBackupRoot(workspaceRoot: string, backupRoot: string) {
  if (!isInside(workspaceRoot, backupRoot) || path.basename(backupRoot).toLowerCase() !== 'backups') {
    throw new Error('Backup retention root must be the workspace backups directory.');
  }
}

function parseGeneratedTimestamp(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[-.](\d{3}))?Z$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part));
  const milliseconds = match[7] === undefined ? 0 : Number(match[7]);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== milliseconds
  ) {
    return null;
  }
  return timestamp;
}

function expired(createdAtMs: number, nowMs: number) {
  return nowMs >= createdAtMs && nowMs - createdAtMs >= RAW_BACKUP_TTL_MS;
}

async function assertRootIsPhysicalDirectory(backupRoot: string) {
  let stats;
  try {
    stats = await lstat(backupRoot);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Backup retention root must be a physical directory.');
  }
  const physicalRoot = await realpath(backupRoot);
  if (comparable(physicalRoot) !== comparable(backupRoot)) {
    throw new Error('Backup retention root cannot be a symlink or reparse-point alias.');
  }
  return true;
}

async function assertSafeRegularFile(backupRoot: string, target: string) {
  if (path.dirname(target) !== backupRoot || !isInside(backupRoot, target)) {
    throw new Error('Backup artifact escaped the allowed root.');
  }
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Backup artifact is not a physical regular file.');
  }
  const physicalTarget = await realpath(target);
  if (!isInside(backupRoot, physicalTarget) || comparable(physicalTarget) !== comparable(target)) {
    throw new Error('Backup artifact resolves outside the allowed root.');
  }
}

async function assertSafeRollbackTree(backupRoot: string, target: string) {
  if (path.dirname(target) !== backupRoot || !isInside(backupRoot, target)) {
    throw new Error('Rollback state escaped the allowed root.');
  }
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!isInside(backupRoot, current)) {
      throw new Error('Rollback state contains an unsafe path.');
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error('Rollback state contains a symlink or reparse point.');
    }
    const physicalCurrent = await realpath(current);
    if (!isInside(backupRoot, physicalCurrent) || comparable(physicalCurrent) !== comparable(current)) {
      throw new Error('Rollback state resolves outside the allowed root.');
    }
    if (stats.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) stack.push(path.join(current, entry.name));
    } else if (!stats.isFile()) {
      throw new Error('Rollback state contains a non-regular filesystem entry.');
    }
  }
}

async function removeBackupSet(backupRoot: string, backupSet: BackupSet) {
  const targets = [backupSet.sql, backupSet.manifest].filter((item): item is string => Boolean(item));
  for (const target of targets) await assertSafeRegularFile(backupRoot, target);
  for (const target of targets) {
    await assertSafeRegularFile(backupRoot, target);
    await unlink(target);
  }
  return targets.length;
}

export async function enforceBackupArtifactRetention(
  options: BackupRetentionOptions = {},
): Promise<BackupRetentionSummary> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const backupRoot = path.resolve(options.backupRoot ?? path.join(workspaceRoot, 'backups'));
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('Invalid backup retention clock.');
  assertAllowedBackupRoot(workspaceRoot, backupRoot);

  const summary: BackupRetentionSummary = {
    apply: options.apply === true,
    expiredBackupSets: 0,
    expiredRollbackStates: 0,
    removedEntries: 0,
    skippedUnsafe: 0,
    keptFresh: 0,
  };
  if (!await assertRootIsPhysicalDirectory(backupRoot)) return summary;

  const backupSets = new Map<string, BackupSet>();
  const rollbackStates: Array<{ path: string; createdAtMs: number }> = [];
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    const backupMatch = BACKUP_ARTIFACT_PATTERN.exec(entry.name);
    if (backupMatch) {
      const [, base, timestamp, extension] = backupMatch;
      const createdAtMs = parseGeneratedTimestamp(timestamp);
      if (createdAtMs === null) continue;
      const backupSet = backupSets.get(base) ?? { createdAtMs };
      const target = path.join(backupRoot, entry.name);
      if (extension === 'sql') backupSet.sql = target;
      else backupSet.manifest = target;
      backupSets.set(base, backupSet);
      continue;
    }
    const rollbackMatch = ROLLBACK_STATE_PATTERN.exec(entry.name);
    if (!rollbackMatch) continue;
    const createdAtMs = parseGeneratedTimestamp(rollbackMatch[1]);
    if (createdAtMs !== null) rollbackStates.push({
      path: path.join(backupRoot, entry.name),
      createdAtMs,
    });
  }

  for (const backupSet of backupSets.values()) {
    if (!expired(backupSet.createdAtMs, nowMs)) {
      summary.keptFresh += 1;
      continue;
    }
    summary.expiredBackupSets += 1;
    try {
      const targets = [backupSet.sql, backupSet.manifest].filter(
        (item): item is string => Boolean(item),
      );
      for (const target of targets) await assertSafeRegularFile(backupRoot, target);
      if (summary.apply) summary.removedEntries += await removeBackupSet(backupRoot, backupSet);
    } catch {
      summary.skippedUnsafe += 1;
    }
  }

  for (const rollbackState of rollbackStates) {
    if (!expired(rollbackState.createdAtMs, nowMs)) {
      summary.keptFresh += 1;
      continue;
    }
    summary.expiredRollbackStates += 1;
    try {
      await assertSafeRollbackTree(backupRoot, rollbackState.path);
      if (summary.apply) {
        await assertSafeRollbackTree(backupRoot, rollbackState.path);
        await rm(rollbackState.path, { recursive: true, force: false });
        summary.removedEntries += 1;
      }
    } catch {
      summary.skippedUnsafe += 1;
    }
  }

  return summary;
}

export async function enforceBackupRetentionBestEffort(
  options: BackupRetentionOptions = {},
) {
  try {
    return await enforceBackupArtifactRetention(options);
  } catch {
    return null;
  }
}

function printSummary(summary: BackupRetentionSummary) {
  const mode = summary.apply ? 'apply' : 'dry-run';
  console.log(
    `Backup retention ${mode}: expired_sets=${summary.expiredBackupSets}, `
      + `expired_rollbacks=${summary.expiredRollbackStates}, removed_entries=${summary.removedEntries}, `
      + `skipped_unsafe=${summary.skippedUnsafe}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  enforceBackupArtifactRetention({ apply: process.argv.includes('--apply') })
    .then(printSummary)
    .catch(() => {
      console.error('Backup retention failed safely; no unverified path was removed.');
      process.exitCode = 1;
    });
}
