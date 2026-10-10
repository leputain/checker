import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './dependency-audit-policy.ts';

const now = new Date('2026-10-10T12:00:00.000Z');
const definitions: Record<string, { direct: boolean; via: string[]; nodes: Record<string, string> }> = {
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
};

function fixture() {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {
      name, severity: 'high', isDirect: definition.direct, nodes: Object.keys(definition.nodes),
      via: name === 'braces' ? [{ name: 'braces', dependency: 'braces', severity: 'high',
        range: '<=3.0.3', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm' }] : definition.via,
    }])),
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 8, critical: 0, total: 8 } },
  };
}

const lockfile = { packages: Object.fromEntries(Object.values(definitions).flatMap((definition) => (
  Object.entries(definition.nodes).map(([node, version]) => [node, { version }])
))) };
const accepted = evaluateAudit(fixture(), now, lockfile);
assert.equal(accepted.passed, true);
assert.equal(accepted.status, 'accepted_residual');
assert.equal(accepted.packages.length, 8);
assert.equal(accepted.advisories.length, 1, 'via package counts are not unique advisory counts');

const clean = { auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
assert.equal(evaluateAudit(clean, now).status, 'clean');
assert.equal(evaluateAudit(clean, new Date('2027-01-01')).passed, true,
  'an expired exception must not block a genuinely clean report');

for (const malformed of [null, [], '', {}, { error: { detail: 'private-audit-value' } },
  { ...clean, auditReportVersion: 1 }, { ...clean, error: null },
  { ...fixture(), metadata: clean.metadata }]) {
  assert.equal(evaluateAudit(malformed, now).passed, false);
}
assert.equal(evaluateAudit(fixture(), new Date('invalid')).passed, false);

const unknownAdvisory = fixture();
unknownAdvisory.vulnerabilities.braces.via = [{ name: 'braces', dependency: 'braces', severity: 'high',
  range: '<=3.0.3', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }];
assert.equal(evaluateAudit(unknownAdvisory, now).passed, false);

const newPackage = fixture();
newPackage.vulnerabilities['incoming-parser'] = { name: 'incoming-parser', severity: 'high',
  isDirect: true, nodes: ['node_modules/incoming-parser'], via: ['braces'] };
newPackage.metadata.vulnerabilities.high = 9;
newPackage.metadata.vulnerabilities.total = 9;
assert.equal(evaluateAudit(newPackage, now).passed, false,
  'the same accepted GHSA must not authorize a new vulnerable package');

const newInstallPath = fixture();
newInstallPath.vulnerabilities.braces.nodes.push('node_modules/runtime/node_modules/braces');
assert.equal(evaluateAudit(newInstallPath, now).passed, false);

const cycle = fixture();
cycle.vulnerabilities.braces.via = ['micromatch'];
assert.equal(evaluateAudit(cycle, now).reasons[0], 'audit_graph_cycle');
const missingReference = fixture();
missingReference.vulnerabilities.vinext.via = ['missing-package'];
assert.equal(evaluateAudit(missingReference, now).reasons[0], 'audit_graph_reference_missing');
const changedChain = fixture();
changedChain.vulnerabilities.vinext.via = ['braces'];
assert.equal(evaluateAudit(changedChain, now).passed, false);
const changedRoot = fixture();
changedRoot.vulnerabilities.braces.via = [{ name: 'different-root', dependency: 'braces', severity: 'high',
  range: '<=3.0.3', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm' }];
assert.equal(evaluateAudit(changedRoot, now).passed, false);
const changedSeverity = fixture();
changedSeverity.vulnerabilities.braces.severity = 'critical';
changedSeverity.metadata.vulnerabilities.high = 7;
changedSeverity.metadata.vulnerabilities.critical = 1;
assert.equal(evaluateAudit(changedSeverity, now).passed, false);

const changedVersion = structuredClone(lockfile);
changedVersion.packages['node_modules/braces'].version = '3.0.4';
assert.equal(evaluateAudit(fixture(), now, changedVersion).passed, false);
assert.equal(evaluateAudit(fixture(), now, {}).passed, false);
assert.equal(evaluateAudit(fixture(), new Date('2026-11-09T23:59:59.999Z')).passed, true);
assert.equal(evaluateAudit(fixture(), new Date('2026-11-10T00:00:00.000Z')).passed, false);

// CLI malformed-file coverage uses an isolated fixture and never invokes npm/network.
const prefix = 'candidate-audit-policy-';
const directory = await mkdtemp(path.join(tmpdir(), prefix));
try {
  const auditPath = path.join(directory, 'invalid audit.json');
  await writeFile(auditPath, '{invalid private-audit-value');
  const result = spawnSync(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('./dependency-audit-policy.ts', import.meta.url)), auditPath], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.doesNotMatch(result.stdout + result.stderr, /private-audit-value/u);
} finally {
  const relative = path.relative(tmpdir(), directory);
  assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep));
  await rm(directory, { recursive: true, force: true });
}
console.log('Dependency audit policy tests: PASS');
