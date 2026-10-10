import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTED_ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
export const EXCEPTION_EXPIRES_AT = '2026-11-10T00:00:00.000Z';

// Temporary, reviewed build/lint-only dependency chains. This is not a severity
// threshold: every other advisory, package, edge, install path or version fails.
const reviewed = {
  braces: { direct: false, via: [], nodes: { 'node_modules/braces': '3.0.3' } },
  micromatch: { direct: false, via: ['braces'], nodes: { 'node_modules/micromatch': '4.0.8' } },
  'fast-glob': { direct: false, via: ['micromatch'], nodes: {
    'node_modules/fast-glob': '3.3.1',
    'node_modules/vite-plugin-dynamic-import/node_modules/fast-glob': '3.3.3',
  } },
  '@next/eslint-plugin-next': { direct: false, via: ['fast-glob'], nodes: { 'node_modules/@next/eslint-plugin-next': '16.3.8' } },
  'eslint-config-next': { direct: true, via: ['@next/eslint-plugin-next'], nodes: { 'node_modules/eslint-config-next': '16.3.8' } },
  'vite-plugin-dynamic-import': { direct: false, via: ['fast-glob'], nodes: { 'node_modules/vite-plugin-dynamic-import': '1.6.0' } },
  'vite-plugin-commonjs': { direct: false, via: ['vite-plugin-dynamic-import'], nodes: { 'node_modules/vite-plugin-commonjs': '0.10.4' } },
  vinext: { direct: true, via: ['vite-plugin-commonjs'], nodes: { 'node_modules/vinext': '1.1.0' } },
} satisfies Record<string, { direct: boolean; via: string[]; nodes: Record<string, string> }>;

