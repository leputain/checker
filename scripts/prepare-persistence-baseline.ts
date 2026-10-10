import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = path.join(root, '.data', 'security-upgrade', 'baseline-runtime');
const baselineVersion = '4.20260515.0';
try {
  const current = JSON.parse(await readFile(path.join(baseline, 'node_modules', 'miniflare', 'package.json'), 'utf8'));
  if (current.version === baselineVersion) {
    console.log('Isolated Miniflare 4 rollback fixture is available.');
    process.exit(0);
  }
} catch {
  // Install the recorded comparison runtime; never use it for production data.
}
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) throw new Error('Run baseline preparation through npm.');
await mkdir(baseline, { recursive: true });
await writeFile(path.join(baseline, 'package.json'), `${JSON.stringify({
  name: 'candidate-check-isolated-rollback-fixture', version: '1.0.0', private: true,
  description: 'Miniflare 4 only for synthetic cross-version persistence acceptance.',
  dependencies: { miniflare: baselineVersion }, scripts: {},
}, null, 2)}\n`);
const result = spawnSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: baseline, stdio: 'inherit', windowsHide: true, shell: false,
});
if (result.status !== 0) throw new Error('Isolated rollback runtime installation failed.');
console.log('Isolated rollback runtime prepared; production dependencies are unchanged.');
