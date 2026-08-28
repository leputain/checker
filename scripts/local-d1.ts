import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerPath = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export type LocalD1Options = {
  configPath?: string;
  cwd?: string;
};

export function runWrangler(
  args: string[],
  persistTo?: string | null,
  options: LocalD1Options = {},
) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(options.configPath ?? path.join(projectRoot, 'wrangler.local.jsonc'));
  const resolvedPersistTo = persistTo === undefined
    ? path.join(cwd, '.wrangler', 'state')
    : persistTo;
  const persistenceArgs = resolvedPersistTo === null
    ? []
    : ['--persist-to', path.resolve(resolvedPersistTo)];
  const result = spawnSync(
    process.execPath,
    [wranglerPath, ...args, '--config', configPath, '--local', ...persistenceArgs],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Wrangler command failed').trim());
  }
  return result.stdout.trim();
}

export function queryLocalD1<T>(
  sql: string,
  persistTo?: string,
  options: LocalD1Options = {},
): T[] {
  const output = runWrangler(
    ['d1', 'execute', 'DB', '--command', sql, '--json'],
    persistTo,
    options,
  );
  const payload = JSON.parse(output) as Array<{ success: boolean; results: T[] }>;
  if (!payload[0]?.success) throw new Error('Local D1 query failed.');
  return payload[0].results;
}

export function executeLocalD1File(
  filePath: string,
  persistTo?: string,
  options: LocalD1Options = {},
) {
  return runWrangler(
    ['d1', 'execute', 'DB', '--file', path.resolve(filePath)],
    persistTo,
    options,
  );
}
