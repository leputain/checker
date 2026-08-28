import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createBackup } from './ops-backup.ts';
import { assertLocalDatabaseIntegrity, verifyBackup } from './ops-backup-verify.ts';
import { executeLocalD1File } from './local-d1.ts';
import {
  readLocalD1DatabaseId,
  resolveOpsContext,
  type OpsContext,
  type OpsContextOptions,
} from './ops-context.ts';
import { acquireDestructiveOperationGuard } from './runtime-lock.ts';
import { applyRuntimeRetention } from '../lib/runtime-retention.ts';

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

export type RestoreOptions = OpsContextOptions & {
  sourcePath: string;
  checkServer?: boolean;
  nowMs?: number;
};

async function enforceRestoredPrivacy(
  context: OpsContext,
  statePath: string,
  nowMs: number,
) {
  const databaseId = await readLocalD1DatabaseId(context);
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: databaseId },
    d1Persist: path.join(statePath, 'v3', 'd1'),
  });
  try {
    await applyRuntimeRetention(await miniflare.getD1Database('DB'), nowMs);
  } finally {
    await miniflare.dispose();
  }
}

export async function restoreBackup(options: RestoreOptions) {
  const context = resolveOpsContext(options);
  const runtimeGuard = await acquireDestructiveOperationGuard({
    workspaceRoot: context.workspaceRoot,
    probeFallbackPorts: options.checkServer !== false,
  });
  try {
    const sourcePath = path.resolve(options.sourcePath);
    await verifyBackup(sourcePath, context);
    const preRestore = await createBackup(context);
    await verifyBackup(preRestore.sqlPath, context);

    const statePath = context.persistPath;
    const rollbackPath = path.join(
      context.workspaceRoot,
      'backups',
      `rollback-state-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
    );
    assertInside(context.workspaceRoot, statePath);
    assertInside(context.workspaceRoot, rollbackPath);
    await access(statePath);
    await mkdir(path.dirname(rollbackPath), { recursive: true });
    await rename(statePath, rollbackPath);
    await mkdir(statePath, { recursive: true });
    try {
      executeLocalD1File(sourcePath, statePath, context.localD1);
      await enforceRestoredPrivacy(context, statePath, options.nowMs ?? Date.now());
      assertLocalDatabaseIntegrity(statePath, context.localD1);
      console.log(
        `Restore complete. Rollback state: ${path.relative(context.workspaceRoot, rollbackPath)}`,
      );
      return { preRestore, rollbackPath };
    } catch (error) {
      assertInside(context.workspaceRoot, statePath);
      await rm(statePath, { recursive: true, force: true });
      await rename(rollbackPath, statePath);
      throw error;
    }
  } finally {
    await runtimeGuard.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const source = argument('--from');
  const apply = process.argv.includes('--apply');
  if (!source || !apply) {
    console.error('Использование: npm run ops:restore -- --from <backup.sql> --apply');
    process.exitCode = 2;
  } else {
    restoreBackup({ sourcePath: source }).catch(() => {
      console.error('Restore failed. Original local state was preserved when possible.');
      process.exitCode = 1;
    });
  }
}
