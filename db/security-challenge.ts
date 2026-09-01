import {
  choicePermutation,
  database,
  ensureQuestionBankReady,
  ensureSchema,
  sha256,
  sha256Hex,
  type Difficulty,
  type QuestionRow,
} from './runtime.ts';
import {
  SECURITY_CHALLENGE_CONFIG,
  SECURITY_CHALLENGE_CONFIG_ID,
  SECURITY_CHALLENGE_SCORING_VERSION,
  challengeParticipantKey,
  challengeScoreDeltaUnits,
  displayedChallengeScore,
  normalizedChallengeParticipantIdentity,
  type SecurityChallengeCompletionReason,
  type SecurityChallengeOutcome,
} from '@/lib/security-challenge-config.ts';

export type SecurityChallengeAttemptRow = {
  id: string;
  token_hash: string;
  start_key: string;
  nickname: string;
  normalized_nickname: string;
  participant_key: string;
  config_id: string;
  scoring_version: number;
  bank_revision: string;
  pool_revision: string;
  pool_question_ids: string;
  status: 'active' | 'completed';
  completion_reason: SecurityChallengeCompletionReason | null;
  started_at: number;
  total_deadline_at: number;
  current_question_started_at: number;
  question_deadline_at: number;
  current_question_id: number | null;
  current_ordinal: number;
  score_units: number;
  correct_count: number;
  incorrect_count: number;
  timeout_count: number;
  completed_at: number | null;
  duration_seconds: number | null;
};

type ChallengeQuestionEventRow = {
  id: number;
  attempt_id: string;
  question_id: number;
  ordinal: number;
  difficulty: Difficulty;
  choice_order_json: string;
  selected_index: number | null;
  canonical_selected_index: number | null;
  outcome: SecurityChallengeOutcome;
  score_delta_units: number;
  presented_at: number;
  resolved_at: number | null;
  elapsed_seconds: number | null;
};

type ChallengePoolQuestion = Pick<
  QuestionRow,
  | 'id'
  | 'difficulty'
  | 'prompt'
  | 'context_type'
  | 'context_text'
  | 'choices_json'
  | 'correct_index'
  | 'content_hash'
  | 'dedupe_key'
> & { presentation_count: number };

export class SecurityChallengeConflictError extends Error {}
export class SecurityChallengeInvalidChoiceError extends Error {}
export class SecurityChallengePoolError extends Error {}

function parseNumberList(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item))) {
    throw new Error('challenge_pool_snapshot_invalid');
  }
  return parsed as number[];
}

function elapsedSeconds(startedAt: number, deadlineAt: number, now: number) {
  const allocated = Math.max(0, Math.ceil((deadlineAt - startedAt) / 1_000));
  return Math.min(allocated, Math.max(0, Math.ceil((now - startedAt) / 1_000)));
}

