import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function gitFiles(args: string[]) {
  return execFileSync('git', [...args, '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
}

const tracked = gitFiles(['ls-files', '--cached']);
const modifiedTracked = gitFiles(['diff', '--name-only', '--diff-filter=ACMR']);
const untracked = gitFiles(['ls-files', '--others', '--exclude-standard']);
const candidates = [
  ...tracked.map((file) => ({ file, source: 'index' as const })),
  ...modifiedTracked.map((file) => ({ file, source: 'worktree' as const })),
  ...untracked.map((file) => ({ file, source: 'worktree' as const })),
];

const forbiddenNames = [/^tg_token\.txt$/i, /^\.dev\.vars/i, /^\.env(?:\.|$)/i];
const rules = [
  { name: 'telegram_bot_token', pattern: /\d{8,12}:[A-Za-z0-9_-]{20,64}/ },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'cloudflare_api_token', pattern: /CLOUDFLARE_API_TOKEN\s*[:=]\s*[^\s'"`]{12,}/i },
] as const;

const findings: string[] = [];
for (const { file, source } of candidates) {
  const normalized = file.replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1) ?? normalized;
  if (forbiddenNames.some((pattern) => pattern.test(basename))) {
    findings.push(`${normalized}:1:secret_file_tracked`);
    continue;
  }
  let buffer: Buffer;
  try {
    buffer = source === 'index'
      ? execFileSync('git', ['show', `:${file}`], { encoding: 'buffer', maxBuffer: 3_000_000 })
      : readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.length > 2_000_000 || buffer.includes(0)) continue;
  const contents = buffer.toString('utf8');
  contents.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) findings.push(`${normalized}:${index + 1}:${rule.name}`);
    }
  });
}

if (findings.length > 0) {
  console.error('Проверка секретов не пройдена:');
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log(`secret scan: PASS (${candidates.length} index/modified/untracked inputs)`);
}
