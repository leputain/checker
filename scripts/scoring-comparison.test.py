#!/usr/bin/env python3
"""Synthetic SQLite tests; never open a project runtime/production database."""

import contextlib
import io
import json
import sqlite3
import tempfile
import types
import unittest
from pathlib import Path


MODULE = types.ModuleType("scoring_comparison")
SOURCE = Path(__file__).with_name("scoring-comparison.py")
exec(compile(SOURCE.read_text(encoding="utf-8"), str(SOURCE), "exec"), MODULE.__dict__)

SCHEMA = """
CREATE TABLE attempts(id TEXT PRIMARY KEY, candidate_name TEXT, candidate_key TEXT,
 status TEXT, analytics_facts_version INTEGER, scoring_version INTEGER,
 base_max_score INTEGER, score INTEGER, correct_count INTEGER, wrong_count INTEGER,
 verdict TEXT, completed_at INTEGER, base_question_ids TEXT, bank_revision TEXT,
 public_alias TEXT, token_hash TEXT);
CREATE TABLE questions(id INTEGER PRIMARY KEY, difficulty TEXT, weight INTEGER,
 choices_json TEXT, correct_index INTEGER, prompt TEXT);
CREATE TABLE question_bank_revision_items(revision_hash TEXT, question_id INTEGER, active INTEGER);
CREATE TABLE attempt_questions(attempt_id TEXT, question_id INTEGER, question_kind TEXT,
 ordinal INTEGER, source_question_id INTEGER, score_value INTEGER, presented_at INTEGER);
CREATE TABLE answers(id INTEGER PRIMARY KEY, attempt_id TEXT, question_id INTEGER,
 fact_version INTEGER, answer_origin TEXT, is_correct INTEGER, timed_out INTEGER,
 elapsed_seconds INTEGER, awarded_score INTEGER, canonical_selected_index INTEGER);
"""


def fixture(connection, errors=(), additional_wrong=(), base_timeouts=(),
            unshown=(), additional_timeouts=()):
    """The public 5/7/7/1 plan, with an additional for each shown base mistake."""
    difficulties = [difficulty for difficulty, count in MODULE.PLAN.items() for _ in range(count)]
    base_ids = list(range(1, 21))
    wrong = set(errors) | set(base_timeouts) | set(unshown)
    total_correct = total_wrong = score = 0
    rows = []
    for question_id, difficulty in zip(base_ids, difficulties):
        value = 2 * MODULE.WEIGHTS[difficulty]
        correct = question_id not in wrong
        timed_out = question_id in set(base_timeouts) | set(unshown)
        shown = question_id not in unshown
        origin = "submitted" if not timed_out else "question_timeout" if shown else "total_timeout_unshown"
        rows.append((question_id, difficulty, "base", question_id, None, value,
                     shown, correct, timed_out, origin))
    for ordinal, source_id in enumerate(sorted(wrong - set(unshown)), start=21):
        difficulty = difficulties[source_id - 1]
        correct = source_id not in set(additional_wrong) | set(additional_timeouts)
        timed_out = source_id in additional_timeouts
        rows.append((ordinal, difficulty, "additional", ordinal, source_id,
                     MODULE.WEIGHTS[difficulty], True, correct, timed_out,
                     "question_timeout" if timed_out else "submitted"))
    for question_id, difficulty, kind, ordinal, source_id, value, shown, correct, timed_out, origin in rows:
        connection.execute("INSERT INTO questions VALUES (?, ?, ?, ?, 0, ?)", (
            question_id, difficulty, MODULE.WEIGHTS[difficulty],
            json.dumps(["private-choice-one", "private-choice-two"]), "private-prompt"))
        connection.execute("INSERT INTO question_bank_revision_items VALUES ('bank-fixture', ?, 1)", (question_id,))
        connection.execute("INSERT INTO attempt_questions VALUES ('private-attempt-id', ?, ?, ?, ?, ?, ?)", (
            question_id, kind, ordinal, source_id, value, 1 if shown else None))
        connection.execute("INSERT INTO answers VALUES (?, 'private-attempt-id', ?, 1, ?, ?, ?, ?, ?, ?)", (
            question_id, question_id, origin, int(correct), int(timed_out),
            0 if not shown else 30 if timed_out else 5,
            value if correct else 0, None if timed_out else 0 if correct else 1))
        total_correct += correct
        total_wrong += not correct
        score += value if correct else 0
    verdict, _ = MODULE.old_verdict(score, total_correct, total_wrong)
    connection.execute("INSERT INTO attempts VALUES (?, ?, ?, 'completed', 1, 2, 100, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (
        "private-attempt-id", "Synthetic Person", "private-candidate-key", score,
        total_correct, total_wrong, verdict, 1_791_622_800_000,
        json.dumps(base_ids), "bank-fixture", "private-public-alias", "private-token-hash"))
    connection.commit()


