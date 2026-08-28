import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const workspace = path.resolve('.');
const statePath = path.resolve('.wrangler', 'e2e');
const expectedParent = path.resolve(workspace, '.wrangler');

if (path.dirname(statePath) !== expectedParent || path.basename(statePath) !== 'e2e') {
  throw new Error('Refusing to reset an unexpected E2E state path.');
}

rmSync(statePath, { recursive: true, force: true });
const e2eDataPath = path.resolve('.data');
const e2eAdminPinPath = path.join(e2eDataPath, 'e2e-admin-pin.txt');
if (!e2eAdminPinPath.startsWith(`${e2eDataPath}${path.sep}`)) {
  throw new Error('Refusing to write an unexpected E2E credential path.');
}
mkdirSync(e2eDataPath, { recursive: true });
writeFileSync(e2eAdminPinPath, '731942\n', { encoding: 'utf8', mode: 0o600 });
console.log('E2E state reset: .wrangler/e2e');