const severities = ['info', 'low', 'moderate', 'high', 'critical'] as const;
type Severity = typeof severities[number];
type Advisory = { name: string; dependency: string; url: string; severity: Severity; range: string };
type AuditEntry = { name: string; severity: Severity; isDirect: boolean; via: Array<string | Advisory>; nodes: string[] };
export type AuditPolicyResult = {
  passed: boolean;
  status: 'clean' | 'accepted_residual' | 'blocked';
  reasons: string[];
  packages: string[];
  advisories: string[];
  exceptionExpiresAt: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    && new Set(value).size === value.length;
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function blocked(reason: string): AuditPolicyResult {
  return { passed: false, status: 'blocked', reasons: [reason], packages: [], advisories: [],
    exceptionExpiresAt: EXCEPTION_EXPIRES_AT };
}

/** Evaluate an npm audit v2 report without I/O. CLI additionally supplies the lockfile. */
export function evaluateAudit(data: unknown, now = new Date(), lockfile?: unknown): AuditPolicyResult {
  if (!record(data) || Object.hasOwn(data, 'error')) return blocked('audit_error_or_unavailable');
  if (data.auditReportVersion !== 2 || !record(data.vulnerabilities)
    || !record(data.metadata) || !record(data.metadata.vulnerabilities)) return blocked('audit_format_invalid');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return blocked('audit_clock_invalid');

  const entries = new Map<string, AuditEntry>();
  for (const [name, raw] of Object.entries(data.vulnerabilities)) {
    if (!record(raw) || raw.name !== name || !severities.includes(raw.severity as Severity)
      || typeof raw.isDirect !== 'boolean' || !strings(raw.nodes) || raw.nodes.length === 0
      || !Array.isArray(raw.via) || raw.via.length === 0) return blocked('audit_entry_invalid');
    const via: Array<string | Advisory> = [];
    for (const item of raw.via) {
      if (typeof item === 'string' && item.length > 0) via.push(item);
      else if (record(item) && typeof item.name === 'string' && typeof item.dependency === 'string'
        && typeof item.url === 'string' && typeof item.range === 'string'
        && severities.includes(item.severity as Severity)) via.push(item as Advisory);
      else return blocked('audit_advisory_invalid');
    }
    entries.set(name, { name, severity: raw.severity as Severity, isDirect: raw.isDirect, via, nodes: raw.nodes });
  }
  const counts = data.metadata.vulnerabilities;
  for (const severity of severities) {
    if (!Number.isInteger(counts[severity]) || (counts[severity] as number) < 0
      || counts[severity] !== [...entries.values()].filter((entry) => entry.severity === severity).length) {
      return blocked('audit_counts_invalid');
    }
  }
  if (!Number.isInteger(counts.total) || counts.total !== entries.size) return blocked('audit_counts_invalid');
  if (entries.size === 0) return { passed: true, status: 'clean', reasons: [], packages: [], advisories: [],
    exceptionExpiresAt: EXCEPTION_EXPIRES_AT };

  // Resolve all via edges first: missing references and cycles must never be
  // interpreted as having no advisories or be hidden by an allowlisted parent.
  const resolved = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  function roots(name: string): Set<string> {
    if (visiting.has(name)) throw new Error('audit_graph_cycle');
    const cached = resolved.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) throw new Error('audit_graph_reference_missing');
    visiting.add(name);
    const result = new Set<string>();
    for (const item of entry.via) {
      if (typeof item === 'string') for (const url of roots(item)) result.add(url);
      else result.add(item.url);
    }
    visiting.delete(name);
    resolved.set(name, result);
    return result;
  }
  try {
    for (const name of entries.keys()) roots(name);
  } catch (error) {
    return blocked(error instanceof Error && error.message === 'audit_graph_cycle'
      ? 'audit_graph_cycle' : 'audit_graph_reference_missing');
  }
  const advisories = [...new Set([...resolved.values()].flatMap((urls) => [...urls]))];
  if (!sameSet(advisories, [ACCEPTED_ADVISORY])) return blocked('audit_advisory_not_reviewed');
  if (!sameSet([...entries.keys()], Object.keys(reviewed))) return blocked('audit_package_set_not_reviewed');
  for (const [name, entry] of entries) {
    const expected = reviewed[name as keyof typeof reviewed];
    const via = entry.via.filter((item): item is string => typeof item === 'string');
    const ownAdvisories = entry.via.filter((item): item is Advisory => typeof item !== 'string');
    if (entry.severity !== 'high' || entry.isDirect !== expected.direct
      || !sameSet(entry.nodes, Object.keys(expected.nodes)) || !sameSet(via, expected.via)) {
      return blocked('audit_chain_not_reviewed');
    }
    if (name === 'braces') {
      if (ownAdvisories.length !== 1 || ownAdvisories[0].name !== 'braces'
        || ownAdvisories[0].dependency !== 'braces' || ownAdvisories[0].severity !== 'high'
        || ownAdvisories[0].range !== '<=3.0.3') return blocked('audit_root_not_reviewed');
    } else if (ownAdvisories.length !== 0) return blocked('audit_root_not_reviewed');
  }
  if (lockfile !== undefined) {
    if (!record(lockfile) || !record(lockfile.packages)) return blocked('audit_lockfile_invalid');
    for (const expected of Object.values(reviewed)) {
      for (const [node, version] of Object.entries(expected.nodes)) {
        const installed = lockfile.packages[node];
        if (!record(installed) || installed.version !== version) return blocked('audit_version_not_reviewed');
      }
    }
  }
  if (now.getTime() >= Date.parse(EXCEPTION_EXPIRES_AT)) return blocked('audit_exception_expired');
  return { passed: true, status: 'accepted_residual', reasons: ['temporary_build_lint_braces_exception'],
    packages: [...entries.keys()].sort(), advisories, exceptionExpiresAt: EXCEPTION_EXPIRES_AT };
}

async function main() {
  try {
    if (process.argv.length > 3) return blocked('audit_arguments_invalid');
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    let data: unknown;
    if (process.argv[2]) data = JSON.parse(await readFile(path.resolve(process.argv[2]), 'utf8'));
    else {
      const npmCli = process.env.npm_execpath
        ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const audit = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
        cwd: projectRoot, encoding: 'utf8', shell: false, windowsHide: true,
        timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (audit.error || audit.signal || (audit.status !== 0 && audit.status !== 1)) return blocked('audit_unavailable');
      data = JSON.parse(audit.stdout);
    }
    const lockfile: unknown = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    return evaluateAudit(data, new Date(), lockfile);
  } catch {
    return blocked('audit_unavailable_or_invalid_json');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  if (result.status === 'accepted_residual') {
    console.warn(`WARNING: only the reviewed braces build/lint chains are temporarily accepted until ${EXCEPTION_EXPIRES_AT}.`);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
