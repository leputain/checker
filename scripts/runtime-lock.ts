import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const LOCK_VERSION = 1;
const RUNTIME_FILE_PATTERN = /^runtime-(\d+)-([0-9a-f]{32})\.json$/u;
const OPERATION_FILE = 'destructive-operation.json';
const FALLBACK_PORTS = [3_000, 3_001] as const;

type RuntimeLockRecord = {
  version: 1;
  kind: 'runtime';
  lockId: string;
  pid: number;
  port: number;
  workspaceRoot: string;
  statePath: string;
  createdAt: number;
};

type OperationLockRecord = {
  version: 1;
  kind: 'destructive-operation';
  lockId: string;
  pid: number;
  workspaceRoot: string;
  createdAt: number;
};

type LockRecord = RuntimeLockRecord | OperationLockRecord;

export type RuntimeLockHandle = {
  filePath: string;
  release: () => Promise<void>;
  releaseSync: () => void;
};

export type DestructiveOperationGuard = {
  release: () => Promise<void>;
};

type GuardDependencies = {
  processAlive?: (pid: number) => boolean;
  probePort?: (port: number) => Promise<boolean>;
};

function normalizeForComparison(value: string) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, target: string) {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function assertPositivePid(pid: unknown): asserts pid is number {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw new Error('Runtime lock is invalid.');
}

function assertLockId(lockId: unknown): asserts lockId is string {
  if (typeof lockId !== 'string' || !/^[0-9a-f]{32}$/u.test(lockId)) {
    throw new Error('Runtime lock is invalid.');
  }
}

function parseLock(
  source: string,
  expectedKind: LockRecord['kind'],
  workspaceRoot: string,
  fileName: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Runtime lock is invalid.');
  }
  if (!value || typeof value !== 'object') throw new Error('Runtime lock is invalid.');
  const record = value as Partial<LockRecord>;
  if (
    record.version !== LOCK_VERSION
    || record.kind !== expectedKind
    || typeof record.workspaceRoot !== 'string'
    || !path.isAbsolute(record.workspaceRoot)
    || normalizeForComparison(record.workspaceRoot)
      !== normalizeForComparison(workspaceRoot)
    || !Number.isSafeInteger(record.createdAt)
    || Number(record.createdAt) < 1
  ) {
    throw new Error('Runtime lock is invalid.');
  }
  assertPositivePid(record.pid);
  assertLockId(record.lockId);
  if (expectedKind === 'runtime') {
    const runtime = record as Partial<RuntimeLockRecord>;
    const match = RUNTIME_FILE_PATTERN.exec(fileName);
    if (
      !match
      || Number(match[1]) !== runtime.pid
      || match[2] !== runtime.lockId
      || !Number.isInteger(runtime.port)
      || Number(runtime.port) < 1
      || Number(runtime.port) > 65_535
      || typeof runtime.statePath !== 'string'
      || !path.isAbsolute(runtime.statePath)
      || !isInside(workspaceRoot, runtime.statePath)
    ) {
      throw new Error('Runtime lock is invalid.');
    }
  } else if (fileName !== OPERATION_FILE) {
    throw new Error('Runtime lock is invalid.');
  }
  return record as LockRecord;
}

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function defaultProbePort(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function lockDirectory(workspaceRoot: string) {
  return path.join(path.resolve(workspaceRoot), '.data', 'runtime-locks');
}

async function ensureLockDirectory(workspaceRoot: string) {
  const root = path.resolve(workspaceRoot);
  const directory = lockDirectory(root);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe runtime lock directory.');
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (!isInside(realRoot, realDirectory)) throw new Error('Unsafe runtime lock directory.');
  return directory;
}

async function writeExclusive(filePath: string, record: LockRecord) {
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function releaseOwnedLock(
  filePath: string,
  expectedKind: LockRecord['kind'],
  workspaceRoot: string,
  lockId: string,
) {
  try {
    const record = parseLock(
      await readFile(filePath, 'utf8'),
      expectedKind,
      workspaceRoot,
      path.basename(filePath),
    );
    if (record.lockId === lockId) await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function releaseOwnedLockSync(
  filePath: string,
  expectedKind: LockRecord['kind'],
  workspaceRoot: string,
  lockId: string,
) {
  try {
    const record = parseLock(
      readFileSync(filePath, 'utf8'),
      expectedKind,
      workspaceRoot,
      path.basename(filePath),
    );
    if (record.lockId === lockId) unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
}

async function inspectOperationLock(
  workspaceRoot: string,
  directory: string,
  processAlive: (pid: number) => boolean,
) {
  const filePath = path.join(directory, OPERATION_FILE);
  let record: OperationLockRecord;
  try {
    record = parseLock(
      await readFile(filePath, 'utf8'),
      'destructive-operation',
      workspaceRoot,
      OPERATION_FILE,
    ) as OperationLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (processAlive(record.pid)) return true;
  await releaseOwnedLock(
    filePath,
    'destructive-operation',
    workspaceRoot,
    record.lockId,
  );
  return false;
}

async function inspectRuntimeLocks(
  workspaceRoot: string,
  directory: string,
  processAlive: (pid: number) => boolean,
) {
  let live = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith('runtime-')) continue;
    if (!entry.isFile() || !RUNTIME_FILE_PATTERN.test(entry.name)) {
      throw new Error('Runtime lock is invalid.');
    }
    const filePath = path.join(directory, entry.name);
    const record = parseLock(
      await readFile(filePath, 'utf8'),
      'runtime',
      workspaceRoot,
      entry.name,
    ) as RuntimeLockRecord;
    if (processAlive(record.pid)) live = true;
    else await releaseOwnedLock(filePath, 'runtime', workspaceRoot, record.lockId);
  }
  return live;
}

export async function registerRuntimeLock(input: {
  workspaceRoot: string;
  statePath: string;
  port: number;
} & GuardDependencies): Promise<RuntimeLockHandle> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const statePath = path.resolve(input.statePath);
  if (!isInside(workspaceRoot, statePath)) throw new Error('Unsafe runtime state path.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error('Runtime port is invalid.');
  }
  const processAlive = input.processAlive ?? defaultProcessAlive;
  const directory = await ensureLockDirectory(workspaceRoot);
  if (await inspectOperationLock(workspaceRoot, directory, processAlive)) {
    throw new Error('A destructive local operation is already running.');
  }
  await inspectRuntimeLocks(workspaceRoot, directory, processAlive);

  const lockId = randomUUID().replaceAll('-', '');
  const record: RuntimeLockRecord = {
    version: LOCK_VERSION,
    kind: 'runtime',
    lockId,
    pid: process.pid,
    port: input.port,
    workspaceRoot,
    statePath,
    createdAt: Date.now(),
  };
  const filePath = path.join(directory, `runtime-${record.pid}-${lockId}.json`);
  await writeExclusive(filePath, record);
  const release = () => releaseOwnedLock(filePath, 'runtime', workspaceRoot, lockId);
  try {
    if (await inspectOperationLock(workspaceRoot, directory, processAlive)) {
      throw new Error('A destructive local operation is already running.');
    }
  } catch (error) {
    await release();
    throw error;
  }
  return {
    filePath,
    release,
    releaseSync: () => releaseOwnedLockSync(filePath, 'runtime', workspaceRoot, lockId),
  };
}

export async function acquireDestructiveOperationGuard(input: {
  workspaceRoot: string;
  probeFallbackPorts?: boolean;
} & GuardDependencies): Promise<DestructiveOperationGuard> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const processAlive = input.processAlive ?? defaultProcessAlive;
  const probePort = input.probePort ?? defaultProbePort;
  const directory = await ensureLockDirectory(workspaceRoot);
  const filePath = path.join(directory, OPERATION_FILE);
  if (await inspectOperationLock(workspaceRoot, directory, processAlive)) {
    throw new Error('Another destructive local operation is already running.');
  }

  const lockId = randomUUID().replaceAll('-', '');
  const record: OperationLockRecord = {
    version: LOCK_VERSION,
    kind: 'destructive-operation',
    lockId,
    pid: process.pid,
    workspaceRoot,
    createdAt: Date.now(),
  };
  try {
    await writeExclusive(filePath, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another destructive local operation is already running.');
    }
    throw error;
  }
  const release = () => releaseOwnedLock(
    filePath,
    'destructive-operation',
    workspaceRoot,
    lockId,
  );
  try {
    if (await inspectRuntimeLocks(workspaceRoot, directory, processAlive)) {
      throw new Error('Stop every local Candidate Check runtime before this operation.');
    }
    if (input.probeFallbackPorts !== false) {
      const probes = await Promise.all(FALLBACK_PORTS.map((port) => probePort(port)));
      if (probes.some(Boolean)) {
        throw new Error('Stop the local Candidate Check runtime before this operation.');
      }
    }
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}
