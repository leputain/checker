#!/usr/bin/env python3
"""Synthetic fixtures only; no project runtime or production SQLite is opened."""

import contextlib
import io
import json
import sqlite3
import tempfile
import types
import unittest
from pathlib import Path


MODULE = types.ModuleType("sqlite_business_manifest")
SOURCE = Path(__file__).with_name("sqlite-business-manifest.py")
exec(compile(SOURCE.read_text(encoding="utf-8"), str(SOURCE), "exec"), MODULE.__dict__)


def populate(connection, reverse=False):
    for table in sorted(MODULE.REQUIRED_TABLES):
        quoted = MODULE.quote_identifier(table)
        connection.execute("CREATE TABLE " + quoted + " (a TEXT, b INTEGER, payload, PRIMARY KEY(a,b))")
        rows = [("synthetic-private-name", 1, None), ("synthetic-private-key", 2, 1),
                ("synthetic-private-key", 3, 1.0), ("synthetic-private-token", 4, b"secret-blob"),
                ("synthetic-private-payload", 5, '{"token":"private-json"}')]
        connection.executemany("INSERT INTO " + quoted + " VALUES (?,?,?)", list(reversed(rows)) if reverse else rows)
    connection.commit()


class ManifestTests(unittest.TestCase):
    def database(self, reverse=False):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        populate(connection, reverse)
        return connection

    def test_all_tables_fields_storage_types_and_insertion_order(self):
        first = MODULE.capture(self.database())
        second = MODULE.capture(self.database(reverse=True))
        self.assertEqual(first, second)
        self.assertTrue(MODULE.compare_manifests(first, second)["identical"])
        self.assertEqual(len(first["groups"]["business"]["tables"]), 21)
        self.assertEqual(len(first["groups"]["derived"]["tables"]), 7)
        self.assertEqual(len(first["groups"]["runtime"]["tables"]), 1)
        rendered = json.dumps(first)
        for private in ("synthetic-private", "secret-blob", "private-json", "payload", "PRIMARY KEY"):
            self.assertNotIn(private, rendered)
        self.assertNotEqual(MODULE.typed_value(1), MODULE.typed_value(1.0))
        self.assertNotEqual(MODULE.typed_value(None), MODULE.typed_value(""))

    def test_outbox_payload_and_delivery_column_changes_are_protected(self):
        for mutation in ("UPDATE telegram_outbox SET payload = 'changed-body' WHERE b = 5",
                         "UPDATE telegram_outbox SET b = 99 WHERE b = 5"):
            with self.subTest(mutation=mutation):
                connection = self.database()
                before = MODULE.capture(connection)
                connection.execute("PRAGMA query_only = OFF")
                connection.execute(mutation)
                connection.commit()
                report = MODULE.compare_manifests(before, MODULE.capture(connection))
                self.assertFalse(report["identical"])
                self.assertEqual(report["groups"]["business"]["changedTables"], ["telegram_outbox"])

    def test_derived_runtime_and_internal_are_explicitly_separate(self):
        connection = self.database()
        before = MODULE.capture(connection)
        connection.execute("PRAGMA query_only = OFF")
        connection.execute("UPDATE telegram_delivery_state SET payload = 'lease-change' WHERE b = 1")
        connection.execute("CREATE TABLE _cf_METADATA(key TEXT PRIMARY KEY, value BLOB)")
        connection.execute("INSERT INTO _cf_METADATA VALUES ('fixture-only', X'01')")
        connection.commit()
        after = MODULE.capture(connection)
        all_report = MODULE.compare_manifests(before, after)
        self.assertFalse(all_report["identical"])
        self.assertTrue(all_report["groups"]["business"]["identical"])
        self.assertFalse(all_report["groups"]["runtime"]["identical"])
        self.assertFalse(all_report["groups"]["internal"]["identical"])
        self.assertTrue(MODULE.compare_manifests(before, after, "business")["identical"])
        self.assertFalse(MODULE.compare_manifests(before, after, "application")["identical"],
                         "application gate must protect the runtime delivery row")

    def test_unknown_table_missing_table_and_schema_drift_fail_closed(self):
        connection = self.database()
        before = MODULE.capture(connection)
        connection.execute("PRAGMA query_only = OFF")
        connection.execute("ALTER TABLE telegram_outbox ADD COLUMN new_delivery_field TEXT")
        connection.commit()
        report = MODULE.compare_manifests(before, MODULE.capture(connection))
        self.assertFalse(report["groups"]["business"]["schemaIdentical"])
        connection.execute("PRAGMA query_only = OFF")
        connection.execute("CREATE TABLE unknown_sensitive_table(id INTEGER PRIMARY KEY)")
        connection.commit()
        with self.assertRaisesRegex(MODULE.ManifestError, "unclassified_tables"):
            MODULE.capture(connection)
        connection.execute("PRAGMA query_only = OFF")
        connection.execute("DROP TABLE unknown_sensitive_table")
        connection.execute("DROP TABLE attempts")
        connection.commit()
        with self.assertRaisesRegex(MODULE.ManifestError, "required_tables_missing"):
            MODULE.capture(connection)

    def test_read_only_uri_cli_compare_and_error_privacy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private # fixture.sqlite"
            with contextlib.closing(sqlite3.connect(path)) as connection:
                populate(connection)
            original = path.read_bytes()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main(["capture", str(path)]), 0)
            manifest = Path(directory) / "expected.json"
            manifest.write_text(output.getvalue(), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main(["compare", str(path), str(manifest)]), 0)
            self.assertTrue(json.loads(output.getvalue())["identical"])
            self.assertEqual(path.read_bytes(), original)
            missing = Path(directory) / "private-nonexistent.sqlite"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main(["capture", str(missing)]), 1)
            self.assertEqual(json.loads(output.getvalue()), {"error": "manifest_failed"})
            self.assertFalse(missing.exists())
            self.assertNotIn(str(path), output.getvalue())

    def test_query_only_snapshot_and_invalid_expected_digest(self):
        connection = self.database()
        before_changes = connection.total_changes
        manifest = MODULE.capture(connection)
        self.assertFalse(connection.in_transaction)
        self.assertEqual(connection.total_changes, before_changes)
        with self.assertRaises(sqlite3.OperationalError):
            connection.execute("DELETE FROM attempts")
        malformed = json.loads(json.dumps(manifest))
        malformed["groups"]["business"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(MODULE.ManifestError, "manifest_totals_invalid"):
            MODULE.compare_manifests(malformed, manifest)

    def test_private_sql_transfer_preserves_all_columns_types_and_constraints(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = self.database()
            before = MODULE.capture(connection)
            exported = Path(directory) / "private-transfer.sql"
            result = MODULE.export_sql(connection, exported)
            self.assertTrue(result["exported"])
            self.assertEqual(result["groups"], before["groups"])
            if __import__("os").name != "nt":
                self.assertEqual(exported.stat().st_mode & 0o777, 0o600)
            with contextlib.closing(sqlite3.connect(":memory:")) as restored:
                restored.executescript(exported.read_text(encoding="utf-8"))
                after = MODULE.capture(restored)
                self.assertTrue(MODULE.compare_manifests(before, after)["identical"])
            self.assertNotIn("synthetic-private", json.dumps(result))
            with self.assertRaises(FileExistsError):
                MODULE.export_sql(connection, exported)
            self.assertTrue(exported.exists(), "refusing overwrite must not delete an existing backup")

    def test_sql_transfer_preserves_deleted_high_water_autoincrement_and_nul_text(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = self.database()
            connection.execute("DROP TABLE answers")
            connection.execute("CREATE TABLE answers(id INTEGER PRIMARY KEY AUTOINCREMENT, payload)")
            connection.execute("INSERT INTO answers(id,payload) VALUES(1,?)", ("fixture\x00UTF-8: тест",))
            connection.execute("INSERT INTO answers(id,payload) VALUES(42,NULL)")
            connection.execute("DELETE FROM answers WHERE id=42")
            connection.commit()
            before = MODULE.capture(connection)
            exported = Path(directory) / "private-sequence-transfer.sql"
            MODULE.export_sql(connection, exported)
            with contextlib.closing(sqlite3.connect(":memory:")) as restored:
                restored.executescript(exported.read_text(encoding="utf-8"))
                self.assertTrue(MODULE.compare_manifests(before, MODULE.capture(restored))["identical"])
                restored.execute("PRAGMA query_only=OFF")
                restored.execute("INSERT INTO answers(payload) VALUES('next-fixture')")
                self.assertEqual(restored.execute("SELECT MAX(id) FROM answers").fetchone()[0], 43)


if __name__ == "__main__":
    unittest.main(verbosity=2)
