import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRuntimeMaintenancePolicy } from '../lib/runtime-process-policy.ts';

assert.deepEqual(readRuntimeMaintenancePolicy({}), { enabled: true, startDelayMs: 2_000 });
assert.deepEqual(readRuntimeMaintenancePolicy({ CANDIDATE_CHECK_MAINTENANCE_ENABLED: '0' }), {
  enabled: false, startDelayMs: 2_000,
});
assert.deepEqual(readRuntimeMaintenancePolicy({
  CANDIDATE_CHECK_MAINTENANCE_ENABLED: '1',
  CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS: '60000',
}), { enabled: true, startDelayMs: 60_000 });
assert.equal(readRuntimeMaintenancePolicy({
  CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS: '120000',
}).startDelayMs, 120_000);
for (const invalid of ['0', '-1', '1.5', '1e3', '120001', 'Infinity']) {
  assert.throws(() => readRuntimeMaintenancePolicy({
    CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS: invalid,
  }), /must be an integer/u);
}
assert.throws(() => readRuntimeMaintenancePolicy({
  CANDIDATE_CHECK_MAINTENANCE_ENABLED: 'false',
}), /must be 0 or 1/u);

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function until(predicate: () => boolean | Promise<boolean>, message: string, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function childExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic process did not exit.')), 8_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

const helperUrl = pathToFileURL(fileURLToPath(new URL('../lib/runtime-process-policy.ts', import.meta.url))).href;
const leafSource = `
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.send({ kind: 'signal', who: 'leaf' }, () => process.exit(0)));
  process.send({ kind: 'leaf-ready', pid: process.pid });
`;
const childSource = `
  const { spawn } = await import('node:child_process');
  const leaf = spawn(process.execPath, ['--input-type=module', '-e', process.argv[1]], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, shell: false
  });
  leaf.on('message', message => {
    if (message.kind === 'leaf-ready') process.send({ kind: 'ready', pid: process.pid, leafPid: message.pid });
    else process.send(message);
  });
  process.on('SIGTERM', () => {
    process.send({ kind: 'signal', who: 'child' });
    if (leaf.exitCode !== null || leaf.signalCode !== null) process.exit(0);
    else leaf.once('exit', () => process.exit(0));
  });
  setInterval(() => {}, 1000);
`;
const wrapperSource = `
  const { spawnManagedRuntimeProcess } = await import(process.argv[1]);
  const managed = spawnManagedRuntimeProcess(process.execPath,
    ['--input-type=module', '-e', process.argv[2], process.argv[3]],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    { onStopping: () => process.send({ kind: 'stopping' }), shutdownTimeoutMs: 500 });
  managed.child.on('message', message => process.send(message));
  process.on('message', message => { if (message.kind === 'stop') void managed.stop('SIGTERM'); });
  const result = await managed.exited;
  process.send({ kind: 'finished', result }, () => process.exit(result.code));
`;

async function testProcessTree() {
  const messages: Array<{ kind: string; pid?: number; leafPid?: number; who?: string }> = [];
  const wrapper = spawn(process.execPath, [
    '--experimental-strip-types', '--input-type=module', '-e', wrapperSource,
    helperUrl, childSource, leafSource,
  ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true, shell: false });
  const exit = childExit(wrapper);
  wrapper.on('message', (message) => messages.push(message as typeof messages[number]));
  const ownedPids: number[] = [];
  try {
    await until(() => messages.some((message) => message.kind === 'ready'), 'Synthetic child tree did not start.');
    const ready = messages.find((message) => message.kind === 'ready')!;
    ownedPids.push(ready.pid!, ready.leafPid!);
    assert(ownedPids.every(alive), 'both synthetic descendants must be alive before shutdown');
    if (process.platform === 'win32') {
      // process.kill(SIGTERM) forcibly terminates Windows programs without
      // delivering a JS signal. Exercise the same stop path through IPC.
      wrapper.send({ kind: 'stop' });
    } else {
      wrapper.kill('SIGTERM');
    }
    assert.deepEqual(await exit, { code: 143, signal: null });
    await until(() => ownedPids.every((pid) => !alive(pid)), 'Shutdown left a synthetic descendant running.');
    assert(messages.some((message) => message.kind === 'stopping'), 'shutdown must stop background maintenance');
    if (process.platform !== 'win32') {
      assert(messages.some((message) => message.kind === 'signal' && message.who === 'child'));
      assert(messages.some((message) => message.kind === 'signal' && message.who === 'leaf'));
    }
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null && wrapper.connected) {
      wrapper.send({ kind: 'stop' });
      await exit.catch(() => undefined);
    }
    for (const pid of ownedPids) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function exists(target: string) {
  try { await access(target); return true; } catch { return false; }
}

async function testMaintenanceWrapper(enabled: boolean) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'candidate-check-runtime-process-'));
  const port = await unusedPort();
  const fakeCli = path.join(workspace, 'node_modules', 'vite', 'bin', 'vite.js');
  const backupDirectory = path.join(workspace, 'backups');
  const expiredBackup = path.join(backupDirectory, 'candidate-check-2020-01-01T00-00-00-000Z-12345678.sql');
  await mkdir(path.dirname(fakeCli), { recursive: true });
  await mkdir(backupDirectory);
  await writeFile(expiredBackup, '-- synthetic expired backup\n', 'utf8');
  await writeFile(expiredBackup.replace(/\.sql$/u, '.manifest.json'), '{}\n', 'utf8');
  await writeFile(fakeCli, `
    const { createServer } = require('node:http');
    const server = createServer((request, response) => {
      if (request.url === '/shutdown') {
        response.writeHead(204).end();
        server.close(() => process.exit(0));
      } else {
        console.log(JSON.stringify({kind:'maintenance',at:Date.now()}));
        response.writeHead(204).end();
      }
    });
    server.listen(${port}, '127.0.0.1', () => console.log(JSON.stringify({kind:'ready'})));
  `, 'utf8');
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'ComSpec']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    CANDIDATE_CHECK_STATE_PATH: '.wrangler/test-state',
    CANDIDATE_CHECK_SKIP_TELEGRAM_FILE: '1',
    CANDIDATE_CHECK_ADMIN_PIN_FILE: path.join(workspace, 'absent-synthetic-admin-pin.txt'),
    CANDIDATE_CHECK_MAINTENANCE_ENABLED: enabled ? '1' : '0',
    CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS: '500',
    TELEGRAM_ENABLED: '0', TELEGRAM_REQUIRED: '0',
  });
  const startedAt = Date.now();
  const wrapper = spawn(process.execPath, [
    '--experimental-strip-types', fileURLToPath(new URL('./run-local.ts', import.meta.url)),
    'preview', '--port', String(port),
  ], { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const exit = childExit(wrapper);
  let output = '';
  wrapper.stdout!.on('data', (chunk) => { output += String(chunk); });
  wrapper.stderr!.on('data', (chunk) => { output += String(chunk); });
  try {
    await until(() => output.includes('"kind":"ready"'), 'Synthetic preview did not become ready.');
    if (enabled) {
      await until(() => output.includes('"kind":"maintenance"'), 'Enabled maintenance did not start after its grace.');
      const firstRequest = output.split('\n').find((line) => line.includes('"kind":"maintenance"'))!;
      assert(JSON.parse(firstRequest).at - startedAt >= 500, 'maintenance must respect its startup grace');
      assert.equal(await exists(expiredBackup), false, 'enabled maintenance preserves normal startup retention');
    } else {
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal(output.includes('"kind":"maintenance"'), false, 'disabled maintenance must not call its endpoint');
      assert.equal(await exists(expiredBackup), true, 'disabled maintenance must not prune clone backups');
    }
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
    assert.equal(response.status, 204);
    assert.deepEqual(await exit, { code: 0, signal: null });
    await until(async () => {
      const { readdir } = await import('node:fs/promises');
      return (await readdir(path.join(workspace, '.data', 'runtime-locks'))).length === 0;
    }, 'Wrapper did not release its runtime lock.');
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => undefined);
      await exit.catch(() => { wrapper.kill('SIGKILL'); });
    }
    const resolved = path.resolve(workspace);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()), 'cleanup must stay under the temporary directory');
    assert(path.basename(resolved).startsWith('candidate-check-runtime-process-'));
    await rm(resolved, { recursive: true, force: true });
  }
}

await testProcessTree();
await testMaintenanceWrapper(false);
await testMaintenanceWrapper(true);
console.log('runtime process tests: PASS');
