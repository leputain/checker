import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export function readRuntimeMaintenancePolicy(environment: Readonly<Record<string, string | undefined>>) {
  const enabledValue = environment.CANDIDATE_CHECK_MAINTENANCE_ENABLED?.trim();
  if (enabledValue && enabledValue !== '0' && enabledValue !== '1') {
    throw new Error('CANDIDATE_CHECK_MAINTENANCE_ENABLED must be 0 or 1.');
  }
  const delayValue = environment.CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS?.trim();
  const startDelayMs = delayValue ? Number(delayValue) : 2_000;
  if (
    (delayValue && !/^[1-9]\d*$/u.test(delayValue))
    || !Number.isSafeInteger(startDelayMs) || startDelayMs < 1 || startDelayMs > 120_000
  ) {
    throw new Error('CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS must be an integer from 1 to 120000.');
  }
  return { enabled: enabledValue !== '0', startDelayMs };
}

export type RuntimeProcessExit = {
  code: number;
  signal: NodeJS.Signals | null;
  failedToStart: boolean;
};

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Windows has no POSIX process-group signals. Killing the parent first
    // would make its descendants unaddressable by taskkill /T.
    if (!processExists(child.pid)) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', shell: false, windowsHide: true,
      });
      killer.once('error', reject);
      killer.once('exit', (code) => {
        if (code === 0 || !processExists(child.pid!)) resolve();
        else reject(new Error('Runtime process tree could not be stopped.'));
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Own one child tree. Only this child's POSIX group or Windows PID is targeted. */
export function spawnManagedRuntimeProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
  callbacks: {
    onStopping?: () => void;
    onStopError?: () => void;
    shutdownTimeoutMs?: number;
  } = {},
) {
  const child = spawn(executable, args, {
    ...options,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stopping = false;
  let requestedSignal: NodeJS.Signals | null = null;
  let forceTimer: NodeJS.Timeout | null = null;
  let finishing = false;
  let termination: Promise<void> = Promise.resolve();
  let resolveExit: (result: RuntimeProcessExit) => void;
  const exited = new Promise<RuntimeProcessExit>((resolve) => { resolveExit = resolve; });

  function stop(signal: NodeJS.Signals = 'SIGTERM') {
    if (finishing) return termination;
    const force = stopping;
    stopping = true;
    requestedSignal ??= signal;
    callbacks.onStopping?.();
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        void terminateProcessTree(child, 'SIGKILL').catch(() => callbacks.onStopError?.());
      }, callbacks.shutdownTimeoutMs ?? 5_000);
    }
    termination = terminateProcessTree(child, force ? 'SIGKILL' : signal)
      .catch(() => { callbacks.onStopError?.(); });
    return termination;
  }
  const onSigterm = () => { void stop('SIGTERM'); };
  const onSigint = () => { void stop('SIGINT'); };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  async function finish(code: number | null, signal: NodeJS.Signals | null, failedToStart: boolean) {
    if (finishing) return;
    finishing = true;
    callbacks.onStopping?.();
    if (forceTimer) clearTimeout(forceTimer);
    await termination;
    if (process.platform !== 'win32' && child.pid) {
      // The root may exit before a worker. Give descendants time to finish,
      // then remove any remaining members of the group before releasing locks.
      await terminateProcessTree(child, 'SIGTERM').catch(() => callbacks.onStopError?.());
      if (processExists(-child.pid)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await terminateProcessTree(child, 'SIGKILL').catch(() => callbacks.onStopError?.());
      }
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    const effectiveSignal = requestedSignal ?? signal;
    const signalCode = effectiveSignal === 'SIGINT' ? 130 : effectiveSignal ? 143 : null;
    resolveExit({ code: failedToStart ? 1 : signalCode ?? code ?? 1, signal: effectiveSignal, failedToStart });
  }
  child.once('error', () => { void finish(null, null, true); });
  child.once('exit', (code, signal) => { void finish(code, signal, false); });
  return { child, stop, exited };
}
