import { env } from 'cloudflare:workers';
import migration0000 from '../drizzle/0000_sweet_morgan_stark.sql?raw';
import migration0001 from '../drizzle/0001_furry_wallow.sql?raw';
import migration0002 from '../drizzle/0002_pink_wild_child.sql?raw';
import migration0003 from '../drizzle/0003_thin_johnny_blaze.sql?raw';
import migration0004 from '../drizzle/0004_overjoyed_vapor.sql?raw';
import migration0005 from '../drizzle/0005_mighty_madame_masque.sql?raw';
import migration0006 from '../drizzle/0006_numerous_jack_flag.sql?raw';
import { calculateAccuracy, calculateVerdict, type Verdict } from '@/lib/scoring.ts';
import { TEST_CONFIG, type Difficulty } from '@/lib/test-config.ts';
import { summarizeQuestionBank, type QuestionDefinition } from '@/lib/question-bank-validation.ts';
import { loadQuestionBank } from './question-bank';

export type { Difficulty, Verdict };

export const CURRENT_SCHEMA_VERSION = 5;

export type QuestionRow = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  choices_json: string;
  correct_index: number;
  weight: number;
  active: number;
  content_hash: string | null;
  dedupe_key: string;
};

export type AttemptRow = {
  id: string;
  token_hash: string;
  start_key: string | null;
  candidate_name: string | null;
  public_alias: string;
  bank_revision: string | null;
  telegram_root_message_id: number | null;
  status: 'active' | 'completed' | 'aborted';
  started_at: number;
  total_deadline_at: number;
  current_question_started_at: number;
  question_deadline_at: number;
  current_question_id: number | null;
  pending_question_ids: string;
  asked_question_ids: string;
  base_question_ids: string;
  base_max_score: number;
  score: number;
  correct_count: number;
  wrong_count: number;
  verdict: Verdict | null;
  completed_at: number | null;
  duration_seconds: number | null;
};

export class QuestionBankConflictError extends Error {
  constructor(questionId: number) {
    super(`Question id ${questionId} already exists with different immutable content.`);
    this.name = 'QuestionBankConflictError';
  }
}

let schemaInitialization: Promise<void> | null = null;
let bankInitialization: Promise<string> | null = null;

export function database() {
  if (!env.DB) throw new Error('SQLite binding DB is unavailable');
  return env.DB;
}

const MANAGED_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-0000-0002',
    sql: [migration0000, migration0001, migration0002].join('\n--> statement-breakpoint\n'),
  },
  { version: 2, name: 'telegram-and-bank-revisions-0003', sql: migration0003 },
  { version: 3, name: 'attempt-timing-0004', sql: migration0004 },
  { version: 4, name: 'question-deduplication-0005', sql: migration0005 },
  { version: 5, name: 'telegram-reporting-0006', sql: migration0006 },
] as const;

function migrationStatements(sql: string) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function adoptLegacyBaselineIfNeeded() {
  const db = database();
  const applied = await db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').first<{ count: number }>();
  if ((applied?.count ?? 0) > 0) return;
  const attemptsTable = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempts'")
    .first<{ name: string }>();
  if (!attemptsTable) return;

  const attemptColumns = await db.prepare('PRAGMA table_info(attempts)').all<{ name: string }>();
  const questionColumns = await db.prepare('PRAGMA table_info(questions)').all<{ name: string }>();
  const attemptNames = new Set(attemptColumns.results.map((column) => column.name));
  const questionNames = new Set(questionColumns.results.map((column) => column.name));
  const supported = ['base_question_ids', 'base_max_score', 'verdict'].every((name) => (
    attemptNames.has(name)
  )) && questionNames.has('topic');
  if (!supported) throw new Error('unsupported_legacy_schema');

  await db
    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
    .bind('adopted-legacy-baseline-0000-0002', Date.now())
    .run();
}

async function applyManagedMigration(version: number, name: string, sql: string) {
  const db = database();
  const statements = migrationStatements(sql).map((statement) => db.prepare(statement));
  statements.push(
    db
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .bind(version, name, Date.now()),
  );
  await db.batch(statements);
}