class ComparisonTests(unittest.TestCase):
    def database(self, **kwargs):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript(SCHEMA)
        fixture(connection, **kwargs)
        return connection

    def compare(self, **kwargs):
        report = MODULE.compare_database(self.database(**kwargs), ["  SYNTHETIC person "])
        record = report["attempts"][0]
        self.assertTrue(record["valid"], record.get("validationErrors"))
        return record

    def test_three_current_nineties_split_by_base_gate(self):
        for errors, base_correct, verdict in (
                ((20,), 19, "PASS"),
                ((6, 7, 8, 9, 10), 15, "REVIEW"),
                ((1, 2, 3, 4, 5, 6, 13), 13, "REVIEW")):
            with self.subTest(errors=errors):
                record = self.compare(errors=errors)
                self.assertEqual((record["oldScore"], record["newScore"], record["delta"]), (90, 80, -10))
                self.assertEqual(record["baseCorrect"], base_correct)
                self.assertEqual(record["newVerdict"], verdict)
                self.assertEqual(record["basePenalty"], 10)

    def test_additional_wrong_and_shown_timeouts_have_weighted_penalties(self):
        for kwargs in ({"errors": (20,), "additional_wrong": (20,)},
                       {"base_timeouts": (20,), "additional_timeouts": (20,)}):
            record = self.compare(**kwargs)
            self.assertEqual((record["oldScore"], record["newScore"]), (80, 60))
            self.assertEqual((record["basePenalty"], record["additionalPenalty"]), (10, 10))
            self.assertEqual(record["shownErrors"], 2)
            self.assertEqual(record["newVerdict"], "REVIEW")
        self.assertEqual(record["shownTimeouts"], 2)

    def test_unshown_timeout_forfeits_reward_without_penalty(self):
        record = self.compare(unshown=(20,))
        self.assertEqual((record["oldScore"], record["newScore"]), (80, 80))
        self.assertEqual(record["basePenalty"], 0)
        self.assertEqual(record["unshownTimeouts"], 1)
        self.assertEqual(record["shownErrors"], 0)

    def test_final_clamp_preserves_negative_raw_total(self):
        # Ten shown errors are the remedial limit; the remaining base questions
        # were never shown at the total deadline and earn zero without penalty.
        record = self.compare(errors=tuple(range(11, 21)), additional_wrong=tuple(range(11, 21)),
                              unshown=tuple(range(1, 11)))
        self.assertLess(record["rawNewScore"], 0)
        self.assertEqual(record["newScore"], 0)
        self.assertEqual(record["newVerdict"], "FAIL")

    def test_corrupt_facts_refuse_exact_calculation(self):
        for mutation, expected in (
                ("UPDATE answers SET awarded_score = 0 WHERE id = 1", "awarded_score_sum_mismatch"),
                ("UPDATE attempts SET wrong_count = 1", "attempt_answer_counts_mismatch"),
                ("DELETE FROM answers WHERE id = 1", "unresolved_base"),
                ("UPDATE attempt_questions SET ordinal = 2 WHERE question_id = 1", "ledger_ordinals_invalid"),
                ("UPDATE answers SET fact_version = 0 WHERE id = 1", "answer_fact_invalid"),
                ("UPDATE attempts SET verdict = 'FAIL'", "stored_verdict_mismatch")):
            with self.subTest(mutation=mutation):
                connection = self.database()
                connection.execute(mutation)
                connection.commit()
                record = MODULE.compare_database(connection)["attempts"][0]
                self.assertFalse(record["valid"])
                self.assertIn(expected, record["validationErrors"])
                self.assertIsNone(record["newScore"])
                self.assertIsNone(record["delta"])

    def test_exclusions_privacy_snapshot_and_query_only(self):
        connection = self.database()
        for suffix, column, value in (("demo", "candidate_key", "demo:v1:anything"),
                                      ("legacy", "analytics_facts_version", 0),
                                      ("old-score", "scoring_version", 1),
                                      ("old-max", "base_max_score", 50),
                                      ("active", "status", "active")):
            connection.execute("INSERT INTO attempts SELECT id || ?, candidate_name, candidate_key, status, "
                               "analytics_facts_version, scoring_version, base_max_score, score, correct_count, "
                               "wrong_count, verdict, completed_at, base_question_ids, bank_revision, public_alias, "
                               "token_hash FROM attempts WHERE id = 'private-attempt-id'", (suffix,))
            connection.execute("UPDATE attempts SET " + column + " = ? WHERE id = ?", (value, "private-attempt-id" + suffix))
        connection.commit()
        before = connection.total_changes
        report = MODULE.compare_database(connection, ["Synthetic Person"])
        self.assertEqual(report["counts"]["eligible"], 1)
        self.assertEqual(report["counts"]["valid"], 1)
        self.assertEqual(report["summary"]["distinctCandidates"], 1)
        self.assertEqual(report["summary"]["meanDrop"], 0)
        self.assertEqual(list(report["counts"]["excluded"].values()), [1, 1, 1, 1, 1])
        encoded = json.dumps(report)
        for private in ("private-attempt-id", "private-candidate-key", "Synthetic Person", "private-public-alias",
                        "private-token-hash", "private-prompt", "private-choice-one", "bank-fixture"):
            self.assertNotIn(private, encoded)
        self.assertTrue(report["attempts"][0]["is_target"])
        self.assertEqual(connection.total_changes, before)
        self.assertFalse(connection.in_transaction)
        with self.assertRaises(sqlite3.OperationalError):
            connection.execute("UPDATE attempts SET score = 0")

    def test_target_matches_name_prefix_and_reports_multiple_matches(self):
        connection = self.database()
        connection.execute("UPDATE attempts SET candidate_name = 'Synthetic Person Family'")
        connection.commit()
        report = MODULE.compare_database(connection, ["Synthetic Person"])
        self.assertTrue(report["attempts"][0]["is_target"])
        self.assertEqual(report["summary"]["targetMatchedAttempts"], 1)
        self.assertFalse(report["summary"]["targetMultipleMatches"])

    def test_read_only_uri_cli_and_failure_do_not_expose_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic # database.sqlite"
            connection = sqlite3.connect(path)
            connection.executescript(SCHEMA)
            fixture(connection)
            connection.close()
            before = path.read_bytes()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main([str(path), "--target-name", "Synthetic Person"]), 0)
            self.assertTrue(json.loads(output.getvalue())["attempts"][0]["is_target"])
            self.assertEqual(path.read_bytes(), before)
            missing = Path(directory) / "private-missing.sqlite"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main([str(missing)]), 1)
            self.assertFalse(missing.exists())
            self.assertEqual(json.loads(output.getvalue()), {"error": "comparison_failed", "readOnly": True})


if __name__ == "__main__":
    unittest.main(verbosity=2)
