import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from './miniflare-runtime.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Runtime = { getD1Database(name: string): Promise<D1Database>; dispose(): Promise<void> };

/** Atomically claim a fresh state directory; never accept an existing target. */
export async function createNewTransferDirectory(state: string) {
  await mkdir(path.dirname(state), { recursive: true, mode: 0o700 });
  try {
    await mkdir(state, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Transfer target must be new; existing state is never overwritten.');
    }
    throw error;
  }
}

export async function initializeTransferState(args: readonly string[]) {
  if (args.length !== 2 && args.length !== 4) throw new Error('Usage: STATE_PATH DATABASE_UUID [--sdk-package MINIFLARE_DIRECTORY]');
  if (args.length === 4 && args[2] !== '--sdk-package') throw new Error('Unknown initialization option.');
  const state = path.resolve(args[0]);
  const databaseId = args[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(databaseId)) {
    throw new Error('Database id must be a UUID.');
  }
  const common = {
    modules: true,
    script: 'export default { fetch() { return new Response("isolated state initialization") } }',
    compatibilityDate: '2026-05-15',
    d1Databases: { DB: databaseId },
  };
  let createRuntime: () => Runtime;
  let major: number;
  if (args.length === 4) {
    const sdkPackage = path.resolve(args[3]);
    const metadata = JSON.parse(await readFile(path.join(sdkPackage, 'package.json'), 'utf8'));
    if (metadata.name !== 'miniflare' || typeof metadata.version !== 'string' || !metadata.version.startsWith('4.')) {
      throw new Error('Rollback SDK must be the recorded Miniflare 4 package.');
    }
    const require = createRequire(path.join(root, 'package.json'));
    const old = require(sdkPackage) as { Miniflare: new(options: typeof common & { d1Persist: string }) => Runtime };
    if (typeof old.Miniflare !== 'function') throw new Error('Rollback SDK has no Miniflare constructor.');
    createRuntime = () => new old.Miniflare({ ...common, d1Persist: path.join(state, 'v3', 'd1') });
    major = 4;
  } else {
    createRuntime = () => new Miniflare({ ...common, resourcePersistencePath: path.join(state, 'v3') });
    major = 5;
  }
  await createNewTransferDirectory(state);
  const runtime = createRuntime();
  try {
    await (await runtime.getD1Database('DB')).prepare('SELECT 1').first();
  } finally {
    await runtime.dispose();
  }
  return { initialized: true, sdkMajor: major, existingStateOverwritten: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await initializeTransferState(process.argv.slice(2))));
}
