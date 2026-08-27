import { env } from 'cloudflare:workers';
import questionBank from './questions.json';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
export type Verdict = 'PASS' | 'REVIEW' | 'FAIL';

type SeedQuestion = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  active: boolean;
};

export type QuestionRow = {
  id: number;
  difficulty: Difficulty;
  topic: string;
  prompt: string;
  choices_json: string;
  correct_index: number;
  weight: number;
};

export type AttemptRow = {
  id: string;
  token_hash: string;
  public_alias: string;
  status: 'active' | 'completed';
  started_at: number;
  total_deadline_at: number;
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

const weights: Record<Difficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 5,
};

let initialized: Promise<void> | null = null;

export function database() {
  if (!env.DB) throw new Error('SQLite binding DB is unavailable');
  return env.DB;
}

async function addMissingColumns() {
  const db = database();
  const questionColumns = await db.prepare('PRAGMA table_info(questions)').all<{ name: string }>();
  if (!questionColumns.results.some((column) => column.name === 'topic')) {
    await db.prepare("ALTER TABLE questions ADD COLUMN topic TEXT NOT NULL DEFAULT 'general'").run();
  }

  const attemptColumns = await db.prepare('PRAGMA table_info(attempts)').all<{ name: string }>();
  const existing = new Set(attemptColumns.results.map((column) => column.name));
  const migrations = [
    ['base_question_ids', "ALTER TABLE attempts ADD COLUMN base_question_ids TEXT NOT NULL DEFAULT '[]'"],
    ['base_max_score', 'ALTER TABLE attempts ADD COLUMN base_max_score INTEGER NOT NULL DEFAULT 0'],
    ['verdict', 'ALTER TABLE attempts ADD COLUMN verdict TEXT'],
  ] as const;
  for (const [column, sql] of migrations) {
    if (!existing.has(column)) await db.prepare(sql).run();
  }
}

async function syncQuestionBank() {
  const db = database();
  const questions = questionBank as SeedQuestion[];
  await db.batch(
    questions.map((question) =>
      db
        .prepare(
          `INSERT INTO questions (id, difficulty, topic, prompt, choices_json, correct_index, weight, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET difficulty = excluded.difficulty, topic = excluded.topic,
             prompt = excluded.prompt, choices_json = excluded.choices_json,
             correct_index = excluded.correct_index, weight = excluded.weight, active = excluded.active`,
        )
        .bind(
          question.id,
          question.difficulty,
          question.topic,
          question.prompt,
          JSON.stringify(question.choices),
          question.correctIndex,
          weights[question.difficulty],
          question.active ? 1 : 0,
        ),
    ),
  );
}

async function migrateLegacyAttempts() {
  const db = database();
  const legacy = await db
    .prepare(
      `SELECT id, asked_question_ids, pending_question_ids, score, correct_count, wrong_count
       FROM attempts WHERE base_max_score = 0`,
    )
    .all<{
      id: string;
      asked_question_ids: string;
      pending_question_ids: string;
      score: number;
      correct_count: number;
      wrong_count: number;
    }>();

  for (const attempt of legacy.results) {
    const ordered = [
      ...(JSON.parse(attempt.asked_question_ids) as number[]),
      ...(JSON.parse(attempt.pending_question_ids) as number[]),
    ];
    const baseQuestionIds = [...new Set(ordered)].slice(0, 6);
    if (baseQuestionIds.length === 0) continue;
    const placeholders = baseQuestionIds.map(() => '?').join(',');
    const total = await db
      .prepare(`SELECT COALESCE(SUM(weight), 0) AS value FROM questions WHERE id IN (${placeholders})`)
      .bind(...baseQuestionIds)
      .first<{ value: number }>();
    const baseMaxScore = total?.value ?? 0;
    if (baseMaxScore === 0) continue;
    const score = Math.min(attempt.score, baseMaxScore);
    const answeredCount = attempt.correct_count + attempt.wrong_count;
    const accuracy = answeredCount
      ? Math.round((attempt.correct_count / answeredCount) * 100)
      : 0;
    await db
      .prepare(
        `UPDATE attempts SET base_question_ids = ?, base_max_score = ?, score = ?, verdict = ?
         WHERE id = ? AND base_max_score = 0`,
      )
      .bind(
        JSON.stringify(baseQuestionIds),
        baseMaxScore,
        score,
        calculateVerdict(score, baseMaxScore, accuracy),
        attempt.id,
      )
      .run();
  }
}

