import { calculateAccuracy, calculateScore, calculateVerdict } from '@/lib/scoring.ts';
import { answerTelegramMessage, completedTelegramMessage } from '@/lib/telegram-messages.ts';
import { TEST_CONFIG } from '@/lib/test-config.ts';
import { shouldQueueTelegramNotifications } from './telegram-outbox';
import {
  choicePermutation,
  database,
  findAttempt,
  findQuestion,
  type AttemptRow,
  type Difficulty,
  type QuestionRow,
} from './runtime';

export class AttemptQuestionConflictError extends Error {}
export class InvalidChoiceError extends Error {}
export class PrematureTimeoutError extends Error {}

async function chooseReplacementQuestion(
  difficulty: Difficulty,
  asked: number[],
  pending: number[],
) {
  const excluded = [...asked, ...pending];
  const placeholders = excluded.map(() => '?').join(',');
  const sql = `SELECT id FROM questions WHERE active = 1 AND difficulty = ? ${
    excluded.length ? `AND id NOT IN (${placeholders})` : ''
  } ORDER BY RANDOM() LIMIT 1`;
  return database()
    .prepare(sql)
    .bind(difficulty, ...excluded)
    .first<{ id: number }>();
}

async function alreadyProcessed(attemptId: string, questionId: number) {
  return database()
    .prepare('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?')
    .bind(attemptId, questionId)
    .first<{ id: number }>();
}

async function loadQuestions(ids: number[]) {
  const rows: QuestionRow[] = [];
  for (const id of ids) {
    const question = await findQuestion(id);
    if (!question) throw new AttemptQuestionConflictError('Вопрос недоступен.');
    rows.push(question);
  }
  return rows;
}

function questionElapsedSeconds(attempt: AttemptRow, now: number) {
  const startedAt = attempt.current_question_started_at || Math.max(
    attempt.started_at,
    attempt.question_deadline_at - TEST_CONFIG.questionTimeSeconds * 1_000,
  );
  const deadline = Math.min(attempt.question_deadline_at, attempt.total_deadline_at);
  const allocated = Math.max(0, Math.ceil((deadline - startedAt) / 1_000));
  return Math.min(allocated, Math.max(0, Math.ceil((now - startedAt) / 1_000)));
}

