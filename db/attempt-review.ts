import {
  reviewExplanation,
  type AttemptQuestionReviewDto,
} from '../lib/attempt-review.ts';
import type { QuestionDefinition } from '../lib/question-bank-validation.ts';
import type { Difficulty } from '../lib/test-config.ts';

type AttemptQuestionReviewRow = {
  question_id: number;
  question_kind: 'base' | 'additional';
  ordinal: number;
  score_value: number;
  presented_at: number | null;
  topic: string;
  difficulty: Difficulty;
  prompt: string;
  context_type: QuestionDefinition['contextType'] | null;
  context_text: string | null;
  choices_json: string;
  correct_index: number;
  answer_id: number | null;
  canonical_selected_index: number | null;
  is_correct: number | null;
  timed_out: number | null;
  elapsed_seconds: number | null;
  awarded_score: number | null;
};

export async function loadAttemptQuestionReview(
  db: D1Database,
  attemptId: string,
): Promise<AttemptQuestionReviewDto[]> {
  const rows = await db.prepare(`SELECT
      aq.question_id, aq.question_kind, aq.ordinal, aq.score_value, aq.presented_at,
      q.topic, q.difficulty, q.prompt, q.context_type, q.context_text,
      q.choices_json, q.correct_index,
      a.id AS answer_id, a.canonical_selected_index, a.is_correct, a.timed_out,
      a.elapsed_seconds, a.awarded_score
    FROM attempt_questions aq
    JOIN questions q ON q.id = aq.question_id
    LEFT JOIN answers a
      ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
    WHERE aq.attempt_id = ?
    ORDER BY aq.ordinal`)
    .bind(attemptId)
    .all<AttemptQuestionReviewRow>();

  return rows.results.map((row) => {
    const choices = JSON.parse(row.choices_json) as string[];
    const correctAnswer = choices[row.correct_index] ?? 'Правильный вариант недоступен';
    const selectedAnswer = row.canonical_selected_index === null
      ? null
      : choices[row.canonical_selected_index] ?? null;
    const timedOut = row.timed_out === 1;
    const status = row.presented_at === null || row.answer_id === null
      ? 'unshown' as const
      : timedOut
        ? 'timeout' as const
        : row.is_correct === 1
          ? 'correct' as const
          : 'incorrect' as const;
    return {
      questionId: row.question_id,
      ordinal: row.ordinal,
      questionKind: row.question_kind,
      scoreValue: row.score_value,
      topic: row.topic,
      difficulty: row.difficulty,
      prompt: row.prompt,
      contextType: row.context_type ?? null,
      context: row.context_text,
      status,
      selectedAnswer,
      correctAnswer,
      elapsedSeconds: row.elapsed_seconds,
      awardedScore: row.awarded_score ?? 0,
      explanation: reviewExplanation({
        topic: row.topic,
        correctAnswer,
        selectedAnswer,
        timedOut,
        hasContext: row.context_text !== null,
      }),
    };
  });
}