export function ensureDatabase() {
  if (initialized) return initialized;
  initialized = (async () => {
    const db = database();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard','expert')), topic TEXT NOT NULL DEFAULT 'general', prompt TEXT NOT NULL, choices_json TEXT NOT NULL, correct_index INTEGER NOT NULL, weight INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, public_alias TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', started_at INTEGER NOT NULL, total_deadline_at INTEGER NOT NULL, question_deadline_at INTEGER NOT NULL, current_question_id INTEGER, pending_question_ids TEXT NOT NULL, asked_question_ids TEXT NOT NULL, base_question_ids TEXT NOT NULL DEFAULT '[]', base_max_score INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0, verdict TEXT, completed_at INTEGER, duration_seconds INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL, selected_index INTEGER, is_correct INTEGER NOT NULL, answered_at INTEGER NOT NULL, UNIQUE(attempt_id, question_id))`),
    ]);
    await addMissingColumns();
    await db.batch([
      db.prepare('DROP INDEX IF EXISTS idx_attempts_leaderboard'),
      db.prepare('CREATE INDEX idx_attempts_leaderboard ON attempts(status, score DESC, wrong_count ASC, duration_seconds ASC)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_questions_pool ON questions(active, difficulty)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id)'),
    ]);
    await syncQuestionBank();
    await migrateLegacyAttempts();
  })().catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string) {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function publicAlias(name: string) {
  const words = name.trim().replace(/\s+/g, ' ').split(' ');
  const first = words[0].slice(0, 30);
  return words.length > 1
    ? `${first} ${words.at(-1)![0].toLocaleUpperCase('ru-RU')}.`
    : `${first[0].toLocaleUpperCase('ru-RU')}***`;
}

export function calculateVerdict(score: number, baseMaxScore: number, accuracy: number): Verdict {
  const scorePercent = baseMaxScore > 0 ? (score / baseMaxScore) * 100 : 0;
  if (scorePercent >= 70 && accuracy >= 70) return 'PASS';
  if (scorePercent >= 50 || accuracy >= 60) return 'REVIEW';
  return 'FAIL';
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

export async function findQuestion(id: number) {
  return database()
    .prepare('SELECT id, difficulty, topic, prompt, choices_json, correct_index, weight FROM questions WHERE id = ? AND active = 1')
    .bind(id)
    .first<QuestionRow>();
}

export async function verifyAttempt(id: string, token: string) {
  const attempt = await findAttempt(id);
  if (!attempt || !token || (await sha256Hex(token)) !== attempt.token_hash) return null;
  return attempt;
}

export async function attemptPayload(attempt: AttemptRow, token = '') {
  const answeredCount = attempt.correct_count + attempt.wrong_count;
  const accuracy = answeredCount ? Math.round((attempt.correct_count / answeredCount) * 100) : 0;

  if (attempt.status === 'completed' || attempt.current_question_id === null) {
    const verdict = attempt.verdict ?? calculateVerdict(attempt.score, attempt.base_max_score, accuracy);
    return {
      attemptId: attempt.id,
      token,
      alias: attempt.public_alias,
      status: 'completed' as const,
      result: {
        verdict,
        score: attempt.score,
        baseMaxScore: attempt.base_max_score,
        scorePercent: attempt.base_max_score ? Math.round((attempt.score / attempt.base_max_score) * 100) : 0,
        correctCount: attempt.correct_count,
        wrongCount: attempt.wrong_count,
        answeredCount,
        accuracy,
        durationSeconds: attempt.duration_seconds ?? 0,
      },
    };
  }

  const question = await findQuestion(attempt.current_question_id);
  if (!question) throw new Error('Question not found');
  const choices = JSON.parse(question.choices_json) as string[];
  const permutation = await choicePermutation(attempt.id, question.id, choices.length);

  return {
    attemptId: attempt.id,
    token,
    alias: attempt.public_alias,
    status: 'active' as const,
    question: {
      id: question.id,
      prompt: question.prompt,
      choices: permutation.map((index) => choices[index]),
      difficulty: question.difficulty,
      topic: question.topic,
      weight: question.weight,
      position: JSON.parse(attempt.asked_question_ids).length,
      minimumQuestions: JSON.parse(attempt.base_question_ids).length,
      questionDeadlineAt: attempt.question_deadline_at,
      totalDeadlineAt: attempt.total_deadline_at,
    },
  };
}
