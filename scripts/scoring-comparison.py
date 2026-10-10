#!/usr/bin/env python3
"""Anonymous, read-only comparison of candidate scoring v2 and proposed v3.

Run a saved file, or send this source to ``python3 - DB_PATH`` on the DB host.
Only Python's standard library is required. No stored result is changed. A live
WAL database is deliberately opened without immutable=1, so committed WAL rows
remain visible. SQLite may use its normal WAL/SHM service files.
"""

import argparse
import json
import math
import sqlite3
import sys
import unicodedata
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path


MOSCOW = timezone(timedelta(hours=3), name="Europe/Moscow")
BASE_COUNT = 20
MAX_ADDITIONAL = 10
WEIGHTS = {"easy": 1, "medium": 2, "hard": 3, "expert": 10}
PLAN = {"easy": 5, "medium": 7, "hard": 7, "expert": 1}
VERDICTS = {"PASS", "REVIEW", "FAIL"}
SHOWN_ORIGINS = {"submitted", "question_timeout", "total_timeout_presented"}

# Explicit projections keep names, aliases, tokens and question content out of
# Python rows. Identifiers are used internally for joins and are never emitted.
ATTEMPTS_SQL = """
SELECT id, score, base_max_score, correct_count, wrong_count, verdict,
       completed_at, base_question_ids, bank_revision,
       target_match(candidate_name) AS is_target
FROM attempts
WHERE status = 'completed'
  AND substr(COALESCE(candidate_key, ''), 1, 8) != 'demo:v1:'
  AND analytics_facts_version = 1 AND scoring_version = 2 AND base_max_score = 100
ORDER BY completed_at, id
"""

FACTS_SQL = """
SELECT aq.question_id, aq.question_kind, aq.ordinal, aq.source_question_id,
       aq.score_value, aq.presented_at, q.id AS question_exists,
       q.difficulty, q.weight,
       (SELECT COUNT(*) FROM question_bank_revision_items ri
          WHERE ri.revision_hash = ? AND ri.question_id = aq.question_id
            AND ri.active = 1) AS revision_membership,
       a.id AS answer_id, a.fact_version, a.answer_origin, a.is_correct,
       a.timed_out, a.elapsed_seconds, a.awarded_score,
       (a.canonical_selected_index IS NULL) AS selection_missing,
       CASE WHEN json_valid(q.choices_json) THEN
         a.canonical_selected_index >= 0 AND
         a.canonical_selected_index < json_array_length(q.choices_json)
       ELSE 0 END AS selection_valid,
       CASE WHEN a.is_correct = 1
         THEN a.canonical_selected_index = q.correct_index
         ELSE a.canonical_selected_index != q.correct_index
       END AS submitted_verdict_matches
FROM attempt_questions aq
LEFT JOIN questions q ON q.id = aq.question_id
LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
WHERE aq.attempt_id = ?
ORDER BY aq.ordinal, aq.question_id
"""

EXCLUSIONS_SQL = """
SELECT CASE
  WHEN status != 'completed' OR status IS NULL THEN 'notCompleted'
  WHEN substr(COALESCE(candidate_key, ''), 1, 8) = 'demo:v1:' THEN 'demoNamespace'
  WHEN analytics_facts_version != 1 OR analytics_facts_version IS NULL
    THEN 'unsupportedFactsVersion'
  WHEN scoring_version != 2 OR scoring_version IS NULL THEN 'unsupportedScoringVersion'
  WHEN base_max_score != 100 OR base_max_score IS NULL THEN 'unsupportedBaseMaximum'
  ELSE 'eligible' END AS bucket, COUNT(*) AS count
FROM attempts GROUP BY bucket
"""


def integer(value, minimum=0, maximum=None):
    return (type(value) is int and value >= minimum
            and (maximum is None or value <= maximum))


def normalize_name(value):
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def moscow_date(milliseconds):
    if not integer(milliseconds):
        return None
    try:
        return datetime.fromtimestamp(milliseconds / 1000, MOSCOW).isoformat(
            timespec="seconds")
    except (ValueError, OverflowError, OSError):
        return None


def old_verdict(score, correct, wrong):
    # Math.round() in the source uses half-up for nonnegative percentages.
    accuracy = math.floor(100 * correct / (correct + wrong) + 0.5) if correct + wrong else 0
    verdict = "PASS" if score >= 80 and accuracy >= 70 else "REVIEW" if score >= 50 else "FAIL"
    return verdict, accuracy


