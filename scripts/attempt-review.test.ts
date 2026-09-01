import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { loadAttemptQuestionReview } from '../db/attempt-review.ts';

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});

try {
  const db = await miniflare.getD1Database('DB');
  await db.batch([
    db.prepare(`CREATE TABLE questions (
      id INTEGER PRIMARY KEY, topic TEXT NOT NULL, difficulty TEXT NOT NULL,
      prompt TEXT NOT NULL, context_type TEXT, context_text TEXT,
      choices_json TEXT NOT NULL, correct_index INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE attempt_questions (
      attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL, question_kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL, score_value INTEGER NOT NULL, presented_at INTEGER
    )`),
    db.prepare(`CREATE TABLE answers (
      id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL,
      canonical_selected_index INTEGER, is_correct INTEGER NOT NULL, timed_out INTEGER NOT NULL,
      elapsed_seconds INTEGER, awarded_score INTEGER
    )`),
  ]);
  const insertQuestion = db.prepare(`INSERT INTO questions (
    id, topic, difficulty, prompt, choices_json, correct_index
  ) VALUES (?, 'Сети', 'easy', ?, '["Неверно","Верно"]', 1)`);
  const insertLedger = db.prepare(`INSERT INTO attempt_questions (
    attempt_id, question_id, question_kind, ordinal, score_value, presented_at
  ) VALUES ('attempt', ?, 'base', ?, 2, ?)`);
  await db.batch([
    insertQuestion.bind(1, 'Правильный вопрос'),
    insertQuestion.bind(2, 'Вопрос с ошибкой'),
    insertQuestion.bind(3, 'Вопрос с тайм-аутом'),
    insertQuestion.bind(4, 'Непоказанный вопрос'),
    insertLedger.bind(1, 1, 100),
    insertLedger.bind(2, 2, 200),
    insertLedger.bind(3, 3, 300),
    insertLedger.bind(4, 4, null),
    db.prepare(`INSERT INTO answers VALUES
      (1, 'attempt', 1, 1, 1, 0, 5, 2),
      (2, 'attempt', 2, 0, 0, 0, 8, 0),
      (3, 'attempt', 3, NULL, 0, 1, 30, 0),
      (4, 'attempt', 4, NULL, 0, 1, 0, 0)`),
  ]);

  const review = await loadAttemptQuestionReview(db, 'attempt');
  assert.deepEqual(review.map((item) => item.status), [
    'correct',
    'incorrect',
    'timeout',
    'unshown',
  ]);
  assert.equal(review[1].selectedAnswer, 'Неверно');
  assert.equal(review[1].correctAnswer, 'Верно');
  assert.match(review[1].explanation, /Верный вариант/u);
  assert.match(review[2].explanation, /Время ответа истекло/u);
  assert.deepEqual(
    review
      .filter((item) => item.status === 'incorrect' || item.status === 'timeout')
      .map((item) => item.questionId),
    [2, 3],
    'candidate review must not reveal a correct or unshown answer',
  );

  console.log('attempt review tests: PASS');
} finally {
  await miniflare.dispose();
}
