import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalD1Options } from './local-d1.ts';

export type OpsContextOptions = {
  workspaceRoot?: string;
  configPath?: string;
};

export type OpsContext = {
  workspaceRoot: string;
  configPath: string;
  persistPath: string;
  localD1: LocalD1Options;
};

export function resolveOpsContext(options: OpsContextOptions = {}): OpsContext {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const configPath = path.resolve(
    options.configPath ?? path.join(workspaceRoot, 'wrangler.local.jsonc'),
  );
  return {
    workspaceRoot,
    configPath,
    persistPath: path.join(workspaceRoot, '.wrangler', 'state'),
    localD1: { cwd: workspaceRoot, configPath },
  };
}

function stripJsonComments(source: string) {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (character === '\n' || character === '\r') {
        result += character;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }
  if (inString || blockComment) throw new Error('Invalid Wrangler JSONC configuration.');
  return result;
}

export async function readLocalD1DatabaseId(context: OpsContext, binding = 'DB') {
  const parsed = JSON.parse(stripJsonComments(
    await readFile(context.configPath, 'utf8'),
  )) as {
    d1_databases?: Array<{ binding?: unknown; database_id?: unknown }>;
  };
  const matches = (parsed.d1_databases ?? []).filter((item) => item.binding === binding);
  if (matches.length !== 1 || typeof matches[0].database_id !== 'string') {
    throw new Error(`Wrangler config must contain exactly one ${binding} D1 binding.`);
  }
  const databaseId = matches[0].database_id.trim();
  if (!databaseId || databaseId.length > 128) {
    throw new Error(`Wrangler ${binding} database_id is invalid.`);
  }
  return databaseId;
}