export function ensureSchema() {
  if (schemaInitialization) return schemaInitialization;
  schemaInitialization = (async () => {
    const db = database();
    await db
      .prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`)
      .run();
    await adoptLegacyBaselineIfNeeded();
    const applied = await db
      .prepare('SELECT version FROM schema_migrations')
      .all<{ version: number }>();
    const versions = new Set(applied.results.map((row) => row.version));
    for (const migration of MANAGED_MIGRATIONS) {
      if (versions.has(migration.version)) continue;
      await applyManagedMigration(migration.version, migration.name, migration.sql);
      versions.add(migration.version);
    }
    await db.prepare('PRAGMA optimize').run();
  })().catch((error) => {
    schemaInitialization = null;
    console.error('schema_initialization_failed');
    throw error;
  });
  return schemaInitialization;
}

export async function currentSchemaVersion() {
  const row = await database()
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .first<{ version: number }>();
  return row?.version ?? 0;
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuestion(question: QuestionDefinition) {
  return {
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    choices: question.choices,
    correctIndex: question.correctIndex,
    weight: TEST_CONFIG.weights[question.difficulty],
  };
}

async function questionContentHash(question: QuestionDefinition) {
  return sha256Hex(JSON.stringify(canonicalQuestion(question)));
}

export async function questionBankRevision(questions = loadQuestionBank()) {
  const canonical = [...questions]
    .sort((left, right) => left.id - right.id)
    .map((question) => ({
      ...canonicalQuestion(question),
      active: question.active,
      dedupeKey: question.dedupeKey,
    }));
  return sha256Hex(JSON.stringify(canonical));
}

function rowMatchesQuestion(row: QuestionRow, question: QuestionDefinition) {
  return (
    row.difficulty === question.difficulty &&
    row.topic === question.topic &&
    row.prompt === question.prompt &&
    row.choices_json === JSON.stringify(question.choices) &&
    row.correct_index === question.correctIndex &&
    row.weight === TEST_CONFIG.weights[question.difficulty]
  );
}

export function ensureQuestionBankReady() {
  if (bankInitialization) return bankInitialization;
  bankInitialization = (async () => {
    await ensureSchema();
    const db = database();
    const questions = loadQuestionBank();
    const revision = await questionBankRevision(questions);

    const stored = await db.prepare('SELECT * FROM questions').all<QuestionRow>();
    const byId = new Map(stored.results.map((question) => [question.id, question]));
    const hashes = new Map<number, string>();
    for (const question of questions) {
      const hash = await questionContentHash(question);
      hashes.set(question.id, hash);
      const existing = byId.get(question.id);
      if (existing && !rowMatchesQuestion(existing, question)) {
        throw new QuestionBankConflictError(question.id);
      }
    }

    const summary = summarizeQuestionBank(questions);
    const statements: D1PreparedStatement[] = [db.prepare('UPDATE questions SET active = 0')];
    for (const question of questions) {
      const hash = hashes.get(question.id)!;
      if (byId.has(question.id)) {
        statements.push(
          db
            .prepare('UPDATE questions SET active = ?, content_hash = ?, dedupe_key = ? WHERE id = ?')
            .bind(question.active ? 1 : 0, hash, question.dedupeKey, question.id),
        );
      } else {
        statements.push(
          db
            .prepare(`INSERT INTO questions (
              id, difficulty, topic, prompt, choices_json, correct_index, weight, active,
              content_hash, dedupe_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              question.id,
              question.difficulty,
              question.topic,
              question.prompt,
              JSON.stringify(question.choices),
              question.correctIndex,
              TEST_CONFIG.weights[question.difficulty],
              question.active ? 1 : 0,
              hash,
              question.dedupeKey,
            ),
        );
      }
    }
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO question_bank_revisions (
          hash, applied_at, total_count, active_count, pools_json
        ) VALUES (?, ?, ?, ?, ?)`)
        .bind(
          revision,
          Date.now(),
          summary.total,
          summary.active,
          JSON.stringify(summary.pools),
        ),
    );
    await db.batch(statements);
    return revision;
  })().catch((error) => {
    bankInitialization = null;
    throw error;
  });
  return bankInitialization;
}

export function publicAlias(name: string) {
  const words = name.trim().replace(/\s+/g, ' ').split(' ');
  const first = words[0].slice(0, 30);
  return words.length > 1
    ? `${first} ${words.at(-1)![0].toLocaleUpperCase('ru-RU')}.`
    : `${first[0].toLocaleUpperCase('ru-RU')}***`;
}

export async function choicePermutation(attemptId: string, questionId: number, length: number) {
  const digest = await sha256(`${attemptId}:${questionId}`);
  let state = new DataView(digest.buffer).getUint32(0) || 1;
  const indexes = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swapIndex = (state >>> 0) % (index + 1);
    [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
  }
  return indexes;
}

export async function findAttempt(id: string) {
  return database().prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first<AttemptRow>();
}

export async function findAttemptByStartKey(startKey: string) {
  return database()
    .prepare('SELECT * FROM attempts WHERE start_key = ?')
    .bind(startKey)
    .first<AttemptRow>();
}

export async function findQuestion(id: number) {
  return database()
    .prepare(`SELECT id, difficulty, topic, prompt, choices_json, correct_index,
      weight, active, content_hash, dedupe_key FROM questions WHERE id = ?`)
    .bind(id)
    .first<QuestionRow>();
}

export async function verifyAttempt(id: string, token: string) {
  const attempt = await findAttempt(id);
  if (!attempt || !token || (await sha256Hex(token)) !== attempt.token_hash) return null;
  return attempt;
}

export async function attemptPayload(attempt: AttemptRow) {
  const serverNowMs = Date.now();
  const answeredCount = attempt.correct_count + attempt.wrong_count;
  const accuracy = calculateAccuracy(attempt.correct_count, attempt.wrong_count);

  if (attempt.status === 'aborted') {
    return {
      attemptId: attempt.id,
      alias: attempt.public_alias,
      status: 'aborted' as const,
      serverNowMs,
    };
  }

  if (attempt.status === 'completed' || attempt.current_question_id === null) {
    const verdict = attempt.verdict ?? calculateVerdict(attempt.score, attempt.base_max_score, accuracy);
    return {
      attemptId: attempt.id,
      alias: attempt.public_alias,
      status: 'completed' as const,
      serverNowMs,
      result: {
        verdict,
        score: attempt.score,
        baseMaxScore: attempt.base_max_score,
        scorePercent: attempt.base_max_score
          ? Math.round((attempt.score / attempt.base_max_score) * 100)
          : 0,
        correctCount: attempt.correct_count,
        wrongCount: attempt.wrong_count,
        answeredCount,
        accuracy,
        durationSeconds: attempt.duration_seconds ?? 0,
        completedAt: new Date(
          attempt.completed_at ?? attempt.started_at + (attempt.duration_seconds ?? 0) * 1_000,
        ).toISOString(),
      },
    };
  }

  const question = await findQuestion(attempt.current_question_id);
  if (!question) throw new Error('Question not found');
  const choices = JSON.parse(question.choices_json) as string[];
  const permutation = await choicePermutation(attempt.id, question.id, choices.length);

  return {
    attemptId: attempt.id,
    alias: attempt.public_alias,
    status: 'active' as const,
    serverNowMs,
    question: {
      id: question.id,
      prompt: question.prompt,
      choices: permutation.map((index) => choices[index]),
      difficulty: question.difficulty,
      weight: question.weight,
      position: JSON.parse(attempt.asked_question_ids).length,
      minimumQuestions: JSON.parse(attempt.base_question_ids).length,
      questionDeadlineAt: attempt.question_deadline_at,
      totalDeadlineAt: attempt.total_deadline_at,
    },
  };
}