async function deterministicPermutation(seed: string, length: number) {
  const digest = await sha256(seed);
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

export async function challengeDifficultyForOrdinal(attemptId: string, ordinal: number) {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('challenge_ordinal_invalid');
  const block = SECURITY_CHALLENGE_CONFIG.difficultyBlock;
  const blockIndex = Math.floor((ordinal - 1) / block.length);
  const position = (ordinal - 1) % block.length;
  const permutation = await deterministicPermutation(
    `security-challenge:difficulty:${attemptId}:${blockIndex}`,
    block.length,
  );
  return block[permutation[position]];
}

export async function securityChallengePoolSnapshot() {
  const bankRevision = await ensureQuestionBankReady();
  const rows = await database().prepare(`SELECT
      questions.id, questions.difficulty, questions.content_hash, questions.dedupe_key
    FROM question_bank_revision_items membership
    JOIN questions ON questions.id = membership.question_id
    JOIN question_categories category ON category.id = questions.category_id
    WHERE membership.revision_hash = ? AND membership.active = 1
      AND category.active = 1 AND category.selection_key = ?
    ORDER BY questions.id`)
    .bind(bankRevision, SECURITY_CHALLENGE_CONFIG.categorySelectionKey)
    .all<{
      id: number;
      difficulty: Difficulty;
      content_hash: string | null;
      dedupe_key: string;
    }>();
  const unique = new Map<string, typeof rows.results[number]>();
  for (const row of rows.results) {
    const key = row.dedupe_key || `question:${row.id}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const counts = { easy: 0, medium: 0, hard: 0, expert: 0 } satisfies Record<Difficulty, number>;
  for (const row of unique.values()) counts[row.difficulty] += 1;
  const required = { easy: 3, medium: 3, hard: 3, expert: 1 } satisfies Record<Difficulty, number>;
  if ((Object.keys(required) as Difficulty[]).some((difficulty) => counts[difficulty] < required[difficulty])) {
    throw new SecurityChallengePoolError('В ИБ-пуле недостаточно уникальных вопросов.');
  }
  const canonical = [...unique.values()].map((row) => ({
    id: row.id,
    difficulty: row.difficulty,
    contentHash: row.content_hash ?? '',
    dedupeKey: row.dedupe_key || `question:${row.id}`,
  }));
  return {
    bankRevision,
    poolRevision: await sha256Hex(JSON.stringify(canonical)),
    questionIds: canonical.map((row) => row.id),
    counts,
  };
}

async function findChallengeAttempt(id: string) {
  return database().prepare('SELECT * FROM security_challenge_attempts WHERE id = ?')
    .bind(id).first<SecurityChallengeAttemptRow>();
}

async function findChallengeAttemptByStartKey(startKey: string) {
  return database().prepare('SELECT * FROM security_challenge_attempts WHERE start_key = ?')
    .bind(startKey).first<SecurityChallengeAttemptRow>();
}

export async function verifySecurityChallengeAttempt(id: string, token: string) {
  const attempt = await findChallengeAttempt(id);
  if (!attempt || !token || await sha256Hex(token) !== attempt.token_hash) return null;
  return attempt;
}

async function loadCurrentEvent(attempt: SecurityChallengeAttemptRow) {
  if (attempt.current_question_id === null) return null;
  return database().prepare(`SELECT * FROM security_challenge_question_events
    WHERE attempt_id = ? AND ordinal = ? AND question_id = ?`)
    .bind(attempt.id, attempt.current_ordinal, attempt.current_question_id)
    .first<ChallengeQuestionEventRow>();
}

async function loadQuestion(id: number) {
  return database().prepare(`SELECT id, difficulty, prompt, context_type, context_text,
      choices_json, correct_index, content_hash, dedupe_key, 0 AS presentation_count
    FROM questions WHERE id = ?`)
    .bind(id).first<ChallengePoolQuestion>();
}

async function chooseQuestion(
  attemptId: string,
  poolQuestionIds: readonly number[],
  ordinal: number,
) {
  const difficulty = await challengeDifficultyForOrdinal(attemptId, ordinal);
  const [candidateRows, usedRows] = await Promise.all([
    database().prepare(`SELECT questions.id, questions.difficulty, questions.prompt,
        questions.context_type, questions.context_text, questions.choices_json,
        questions.correct_index, questions.content_hash, questions.dedupe_key,
        COUNT(events.id) AS presentation_count
      FROM questions
      LEFT JOIN security_challenge_question_events events ON events.question_id = questions.id
      WHERE questions.difficulty = ?
      GROUP BY questions.id
      ORDER BY presentation_count, questions.id`)
      .bind(difficulty).all<ChallengePoolQuestion>(),
    database().prepare(`SELECT events.question_id, questions.dedupe_key
      FROM security_challenge_question_events events
      JOIN questions ON questions.id = events.question_id
      WHERE events.attempt_id = ?`)
      .bind(attemptId).all<{ question_id: number; dedupe_key: string }>(),
  ]);
  const poolIds = new Set(poolQuestionIds);
  const usedIds = new Set(usedRows.results.map((row) => row.question_id));
  const usedDedupe = new Set(usedRows.results.map((row) => (
    row.dedupe_key || `question:${row.question_id}`
  )));
  const available = candidateRows.results.filter((row) => (
    poolIds.has(row.id)
    && !usedIds.has(row.id)
    && !usedDedupe.has(row.dedupe_key || `question:${row.id}`)
  ));
  if (available.length === 0) return null;
  const minimumExposure = available[0].presentation_count;
  const leastExposed = available.filter((row) => row.presentation_count === minimumExposure);
  const digest = await sha256(`security-challenge:question:${attemptId}:${ordinal}`);
  const offset = new DataView(digest.buffer).getUint32(0) % leastExposed.length;
  return leastExposed[offset];
}

async function questionEventValues(attemptId: string, question: ChallengePoolQuestion, ordinal: number) {
  const choices = JSON.parse(question.choices_json) as string[];
  if (choices.length < 2 || choices.length > 6) throw new SecurityChallengePoolError(
    'В ИБ-пуле найден вопрос с недопустимым количеством вариантов.',
  );
  return {
    question,
    choiceOrder: await choicePermutation(attemptId, question.id, choices.length),
    ordinal,
  };
}

export async function createSecurityChallengeAttempt(input: {
  nickname: string;
  normalizedNickname: string;
  startKey: string;
  token: string;
}) {
  await ensureSchema();
  const tokenHash = await sha256Hex(input.token);
  const existing = await findChallengeAttemptByStartKey(input.startKey);
  if (existing) {
    if (existing.token_hash !== tokenHash) throw new SecurityChallengeConflictError(
      'Конфликт параметров запуска.',
    );
    return existing;
  }
  const snapshot = await securityChallengePoolSnapshot();
  const id = crypto.randomUUID();
  const firstQuestion = await chooseQuestion(id, snapshot.questionIds, 1);
  if (!firstQuestion) throw new SecurityChallengePoolError('Не удалось выбрать первый вопрос.');
  const firstEvent = await questionEventValues(id, firstQuestion, 1);
  const now = Date.now();
  const totalDeadlineAt = now + SECURITY_CHALLENGE_CONFIG.totalTimeSeconds * 1_000;
  const participantKey = await challengeParticipantKey(input.nickname);
  const statements = [
    database().prepare(`INSERT INTO security_challenge_attempts (
        id, token_hash, start_key, nickname, normalized_nickname, participant_key,
        config_id, scoring_version, bank_revision, pool_revision, pool_question_ids,
        status, started_at, total_deadline_at, current_question_started_at,
        question_deadline_at, current_question_id, current_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1)
      ON CONFLICT(start_key) DO NOTHING`)
      .bind(
        id,
        tokenHash,
        input.startKey,
        input.nickname,
        input.normalizedNickname,
        participantKey,
        SECURITY_CHALLENGE_CONFIG_ID,
        SECURITY_CHALLENGE_SCORING_VERSION,
        snapshot.bankRevision,
        snapshot.poolRevision,
        JSON.stringify(snapshot.questionIds),
        now,
        totalDeadlineAt,
        now,
        Math.min(now + SECURITY_CHALLENGE_CONFIG.questionTimeSeconds * 1_000, totalDeadlineAt),
        firstQuestion.id,
      ),
    database().prepare(`INSERT OR IGNORE INTO security_challenge_question_events (
        attempt_id, question_id, ordinal, difficulty, choice_order_json, outcome, presented_at
      ) SELECT ?, ?, 1, ?, ?, 'pending', ?
      WHERE EXISTS (SELECT 1 FROM security_challenge_attempts WHERE id = ?)`)
      .bind(
        id,
        firstQuestion.id,
        firstQuestion.difficulty,
        JSON.stringify(firstEvent.choiceOrder),
        now,
        id,
      ),
  ];
  await database().batch(statements);
  const created = await findChallengeAttemptByStartKey(input.startKey);
  if (!created || created.token_hash !== tokenHash) throw new SecurityChallengeConflictError(
    'Конфликт параметров запуска.',
  );
  return created;
}

async function resolveCurrentQuestion(
  attempt: SecurityChallengeAttemptRow,
  selectedIndex: number | null,
  requestedTimeout: boolean,
  now: number,
) {
  if (attempt.status !== 'active' || attempt.current_question_id === null) return attempt;
  const [event, question] = await Promise.all([
    loadCurrentEvent(attempt),
    loadQuestion(attempt.current_question_id),
  ]);
  if (!event || !question) throw new SecurityChallengeConflictError('Текущий вопрос недоступен.');
  if (event.outcome !== 'pending') return (await findChallengeAttempt(attempt.id)) ?? attempt;
  const choices = JSON.parse(question.choices_json) as string[];
  if (selectedIndex !== null && (
    !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= choices.length
  )) throw new SecurityChallengeInvalidChoiceError('Выберите допустимый вариант ответа.');

  const totalExpired = now >= attempt.total_deadline_at;
  const questionExpired = now >= attempt.question_deadline_at;
  if (requestedTimeout && !questionExpired && !totalExpired) {
    throw new SecurityChallengeConflictError('Время вопроса ещё не истекло.');
  }
  const timedOut = requestedTimeout || questionExpired || totalExpired;
  if (!timedOut && selectedIndex === null) {
    throw new SecurityChallengeInvalidChoiceError('Выберите вариант ответа.');
  }
  const choiceOrder = JSON.parse(event.choice_order_json) as number[];
  const canonicalSelectedIndex = timedOut || selectedIndex === null
    ? null
    : choiceOrder[selectedIndex];
  const correct = canonicalSelectedIndex === question.correct_index;
  const outcome: SecurityChallengeOutcome = timedOut
    ? 'timeout'
    : correct ? 'correct' : 'incorrect';
  const delta = challengeScoreDeltaUnits(question.difficulty, choices.length, correct && !timedOut);
  const nextOrdinal = attempt.current_ordinal + 1;
  const nextQuestion = totalExpired
    ? null
    : await chooseQuestion(attempt.id, parseNumberList(attempt.pool_question_ids), nextOrdinal);
  const completionReason: SecurityChallengeCompletionReason | null = totalExpired
    ? 'total_timeout'
    : nextQuestion ? null : 'pool_exhausted';
  const nextEvent = nextQuestion
    ? await questionEventValues(attempt.id, nextQuestion, nextOrdinal)
    : null;
  const duration = Math.max(0, Math.ceil((now - attempt.started_at) / 1_000));
  const questionElapsed = elapsedSeconds(
    attempt.current_question_started_at,
    Math.min(attempt.question_deadline_at, attempt.total_deadline_at),
    now,
  );
  const nextQuestionDeadline = Math.min(
    now + SECURITY_CHALLENGE_CONFIG.questionTimeSeconds * 1_000,
    attempt.total_deadline_at,
  );
  const statements: D1PreparedStatement[] = [
    database().prepare(`UPDATE security_challenge_question_events
      SET selected_index = ?, canonical_selected_index = ?, outcome = ?,
        score_delta_units = ?, resolved_at = ?, elapsed_seconds = ?
      WHERE attempt_id = ? AND ordinal = ? AND question_id = ? AND outcome = 'pending'`)
      .bind(
        timedOut ? null : selectedIndex,
        canonicalSelectedIndex,
        outcome,
        delta,
        now,
        questionElapsed,
        attempt.id,
        attempt.current_ordinal,
        attempt.current_question_id,
      ),
    nextQuestion
      ? database().prepare(`UPDATE security_challenge_attempts SET
          score_units = score_units + ?,
          correct_count = correct_count + ?,
          incorrect_count = incorrect_count + ?,
          timeout_count = timeout_count + ?,
          current_question_started_at = ?, question_deadline_at = ?,
          current_question_id = ?, current_ordinal = ?
        WHERE id = ? AND status = 'active' AND current_question_id = ? AND current_ordinal = ?`)
        .bind(
          delta,
          correct && !timedOut ? 1 : 0,
          !correct && !timedOut ? 1 : 0,
          timedOut ? 1 : 0,
          now,
          nextQuestionDeadline,
          nextQuestion.id,
          nextOrdinal,
          attempt.id,
          attempt.current_question_id,
          attempt.current_ordinal,
        )
      : database().prepare(`UPDATE security_challenge_attempts SET
          score_units = score_units + ?,
          correct_count = correct_count + ?,
          incorrect_count = incorrect_count + ?,
          timeout_count = timeout_count + ?,
          status = 'completed', completion_reason = ?, completed_at = ?, duration_seconds = ?,
          current_question_id = NULL
        WHERE id = ? AND status = 'active' AND current_question_id = ? AND current_ordinal = ?`)
        .bind(
          delta,
          correct && !timedOut ? 1 : 0,
          !correct && !timedOut ? 1 : 0,
          timedOut ? 1 : 0,
          completionReason,
          now,
          duration,
          attempt.id,
          attempt.current_question_id,
          attempt.current_ordinal,
        ),
  ];
  if (nextEvent) {
    statements.push(database().prepare(`INSERT OR IGNORE INTO security_challenge_question_events (
        attempt_id, question_id, ordinal, difficulty, choice_order_json, outcome, presented_at
      ) SELECT ?, ?, ?, ?, ?, 'pending', ?
      WHERE EXISTS (SELECT 1 FROM security_challenge_attempts
        WHERE id = ? AND status = 'active' AND current_question_id = ? AND current_ordinal = ?)`)
      .bind(
        attempt.id,
        nextEvent.question.id,
        nextOrdinal,
        nextEvent.question.difficulty,
        JSON.stringify(nextEvent.choiceOrder),
        now,
        attempt.id,
        nextEvent.question.id,
        nextOrdinal,
      ));
  }
  await database().batch(statements);
  return (await findChallengeAttempt(attempt.id)) ?? attempt;
}

export async function settleSecurityChallengeAttempt(
  attempt: SecurityChallengeAttemptRow,
  now = Date.now(),
) {
  if (attempt.status !== 'active') return attempt;
  if (now < attempt.question_deadline_at && now < attempt.total_deadline_at) return attempt;
  return resolveCurrentQuestion(attempt, null, true, now);
}

export async function answerSecurityChallengeQuestion(
  attempt: SecurityChallengeAttemptRow,
  questionId: number,
  selectedIndex: number | null,
  now = Date.now(),
) {
  if (attempt.status !== 'active') return attempt;
  if (attempt.current_question_id !== questionId) {
    throw new SecurityChallengeConflictError('Этот вопрос уже закрыт.');
  }
  return resolveCurrentQuestion(attempt, selectedIndex, selectedIndex === null, now);
}

export async function finishSecurityChallengeAttempt(
  attempt: SecurityChallengeAttemptRow,
  now = Date.now(),
  retryAfterRace = true,
) {
  if (attempt.status !== 'active') return attempt;
  if (now >= attempt.total_deadline_at) return settleSecurityChallengeAttempt(attempt, now);
  const duration = Math.max(0, Math.ceil((now - attempt.started_at) / 1_000));
  const statements: D1PreparedStatement[] = [];
  if (attempt.current_question_id !== null) {
    statements.push(database().prepare(`UPDATE security_challenge_question_events
      SET outcome = 'manual_unanswered', resolved_at = ?, elapsed_seconds = ?
      WHERE attempt_id = ? AND ordinal = ? AND question_id = ? AND outcome = 'pending'`)
      .bind(
        now,
        elapsedSeconds(
          attempt.current_question_started_at,
          Math.min(attempt.question_deadline_at, attempt.total_deadline_at),
          now,
        ),
        attempt.id,
        attempt.current_ordinal,
        attempt.current_question_id,
      ));
  }
  statements.push(database().prepare(`UPDATE security_challenge_attempts SET
      status = 'completed', completion_reason = 'manual', completed_at = ?,
      duration_seconds = ?, current_question_id = NULL
    WHERE id = ? AND status = 'active' AND current_ordinal = ?`)
    .bind(now, duration, attempt.id, attempt.current_ordinal));
  await database().batch(statements);
  const updated = (await findChallengeAttempt(attempt.id)) ?? attempt;
  if (
    retryAfterRace
    && updated.status === 'active'
    && updated.current_ordinal !== attempt.current_ordinal
  ) return finishSecurityChallengeAttempt(updated, now, false);
  return updated;
}

export async function securityChallengeAttemptPayload(attempt: SecurityChallengeAttemptRow) {
  const serverNowMs = Date.now();
  const resolvedCount = attempt.correct_count + attempt.incorrect_count + attempt.timeout_count;
  if (attempt.status === 'completed' || attempt.current_question_id === null) {
    return {
      attemptId: attempt.id,
      nickname: attempt.nickname,
      status: 'completed' as const,
      serverNowMs,
      cohort: {
        configId: attempt.config_id,
        scoringVersion: attempt.scoring_version,
        poolRevision: attempt.pool_revision,
      },
      result: {
        score: displayedChallengeScore(attempt.score_units),
        scoreUnits: attempt.score_units,
        correctCount: attempt.correct_count,
        incorrectCount: attempt.incorrect_count,
        timeoutCount: attempt.timeout_count,
        resolvedCount,
        eligibleForLeaderboard: resolvedCount >= SECURITY_CHALLENGE_CONFIG.minimumRankedQuestions,
        completionReason: attempt.completion_reason,
        durationSeconds: attempt.duration_seconds ?? 0,
        completedAt: new Date(attempt.completed_at ?? serverNowMs).toISOString(),
      },
    };
  }
  const [event, question] = await Promise.all([
    loadCurrentEvent(attempt),
    loadQuestion(attempt.current_question_id),
  ]);
  if (!event || !question) throw new SecurityChallengeConflictError('Текущий вопрос недоступен.');
  const choices = JSON.parse(question.choices_json) as string[];
  const choiceOrder = JSON.parse(event.choice_order_json) as number[];
  return {
    attemptId: attempt.id,
    nickname: attempt.nickname,
    status: 'active' as const,
    serverNowMs,
    resolvedCount,
    question: {
      id: question.id,
      ordinal: event.ordinal,
      prompt: question.prompt,
      difficulty: question.difficulty,
      ...(question.context_type && question.context_text !== null
        ? { contextType: question.context_type, context: question.context_text }
        : {}),
      choices: choiceOrder.map((index) => choices[index]),
      questionDeadlineAt: attempt.question_deadline_at,
      totalDeadlineAt: attempt.total_deadline_at,
    },
  };
}

export async function securityChallengeReview(attempt: SecurityChallengeAttemptRow) {
  if (attempt.status !== 'completed') throw new SecurityChallengeConflictError(
    'Разбор доступен только после завершения.',
  );
  const rows = await database().prepare(`SELECT events.*, questions.prompt,
      questions.context_type, questions.context_text, questions.choices_json,
      questions.correct_index
    FROM security_challenge_question_events events
    JOIN questions ON questions.id = events.question_id
    WHERE events.attempt_id = ? ORDER BY events.ordinal`)
    .bind(attempt.id).all<ChallengeQuestionEventRow & {
      prompt: string;
      context_type: string | null;
      context_text: string | null;
      choices_json: string;
      correct_index: number;
    }>();
  return rows.results.map((row) => {
    const choices = JSON.parse(row.choices_json) as string[];
    const order = JSON.parse(row.choice_order_json) as number[];
    const shownChoices = order.map((index) => choices[index]);
    const manualUnanswered = row.outcome === 'manual_unanswered';
    return {
      eventId: row.id,
      questionId: row.question_id,
      ordinal: row.ordinal,
      prompt: row.prompt,
      difficulty: row.difficulty,
      ...(row.context_type && row.context_text !== null
        ? { contextType: row.context_type, context: row.context_text }
        : {}),
      choices: shownChoices,
      selectedIndex: row.selected_index,
      correctIndex: manualUnanswered ? null : order.indexOf(row.correct_index),
      outcome: row.outcome,
      scoreDelta: displayedChallengeScore(row.score_delta_units),
      elapsedSeconds: row.elapsed_seconds,
    };
  });
}

export async function saveSecurityChallengeFeedback(
  attempt: SecurityChallengeAttemptRow,
  eventId: number,
  comment: string,
) {
  if (attempt.status !== 'completed') throw new SecurityChallengeConflictError(
    'Отзыв можно оставить после завершения.',
  );
  const event = await database().prepare(`SELECT id FROM security_challenge_question_events
    WHERE id = ? AND attempt_id = ? AND outcome != 'pending'`)
    .bind(eventId, attempt.id).first<{ id: number }>();
  if (!event) throw new SecurityChallengeConflictError('Вопрос из разбора не найден.');
  const id = crypto.randomUUID();
  const now = Date.now();
  await database().prepare(`INSERT INTO security_challenge_feedback (
      id, attempt_id, question_event_id, participant_key, comment, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(attempt_id, question_event_id) DO UPDATE SET
      comment = excluded.comment, status = 'open', resolution_note = NULL,
      resolved_at = NULL, admin_session_fingerprint = NULL`)
    .bind(id, attempt.id, eventId, attempt.participant_key, comment, now).run();
  return { status: 'open' as const };
}

export async function securityChallengeLeaderboard(period: 'today' | 'all' = 'all') {
  const snapshot = await securityChallengePoolSnapshot();
  const now = new Date();
  const moscowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(moscowParts.map((part) => [part.type, part.value]));
  const dayStart = Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00+03:00`);
  const rows = await database().prepare(`WITH eligible AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY participant_key
        ORDER BY score_units DESC, correct_count DESC,
          (incorrect_count + timeout_count) ASC, timeout_count ASC, completed_at ASC
      ) AS participant_rank
      FROM security_challenge_attempts
      WHERE status = 'completed' AND config_id = ? AND scoring_version = ?
        AND pool_revision = ?
        AND (correct_count + incorrect_count + timeout_count) >= ?
        AND (? IS NULL OR (completed_at >= ? AND completed_at < ?))
    )
    SELECT nickname, score_units, correct_count, incorrect_count, timeout_count,
      completed_at, duration_seconds
    FROM eligible WHERE participant_rank = 1
    ORDER BY score_units DESC, correct_count DESC,
      (incorrect_count + timeout_count) ASC, timeout_count ASC, completed_at ASC
    LIMIT 100`)
    .bind(
      SECURITY_CHALLENGE_CONFIG_ID,
      SECURITY_CHALLENGE_SCORING_VERSION,
      snapshot.poolRevision,
      SECURITY_CHALLENGE_CONFIG.minimumRankedQuestions,
      period === 'today' ? dayStart : null,
      dayStart,
      dayStart + 24 * 60 * 60 * 1_000,
    ).all<{
      nickname: string;
      score_units: number;
      correct_count: number;
      incorrect_count: number;
      timeout_count: number;
      completed_at: number;
      duration_seconds: number;
    }>();
  return {
    period,
    cohort: {
      configId: SECURITY_CHALLENGE_CONFIG_ID,
      scoringVersion: SECURITY_CHALLENGE_SCORING_VERSION,
      poolRevision: snapshot.poolRevision,
    },
    entries: rows.results.map((row, index) => ({
      rank: index + 1,
      nickname: row.nickname,
      score: displayedChallengeScore(row.score_units),
      correctCount: row.correct_count,
      incorrectCount: row.incorrect_count,
      timeoutCount: row.timeout_count,
      completedAt: new Date(row.completed_at).toISOString(),
      durationSeconds: row.duration_seconds,
    })),
  };
}

export async function maintainSecurityChallengeAttempts(now = Date.now()) {
  await ensureSchema();
  const expired = await database().prepare(`SELECT * FROM security_challenge_attempts
    WHERE status = 'active' AND total_deadline_at <= ? ORDER BY total_deadline_at LIMIT 50`)
    .bind(now).all<SecurityChallengeAttemptRow>();
  for (const attempt of expired.results) await settleSecurityChallengeAttempt(attempt, now);
  return { settled: expired.results.length };
}

export async function securityChallengeAdminReport() {
  await ensureSchema();
  const [overview, attempts, distribution, questionStats, difficultyStats, feedback] = await Promise.all([
    database().prepare(`SELECT
        COUNT(*) AS starts,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        COUNT(DISTINCT participant_key) AS participants,
        AVG(CASE WHEN status = 'completed' THEN score_units END) AS average_score_units,
        AVG(CASE WHEN status = 'completed' THEN duration_seconds END) AS average_duration_seconds,
        SUM(correct_count) AS correct_count,
        SUM(incorrect_count) AS incorrect_count,
        SUM(timeout_count) AS timeout_count,
        SUM(CASE WHEN completion_reason = 'manual' THEN 1 ELSE 0 END) AS manual_count,
        SUM(CASE WHEN completion_reason = 'total_timeout' THEN 1 ELSE 0 END) AS total_timeout_count,
        SUM(CASE WHEN completion_reason = 'pool_exhausted' THEN 1 ELSE 0 END) AS pool_exhausted_count
      FROM security_challenge_attempts`).first<Record<string, number | null>>(),
    database().prepare(`SELECT id, nickname, status, completion_reason, score_units,
        correct_count, incorrect_count, timeout_count, started_at, completed_at
      FROM security_challenge_attempts ORDER BY started_at DESC LIMIT 100`)
      .all<Record<string, string | number | null>>(),
    database().prepare(`SELECT score_units, duration_seconds
      FROM security_challenge_attempts WHERE status = 'completed'
      ORDER BY completed_at DESC LIMIT 10000`)
      .all<{ score_units: number; duration_seconds: number }>(),
    database().prepare(`WITH first_exposure AS (
        SELECT events.*, attempts.participant_key, attempts.pool_revision,
          ROW_NUMBER() OVER (
            PARTITION BY attempts.participant_key, events.question_id, attempts.pool_revision
            ORDER BY events.presented_at, events.id
          ) AS exposure_rank
        FROM security_challenge_question_events events
        JOIN security_challenge_attempts attempts ON attempts.id = events.attempt_id
        WHERE events.outcome != 'pending' AND events.outcome != 'manual_unanswered'
      )
      SELECT questions.id AS question_id, questions.prompt, questions.difficulty,
        COUNT(events.id) AS presentations,
        SUM(CASE WHEN events.outcome = 'correct' THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN events.outcome = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
        SUM(CASE WHEN events.outcome = 'timeout' THEN 1 ELSE 0 END) AS timeout_count,
        AVG(events.elapsed_seconds) AS average_seconds,
        SUM(events.score_delta_units) AS net_score_units,
        SUM(CASE WHEN first.exposure_rank = 1 THEN 1 ELSE 0 END) AS first_exposure_count,
        SUM(CASE WHEN first.exposure_rank = 1 AND first.outcome = 'correct' THEN 1 ELSE 0 END)
          AS first_exposure_correct
      FROM security_challenge_question_events events
      JOIN questions ON questions.id = events.question_id
      LEFT JOIN first_exposure first ON first.id = events.id
      WHERE events.outcome != 'pending' AND events.outcome != 'manual_unanswered'
      GROUP BY questions.id ORDER BY presentations DESC, questions.id LIMIT 200`)
      .all<Record<string, string | number | null>>(),
    database().prepare(`WITH first_exposure AS (
        SELECT events.*, attempts.participant_key, attempts.pool_revision,
          ROW_NUMBER() OVER (
            PARTITION BY attempts.participant_key, events.question_id, attempts.pool_revision
            ORDER BY events.presented_at, events.id
          ) AS exposure_rank
        FROM security_challenge_question_events events
        JOIN security_challenge_attempts attempts ON attempts.id = events.attempt_id
        WHERE events.outcome NOT IN ('pending', 'manual_unanswered')
      )
      SELECT events.difficulty, COUNT(events.id) AS presentations,
        SUM(CASE WHEN events.outcome = 'correct' THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN events.outcome = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
        SUM(CASE WHEN events.outcome = 'timeout' THEN 1 ELSE 0 END) AS timeout_count,
        AVG(events.elapsed_seconds) AS average_seconds,
        SUM(events.score_delta_units) AS net_score_units,
        SUM(CASE WHEN first.exposure_rank = 1 THEN 1 ELSE 0 END) AS first_exposure_count,
        SUM(CASE WHEN first.exposure_rank = 1 AND first.outcome = 'correct' THEN 1 ELSE 0 END)
          AS first_exposure_correct
      FROM security_challenge_question_events events
      LEFT JOIN first_exposure first ON first.id = events.id
      WHERE events.outcome NOT IN ('pending', 'manual_unanswered')
      GROUP BY events.difficulty ORDER BY
        CASE events.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2
          WHEN 'hard' THEN 3 ELSE 4 END`)
      .all<Record<string, string | number | null>>(),
    database().prepare(`SELECT feedback.id, feedback.comment, feedback.status,
        feedback.resolution_note, feedback.created_at, feedback.resolved_at,
        attempts.nickname, events.question_id, questions.prompt
      FROM security_challenge_feedback feedback
      JOIN security_challenge_attempts attempts ON attempts.id = feedback.attempt_id
      JOIN security_challenge_question_events events ON events.id = feedback.question_event_id
      JOIN questions ON questions.id = events.question_id
      ORDER BY CASE feedback.status WHEN 'open' THEN 0 ELSE 1 END, feedback.created_at DESC
      LIMIT 100`).all<Record<string, string | number | null>>(),
  ]);
  const percentile = (values: number[], fraction: number) => {
    if (values.length === 0) return 0;
    const ordered = values.toSorted((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  };
  const scoreValues = distribution.results.map((row) => row.score_units);
  const durationValues = distribution.results.map((row) => row.duration_seconds);
  return {
    overview: {
      ...(overview ?? {}),
      averageScore: displayedChallengeScore(Number(overview?.average_score_units ?? 0)),
      medianScore: displayedChallengeScore(percentile(scoreValues, 0.5)),
      p90Score: displayedChallengeScore(percentile(scoreValues, 0.9)),
      medianDurationSeconds: percentile(durationValues, 0.5),
      p90DurationSeconds: percentile(durationValues, 0.9),
      repeatAttempts: Math.max(
        0,
        Number(overview?.starts ?? 0) - Number(overview?.participants ?? 0),
      ),
    },
    attempts: attempts.results.map((row) => ({
      ...row,
      score: displayedChallengeScore(Number(row.score_units ?? 0)),
    })),
    questions: questionStats.results.map((row) => ({
      ...row,
      netScore: displayedChallengeScore(Number(row.net_score_units ?? 0)),
    })),
    difficulties: difficultyStats.results.map((row) => ({
      ...row,
      netScore: displayedChallengeScore(Number(row.net_score_units ?? 0)),
    })),
    feedback: feedback.results,
  };
}

export async function securityChallengeAdminAttemptDetail(id: string) {
  await ensureSchema();
  const attempt = await findChallengeAttempt(id);
  if (!attempt) return null;
  const resolvedCount = attempt.correct_count + attempt.incorrect_count + attempt.timeout_count;
  return {
    attemptId: attempt.id,
    nickname: attempt.nickname,
    status: attempt.status,
    completionReason: attempt.completion_reason,
    score: displayedChallengeScore(attempt.score_units),
    correctCount: attempt.correct_count,
    incorrectCount: attempt.incorrect_count,
    timeoutCount: attempt.timeout_count,
    resolvedCount,
    eligibleForLeaderboard: resolvedCount >= SECURITY_CHALLENGE_CONFIG.minimumRankedQuestions,
    startedAt: new Date(attempt.started_at).toISOString(),
    completedAt: attempt.completed_at ? new Date(attempt.completed_at).toISOString() : null,
    cohort: {
      configId: attempt.config_id,
      scoringVersion: attempt.scoring_version,
      poolRevision: attempt.pool_revision,
    },
    review: attempt.status === 'completed' ? await securityChallengeReview(attempt) : [],
  };
}

export async function resolveSecurityChallengeFeedback(input: {
  id: string;
  status: 'resolved' | 'rejected';
  resolutionNote: string;
  adminSessionFingerprint: string;
}) {
  const result = await database().prepare(`UPDATE security_challenge_feedback SET
      status = ?, resolution_note = ?, resolved_at = ?, admin_session_fingerprint = ?
    WHERE id = ? AND status = 'open'`)
    .bind(
      input.status,
      input.resolutionNote || null,
      Date.now(),
      input.adminSessionFingerprint,
      input.id,
    ).run();
  return (result.meta.changes ?? 0) > 0;
}

export function challengeNormalizedNicknameForStorage(nickname: string) {
  return normalizedChallengeParticipantIdentity(nickname);
}
