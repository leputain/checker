#!/usr/bin/env python3
"""Read-only SQLite fingerprints, with no row values, identifiers or paths emitted.

Usage: python3 - capture DB_PATH
       python3 - compare DB_PATH EXPECTED_JSON_PATH [--scope all|application|business]
       python3 - export DB_PATH PRIVATE_OUTPUT.sql
The source may be sent through stdin. Import capture() / compare_manifests() for
reuse. Callers must stop writers for a cutover proof; a read snapshot alone does
not prove that another process has stopped writing.
"""

import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


FORMAT_VERSION = 1
TABLE_GROUPS = {
    "business": (
        "answers", "attempt_questions", "attempts", "question_bank_change_events",
        "question_bank_change_set_items", "question_bank_change_sets", "question_bank_mutations",
        "question_bank_revision_items", "question_bank_revisions", "question_bank_state",
        "question_categories", "question_review_history", "question_version_links", "questions",
        "schema_migrations", "security_challenge_attempts", "security_challenge_configs",
        "security_challenge_feedback", "security_challenge_question_events", "telegram_outbox",
        "test_config_versions",
    ),
    "derived": (
        "analytics_candidate_aggregates", "analytics_candidate_dimensions",
        "analytics_daily_choice_aggregates", "analytics_daily_question_aggregates",
        "analytics_daily_timing_aggregates", "analytics_refresh_state", "analytics_report_aggregates",
    ),
    "runtime": ("telegram_delivery_state",),
    "internal": ("_cf_METADATA", "sqlite_sequence", "sqlite_stat1", "sqlite_stat4"),
}
REQUIRED_TABLES = set().union(*(set(TABLE_GROUPS[key]) for key in ("business", "derived", "runtime")))
KNOWN_TABLES = REQUIRED_TABLES | set(TABLE_GROUPS["internal"])


class ManifestError(Exception):
    """A stable, non-sensitive error code; never use raw SQLite exceptions as output."""


