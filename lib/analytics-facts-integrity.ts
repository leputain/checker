import { BASE_MAX_SCORE } from './scoring.ts';
import {
  ANALYTICS_FACTS_VERSION,
  BASE_QUESTION_COUNT,
  TEST_CONFIG,
} from './test-config.ts';

export const ANALYTICS_FACTS_READINESS_LIMIT = 100;

function buildAnalyticsFactsIntegrityQuery(recentLimit?: number) {
  const limitClause = recentLimit === undefined
    ? ''
    : ` ORDER BY completed_at DESC LIMIT ${recentLimit}`;
  return `WITH exact_attempts AS (
    SELECT id, score, base_max_score, base_question_ids, bank_revision,
      correct_count AS attempt_correct_count,
      wrong_count AS attempt_wrong_count, analytics_facts_version
    FROM attempts
    WHERE status = 'completed' AND analytics_facts_version = ${ANALYTICS_FACTS_VERSION}
    ${limitClause}
  ), aggregates AS (
    SELECT ea.id,
      ea.score,
      ea.base_max_score,
      ea.attempt_correct_count,
      ea.attempt_wrong_count,
      COUNT(aq.question_id) AS assigned_count,
      SUM(CASE WHEN aq.question_kind = 'base' THEN 1 ELSE 0 END) AS base_assigned,
      SUM(CASE WHEN aq.question_kind = 'additional' THEN 1 ELSE 0 END)
        AS additional_assigned,
      MIN(CASE WHEN aq.question_kind = 'base' THEN aq.ordinal END) AS base_min_ordinal,
      MAX(CASE WHEN aq.question_kind = 'base' THEN aq.ordinal END) AS base_max_ordinal,
      COUNT(DISTINCT CASE WHEN aq.question_kind = 'base' THEN aq.ordinal END)
        AS base_distinct_ordinals,
      MIN(CASE WHEN aq.question_kind = 'additional' THEN aq.ordinal END)
        AS additional_min_ordinal,
      MAX(CASE WHEN aq.question_kind = 'additional' THEN aq.ordinal END)
        AS additional_max_ordinal,
      COUNT(DISTINCT CASE WHEN aq.question_kind = 'additional' THEN aq.ordinal END)
        AS additional_distinct_ordinals,
      MAX(CASE WHEN json_valid(ea.base_question_ids)
        AND json_array_length(ea.base_question_ids) = ${BASE_QUESTION_COUNT}
        THEN 0 ELSE 1 END) AS invalid_base_plan_shape,
      SUM(CASE WHEN aq.question_kind = 'base' AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          CASE WHEN json_valid(ea.base_question_ids) THEN ea.base_question_ids ELSE '[]' END
        ) plan
        WHERE plan.type = 'integer' AND plan.value = aq.question_id
      ) THEN 1 ELSE 0 END) AS base_ledger_ids_outside_plan,
      MAX((SELECT COUNT(*)
        FROM json_each(
          CASE WHEN json_valid(ea.base_question_ids) THEN ea.base_question_ids ELSE '[]' END
        ) plan
        WHERE plan.type != 'integer' OR NOT EXISTS (
          SELECT 1 FROM attempt_questions plan_aq
          WHERE plan_aq.attempt_id = ea.id
            AND plan_aq.question_id = plan.value
            AND plan_aq.question_kind = 'base'
        ))) AS invalid_base_plan_items,
      SUM(CASE WHEN aq.question_kind = 'base' AND aq.presented_at IS NOT NULL
        THEN 1 ELSE 0 END) AS base_presented,
      SUM(CASE WHEN aq.question_kind = 'additional' AND aq.presented_at IS NOT NULL
        THEN 1 ELSE 0 END) AS additional_presented,
      SUM(CASE WHEN aq.presented_at IS NOT NULL THEN 1 ELSE 0 END) AS presented_count,
      SUM(CASE WHEN aq.question_kind = 'base' AND an.id IS NOT NULL
        THEN 1 ELSE 0 END) AS base_resolved,
      SUM(CASE WHEN aq.question_kind = 'additional' AND an.id IS NOT NULL
        THEN 1 ELSE 0 END) AS additional_resolved,
      SUM(CASE WHEN an.id IS NOT NULL THEN 1 ELSE 0 END) AS resolved_count,
      SUM(CASE WHEN aq.presented_at IS NOT NULL AND an.id IS NULL
        THEN 1 ELSE 0 END) AS presented_without_exact_answer,
      SUM(CASE WHEN aq.question_kind = 'additional' AND aq.presented_at IS NULL
        AND EXISTS (
          SELECT 1 FROM answers any_answer
          WHERE any_answer.attempt_id = aq.attempt_id
            AND any_answer.question_id = aq.question_id
        ) THEN 1 ELSE 0 END) AS unshown_additional_answers,
      SUM(CASE WHEN aq.question_kind = 'additional'
        AND an.answer_origin = 'total_timeout_unshown'
        THEN 1 ELSE 0 END) AS additional_unshown_timeout_answers,
      SUM(CASE WHEN aq.question_id IS NOT NULL AND (
        q.id IS NULL
        OR qri.question_id IS NULL
        OR qri.active != 1
        OR aq.question_kind NOT IN ('base', 'additional')
        OR (aq.question_kind = 'base' AND (
          aq.ordinal < 1 OR aq.ordinal > ${BASE_QUESTION_COUNT}
          OR aq.source_question_id IS NOT NULL
          OR aq.score_value != q.weight * 2
        ))
        OR (aq.question_kind = 'additional' AND (
          aq.ordinal < ${BASE_QUESTION_COUNT + 1}
          OR aq.ordinal > ${BASE_QUESTION_COUNT + TEST_CONFIG.maxAdditionalQuestions}
          OR aq.source_question_id IS NULL
          OR aq.score_value != q.weight
          OR NOT EXISTS (
            SELECT 1
            FROM attempt_questions source_aq
            JOIN answers source_an
              ON source_an.attempt_id = source_aq.attempt_id
              AND source_an.question_id = source_aq.question_id
              AND source_an.fact_version = ea.analytics_facts_version
            WHERE source_aq.attempt_id = aq.attempt_id
              AND source_aq.question_id = aq.source_question_id
              AND source_aq.question_kind = 'base'
              AND source_aq.presented_at IS NOT NULL
              AND source_an.is_correct = 0
              AND source_an.answer_origin IN ('submitted', 'question_timeout')
          )
        ))
      ) THEN 1 ELSE 0 END) AS invalid_ledger_rows,
      SUM(CASE WHEN an.id IS NOT NULL AND an.is_correct = 1 THEN 1 ELSE 0 END)
        AS fact_correct_count,
      SUM(CASE WHEN an.id IS NOT NULL AND an.timed_out = 1 THEN 1 ELSE 0 END)
        AS fact_timeout_count,
      SUM(CASE WHEN an.id IS NOT NULL AND an.is_correct = 0 AND an.timed_out = 0
        THEN 1 ELSE 0 END) AS fact_incorrect_count,
      SUM(CASE WHEN an.id IS NOT NULL THEN COALESCE(an.awarded_score, 0) ELSE 0 END)
        AS awarded_score,
      SUM(CASE WHEN an.id IS NOT NULL AND (
        an.awarded_score IS NULL
        OR typeof(an.awarded_score) != 'integer'
        OR typeof(an.elapsed_seconds) != 'integer'
        OR an.elapsed_seconds < 0
        OR an.elapsed_seconds > ${TEST_CONFIG.questionTimeSeconds}
        OR an.is_correct NOT IN (0, 1)
        OR an.timed_out NOT IN (0, 1)
        OR an.awarded_score < 0
        OR an.awarded_score > aq.score_value
        OR (an.is_correct = 0 AND an.awarded_score != 0)
        OR (an.is_correct = 1 AND an.timed_out = 1)
        OR an.answer_origin NOT IN (
          'submitted', 'question_timeout', 'total_timeout_presented', 'total_timeout_unshown'
        )
        OR (an.answer_origin = 'submitted' AND an.canonical_selected_index IS NULL)
        OR (an.canonical_selected_index IS NOT NULL AND (
          json_valid(q.choices_json) = 0
          OR an.canonical_selected_index < 0
          OR an.canonical_selected_index >= json_array_length(q.choices_json)
        ))
        OR (an.answer_origin = 'submitted' AND (
          aq.presented_at IS NULL OR an.timed_out != 0
        ))
        OR (an.answer_origin = 'submitted' AND (
          (an.is_correct = 1 AND an.canonical_selected_index != q.correct_index)
          OR (an.is_correct = 0 AND an.canonical_selected_index = q.correct_index)
        ))
        OR (an.answer_origin IN ('question_timeout', 'total_timeout_presented') AND (
          aq.presented_at IS NULL OR an.timed_out != 1
        ))
        OR (an.answer_origin = 'total_timeout_unshown' AND (
          aq.presented_at IS NOT NULL OR an.timed_out != 1
          OR an.canonical_selected_index IS NOT NULL
        ))
      ) THEN 1 ELSE 0 END) AS invalid_answer_facts,
      SUM(CASE WHEN aq.question_kind = 'base' THEN aq.score_value ELSE 0 END)
        AS base_max_earned
    FROM exact_attempts ea
    LEFT JOIN attempt_questions aq ON aq.attempt_id = ea.id
    LEFT JOIN questions q ON q.id = aq.question_id
    LEFT JOIN question_bank_revision_items qri
      ON qri.revision_hash = ea.bank_revision AND qri.question_id = aq.question_id
    LEFT JOIN answers an
      ON an.attempt_id = aq.attempt_id
      AND an.question_id = aq.question_id
      AND an.fact_version = ea.analytics_facts_version
    GROUP BY ea.id
  ), invalid_attempts AS (
    SELECT id FROM aggregates
    WHERE assigned_count != base_assigned + additional_assigned
      OR base_assigned != ${BASE_QUESTION_COUNT}
      OR base_resolved != ${BASE_QUESTION_COUNT}
      OR additional_assigned > ${TEST_CONFIG.maxAdditionalQuestions}
      OR base_min_ordinal != 1
      OR base_max_ordinal != ${BASE_QUESTION_COUNT}
      OR base_distinct_ordinals != ${BASE_QUESTION_COUNT}
      OR invalid_base_plan_shape != 0
      OR base_ledger_ids_outside_plan != 0
      OR invalid_base_plan_items != 0
      OR (additional_assigned > 0 AND (
        additional_min_ordinal != ${BASE_QUESTION_COUNT + 1}
        OR additional_max_ordinal != ${BASE_QUESTION_COUNT} + additional_assigned
        OR additional_distinct_ordinals != additional_assigned
      ))
      OR base_presented > base_assigned
      OR additional_presented > additional_assigned
      OR presented_count > assigned_count
      OR resolved_count > assigned_count
      OR resolved_count != base_resolved + additional_resolved
      OR presented_without_exact_answer != 0
      OR additional_resolved != additional_presented
      OR unshown_additional_answers != 0
      OR additional_unshown_timeout_answers != 0
      OR invalid_ledger_rows != 0
      OR fact_correct_count + fact_incorrect_count + fact_timeout_count != resolved_count
      OR fact_correct_count != attempt_correct_count
      OR fact_incorrect_count + fact_timeout_count != attempt_wrong_count
      OR awarded_score != score
      OR invalid_answer_facts > 0
      OR base_max_earned != ${BASE_MAX_SCORE}
      OR base_max_score != ${BASE_MAX_SCORE}
  ), orphan_answers AS (
    SELECT an.id
    FROM answers an
    JOIN exact_attempts ea ON ea.id = an.attempt_id
    LEFT JOIN attempt_questions aq
      ON aq.attempt_id = an.attempt_id AND aq.question_id = an.question_id
    WHERE an.fact_version = ea.analytics_facts_version AND aq.question_id IS NULL
  )
  SELECT
    (SELECT COUNT(*) FROM invalid_attempts)
    + (SELECT COUNT(*) FROM orphan_answers) AS violations`;
}

export const ANALYTICS_FACTS_INTEGRITY_QUERY = buildAnalyticsFactsIntegrityQuery();
export const ANALYTICS_FACTS_READINESS_QUERY = buildAnalyticsFactsIntegrityQuery(
  ANALYTICS_FACTS_READINESS_LIMIT,
);
