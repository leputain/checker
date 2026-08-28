import assert from 'node:assert/strict';
import { AdminConfigError, parseAdminPin } from './admin-config.ts';

assert.equal(parseAdminPin('  492817  \n'), '492817');

for (const value of ['', '12345', '1234567890123', 'abcdef', 'line one\nline two', `123456\0`]) {
  assert.throws(
    () => parseAdminPin(value),
    (error) => error instanceof AdminConfigError && error.code === 'invalid',
  );
}

console.log('Admin config tests passed.');
