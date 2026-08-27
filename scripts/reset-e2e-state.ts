import { rmSync } from 'node:fs';
import path from 'node:path';

const workspace = path.resolve('.');
const statePath = path.resolve('.wrangler', 'e2e');
const expectedParent = path.resolve(workspace, '.wrangler');

if (path.dirname(statePath) !== expectedParent || path.basename(statePath) !== 'e2e') {
  throw new Error('Refusing to reset an unexpected E2E state path.');
}

rmSync(statePath, { recursive: true, force: true });
console.log('E2E state reset: .wrangler/e2e');
