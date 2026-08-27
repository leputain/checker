import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadTelegramConfig } from './telegram-config.ts';

const roots = ['dist', '.vinext', '.next'].map((root) => path.resolve(root));
const botTokenPattern = /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{20,64}(?![A-Za-z0-9_-])/;
const findings: string[] = [];
const exactValues: string[] = [];

try {
  const telegram = await loadTelegramConfig();
  exactValues.push(telegram.botToken, telegram.chatId);
} catch {
  // Generic token detection still runs when local Telegram is intentionally disabled.
}

async function scanDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(target);
      continue;
    }
    if (!entry.isFile()) continue;

    const metadata = await stat(target);
    if (metadata.size > 10_000_000) continue;
    const buffer = await readFile(target);
    const relative = path.relative(process.cwd(), target).replaceAll('\\', '/');
    if (exactValues.some((value) => value.length > 0 && buffer.includes(value))) {
      findings.push(`${relative}:exact_telegram_binding`);
      continue;
    }
    if (!buffer.includes(0) && botTokenPattern.test(buffer.toString('utf8'))) {
      findings.push(`${relative}:telegram_bot_token`);
    }
  }
}

for (const root of roots) await scanDirectory(root);

if (findings.length > 0) {
  console.error('Build artifact secret scan failed:');
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log('build artifact secret scan: PASS');
}