def quote_identifier(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def typed_value(value):
    # Tag every SQLite storage class. 1, 1.0, "1", b"1" and NULL differ.
    if value is None:
        return ["null"]
    if type(value) is int:
        return ["integer", str(value)]
    if type(value) is float:
        return ["real", value.hex()]
    if type(value) is str:
        return ["text", value]
    if type(value) is bytes:
        return ["blob", value.hex()]
    raise ManifestError("unsupported_storage_class")


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")


def digest_frames(frames):
    digest = hashlib.sha256()
    for frame in frames:
        digest.update(len(frame).to_bytes(8, "big"))
        digest.update(frame)
    return digest.hexdigest()


def fingerprint_table(connection, table, business=False):
    columns = connection.execute("PRAGMA table_xinfo(" + quote_identifier(table) + ")").fetchall()
    if not columns:
        raise ManifestError("table_columns_unavailable")
    names = [column[1] for column in columns]
    keys = [column[1] for column in sorted(columns, key=lambda column: column[5]) if column[5]]
    if business and not keys:
        raise ManifestError("business_primary_key_missing")
    schema = canonical_bytes([list(column) for column in columns])
    select = "SELECT " + ",".join(map(quote_identifier, names)) + " FROM " + quote_identifier(table)
    # Sort canonical PK bytes, not insertion order, rowid or locale collation.
    # The complete typed row breaks ties for internal tables without a PK.
    key_indexes = [names.index(key) for key in keys]
    encoded = []
    seen_keys = set()
    for row in connection.execute(select):
        key = canonical_bytes([typed_value(row[index]) for index in key_indexes])
        if business:
            if any(row[index] is None for index in key_indexes) or key in seen_keys:
                raise ManifestError("business_primary_key_invalid")
            seen_keys.add(key)
        encoded.append((key, canonical_bytes([typed_value(value) for value in row])))
    encoded.sort()
    return {"count": len(encoded), "sha256": digest_frames([schema] + [row for _, row in encoded])}


def capture(connection, snapshot_callback=None):
    """Hash all recognized tables in one read transaction. Never emit row values."""
    if connection.in_transaction:
        raise ManifestError("existing_transaction")
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    try:
        actual = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")}
        if actual - KNOWN_TABLES:
            raise ManifestError("unclassified_tables")
        if REQUIRED_TABLES - actual:
            raise ManifestError("required_tables_missing")
        schema_rows = connection.execute("""SELECT type, name, tbl_name, sql FROM sqlite_schema
            WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name""").fetchall()
        # Preserve schema and constraint definitions too. Internal SQLite/CF
        # structures stay in the internal group, not the business schema hash.
        schemas = {key: [] for key in TABLE_GROUPS}
        for row in schema_rows:
            matched = False
            for group, tables in TABLE_GROUPS.items():
                if row[2] in tables:
                    schemas[group].append(canonical_bytes([typed_value(value) for value in row]))
                    matched = True
                    break
            if not matched:
                raise ManifestError("unclassified_schema_object")
        groups = {}
        for group, tables in TABLE_GROUPS.items():
            entries = {table: fingerprint_table(connection, table, business=group == "business")
                       for table in tables if table in actual}
            groups[group] = {"tables": entries,
                             "count": sum(entry["count"] for entry in entries.values()),
                             "schemaSha256": digest_frames(schemas[group]),
                             "sha256": hashlib.sha256(canonical_bytes(entries)).hexdigest()}
        manifest = {"formatVersion": FORMAT_VERSION, "groups": groups}
        if snapshot_callback is not None:
            snapshot_callback(connection, manifest)
        return manifest
    finally:
        connection.rollback()


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get("formatVersion") != FORMAT_VERSION:
        raise ManifestError("manifest_format_invalid")
    groups = manifest.get("groups")
    if not isinstance(groups, dict) or set(groups) != set(TABLE_GROUPS):
        raise ManifestError("manifest_groups_invalid")
    for group, allowed in TABLE_GROUPS.items():
        content = groups[group]
        if not isinstance(content, dict) or not isinstance(content.get("tables"), dict):
            raise ManifestError("manifest_tables_invalid")
        tables = content["tables"]
        if set(tables) - set(allowed) or (group != "internal" and set(tables) != set(allowed)):
            raise ManifestError("manifest_tables_invalid")
        for entry in [content] + list(tables.values()):
            if (not isinstance(entry, dict) or type(entry.get("count")) is not int or entry["count"] < 0
                    or not is_digest(entry.get("sha256"))):
                raise ManifestError("manifest_fingerprint_invalid")
        if not is_digest(content.get("schemaSha256")):
            raise ManifestError("manifest_fingerprint_invalid")
        if content["count"] != sum(entry["count"] for entry in tables.values()):
            raise ManifestError("manifest_totals_invalid")
        if content["sha256"] != hashlib.sha256(canonical_bytes(tables)).hexdigest():
            raise ManifestError("manifest_totals_invalid")


def is_digest(value):
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def sql_literal(value):
    if value is None:
        return "NULL"
    if type(value) is int:
        return str(value)
    if type(value) is float:
        if math.isinf(value):
            return "9e999" if value > 0 else "-9e999"
        if math.isnan(value):
            raise ManifestError("unsupported_real_value")
        return repr(value)
    if type(value) is str:
        # Hex text also preserves embedded NULs and avoids SQL quoting ambiguity.
        return "CAST(X'" + value.encode("utf-8").hex() + "' AS TEXT)"
    if type(value) is bytes:
        return "X'" + value.hex() + "'"
    raise ManifestError("unsupported_storage_class")


def export_sql(connection, destination):
    """Export all 29 application tables to a newly created private file.

    The database remains read-only. CF vendor metadata is excluded; SQLite
    autoincrement counters are preserved. Import into an initialized, empty
    application D1 while its writers are stopped, then compare fingerprints.
    This is a raw SQL transport, never a retention/restore operation.
    """
    destination = Path(destination)
    if destination.suffix.lower() != ".sql":
        raise ManifestError("sql_destination_invalid")
    created = False
    sql_digest = hashlib.sha256()

    def write_snapshot(db, manifest):
        nonlocal created
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as output:
            def write(statement):
                chunk = (statement + "\n").encode("utf-8")
                output.write(chunk)
                sql_digest.update(chunk)

            write("PRAGMA foreign_keys=OFF;")
            write("BEGIN TRANSACTION;")
            tables = sorted(REQUIRED_TABLES)
            for table in tables:
                ddl = db.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone()[0]
                write(ddl.rstrip(";") + ";")
            for table in tables:
                columns = db.execute("PRAGMA table_xinfo(" + quote_identifier(table) + ")").fetchall()
                writable = [column[1] for column in columns if column[6] == 0]
                names = ",".join(map(quote_identifier, writable))
                for row in db.execute("SELECT " + names + " FROM " + quote_identifier(table)):
                    write("INSERT INTO " + quote_identifier(table) + "(" + names + ") VALUES(" +
                          ",".join(sql_literal(value) for value in row) + ");")
            # Counters may exceed MAX(id) after deletions; recreating them from
            # current rows alone could reissue an old business identifier.
            if "sqlite_sequence" in manifest["groups"]["internal"]["tables"]:
                write("DELETE FROM sqlite_sequence;")
                for row in db.execute("SELECT name,seq FROM sqlite_sequence ORDER BY name"):
                    write("INSERT INTO sqlite_sequence(name,seq) VALUES(" +
                          ",".join(sql_literal(value) for value in row) + ");")
            for kind in ("index", "trigger"):
                for table in tables:
                    for row in db.execute("SELECT sql FROM sqlite_schema WHERE type=? AND tbl_name=? AND sql IS NOT NULL ORDER BY name", (kind, table)):
                        write(row[0].rstrip(";") + ";")
            write("COMMIT;")
            write("PRAGMA foreign_keys=ON;")
            output.flush()
            os.fsync(output.fileno())

    try:
        manifest = capture(connection, write_snapshot)
        return {**manifest, "exported": True, "sqlSha256": sql_digest.hexdigest()}
    except Exception:
        if created:
            destination.unlink(missing_ok=True)
        raise


def compare_manifests(expected, actual, scope="all"):
    validate_manifest(expected)
    validate_manifest(actual)
    if scope not in ("all", "application", "business"):
        raise ManifestError("comparison_scope_invalid")
    groups = {}
    for group in TABLE_GROUPS:
        before, after = expected["groups"][group], actual["groups"][group]
        changed = [table for table in TABLE_GROUPS[group]
                   if before["tables"].get(table) != after["tables"].get(table)]
        groups[group] = {"identical": not changed and before["schemaSha256"] == after["schemaSha256"],
                         "changedTables": changed, "expectedCount": before["count"], "actualCount": after["count"],
                         "schemaIdentical": before["schemaSha256"] == after["schemaSha256"]}
    if scope == "all":
        selected = list(groups.values())
    elif scope == "application":
        selected = [groups[key] for key in ("business", "derived", "runtime")]
    else:
        selected = [groups["business"]]
    sequence_identical = (expected["groups"]["internal"]["tables"].get("sqlite_sequence")
                          == actual["groups"]["internal"]["tables"].get("sqlite_sequence"))
    return {"formatVersion": FORMAT_VERSION, "scope": scope,
            "identical": all(group["identical"] for group in selected)
                         and (scope != "application" or sequence_identical),
            "sqliteSequenceIdentical": sequence_identical, "groups": groups}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ManifestError("arguments_invalid")


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("command", choices=("capture", "compare", "export"))
    parser.add_argument("database", metavar="DB_PATH")
    parser.add_argument("expected", nargs="?", metavar="EXPECTED_JSON_PATH")
    parser.add_argument("--scope", choices=("all", "application", "business"), default="all")
    try:
        args = parser.parse_args(argv)
        if (args.command in ("compare", "export")) != (args.expected is not None):
            raise ManifestError("arguments_invalid")
        if args.command != "compare" and args.scope != "all":
            raise ManifestError("arguments_invalid")
        path = Path(args.database).resolve(strict=True)
        if not path.is_file():
            raise ManifestError("database_invalid")
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as connection:
            result = export_sql(connection, args.expected) if args.command == "export" else capture(connection)
        if args.command == "compare":
            expected_path = Path(args.expected)
            if expected_path.stat().st_size > 256 * 1024:
                raise ManifestError("manifest_size_invalid")
            expected = json.loads(expected_path.read_text(encoding="utf-8-sig"))
            result = compare_manifests(expected, result, args.scope)
        json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0 if args.command in ("capture", "export") or result["identical"] else 2
    except ManifestError as error:
        result = {"error": str(error)}
    except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError):
        result = {"error": "manifest_failed"}
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
