import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ADMIN_PIN_ITERATIONS = 210_000;

export type AdminRuntimeConfig = {
  status: 'ready' | 'missing' | 'invalid';
  pinHash: string;
  pinSalt: string;
  pinIterations: number;
  sessionSecret: string;
};

export class AdminConfigError extends Error {
  readonly code: 'missing' | 'invalid';

  constructor(code: 'missing' | 'invalid') {
    super(code === 'missing' ? 'Admin PIN file is missing.' : 'Admin PIN file is invalid.');
    this.name = 'AdminConfigError';
    this.code = code;
  }
}

export function parseAdminPin(contents: string) {
  const pin = contents.trim();
  if (!/^\d{4,12}$/u.test(pin)) {
    throw new AdminConfigError('invalid');
  }
  return pin;
}

function derivePinHash(pin: string, salt: Buffer, iterations = ADMIN_PIN_ITERATIONS) {
  return pbkdf2Sync(pin, salt, iterations, 32, 'sha256').toString('base64url');
}

export async function loadAdminRuntimeConfig(
  filePath = path.resolve(process.cwd(), 'admin_pin.txt'),
): Promise<AdminRuntimeConfig> {
  const salt = randomBytes(16);
  const sessionSecret = randomBytes(32).toString('base64url');
  try {
    const pin = parseAdminPin(await readFile(filePath, 'utf8'));
    return {
      status: 'ready',
      pinHash: derivePinHash(pin, salt),
      pinSalt: salt.toString('base64url'),
      pinIterations: ADMIN_PIN_ITERATIONS,
      sessionSecret,
    };
  } catch (error) {
    const status = error instanceof AdminConfigError
      ? error.code
      : (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing'
        : 'invalid';
    // Always expose syntactically valid, per-process dummy bindings. The status
    // binding keeps the admin surface disabled without weakening candidate flow.
    const dummyPin = randomBytes(32).toString('base64url');
    return {
      status,
      pinHash: derivePinHash(dummyPin, salt),
      pinSalt: salt.toString('base64url'),
      pinIterations: ADMIN_PIN_ITERATIONS,
      sessionSecret,
    };
  }
}