def compare_attempt(connection, attempt):
    errors = set()
    if (not integer(attempt["score"], maximum=100)
            or not integer(attempt["correct_count"])
            or not integer(attempt["wrong_count"])):
        errors.add("attempt_totals_invalid")
    completed = moscow_date(attempt["completed_at"])
    if completed is None:
        errors.add("completion_date_invalid")
    try:
        base_ids = json.loads(attempt["base_question_ids"])
    except (TypeError, ValueError):
        base_ids = []
    if (not isinstance(base_ids, list) or len(base_ids) != BASE_COUNT
            or not all(integer(value, minimum=1) for value in base_ids)
            or len(set(base_ids)) != BASE_COUNT):
        errors.add("base_plan_invalid")
        base_ids = []

    facts = [dict(row) for row in connection.execute(
        FACTS_SQL, (attempt["bank_revision"], attempt["id"]))]
    ids = [fact["question_id"] for fact in facts]
    if len(ids) != len(set(ids)):
        errors.add("duplicate_ledger_or_answer")
    if connection.execute("""SELECT COUNT(*) FROM answers a WHERE a.attempt_id = ?
       AND NOT EXISTS (SELECT 1 FROM attempt_questions aq
         WHERE aq.attempt_id = a.attempt_id AND aq.question_id = a.question_id)""",
                          (attempt["id"],)).fetchone()[0]:
        errors.add("orphan_answers")

    groups = {kind: Counter() for kind in ("base", "additional")}
    difficulty_errors = {difficulty: {"base": 0, "additional": 0}
                         for difficulty in WEIGHTS}
    by_id = {fact["question_id"]: fact for fact in facts}
    source_ids = []
    ledger_awarded = 0
    for fact in facts:
        kind = fact["question_kind"]
        if kind not in groups:
            errors.add("question_kind_invalid")
            continue
        group = groups[kind]
        group["assigned"] += 1
        shown = fact["presented_at"] is not None
        resolved = fact["answer_id"] is not None
        group["shown"] += shown
        group["resolved"] += resolved
        value = fact["score_value"]
        difficulty = fact["difficulty"]
        if (fact["question_exists"] is None or fact["revision_membership"] != 1
                or difficulty not in WEIGHTS
                or fact["weight"] != WEIGHTS.get(difficulty)
                or not integer(value, minimum=1)
                or value != WEIGHTS.get(difficulty, 0) * (2 if kind == "base" else 1)):
            errors.add("question_ledger_invalid")
            continue
        group["maximum"] += value
        if kind == "base":
            if fact["source_question_id"] is not None:
                errors.add("base_source_invalid")
            if not resolved:
                errors.add("unresolved_base")
        else:
            source_id = fact["source_question_id"]
            source_ids.append(source_id)
            source = by_id.get(source_id)
            if (source is None or source["question_kind"] != "base"
                    or source["presented_at"] is None or source["is_correct"] != 0
                    or source["answer_origin"] not in {"submitted", "question_timeout"}
                    or source["difficulty"] != difficulty):
                errors.add("additional_source_invalid")
            if shown != resolved:
                errors.add("additional_presentation_partition_invalid")
        if shown and not resolved:
            errors.add("shown_question_unresolved")
        if not resolved:
            continue
        correct, timed_out = fact["is_correct"], fact["timed_out"]
        awarded = fact["awarded_score"]
        origin = fact["answer_origin"]
        if (fact["fact_version"] != 1 or correct not in (0, 1)
                or timed_out not in (0, 1) or (correct == 1 and timed_out == 1)
                or not integer(fact["elapsed_seconds"], maximum=30)
                or not integer(awarded, maximum=value)
                or (correct == 0 and awarded != 0)
                or (not fact["selection_missing"] and not fact["selection_valid"])):
            errors.add("answer_fact_invalid")
        if origin == "submitted":
            if (not shown or timed_out != 0 or fact["selection_missing"]
                    or not fact["submitted_verdict_matches"]):
                errors.add("submitted_answer_invalid")
        elif origin in {"question_timeout", "total_timeout_presented"}:
            if not shown or timed_out != 1 or correct != 0:
                errors.add("shown_timeout_invalid")
        elif origin == "total_timeout_unshown":
            if (shown or kind != "base" or timed_out != 1 or correct != 0
                    or not fact["selection_missing"] or fact["elapsed_seconds"] != 0):
                errors.add("unshown_timeout_invalid")
        else:
            errors.add("answer_origin_invalid")
        if integer(awarded):
            ledger_awarded += awarded
        if correct == 1:
            group["correct"] += 1
            group["earned"] += value
        elif timed_out == 1:
            group["timeouts"] += 1
            group["shownTimeouts" if shown else "unshownTimeouts"] += 1
        else:
            group["incorrect"] += 1
        if correct == 0 and shown:
            group["shownErrors"] += 1  # Includes shown timeouts.
            group["penalty"] += value // 2 if kind == "base" else value
            difficulty_errors[difficulty][kind] += 1

    base, additional = groups["base"], groups["additional"]
    base_facts = [fact for fact in facts if fact["question_kind"] == "base"]
    additional_facts = [fact for fact in facts if fact["question_kind"] == "additional"]
    if (base["assigned"] != BASE_COUNT or base["resolved"] != BASE_COUNT
            or set(base_ids) != {fact["question_id"] for fact in base_facts}
            or base["maximum"] != 100
            or Counter(fact["difficulty"] for fact in base_facts) != Counter(PLAN)):
        errors.add("base_ledger_plan_mismatch")
    if (sorted(fact["ordinal"] for fact in base_facts if integer(fact["ordinal"]))
            != list(range(1, BASE_COUNT + 1))
            or sorted(fact["ordinal"] for fact in additional_facts if integer(fact["ordinal"]))
            != list(range(BASE_COUNT + 1, BASE_COUNT + len(additional_facts) + 1))):
        errors.add("ledger_ordinals_invalid")
    if additional["assigned"] > MAX_ADDITIONAL or len(source_ids) != len(set(source_ids)):
        errors.add("additional_limit_or_chain_invalid")
    for group in groups.values():
        if group["correct"] + group["incorrect"] + group["timeouts"] != group["resolved"]:
            errors.add("outcome_partition_invalid")
    total_correct = base["correct"] + additional["correct"]
    total_wrong = sum(group["incorrect"] + group["timeouts"] for group in groups.values())
    if total_correct != attempt["correct_count"] or total_wrong != attempt["wrong_count"]:
        errors.add("attempt_answer_counts_mismatch")
    if ledger_awarded != attempt["score"]:
        errors.add("awarded_score_sum_mismatch")
    if min(100, base["earned"] + additional["earned"]) != attempt["score"]:
        errors.add("v2_score_reconstruction_mismatch")
    if not errors and attempt["verdict"] not in (None, old_verdict(
            attempt["score"], total_correct, total_wrong)[0]):
        errors.add("stored_verdict_mismatch")

    record = {"is_target": bool(attempt["is_target"]), "completedAtMoscow": completed,
              "valid": not errors,
              "oldScore": attempt["score"] if integer(attempt["score"], maximum=100) else None,
              "oldVerdict": attempt["verdict"] if attempt["verdict"] in VERDICTS else None}
    if errors:
        record.update(validationErrors=sorted(errors), newScore=None, newVerdict=None, delta=None)
        return record
    computed_old_verdict, accuracy = old_verdict(attempt["score"], total_correct, total_wrong)
    if record["oldVerdict"] is None:
        record["oldVerdict"] = computed_old_verdict
    raw = base["earned"] + additional["earned"] - base["penalty"] - additional["penalty"]
    new_score = max(0, min(attempt["base_max_score"], raw))
    new_verdict = ("PASS" if new_score >= 80 and base["correct"] >= 17
                   else "REVIEW" if new_score >= 50 else "FAIL")
    record.update(newScore=new_score, rawNewScore=raw, newVerdict=new_verdict,
                  delta=new_score - attempt["score"], oldAccuracy=accuracy,
                  earnedBase=base["earned"], earnedAdditional=additional["earned"],
                  basePenalty=base["penalty"], additionalPenalty=additional["penalty"],
                  baseAssigned=base["assigned"], baseCorrect=base["correct"],
                  baseAccuracy=100 * base["correct"] / BASE_COUNT,
                  shownErrors=base["shownErrors"] + additional["shownErrors"],
                  shownTimeouts=base["shownTimeouts"] + additional["shownTimeouts"],
                  unshownTimeouts=base["unshownTimeouts"] + additional["unshownTimeouts"],
                  counts={kind: {key: group[key] for key in (
                      "assigned", "shown", "resolved", "correct", "incorrect", "timeouts",
                      "shownErrors", "shownTimeouts", "unshownTimeouts")}
                          for kind, group in groups.items()},
                  difficultyErrors=difficulty_errors)
    return record


