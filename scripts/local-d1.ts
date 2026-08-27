import { spawnSync } from 'node:child_process';
import path from 'node:path';

const wranglerPath = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const configPath = path.resolve('wrangler.local.jsonc');

export function runWrangler(
  args: string[],
  persistTo: string | null = path.resolve('.wrangler', 'state'),
) {
  const persistenceArgs = persistTo === null ? [] : ['--persist-to', persistTo];
  const result = spawnSync(
    process.execPath,
    [wranglerPath, ...args, '--config', configPath, '--local', ...persistenceArgs],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Wrangler command failed').trim());
  }
  return result.stdout.trim();
}

export function queryLocalD1<T>(sql: string, persistTo?: string): T[] {
  const output = runWrangler(
    ['d1', 'execute', 'DB', '--command', sql, '--json'],
    persistTo,
  );
  const payload = JSON.parse(output) as Array<{ success: boolean; results: T[] }>;
  if (!payload[0]?.success) throw new Error('Local D1 query failed.');
  return payload[0].results;
}

export function executeLocalD1File(filePath: string, persistTo?: string) {
  return runWrangler(['d1', 'execute', 'DB', '--file', path.resolve(filePath)], persistTo);
}
