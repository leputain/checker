import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadTelegramConfig, TelegramConfigError } from './telegram-config.ts';

const command = process.argv[2];
if (command !== 'dev' && command !== 'start' && command !== 'preview') {
  console.error('Использование: run-local.ts dev|start|preview');
  process.exit(2);
}

const childEnvironment = { ...process.env };
childEnvironment.TELEGRAM_ENABLED ??= '1';
childEnvironment.TELEGRAM_REQUIRED ??= '1';
childEnvironment.TELEGRAM_REPORT_MODE ??= 'progress_errors';

if (childEnvironment.CANDIDATE_CHECK_SKIP_TELEGRAM_FILE !== '1') {
  delete childEnvironment.TELEGRAM_BOT_TOKEN;
  delete childEnvironment.TELEGRAM_CHAT_ID;
  delete childEnvironment.TELEGRAM_CONFIG_STATUS;
  try {
    const config = await loadTelegramConfig();
    childEnvironment.TELEGRAM_BOT_TOKEN = config.botToken;
    childEnvironment.TELEGRAM_CHAT_ID = config.chatId;
    childEnvironment.TELEGRAM_CONFIG_STATUS = 'ready';
  } catch (error) {
    childEnvironment.TELEGRAM_CONFIG_STATUS =
      error instanceof TelegramConfigError ? error.code : 'invalid';
    console.warn('Telegram-конфигурация недоступна; новые тесты будут временно заблокированы.');
  }
}
delete childEnvironment.CANDIDATE_CHECK_SKIP_TELEGRAM_FILE;

const maintenanceToken = randomBytes(32).toString('base64url');
childEnvironment.MAINTENANCE_TOKEN = maintenanceToken;

function cliPort(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = argument.startsWith('--port=')
      ? argument.slice('--port='.length)
      : argument === '--port' || argument === '-p'
        ? args[index + 1]
        : undefined;
    if (value === undefined) continue;
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
  }
  const environmentPort = Number(process.env.PORT);
  return Number.isInteger(environmentPort) && environmentPort >= 1 && environmentPort <= 65_535
    ? environmentPort
    : 3_000;
}

const cliArguments = process.argv.slice(3);
const port = cliPort(cliArguments);
const basePath = (childEnvironment.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
const maintenanceUrl = `http://localhost:${port}${basePath}/api/internal/maintenance`;
const retryDelays = [2_000, 5_000, 15_000, 30_000, 50_000] as const;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceRequest: AbortController | null = null;
let maintenanceStopped = false;
let maintenanceFailures = 0;

function scheduleMaintenance(delay: number) {
  if (maintenanceStopped) return;
  maintenanceTimer = setTimeout(runMaintenance, delay);
  maintenanceTimer.unref();
}

async function runMaintenance() {
  if (maintenanceStopped) return;
  maintenanceRequest = new AbortController();
  const timeout = setTimeout(() => maintenanceRequest?.abort(), 8_000);
  timeout.unref();
  try {
    const response = await fetch(maintenanceUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${maintenanceToken}` },
      signal: maintenanceRequest.signal,
    });
    if (!response.ok) throw new Error('maintenance_unavailable');
    maintenanceFailures = 0;
    scheduleMaintenance(50_000);
  } catch {
    if (!maintenanceStopped) {
      maintenanceFailures += 1;
      scheduleMaintenance(retryDelays[Math.min(maintenanceFailures - 1, retryDelays.length - 1)]);
    }
  } finally {
    clearTimeout(timeout);
    maintenanceRequest = null;
  }
}

function stopMaintenance() {
  maintenanceStopped = true;
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceRequest?.abort();
}

const executable = command === 'preview'
  ? path.resolve('node_modules', 'vite', 'bin', 'vite.js')
  : path.resolve('node_modules', 'vinext', 'dist', 'cli.js');
const executableArguments = command === 'preview'
  ? [executable, 'preview', ...cliArguments]
  : [executable, command, ...cliArguments];
const child = spawn(process.execPath, executableArguments, {
  env: childEnvironment,
  stdio: 'inherit',
  shell: false,
});

scheduleMaintenance(2_000);

child.on('error', () => {
  stopMaintenance();
  console.error('Не удалось запустить локальный сервер.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  stopMaintenance();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
