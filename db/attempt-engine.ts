import {
  calculateAccuracy,
  calculateScore,
  calculateVerdict,
  questionScoreValue,
} from '@/lib/scoring.ts';
import {
  answerTelegramMessage,
  completedTelegramMessage,
  progressTelegramMessage,
} from '@/lib/telegram-messages.ts';
import { selectRemedialQuestion } from '@/lib/question-selection.ts';
import {
  buildCandidateInsights,
  type CandidateInsightFact,
} from '@/lib/candidate-insights.ts';
import {
  summarizeAttemptStatistics,
  type AttemptStatisticBucket,
} from '@/lib/attempt-statistics.ts';
import { TEST_CONFIG } from '@/lib/test-config.ts';
import {
  classifyQuestion,
  countAdditionalQuestions,
  isUnsupportedActiveAttempt,
  shouldCreateAdditionalQuestion,
} from '@/lib/attempt-policy.ts';
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
  bankRevision: string | null,
) {
  const excluded = [...asked, ...pending];
  const excludedIds = new Set(excluded);
  const excludedQuestions = await loadQuestions(excluded);
  const excludedDedupeKeys = new Set(excludedQuestions.map(dedupeKey));
  const candidates = await database()
    .prepare(bankRevision
      ? `SELECT questions.id, questions.difficulty, questions.topic,
          questions.dedupe_key, questions.weight
        FROM questions
        JOIN question_bank_revision_items membership
          ON membership.question_id = questions.id
        WHERE membership.revision_hash = ? AND membership.active = 1
          AND questions.difficulty = ?
        ORDER BY RANDOM()`
      : `SELECT id, difficulty, topic, dedupe_key, weight FROM questions
        WHERE active = 1 AND difficulty = ? ORDER BY RANDOM()`)
    .bind(...(bankRevision ? [bankRevision, difficulty] : [difficulty]))
    .all<{
      id: number;
      difficulty: Difficulty;
      topic: string;
      dedupe_key: string;
      weight: number;
    }>();
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

async function existingAnswerStatistics(
  attemptId: string,
  baseQuestionIds: ReadonlySet<number>,
  analyticsFactsVersion: number,
) {
  const rows = await database()
    .prepare(`SELECT answers.question_id, questions.difficulty, questions.topic,
      answers.is_correct, answers.timed_out, answers.elapsed_seconds, answers.selected_index,
      answers.fact_version, answers.answer_origin
      FROM answers JOIN questions ON questions.id = answers.question_id
      WHERE answers.attempt_id = ?`)
    .bind(attemptId)
    .all<{
      question_id: number;
      difficulty: Difficulty;
      topic: string;
      is_correct: number;
      timed_out: number;
      elapsed_seconds: number;
      selected_index: number | null;
      fact_version: number;
      answer_origin: string;
    }>();
  return rows.results.map((row): AttemptStatisticBucket => ({
    questionKind: classifyQuestion(row.question_id, baseQuestionIds),
    difficulty: row.difficulty,
    topic: row.topic,
    answeredCount: 1,
    correctCount: row.is_correct,
    timeoutCount: row.timed_out,
    elapsedSeconds: row.elapsed_seconds,
    measuredCount: analyticsFactsVersion > 0
      && row.fact_version === analyticsFactsVersion
      ? row.answer_origin === 'submitted' ? 1 : 0
      : row.selected_index !== null || row.elapsed_seconds > 0 ? 1 : 0,
  }));
}

type CompletionOutcome = {
  correct: boolean;
  timedOut: boolean;
  answerOrigin: string;
  awardedScore: number;
  elapsedSeconds: number;
};

async function completionInsightFacts(
  attemptId: string,
  outcomes: ReadonlyMap<number, CompletionOutcome>,
) {
  const rows = await database().prepare(`SELECT
      attempt_questions.question_id,
      attempt_questions.question_kind,
      attempt_questions.score_value,
      attempt_questions.presented_at,
      questions.topic,
      questions.dedupe_key,
      answers.id AS answer_id,
      answers.is_correct,
      answers.timed_out,
      answers.answer_origin,
      answers.awarded_score,
      answers.elapsed_seconds
    FROM attempt_questions
    JOIN questions ON questions.id = attempt_questions.question_id
    LEFT JOIN answers
      ON answers.attempt_id = attempt_questions.attempt_id
      AND answers.question_id = attempt_questions.question_id
    WHERE attempt_questions.attempt_id = ?
    ORDER BY attempt_questions.ordinal`)
    .bind(attemptId)
    .all<{
      question_id: number;
      question_kind: 'base' | 'additional';
      score_value: number;
      presented_at: number | null;
      topic: string;
      dedupe_key: string;
      answer_id: number | null;
      is_correct: number | null;
      timed_out: number | null;
      answer_origin: string | null;
      awarded_score: number | null;
      elapsed_seconds: number | null;
    }>();
  return rows.results.map((row): CandidateInsightFact => {
    const outcome = outcomes.get(row.question_id);
    const resolved = outcome !== undefined || row.answer_id !== null;
    return {
      questionId: row.question_id,
      questionKind: row.question_kind,
      topic: row.topic,
      dedupeKey: row.dedupe_key,
      scoreValue: row.score_value,
      assigned: true,
      presented: row.presented_at !== null,
      resolved,
      correct: outcome?.correct ?? row.is_correct === 1,
      timedOut: outcome?.timedOut ?? row.timed_out === 1,
      answerOrigin: outcome?.answerOrigin ?? row.answer_origin,
      awardedScore: outcome?.awardedScore ?? row.awarded_score ?? 0,
      elapsedSeconds: outcome?.elapsedSeconds ?? row.elapsed_seconds,
    };
  });
}

export async function processAttemptAnswer(
  attempt: AttemptRow,
  questionId: number,
  selectedChoice: number | null,
  now = Date.now(),
) {
  if (attempt.status !== 'active' || attempt.current_question_id === null) return attempt;
  if (isUnsupportedActiveAttempt(attempt)) throw new AttemptQuestionConflictError(
    'Версия активной попытки больше не поддерживается.',
  );

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
  const baseQuestionIds = new Set(JSON.parse(attempt.base_question_ids) as number[]);
  const ledgerQuestion = await database().prepare(`SELECT question_kind, ordinal, score_value
    FROM attempt_questions WHERE attempt_id = ? AND question_id = ?`)
    .bind(attempt.id, question.id)
    .first<{ question_kind: 'base' | 'additional'; ordinal: number; score_value: number }>();
  const questionKind = ledgerQuestion?.question_kind
    ?? classifyQuestion(question.id, baseQuestionIds);
  const currentPosition = Math.max(1, asked.indexOf(question.id) + 1);
  const additionalNumber = questionKind === 'additional'
    ? asked.filter((askedQuestionId) => !baseQuestionIds.has(askedQuestionId)).length
    : undefined;

  let scheduledAdditional: {
    questionId: number;
    sourceQuestionId: number;
    ordinal: number;
    scoreValue: number;
  } | null = null;
  if (shouldCreateAdditionalQuestion({
    questionKind,
    correct,
    totalExpired,
    additionalQuestionCount: countAdditionalQuestions(baseQuestionIds, asked, pending),
  })) {
    const replacement = await chooseReplacementQuestion(
      question.difficulty,
      question.topic,
      asked,
      pending,
      attempt.bank_revision,
    );
    if (replacement) {
      pending.push(replacement.id);
      scheduledAdditional = {
        questionId: replacement.id,
        sourceQuestionId: question.id,
        ordinal: baseQuestionIds.size
          + countAdditionalQuestions(baseQuestionIds, asked, pending),
        scoreValue: questionScoreValue(replacement.weight, 'additional'),
      };
    }
  }

  const skippedQuestions = totalExpired
    ? await loadQuestions(pending.filter((questionId) => baseQuestionIds.has(questionId)))
    : [];
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
  const scoreValue = ledgerQuestion?.score_value
    ?? questionScoreValue(question.weight, questionKind);
  const score = calculateScore(attempt.score, scoreValue, attempt.base_max_score, correct);
  const awardedScore = score - attempt.score;
  const correctCount = attempt.correct_count + (correct ? 1 : 0);
  const wrongCount = attempt.wrong_count + (correct ? 0 : 1) + skippedQuestions.length;
  const answeredCount = correctCount + wrongCount;
  const accuracy = calculateAccuracy(correctCount, wrongCount);
  const verdict = completed ? calculateVerdict(score, accuracy) : null;
  const completedAt = completed ? now : null;
  const durationSeconds = completed
    ? Math.min(TEST_CONFIG.totalTimeSeconds, Math.ceil((now - attempt.started_at) / 1_000))
    : null;
  const totalQuestions = answeredCount + (nextId === null ? 0 : pending.length + 1);
  const totalRemainingSeconds = Math.max(0, Math.ceil((attempt.total_deadline_at - now) / 1_000));
  const candidateName = attempt.candidate_name ?? attempt.public_alias;
  const completionStats = completed
    ? summarizeAttemptStatistics([
        ...await existingAnswerStatistics(
          attempt.id,
          baseQuestionIds,
          attempt.analytics_facts_version,
        ),
        {
          questionKind,
          difficulty: question.difficulty,
          topic: question.topic,
          answeredCount: 1,
          correctCount: correct ? 1 : 0,
          timeoutCount: timedOut ? 1 : 0,
          elapsedSeconds,
          measuredCount: !timedOut && selectedChoice !== null ? 1 : 0,
        },
        ...skippedQuestions.map((skipped): AttemptStatisticBucket => ({
          questionKind: 'base',
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
  const interviewerProfile = completed
    ? buildCandidateInsights(await completionInsightFacts(
        attempt.id,
        new Map<number, CompletionOutcome>([
          [question.id, {
            correct,
            timedOut,
            answerOrigin: totalExpired
              ? 'total_timeout_presented'
              : questionExpired
                ? 'question_timeout'
                : 'submitted',
            awardedScore,
            elapsedSeconds,
          }],
          ...skippedQuestions.map((skipped): [number, CompletionOutcome] => [skipped.id, {
            correct: false,
            timedOut: true,
            answerOrigin: 'total_timeout_unshown',
            awardedScore: 0,
            elapsedSeconds: 0,
          }]),
        ]),
      )).telegramProfile
    : null;

  const db = database();
  const claimMarker = -(crypto.getRandomValues(new Uint32Array(1))[0] + 1);
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE attempts SET current_question_started_at = ?
      WHERE id = ? AND status = 'active' AND current_question_id = ?
        AND current_question_started_at = ?`)
      .bind(
        claimMarker,
        attempt.id,
        question.id,
        attempt.current_question_started_at,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at,
          elapsed_seconds, timed_out, fact_version, answer_origin,
          canonical_selected_index, awarded_score
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM attempts
          WHERE id = ? AND status = 'active' AND current_question_id = ?
            AND current_question_started_at = ?`,
      )
      .bind(
        attempt.id,
        question.id,
        selectedChoice,
        correct ? 1 : 0,
        now,
        elapsedSeconds,
        timedOut ? 1 : 0,
        attempt.analytics_facts_version,
        totalExpired
          ? 'total_timeout_presented'
          : questionExpired
            ? 'question_timeout'
            : 'submitted',
        originalIndex,
        awardedScore,
        attempt.id,
        question.id,
        claimMarker,
      ),
  ];

  if (scheduledAdditional) {
    statements.push(
      db.prepare(`INSERT INTO attempt_questions (
        attempt_id, question_id, question_kind, ordinal, source_question_id,
        score_value, assigned_at, presented_at
      ) SELECT id, ?, 'additional', ?, ?, ?, ?, NULL
        FROM attempts
        WHERE id = ? AND status = 'active' AND current_question_id = ?
          AND current_question_started_at = ?
        AND EXISTS (
          SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
        )
        ON CONFLICT(attempt_id, question_id) DO NOTHING`)
        .bind(
          scheduledAdditional.questionId,
          scheduledAdditional.ordinal,
          scheduledAdditional.sourceQuestionId,
          scheduledAdditional.scoreValue,
          now,
          attempt.id,
          question.id,
          claimMarker,
          attempt.id,
          question.id,
        ),
    );
  }

  for (const skipped of skippedQuestions) {
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO answers (
          attempt_id, question_id, selected_index, is_correct, answered_at,
          elapsed_seconds, timed_out, fact_version, answer_origin,
          canonical_selected_index, awarded_score
        ) SELECT ?, ?, NULL, 0, ?, 0, 1, ?, 'total_timeout_unshown', NULL, 0
          FROM attempts
          WHERE id = ? AND status = 'active' AND current_question_id = ?
            AND current_question_started_at = ?`)
        .bind(
          attempt.id,
          skipped.id,
          now,
          attempt.analytics_facts_version,
          attempt.id,
          question.id,
          claimMarker,
        ),
    );
  }

  const attemptUpdateStatement = db
    .prepare(
      `UPDATE attempts SET status = ?, current_question_id = ?, pending_question_ids = ?,
        asked_question_ids = ?, score = ?, correct_count = ?, wrong_count = ?,
        current_question_started_at = ?, question_deadline_at = ?, verdict = ?,
        completed_at = ?, duration_seconds = ?
       WHERE id = ? AND current_question_id = ? AND status = 'active'
         AND current_question_started_at = ?
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
      claimMarker,
      attempt.id,
      question.id,
    );
  if (nextId !== null) {
    statements.push(
      db.prepare(`UPDATE attempt_questions
        SET presented_at = COALESCE(presented_at, ?)
        WHERE attempt_id = ? AND question_id = ?
          AND EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM attempts
            WHERE id = ? AND status = 'active' AND current_question_id = ?
              AND current_question_started_at = ?
          )`)
        .bind(
          now,
          attempt.id,
          nextId,
          attempt.id,
          question.id,
          attempt.id,
          question.id,
          claimMarker,
        ),
    );
  }

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
          FROM attempts WHERE id = ? AND status = 'active'
            AND current_question_id = ? AND current_question_started_at = ?
            AND EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            startedEventId,
            progressMessage,
            Math.max(attempt.started_at, now - 1),
            Math.max(attempt.started_at, now - 1),
            attempt.id,
            question.id,
            claimMarker,
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
            )
            AND EXISTS (
              SELECT 1 FROM attempts
              WHERE id = ? AND status = 'active' AND current_question_id = ?
                AND current_question_started_at = ?
            )`)
          .bind(
            attempt.id,
            progressEventId,
            attempt.id,
            question.id,
            attempt.id,
            question.id,
            claimMarker,
          ),
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, ?, 'progress', ?, 'edit_root', 'HTML', 1, 'pending', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?
          ) AND EXISTS (
            SELECT 1 FROM attempts
            WHERE id = ? AND status = 'active' AND current_question_id = ?
              AND current_question_started_at = ?
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
            attempt.id,
            question.id,
            claimMarker,
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
        questionKind,
        scoreValue,
        ...(additionalNumber === undefined ? {} : { additionalNumber }),
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
          ) AND EXISTS (
            SELECT 1 FROM attempts
            WHERE id = ? AND status = 'active' AND current_question_id = ?
              AND current_question_started_at = ?
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
            attempt.id,
            question.id,
            claimMarker,
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
        questionKind: 'base',
        scoreValue: questionScoreValue(skipped.weight, 'base'),
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
          ) AND EXISTS (
            SELECT 1 FROM attempts
            WHERE id = ? AND status = 'active' AND current_question_id = ?
              AND current_question_started_at = ?
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
            attempt.id,
            question.id,
            claimMarker,
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
        accuracy,
        timeoutCount: completionStats.timeoutCount,
        durationSeconds,
        averageAnswerSeconds: completionStats.averageAnswerSeconds,
        completedAt,
        baseAnsweredCount: completionStats.baseAnsweredCount,
        baseCorrectCount: completionStats.baseCorrectCount,
        additionalAnsweredCount: completionStats.additionalAnsweredCount,
        additionalCorrectCount: completionStats.additionalCorrectCount,
        interviewerProfile: interviewerProfile ?? undefined,
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, NULL, 'completed', ?, 'send', 'HTML', 0, 'pending', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM attempts
            WHERE id = ? AND status = 'active' AND current_question_id = ?
              AND current_question_started_at = ?
          )
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            completedEventId,
            attempt.id,
            summaryMessage,
            now,
            eventTime,
            attempt.id,
            question.id,
            claimMarker,
          ),
      );
    }
  }

  const attemptUpdateIndex = statements.length;
  statements.push(attemptUpdateStatement);
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