def compare_database(connection, target_names=()):
    """Use one snapshot. Caller owns the connection; preexisting transactions are rejected."""
    if connection.in_transaction:
        raise ValueError("existing_transaction")
    targets = {normalize_name(name) for name in target_names if name.strip()}
    def target_match(name):
        if not isinstance(name, str):
            return 0
        normalized = normalize_name(name)
        return int(any(normalized == target or normalized.startswith(target + " ")
                       for target in targets))
    connection.create_function("target_match", 1, target_match)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    try:
        buckets = {key: 0 for key in ("notCompleted", "demoNamespace", "unsupportedFactsVersion",
                                     "unsupportedScoringVersion", "unsupportedBaseMaximum", "eligible")}
        for row in connection.execute(EXCLUSIONS_SQL):
            buckets[row["bucket"]] = row["count"]
        records = [compare_attempt(connection, dict(row))
                   for row in connection.execute(ATTEMPTS_SQL).fetchall()]
        valid_records = [record for record in records if record["valid"]]
        valid = len(valid_records)
        distinct_candidates = connection.execute("""SELECT COUNT(DISTINCT NULLIF(candidate_key, ''))
          FROM attempts WHERE status = 'completed'
            AND substr(COALESCE(candidate_key, ''), 1, 8) != 'demo:v1:'
            AND analytics_facts_version = 1 AND scoring_version = 2 AND base_max_score = 100""").fetchone()[0]
        transitions = Counter((record["oldVerdict"], record["newVerdict"])
                              for record in valid_records)
        target_count = sum(record["is_target"] for record in records)
        summary = {"eligibleAttempts": len(records), "distinctCandidates": distinct_candidates,
                   "targetMatchedAttempts": target_count, "targetMultipleMatches": target_count > 1,
                   "oldVerdicts": {verdict: sum(record["oldVerdict"] == verdict for record in valid_records)
                                   for verdict in ("PASS", "REVIEW", "FAIL")},
                   "newVerdicts": {verdict: sum(record["newVerdict"] == verdict for record in valid_records)
                                   for verdict in ("PASS", "REVIEW", "FAIL")},
                   "transitions": [{"oldVerdict": old, "newVerdict": new, "count": count}
                                   for (old, new), count in sorted(transitions.items())],
                   "meanOldScore": round(sum(record["oldScore"] for record in valid_records) / valid, 2) if valid else None,
                   "meanNewScore": round(sum(record["newScore"] for record in valid_records) / valid, 2) if valid else None,
                   "meanDrop": round(-sum(record["delta"] for record in valid_records) / valid, 2) if valid else None,
                   "maximumDrop": max((-record["delta"] for record in valid_records), default=None)}
        return {"readOnly": True, "comparisonModel": "proposed-v3-weighted-penalties",
                "formula": {"baseCorrect": "+score_value", "baseShownWrong": "-score_value/2",
                            "additionalCorrect": "+score_value", "additionalShownWrong": "-score_value",
                            "unshownTimeout": 0, "finalClamp": [0, 100],
                            "passMinimumScore": 80, "passMinimumBaseCorrect": 17,
                            "reviewMinimumScore": 50},
                "counts": {"totalAttempts": sum(buckets.values()), "eligible": buckets.pop("eligible"),
                           "valid": valid, "invalid": len(records) - valid, "excluded": buckets},
                "summary": summary, "attempts": records}
    finally:
        connection.rollback()


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("invalid_arguments")


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("database", metavar="DB_PATH")
    parser.add_argument("--target-name", action="append", default=[], metavar="NAME",
                        help="Match locally; only an is_target boolean is emitted. Repeat for variants.")
    try:
        args = parser.parse_args(argv)
        db_path = Path(args.database).resolve(strict=True)
        if not db_path.is_file():
            raise ValueError("database_not_file")
        # Path.as_uri() quotes reserved characters. mode=ro also prevents creation
        # of a nonexistent database. Do not replace this with an ordinary path.
        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
            report = compare_database(connection, args.target_name)
        json.dump(report, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except (sqlite3.Error, OSError, ValueError, TypeError):
        # Exceptions can contain paths or DB values; never echo them remotely.
        json.dump({"error": "comparison_failed", "readOnly": True}, sys.stdout)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
