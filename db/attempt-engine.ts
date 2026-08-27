import { calculateAccuracy, calculateScore, calculateVerdict } from '@/lib/scoring.ts';
import {
  answerTelegramMessage,
  completedTelegramMessage,
  progressTelegramMessage,
} from '@/lib/telegram-messages.ts';
import { selectRemedialQuestion } from '@/lib/question-selection.ts';
import {
  summarizeAttemptStatistics,
  type AttemptStatisticBucket,
} from '@/lib/attempt-statistics.ts';
import { TEST_CONFIG } from '@/lib/test-config.ts';
import { telegramNotificationPolicy } from './telegram-outbox';
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

function dedupeKey(question: { id: number; dedupe_key: string }) {
  return question.dedupe_key || `question:${question.id}`;
}

async function chooseReplacementQuestion(
  difficulty: Difficulty,
  topic: string,
  asked: number[],
  pending: number[],
) {
  const excluded = [...asked, ...pending];
  const excludedIds = new Set(excluded);
  const excludedQuestions = await loadQuestions(excluded);
  const excludedDedupeKeys = new Set(excludedQuestions.map(dedupeKey));
  const candidates = await database()
    .prepare(`SELECT id, difficulty, topic, dedupe_key FROM questions
      WHERE active = 1 AND difficulty = ? ORDER BY RANDOM()`)
    .bind(difficulty)
    .all<{ id: number; difficulty: Difficulty; topic: string; dedupe_key: string }>();
  return selectRemedialQuestion(
    candidates.results,
    difficulty,
    topic,
    excludedIds,
    excludedDedupeKeys,
  );
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

async function existingTopicErrors(attemptId: string) {
  const rows = await database()
    .prepare(`SELECT questions.topic, COUNT(*) AS count
      FROM answers JOIN questions ON questions.id = answers.question_id
      WHERE answers.attempt_id = ? AND answers.is_correct = 0
      GROUP BY questions.topic`)
    .bind(attemptId)
    .all<{ topic: string; count: number }>();
  return new Map(rows.results.map((row) => [row.topic, row.count]));
}

async function existingAnswerStatistics(attemptId: string) {
  const rows = await database()
    .prepare(`SELECT questions.difficulty, questions.topic,
      COUNT(*) AS answered_count,
      COALESCE(SUM(answers.is_correct), 0) AS correct_count,
      COALESCE(SUM(answers.timed_out), 0) AS timeout_count,
      COALESCE(SUM(answers.elapsed_seconds), 0) AS elapsed_seconds,
      COALESCE(SUM(CASE
        WHEN answers.selected_index IS NOT NULL OR answers.elapsed_seconds > 0 THEN 1
        ELSE 0
      END), 0) AS measured_count
      FROM answers JOIN questions ON questions.id = answers.question_id
      WHERE answers.attempt_id = ?
      GROUP BY questions.difficulty, questions.topic`)
    .bind(attemptId)
    .all<{
      difficulty: Difficulty;
      topic: string;
      answered_count: number;
      correct_count: number;
      timeout_count: number;
      elapsed_seconds: number;
      measured_count: number;
    }>();
  return rows.results.map((row): AttemptStatisticBucket => ({
    difficulty: row.difficulty,
    topic: row.topic,
    answeredCount: row.answered_count,
    correctCount: row.correct_count,
    timeoutCount: row.timeout_count,
    elapsedSeconds: row.elapsed_seconds,
    measuredCount: row.measured_count,
  }));
}

function addTopicError(errors: Map<string, number>, topic: string) {
  errors.set(topic, (errors.get(topic) ?? 0) + 1);
}

export async function processAttemptAnswer(
  attempt: AttemptRow,
  questionId: number,
  selectedChoice: number | null,
  now = Date.now(),
) {
  if (attempt.status !== 'active' || attempt.current_question_id === null) return attempt;

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
  const elapsedSeconds = questionElapsedSeconds(attempt, now);
  const permutation = await choicePermutation(attempt.id, question.id, choices.length);
  const originalIndex = selectedChoice === null ? null : permutation[selectedChoice];
  const correct = !timedOut && originalIndex === question.correct_index;
  const pending = JSON.parse(attempt.pending_question_ids) as number[];
  const asked = JSON.parse(attempt.asked_question_ids) as number[];
  const currentPosition = Math.max(1, asked.indexOf(question.id) + 1);

  if (!correct && !totalExpired) {
    const replacement = await chooseReplacementQuestion(
      question.difficulty,
      question.topic,
      asked,
      pending,
    );
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
  const totalQuestions = answeredCount + (nextId === null ? 0 : pending.length + 1);
  const totalRemainingSeconds = Math.max(0, Math.ceil((attempt.total_deadline_at - now) / 1_000));
  const candidateName = attempt.candidate_name ?? attempt.public_alias;
  const topicErrors = completed ? await existingTopicErrors(attempt.id) : new Map<string, number>();
  if (completed && !correct) addTopicError(topicErrors, question.topic);
  if (completed) {
    for (const skipped of skippedQuestions) addTopicError(topicErrors, skipped.topic);
  }
  const completionStats = completed
    ? summarizeAttemptStatistics([
        ...await existingAnswerStatistics(attempt.id),
        {
          difficulty: question.difficulty,
          topic: question.topic,
          answeredCount: 1,
          correctCount: correct ? 1 : 0,
          timeoutCount: timedOut ? 1 : 0,
          elapsedSeconds,
          measuredCount: selectedChoice !== null || elapsedSeconds > 0 ? 1 : 0,
        },
        ...skippedQuestions.map((skipped): AttemptStatisticBucket => ({
          difficulty: skipped.difficulty,
          topic: skipped.topic,
          answeredCount: 1,
          correctCount: 0,
          timeoutCount: 1,
          elapsedSeconds: 0,
          measuredCount: 0,
        })),
      ])
    : null;

  const db = database();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at,
          elapsed_seconds, timed_out
        ) SELECT ?, ?, ?, ?, ?, ?, ? FROM attempts
          WHERE id = ? AND status = 'active' AND current_question_id = ?`,
      )
      .bind(
        attempt.id,
        question.id,
        selectedChoice,
        correct ? 1 : 0,
        now,
        elapsedSeconds,
        timedOut ? 1 : 0,
        attempt.id,
        question.id,
      ),
  ];

  for (const skipped of skippedQuestions) {
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at,
          elapsed_seconds, timed_out
        ) SELECT ?, ?, NULL, 0, ?, 0, 1 FROM attempts
          WHERE id = ? AND status = 'active' AND current_question_id = ?`)
        .bind(attempt.id, skipped.id, now, attempt.id, question.id),
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

  const notificationPolicy = telegramNotificationPolicy();
  if (notificationPolicy.enabled) {
    let eventTime = now;
    if (notificationPolicy.createProgressCard) {
      const progressState = completed ? 'completed' : 'active';
      const progressMessage = progressTelegramMessage({
        attemptId: attempt.id,
        candidateName,
        state: progressState,
        answeredCount,
        totalQuestions,
        correctCount,
        wrongCount,
        score,
        baseMaxScore: attempt.base_max_score,
        totalRemainingSeconds: completed ? 0 : totalRemainingSeconds,
      });
      const startedEventId = `started-${attempt.id}`;
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, id, NULL, 'started', ?, 'send', 'HTML', 1, 'pending', 0, ?, ?
          FROM attempts WHERE id = ? AND EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            startedEventId,
            progressMessage,
            Math.max(attempt.started_at, now - 1),
            Math.max(attempt.started_at, now - 1),
            attempt.id,
            attempt.id,
            question.id,
          ),
      );

      const progressEventId = `progress-${attempt.id}-${question.id}`;
      statements.push(
        db.prepare(`UPDATE telegram_outbox SET status = 'dead', payload_text = '',
          last_error_code = 'superseded'
          WHERE attempt_id = ? AND event_type = 'progress' AND status = 'pending' AND id != ?
            AND EXISTS (
              SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
            )`)
          .bind(attempt.id, progressEventId, attempt.id, question.id),
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, ?, 'progress', ?, 'edit_root', 'HTML', 1, 'pending', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            progressEventId,
            attempt.id,
            question.id,
            progressMessage,
            now,
            eventTime,
            attempt.id,
            question.id,
          ),
      );
      eventTime += 1;
    }

    if (notificationPolicy.sendAnswer(correct)) {
      const answerEventId = `answer-${attempt.id}-${question.id}`;
      const answerMessage = answerTelegramMessage({
        attemptId: attempt.id,
        position: currentPosition,
        totalQuestions,
        difficulty: question.difficulty,
        weight: question.weight,
        prompt: question.prompt,
        contextType: question.context_type ?? undefined,
        context: question.context_text ?? undefined,
        selectedAnswer: originalIndex === null ? null : choices[originalIndex],
        correctAnswer: choices[question.correct_index],
        correct,
        timedOut,
        questionElapsedSeconds: elapsedSeconds,
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, ?, 'answer', ?, 'reply_root', 'HTML', 1, 'pending', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            answerEventId,
            attempt.id,
            question.id,
            answerMessage,
            now,
            eventTime,
            attempt.id,
            question.id,
          ),
      );
      eventTime += 1;
    }

    for (const skipped of notificationPolicy.sendAnswer(false) ? skippedQuestions : []) {
      const skippedChoices = JSON.parse(skipped.choices_json) as string[];
      const eventId = `answer-${attempt.id}-${skipped.id}`;
      const message = answerTelegramMessage({
        attemptId: attempt.id,
        position: asked.indexOf(skipped.id) + 1,
        totalQuestions,
        difficulty: skipped.difficulty,
        weight: skipped.weight,
        prompt: skipped.prompt,
        contextType: skipped.context_type ?? undefined,
        context: skipped.context_text ?? undefined,
        selectedAnswer: null,
        correctAnswer: skippedChoices[skipped.correct_index],
        correct: false,
        timedOut: true,
        questionElapsedSeconds: 0,
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, ?, 'answer', ?, 'reply_root', 'HTML', 1, 'pending', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            eventId,
            attempt.id,
            skipped.id,
            message,
            now,
            eventTime,
            attempt.id,
            skipped.id,
          ),
      );
      eventTime += 1;
    }

    if (
      completed && verdict && completedAt !== null && durationSeconds !== null && completionStats
    ) {
      const completedEventId = `completed-${attempt.id}`;
      const summaryMessage = completedTelegramMessage({
        attemptId: attempt.id,
        candidateName,
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
        timeoutCount: completionStats.timeoutCount,
        durationSeconds,
        averageAnswerSeconds: completionStats.averageAnswerSeconds,
        completedAt,
        difficultyStats: completionStats.difficultyStats,
        topicErrors: [...topicErrors].map(([topic, count]) => ({ topic, count })),
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, NULL, 'completed', ?, 'send', 'HTML', 0, 'pending', 0, ?, ?
          FROM attempts WHERE id = ? AND status = 'completed'
          ON CONFLICT(id) DO NOTHING`)
          .bind(completedEventId, attempt.id, summaryMessage, now, eventTime, attempt.id),
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