export async function processAttemptAnswer(
  attempt: AttemptRow,
  questionId: number,
  selectedChoice: number | null,
  now = Date.now(),
) {
  if (attempt.status === 'completed' || attempt.current_question_id === null) return attempt;

  if (attempt.current_question_id !== questionId) {
    if (await alreadyProcessed(attempt.id, questionId)) return (await findAttempt(attempt.id))!;
    throw new AttemptQuestionConflictError('Вопрос не относится к текущей попытке.');
  }

  const question = await findQuestion(questionId);
  if (!question) throw new AttemptQuestionConflictError('Вопрос недоступен.');
  const choices = JSON.parse(question.choices_json) as string[];
  if (
    selectedChoice !== null &&
    (!Number.isInteger(selectedChoice) || selectedChoice < 0 || selectedChoice >= choices.length)
  ) {
    throw new InvalidChoiceError('Некорректный вариант ответа.');
  }

  const totalExpired = now >= attempt.total_deadline_at;
  const questionExpired = now >= attempt.question_deadline_at;
  if (selectedChoice === null && !questionExpired && !totalExpired) {
    throw new PrematureTimeoutError('Время вопроса ещё не истекло.');
  }

  const timedOut = questionExpired || totalExpired;
  const permutation = await choicePermutation(attempt.id, question.id, choices.length);
  const originalIndex = selectedChoice === null ? null : permutation[selectedChoice];
  const correct = !timedOut && originalIndex === question.correct_index;
  const pending = JSON.parse(attempt.pending_question_ids) as number[];
  const asked = JSON.parse(attempt.asked_question_ids) as number[];
  const currentPosition = Math.max(1, asked.indexOf(question.id) + 1);

  if (!correct && !totalExpired) {
    const replacement = await chooseReplacementQuestion(question.difficulty, asked, pending);
    if (replacement) pending.push(replacement.id);
  }

  const skippedQuestions = totalExpired ? await loadQuestions([...pending]) : [];
  let nextId: number | null = null;
  if (totalExpired) {
    for (const skipped of skippedQuestions) {
      if (!asked.includes(skipped.id)) asked.push(skipped.id);
    }
    pending.length = 0;
  } else {
    nextId = pending.shift() ?? null;
    if (nextId) asked.push(nextId);
  }

  const completed = nextId === null;
  const score = calculateScore(attempt.score, question.weight, attempt.base_max_score, correct);
  const correctCount = attempt.correct_count + (correct ? 1 : 0);
  const wrongCount = attempt.wrong_count + (correct ? 0 : 1) + skippedQuestions.length;
  const answeredCount = correctCount + wrongCount;
  const accuracy = calculateAccuracy(correctCount, wrongCount);
  const verdict = completed ? calculateVerdict(score, attempt.base_max_score, accuracy) : null;
  const completedAt = completed ? now : null;
  const durationSeconds = completed
    ? Math.min(TEST_CONFIG.totalTimeSeconds, Math.ceil((now - attempt.started_at) / 1_000))
    : null;

  const db = database();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(attempt.id, question.id, selectedChoice, correct ? 1 : 0, now),
  ];

  for (const skipped of skippedQuestions) {
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at
        ) VALUES (?, ?, NULL, 0, ?)`)
        .bind(attempt.id, skipped.id, now),
    );
  }

  const attemptUpdateIndex = statements.length;
  statements.push(
    db
      .prepare(
        `UPDATE attempts SET status = ?, current_question_id = ?, pending_question_ids = ?,
          asked_question_ids = ?, score = ?, correct_count = ?, wrong_count = ?,
          current_question_started_at = ?, question_deadline_at = ?, verdict = ?,
          completed_at = ?, duration_seconds = ?
         WHERE id = ? AND current_question_id = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?)`,
      )
      .bind(
        completed ? 'completed' : 'active',
        nextId,
        JSON.stringify(pending),
        JSON.stringify(asked),
        score,
        correctCount,
        wrongCount,
        now,
        nextId
          ? Math.min(now + TEST_CONFIG.questionTimeSeconds * 1_000, attempt.total_deadline_at)
          : now,
        verdict,
        completedAt,
        durationSeconds,
        attempt.id,
        question.id,
        attempt.id,
        question.id,
      ),
  );

  if (shouldQueueTelegramNotifications()) {
    const answerEventId = `answer-${attempt.id}-${question.id}`;
    const answerMessage = answerTelegramMessage({
      eventId: answerEventId,
      attemptId: attempt.id,
      candidateName: attempt.candidate_name ?? attempt.public_alias,
      position: currentPosition,
      difficulty: question.difficulty,
      weight: question.weight,
      prompt: question.prompt,
      selectedAnswer: originalIndex === null ? null : choices[originalIndex],
      correctAnswer: choices[question.correct_index],
      correct,
      timedOut,
      questionElapsedSeconds: questionElapsedSeconds(attempt, now),
      totalRemainingSeconds: Math.max(0, Math.ceil((attempt.total_deadline_at - now) / 1_000)),
    });
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, status,
          attempt_count, next_attempt_at, created_at
        ) VALUES (?, ?, ?, 'answer', ?, 'pending', 0, ?, ?)`)
        .bind(answerEventId, attempt.id, question.id, answerMessage, now, now),
    );

    skippedQuestions.forEach((skipped, index) => {
      const skippedChoices = JSON.parse(skipped.choices_json) as string[];
      const eventId = `answer-${attempt.id}-${skipped.id}`;
      const eventTime = now + index + 1;
      const message = answerTelegramMessage({
        eventId,
        attemptId: attempt.id,
        candidateName: attempt.candidate_name ?? attempt.public_alias,
        position: asked.indexOf(skipped.id) + 1,
        difficulty: skipped.difficulty,
        weight: skipped.weight,
        prompt: skipped.prompt,
        selectedAnswer: null,
        correctAnswer: skippedChoices[skipped.correct_index],
        correct: false,
        timedOut: true,
        questionElapsedSeconds: 0,
        totalRemainingSeconds: 0,
      });
      statements.push(
        db
          .prepare(`INSERT OR IGNORE INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, status,
            attempt_count, next_attempt_at, created_at
          ) VALUES (?, ?, ?, 'answer', ?, 'pending', 0, ?, ?)`)
          .bind(eventId, attempt.id, skipped.id, message, now, eventTime),
      );
    });

    if (completed && verdict && completedAt !== null && durationSeconds !== null) {
      const completedEventId = `completed-${attempt.id}`;
      const summaryMessage = completedTelegramMessage({
        eventId: completedEventId,
        attemptId: attempt.id,
        candidateName: attempt.candidate_name ?? attempt.public_alias,
        verdict,
        score,
        baseMaxScore: attempt.base_max_score,
        scorePercent: attempt.base_max_score
          ? Math.round((score / attempt.base_max_score) * 100)
          : 0,
        correctCount,
        wrongCount,
        answeredCount,
        accuracy,
        durationSeconds,
        bankRevision: attempt.bank_revision,
        completedAt,
      });
      const completedEventTime = now + skippedQuestions.length + 1;
      statements.push(
        db
          .prepare(`INSERT OR IGNORE INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, status,
            attempt_count, next_attempt_at, created_at
          ) VALUES (?, ?, NULL, 'completed', ?, 'pending', 0, ?, ?)`)
          .bind(completedEventId, attempt.id, summaryMessage, now, completedEventTime),
      );
    }
  }

  const results = await db.batch(statements);
  if ((results[attemptUpdateIndex].meta.changes ?? 0) === 0) return (await findAttempt(attempt.id))!;
  return (await findAttempt(attempt.id))!;
}

export async function settleExpiredAttempt(attempt: AttemptRow, now = Date.now()) {
  if (
    attempt.status !== 'active' ||
    attempt.current_question_id === null ||
    (now < attempt.question_deadline_at && now < attempt.total_deadline_at)
  ) {
    return attempt;
  }
  return processAttemptAnswer(attempt, attempt.current_question_id, null, now);
}
