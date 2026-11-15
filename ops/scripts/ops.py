#!/usr/bin/env python3
"""Explicit, fail-closed release and offline recovery tools (Python standard library)."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import platform
import struct
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone


FORMAT = 1
# Table-digest algorithm stored in databaseState.rowDigestFormat. The token binds the
# COPY query, UTF8/"C" ordering, the session rendering settings and the LF record
# terminator; changing any of them needs a new token, never a reuse of this one.
ROW_DIGEST_FORMAT = "pg-row-json-copytext-c-utf8-lf-v1"
LEGACY_ROW_DIGEST = "legacy-psql-copy-unversioned"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
SEQUENCE_VALUE = re.compile(r"-?[0-9]+")
ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
DB_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,62}$")
PRIVATE_NAMES = {"config.json", "admin_user.json", ".env", ".pgpass"}
CATALOG_LANGUAGES = ("zh", "ja", "en", "ko")


class OpsError(Exception):
    def __init__(self, message, category=None, details=None):
        super().__init__(message)
        # Controlled diagnosis only: a category and object names, never row text,
        # digests, credentials or raw tool stderr.
        self.category = category
        self.details = details


def require(condition, message, category=None):
    if not condition:
        raise OpsError(message, category)


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path, unique_keys=False):
    def unique(pairs):
        # json.loads keeps the last duplicate silently; a manifest that says two things
        # under one key must not be interpreted by whichever value happens to win.
        require(len({key for key, _ in pairs}) == len(pairs), "JSON object repeats a key", "invalid-manifest")
        return dict(pairs)

    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=unique if unique_keys else None)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def new_private_directory(path, parents=False):
    # Python 3.13 maps mkdir(0700) to a restrictive Windows ACL that can exclude
    # restricted service tokens. Windows inherits an operator-protected parent ACL;
    # Linux directly enforces owner-only access for private backups.
    checked_destination(path).mkdir(parents=parents, mode=0o777 if os.name == "nt" else 0o700)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def run(command, *, env=None, cwd=None, allowed=(0,), input_bytes=None):
    # Never use a shell; passwords only live in inherited PG environment/.pgpass.
    process = subprocess.run([str(item) for item in command], cwd=cwd, env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, input=input_bytes)
    if process.returncode not in allowed:
        # Tool errors may contain SQL/host details: leave them on the operator's terminal,
        # but do not copy them to a public manifest or print connection environment.
        message = process.stderr.decode("utf-8", errors="replace").strip()
        raise OpsError(f"{Path(command[0]).name} failed ({process.returncode}): {message[:2000]}")
    return process.returncode, process.stdout.decode("utf-8", errors="strict").strip()


def checked_name(value, kind="database"):
    require(bool(DB_NAME.fullmatch(value or "")), f"Invalid {kind}: use a plain PostgreSQL identifier")
    return value


def sql_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def safe_relative(value):
    require(isinstance(value, str) and value and "\\" not in value and "\x00" not in value,
            "Manifest path must be a nonempty portable relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(part not in ("", ".", "..") for part in value.split("/"))
            and ":" not in value, f"Unsafe relative path: {value}")
    return path


def is_reparse(path):
    path = Path(path)
    if path.is_symlink():
        return True
    return path.exists() and bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def checked_destination(value):
    path = Path(value).absolute()
    require(not path.exists() and not is_reparse(path), "Output must be a new path")
    for parent in path.parents:
        require(not is_reparse(parent), f"Reparse/link output ancestor is not supported: {parent}")
    return path


def resolve_source(value):
    path = Path(value).absolute()
    # A symlink can jump out of a declared data boundary or change during a snapshot.
    require(path.exists() and not is_reparse(path), f"Missing path or unsupported symlink/reparse: {path}")
    for parent in path.parents:
        require(not is_reparse(parent), f"Symlink/reparse ancestor is not supported: {parent}")
    return path


def inventory(root):
    root = resolve_source(root)
    paths = [root] if root.is_file() else sorted(root.rglob("*"))
    entries = []
    for path in paths:
        resolve_source(path)
        if path.is_dir():
            continue
        require(path.is_file(), f"Unsupported filesystem object: {path}")
        relative = path.name if root.is_file() else path.relative_to(root).as_posix()
        safe_relative(relative)
        details = path.stat()
        entries.append({"path": relative, "size": details.st_size, "sha256": digest(path),
                        "mode": stat.S_IMODE(details.st_mode) & 0o777})
    return entries


def content_entries(entries):
    # Windows and Linux permission bits differ; raw bytes and exact name/case are the
    # transport invariant. Linux executable/owner checks are separate preflight checks.
    return [{key: row[key] for key in ("path", "size", "sha256")} for row in entries]


def copy_tree(source, destination):
    source = resolve_source(source)
    if source.is_file():
        destination.mkdir(parents=True, exist_ok=False)
        shutil.copy2(source, destination / source.name)
    else:
        shutil.copytree(source, destination, symlinks=False)


def private_source(relative):
    parts = PurePosixPath(relative).parts
    name = parts[-1].lower()
    return (parts[0] in {".git", "node_modules", "config", "replays", "deck_log", "logs"}
            or name in PRIVATE_NAMES or name.startswith(".env.")
            or name.endswith((".pem", ".key", ".dump", ".yrp", ".log", ".sqlite", ".sqlite3"))
            or any(part in {".git", "node_modules", "logs"} for part in parts)
            or (parts[0] in {"services", "plugins"} and "data" in parts))


def release(source, output, release_id, components, include_public=()):
    source = resolve_source(source)
    require(source.is_dir(), "Application source must be a directory")
    require(bool(ID.fullmatch(release_id)), "release-id must be a lowercase portable identifier")
    output = checked_destination(output)
    require(not output.exists() and not output.with_suffix(output.suffix + ".manifest.json").exists(),
            "Release output already exists; choose a new filename")
    require(not output.is_relative_to(source), "Release output must be outside the application source")
    _, head = run(["git", "rev-parse", "HEAD"], cwd=source)
    _, dirty = run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=source)
    # Untracked runtime files are never silently published. New public code must be
    # explicitly selected after review; ignored state/config remains excluded.
    process = subprocess.run(["git", "ls-files", "-z", "--cached"],
                             cwd=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    selected = set(part.decode("utf-8") for part in process.stdout.split(b"\0") if part)
    for value in include_public:
        relative = safe_relative(value)
        root = resolve_source(source.joinpath(*relative.parts))
        require(root.is_relative_to(source), "Public include must stay inside the application")
        for row in inventory(root):
            item = root / row["path"] if root.is_dir() else root
            selected.add(item.relative_to(source).as_posix())
    paths = sorted(selected)
    inputs = []
    for relative in paths:
        # Catalogs may be tracked/explicitly included, but remain a release component.
        # Keeping them out of application also preserves the documented catalog symlink.
        catalog_path = PurePosixPath(relative)
        if (private_source(relative)
                or (catalog_path.parent == PurePosixPath("plugins/card-catalog/databases")
                    and catalog_path.suffix.lower() == ".cdb")):
            continue
        safe_relative(relative)
        path = source / relative
        if not path.exists():  # An intentional working-tree deletion belongs to this release.
            continue
        require(path.is_file() and not path.is_symlink(), f"Non-regular public source: {relative}")
        require(not any(parent.is_symlink() for parent in path.parents), "Source contains a symlink ancestor")
        inputs.append((path, "application/" + relative))
    component_info = []
    seen = set()
    for name, value in components:
        require(ID.fullmatch(name) and name not in seen, "Duplicate or invalid component ID")
        seen.add(name)
        root = resolve_source(value)
        entries = inventory(root)
        for row in entries:
            if private_source(row["path"]):
                continue
            path = root / row["path"] if root.is_dir() else root
            inputs.append((path, f"components/{name}/{row['path']}"))
        component_info.append({"id": name, "source": str(root), "files": len(entries)})
    require("engine" in seen, "The complete, explicitly selected ygopro directory is required as engine component")
    require(any(name == "application/package-lock.json" for _, name in inputs), "Release lacks package-lock.json")
    entries = []
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(output, "w:gz") as archive:
            for path, name in inputs:
                details = path.stat()
                row = {"path": name, "size": details.st_size, "sha256": digest(path),
                       "mode": stat.S_IMODE(details.st_mode) & 0o777}
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = row["size"], row["mode"], 0
                with path.open("rb") as stream:
                    archive.addfile(info, stream)
                require(digest(path) == row["sha256"], f"Release input changed while being archived: {name}")
                entries.append(row)
        manifest = {"format": FORMAT, "kind": "release", "releaseId": release_id,
                    "createdAt": now(), "gitHead": head, "dirtyWorkingTree": bool(dirty),
                    "archiveSha256": digest(output), "components": component_info,
                    "explicitUntrackedPublicIncludes": list(include_public), "files": entries}
        write_json(output.with_suffix(output.suffix + ".manifest.json"), manifest)
        return manifest
    except Exception:
        # Only the newly created exact output file is removed, never a source directory.
        output.unlink(missing_ok=True)
        raise


def scan_copy_records(stream, include_crlf=False):
    """Count and hash single-column COPY text records independent of the client line ending.

    psql hands Python CRLF-terminated records on Windows and LF on Linux. COPY text
    escapes CR, LF and TAB inside a value, so exactly one physical terminator per
    record can be replaced by LF without touching field bytes. Anything else
    (missing terminator, blank line, stray CR, mixed endings) is a damaged stream.
    """
    lf_digest = hashlib.sha256()
    crlf_digest = hashlib.sha256() if include_crlf else None
    rows, ending = 0, None
    for raw in stream:
        require(raw.endswith(b"\n"), "COPY output ended inside a record", "copy-record-framing")
        current = b"\r\n" if raw.endswith(b"\r\n") else b"\n"
        require(ending in (None, current), "COPY output mixes record endings", "copy-record-framing")
        ending = current
        payload = raw[:-len(current)]
        # No strip/rstrip: a remaining control byte means the framing assumption is wrong.
        require(payload and not any(byte in payload for byte in (b"\r", b"\n", b"\t")),
                "COPY output has an empty record or an unescaped control byte", "copy-record-framing")
        lf_digest.update(payload)
        lf_digest.update(b"\n")
        if crlf_digest is not None:
            crlf_digest.update(payload)
            crlf_digest.update(b"\r\n")
        rows += 1
    return rows, lf_digest.hexdigest(), crlf_digest.hexdigest() if crlf_digest is not None else None


def validate_database_state(state):
    """Structural check of a manifest databaseState; True when it names the digest format.

    Dispatch is on key presence: a batch without rowDigestFormat is the known legacy
    shape, a present key must be exactly the supported token (no fallback).
    """
    def check(condition):
        require(condition, "Backup manifest databaseState is malformed", "invalid-database-state")

    def text(*values):
        return all(isinstance(value, str) for value in values)

    check(isinstance(state, dict))
    versioned = "rowDigestFormat" in state
    if versioned:
        token = state["rowDigestFormat"]
        require(isinstance(token, str) and token == ROW_DIGEST_FORMAT,
                "Unsupported databaseState.rowDigestFormat; use ops tools that know this backup format",
                "unsupported-row-digest-format")
    check(set(state) == {"schema", "tables", "sequences"} | ({"rowDigestFormat"} if versioned else set()))
    check(all(isinstance(state[key], list) for key in ("schema", "tables", "sequences")))
    seen, relations, sequences = set(), [], []
    for item in state["schema"]:
        check(isinstance(item, dict) and set(item) == {"schema", "name", "kind", "columns", "constraints", "indexes"})
        check(text(item["schema"], item["name"], item["kind"]) and item["kind"] in ("r", "p", "v", "m", "S"))
        identity = (item["schema"], item["name"])
        check(identity not in seen)
        seen.add(identity)
        check(isinstance(item["columns"], list))
        for column in item["columns"]:
            check(isinstance(column, dict) and set(column) == {"name", "type", "notNull", "default"})
            check(text(column["name"], column["type"]) and isinstance(column["notNull"], bool)
                  and (column["default"] is None or text(column["default"])))
        check(all(isinstance(item[key], list) and text(*item[key]) for key in ("constraints", "indexes")))
        if item["kind"] in ("r", "p", "m"):
            relations.append(identity)
        elif item["kind"] == "S":
            sequences.append(identity)
    # state() emits tables and sequences in schema order; requiring the same ordered
    # identities also excludes duplicate, missing and uncovered entries.
    check(len(state["tables"]) == len(relations) and len(state["sequences"]) == len(sequences))
    for row, identity in zip(state["tables"], relations):
        check(isinstance(row, dict) and set(row) == {"schema", "table", "rows", "sha256"})
        check((row["schema"], row["table"]) == identity and type(row["rows"]) is int and row["rows"] >= 0)
        check(text(row["sha256"]) and bool(SHA256_HEX.fullmatch(row["sha256"])))
        check((row["rows"] == 0) == (row["sha256"] == EMPTY_SHA256))
    for row, identity in zip(state["sequences"], sequences):
        check(isinstance(row, dict) and set(row) == {"schema", "name", "lastValue", "isCalled"})
        check((row["schema"], row["name"]) == identity and isinstance(row["isCalled"], bool))
        check(text(row["lastValue"]) and bool(SEQUENCE_VALUE.fullmatch(row["lastValue"])))
    return versioned


def state_differences(expected, actual):
    """Difference categories and table names only, for the private restore result."""
    differences = []
    if expected["schema"] != actual["schema"]:
        differences.append({"category": "schema-mismatch"})
    wanted = {(row["schema"], row["table"]): row for row in expected["tables"]}
    found = {(row["schema"], row["table"]): row for row in actual["tables"]}
    if list(wanted) != list(found):
        differences.append({"category": "table-set-mismatch"})
    shared = [key for key in wanted if key in found]
    for category, differs in (("row-count-mismatch", lambda a, b: a["rows"] != b["rows"]),
                              ("content-mismatch", lambda a, b: a["rows"] == b["rows"] and a["sha256"] != b["sha256"])):
        tables = [".".join(key) for key in shared if differs(wanted[key], found[key])]
        if tables:
            differences.append({"category": category, "tables": tables})
    if expected["sequences"] != actual["sequences"]:
        differences.append({"category": "sequence-mismatch"})
    return differences


def verify_restored_state(expected, postgres):
    """Compare the restored database with an already validated manifest databaseState."""
    message = "Restored schema, table content, row counts or sequence state differ from backup"
    if "rowDigestFormat" in expected:
        # A versioned batch is compared strictly; legacy candidates are never tried.
        actual = postgres.state()
        if actual != expected:
            raise OpsError(message, "database-state-mismatch",
                           {"algorithm": ROW_DIGEST_FORMAT, "differences": state_differences(expected, actual)})
        algorithm, ending = ROW_DIGEST_FORMAT, "lf"
    else:
        # Batches written before the format existed hashed the raw psql record ending
        # of their host. One candidate must equal the WHOLE state: accepting LF for
        # one table and CRLF for another would widen what counts as "unchanged".
        candidates = dict(zip(("lf", "crlf"), postgres.state(legacy=True)))
        matches = [name for name, candidate in candidates.items() if candidate == expected]
        if not matches:
            raise OpsError(message, "legacy-no-uniform-match",
                           {"algorithm": LEGACY_ROW_DIGEST,
                            "candidates": {name: state_differences(expected, candidate)
                                           for name, candidate in candidates.items()}})
        # Both candidates can only be equal when no table has a row.
        require(len(matches) == 1 or all(row["rows"] == 0 for row in expected["tables"]),
                message, "legacy-ambiguous-match")
        algorithm, ending = LEGACY_ROW_DIGEST, matches[0] if len(matches) == 1 else "ambiguous-empty"
    # The matched ending describes the digest bytes, not the operating system of the source.
    return {"algorithm": algorithm, "matchedRecordEnding": ending, "scope": "whole-batch",
            "independentRowCountsVerified": True}


class Postgres:
    def __init__(self, database, bin_directory=None):
        self.database = checked_name(database)
        self.bin_directory = Path(bin_directory) if bin_directory else None
        self.environment = os.environ.copy()
        # Do not inherit a URI-like PGDATABASE containing credentials.
        self.environment["PGDATABASE"] = self.database
        self.environment.setdefault("PGCONNECT_TIMEOUT", "10")
        self.environment["PGOPTIONS"] = "-c timezone=UTC -c datestyle=ISO,YMD"
        self.environment["PGCLIENTENCODING"] = "UTF8"

    def tool(self, name):
        executable = name + (".exe" if os.name == "nt" else "")
        return str(self.bin_directory / executable) if self.bin_directory else executable

    def command(self, name, *arguments):
        return run([self.tool(name), *arguments], env=self.environment)

    def sql(self, statement):
        # psql on Windows may convert Unicode command-line SQL to the system codepage.
        # UTF-8 stdin avoids corrupting Chinese names and avoids putting SQL secrets
        # (if an operator uses this helper) on process command lines.
        _, value = run([self.tool("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                        "--dbname", self.database, "--file", "-"], env=self.environment,
                       input_bytes=statement.encode("utf-8"))
        return value

    def query_json(self, statement):
        return json.loads(self.sql(statement))

    def metadata(self):
        return self.query_json("""SELECT json_build_object(
          'serverVersionNum',current_setting('server_version_num')::int,
          'serverVersion',current_setting('server_version'),'database',current_database(),
          'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,
          'owner',pg_get_userbyid(datdba),'timezone',current_setting('TimeZone'))
          FROM pg_database WHERE datname=current_database()""")

    def assert_quiet(self):
        value = int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                             "AND pid<>pg_backend_pid()"))
        require(value == 0, f"Database has {value} other connections; stop every writer and retry")

    def assert_empty(self):
        # A default extension such as plpgsql is allowed; user-created tables, views,
        # sequences, types or routines are not. No DROP/overwrite path exists here.
        count = int(self.sql("""SELECT count(*) FROM (
          SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
          UNION ALL
          SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
                         AND d.objid=p.oid AND d.deptype='e')
          UNION ALL
          SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND t.typtype IN ('e','d')
          AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass
                         AND d.objid=t.oid AND d.deptype='e')) objects"""))
        require(count == 0, "Target database contains user objects; only a new empty database may be restored")

    def schema(self):
        return self.query_json("""SELECT coalesce(json_agg(v ORDER BY v->>'schema',v->>'name'),'[]'::json)
          FROM (SELECT json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
          'columns',(SELECT coalesce(json_agg(json_build_object('name',a.attname,
          'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
          'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]'::json)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
          'constraints',(SELECT coalesce(json_agg(pg_get_constraintdef(x.oid,true) ORDER BY x.conname),'[]'::json)
          FROM pg_constraint x WHERE x.conrelid=c.oid),
          'indexes',(SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text),'[]'::json)
          FROM pg_index i WHERE i.indrelid=c.oid)) v
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%') objects""")

    def row_digest(self, schema, table, legacy=False):
        """Digest one relation; legacy=True returns the (LF, CRLF) pre-format candidates."""
        qualified = sql_identifier(schema) + "." + sql_identifier(table)
        statement = (f"COPY (SELECT row_to_json(t)::text FROM {qualified} t "
                     'ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT')
        environment = self.environment
        if not legacy:
            # The canonical profile pins every documented rendering setting in a local
            # copy. Legacy recomputation keeps the exact query/environment old batches
            # were written with, so their digests stay reproducible.
            statement += " WITH (FORMAT text, ENCODING 'UTF8')"
            environment = self.environment.copy()
            environment["PGOPTIONS"] += " -c intervalstyle=postgres -c bytea_output=hex -c extra_float_digits=3"
        command = [self.tool("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1",
                   "--dbname", self.database, "--file", "-"]
        failure = f"Could not read table {schema}.{table}; verify backup-role SELECT rights"
        with tempfile.TemporaryFile() as error_stream:
            process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=error_stream)
            assert process.stdin is not None and process.stdout is not None
            try:
                process.stdin.write(statement.encode("utf-8"))
                process.stdin.close()
                rows, lf_sha, crlf_sha = scan_copy_records(process.stdout, include_crlf=legacy)
                code = process.wait()
            except OSError as error:
                # The OS error text can carry paths; psql stderr stays in the private temp file.
                raise OpsError(failure, "copy-process-failed") from error
            finally:
                # No digest is published and no psql is left behind on any failure.
                if process.poll() is None:
                    try:
                        process.kill()
                    except OSError:
                        pass
                    process.wait()
                for pipe in (process.stdin, process.stdout):
                    try:
                        pipe.close()
                    except OSError:
                        pass
        require(code == 0, failure, "copy-process-failed")
        record = {"schema": schema, "table": table, "rows": rows, "sha256": lf_sha}
        return (record, {**record, "sha256": crlf_sha}) if legacy else record

    def row_counts(self, relations):
        # Independent of the COPY record count: detects whole records missing from an
        # otherwise well-formed stream. One statement/connection for all relations keeps
        # the cost to a plain scan each; the FROM target is the same as in row_digest.
        if not relations:
            return []
        parts = [f"SELECT {index} AS n, count(*) AS c FROM {sql_identifier(schema)}.{sql_identifier(table)}"
                 for index, (schema, table) in enumerate(relations)]
        try:
            counts = self.query_json("SELECT coalesce(json_agg(c ORDER BY n),'[]'::json) FROM ("
                                     + " UNION ALL ".join(parts) + ") counts")
        except (OpsError, ValueError):
            # Like row_digest, this scan reports a fixed message instead of psql's stderr.
            raise OpsError("Could not count table rows independently; verify backup-role SELECT rights",
                           "copy-process-failed") from None
        require(isinstance(counts, list) and len(counts) == len(relations)
                and all(type(value) is int for value in counts),
                "Could not count table rows independently", "copy-row-count-mismatch")
        return counts

    def state(self, legacy=False):
        """Database state with canonical digests; legacy=True gives (LF, CRLF) old-shape candidates."""
        schema = self.schema()
        digests, sequences = [], []
        for item in schema:
            if item["kind"] in ("r", "p", "m"):
                # Partition children are also included; restore checks the same complete set.
                digests.append(self.row_digest(item["schema"], item["name"], legacy))
            elif item["kind"] == "S":
                qualified = sql_identifier(item["schema"]) + "." + sql_identifier(item["name"])
                value = self.query_json(f"SELECT json_build_object('lastValue',last_value::text,'isCalled',is_called) FROM {qualified}")
                sequences.append({"schema": item["schema"], "name": item["name"], **value})
        tables = [row[0] for row in digests] if legacy else digests
        for row, count in zip(tables, self.row_counts([(row["schema"], row["table"]) for row in tables])):
            require(row["rows"] == count, f"COPY returned a different number of records than count(*) "
                    f"for {row['schema']}.{row['table']}", "copy-row-count-mismatch")
        if legacy:
            # Same schema, counts and sequences; only the record ending of each digest differs.
            return tuple({"schema": schema, "tables": [row[index] for row in digests], "sequences": sequences}
                         for index in (0, 1))
        return {"rowDigestFormat": ROW_DIGEST_FORMAT, "schema": schema, "tables": tables, "sequences": sequences}

    def replay_names(self):
        # Only exact persisted replayFileName values are used; no inferred relation.
        exists = self.sql("SELECT to_regclass('public.duel_log') IS NOT NULL")
        require(exists == "t", "public.duel_log is required for the configured replay association report")
        return self.query_json("""SELECT coalesce(json_agg("replayFileName" ORDER BY id),'[]'::json)
          FROM public.duel_log WHERE "replayFileName" IS NOT NULL AND "replayFileName"<>''""")


def replay_report(entries, names):
    files = {row["path"] for row in entries if row["path"].lower().endswith(".yrp")}
    # Downloadable recordings are immediate children; subdirectories are still backed
    # up, but are explicitly reported instead of being silently exposed as filenames.
    immediate = {name for name in files if "/" not in name}
    referenced = {name for name in names if isinstance(name, str) and name}
    unsafe = sorted(name for name in referenced if "/" in name or "\\" in name or name in (".", ".."))
    return {"linkedFiles": sorted(immediate & referenced), "unlinkedFiles": sorted(immediate - referenced),
            "databaseWithoutFile": sorted(referenced - immediate), "nestedFiles": sorted(files - immediate),
            "unsafeDatabaseFilenames": unsafe, "databaseReferenceCount": len(names)}


def check_release(archive, manifest):
    require(manifest.get("format") == FORMAT and manifest.get("kind") == "release", "Unsupported release manifest")
    require(digest(archive) == manifest.get("archiveSha256"), "Release archive hash mismatch")
    expected = {row["path"]: row for row in manifest["files"]}
    require(len(expected) == len(manifest["files"]), "Duplicate release manifest entry")
    seen = set()
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            safe_relative(member.name)
            require(member.isfile() and member.name not in seen and member.name in expected,
                    "Release archive contains a link, duplicate, directory, or unlisted file")
            seen.add(member.name)
            row = expected[member.name]
            content = stream.extractfile(member)
            checksum = hashlib.sha256()
            assert content is not None
            for part in iter(lambda: content.read(1024 * 1024), b""):
                checksum.update(part)
            require(member.size == row["size"] and checksum.hexdigest() == row["sha256"],
                    f"Release member failed verification: {member.name}")
    require(seen == set(expected), "Release archive misses a manifest member")


def check_units(units):
    require(units and all(re.fullmatch(r"[A-Za-z0-9@_.-]+\.service", name) for name in units),
            "Explicit writerUnits .service names are required")
    evidence = []
    for name in units:
        _, output = run(["systemctl", "show", name, "--property=LoadState,ActiveState", "--no-pager"])
        fields = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        require(fields.get("LoadState") == "loaded" and fields.get("ActiveState") == "inactive",
                f"Writer unit {name} must exist and be inactive; unknown/failed/active units are refused")
        evidence.append({"unit": name, "state": "inactive"})
    return evidence


def validate_plan(plan):
    require(plan.get("format") == FORMAT, "Unsupported plan format")
    checked_name(plan.get("database"))
    checked_name(plan.get("runtimeRole"), "runtime role")
    require(isinstance(plan.get("components"), list) and plan["components"], "Explicit runtime components are required")
    seen, roots = set(), []
    for item in plan["components"]:
        name = item.get("id", "")
        require(ID.fullmatch(name) and name not in seen, "Invalid or duplicate runtime component ID")
        seen.add(name)
        root = resolve_source(item.get("source", ""))
        require(not any(root == old or root.is_relative_to(old) or old.is_relative_to(root) for old in roots),
                "Component boundaries overlap; select disjoint runtime paths")
        roots.append(root)
    require(plan.get("replayComponent") in seen, "replayComponent must identify the actual recordings directory")
    require(resolve_source(next(item["source"] for item in plan["components"]
                                if item["id"] == plan["replayComponent"])).is_dir(), "Replay component must be a directory")


def backup(plan, output, postgres, isolated=None, writer_check=None):
    validate_plan(plan)
    output = checked_destination(output)
    require(not output.exists(), "Backup output must be a new directory")
    for item in plan["components"]:
        require(not output.is_relative_to(Path(item["source"]).absolute()), "Backup output is inside a source component")
    if plan.get("writerGuard"):
        require(not isolated and writer_check is not None, "PM2 backup requires the lock-holding Windows backup entry")
        writer_evidence = writer_check()
    elif isolated:
        require(plan.get("isolated") is True and plan["database"].startswith("srvpro_drill_")
                and isolated == plan["database"], "Isolated mode requires isolated:true and confirmed srvpro_drill_* database")
        writer_evidence = {"mode": "isolated-operator-attestation", "confirmedDatabase": isolated,
                           "linuxSystemdVerified": False}
    else:
        writer_evidence = {"mode": "systemd-offline", "units": check_units(plan.get("writerUnits"))}
    postgres.assert_quiet()
    metadata = postgres.metadata()
    _, dump_version = postgres.command("pg_dump", "--version")
    dump_major = int(re.search(r"(\d+)\.", dump_version).group(1))
    server_major = metadata["serverVersionNum"] // 10000
    require(dump_major >= server_major, "pg_dump client must not be older than the source PostgreSQL major")
    # COLLATE "C" orders by the database encoding; the digest format is defined for UTF8 only.
    require(metadata["encoding"] == "UTF8", "Backup row digests require a UTF8 source database")
    archive = resolve_source(plan["releaseArchive"])
    release_manifest = read_json(str(archive) + ".manifest.json")
    check_release(archive, release_manifest)
    before = {item["id"]: inventory(item["source"]) for item in plan["components"]}
    state = postgres.state()
    require(validate_database_state(state), "New backups must record the versioned row digest format")
    relation = replay_report(before[plan["replayComponent"]], postgres.replay_names())
    new_private_directory(output, parents=True)
    try:
        new_private_directory(output / "files")
        for item in plan["components"]:
            copy_tree(item["source"], output / "files" / item["id"])
            require(content_entries(inventory(output / "files" / item["id"])) == content_entries(before[item["id"]]),
                    f"Component changed while copying: {item['id']}")
        postgres.command("pg_dump", "--format=custom", "--no-owner", "--no-acl", "--dbname", postgres.database,
                         "--file", str(output / "database.dump"))
        require((output / "database.dump").stat().st_size > 0, "Empty database archive")
        shutil.copy2(archive, output / "release.tar.gz")
        write_json(output / "release.manifest.json", release_manifest)
        postgres.assert_quiet()
        require(postgres.state() == state, "Database changed during backup; discard this batch and stop every writer")
        for item in plan["components"]:
            require(content_entries(inventory(item["source"])) == content_entries(before[item["id"]]),
                    f"Source changed during backup: {item['id']}")
        if writer_check is not None:
            require(writer_check() == writer_evidence, "Writer evidence changed during backup")
        elif not isolated:
            check_units(plan["writerUnits"])
        manifest = {"format": FORMAT, "kind": "joint-backup", "createdAt": now(), "batchId": output.name,
                    "sourceDatabase": metadata, "pgDumpVersion": dump_version, "pgDumpMajor": dump_major,
                    "runtimeRole": plan["runtimeRole"], "quiescence": writer_evidence,
                    "ownerStrategy": "restore-no-owner-no-acl-map-to-explicit-new-owner",
                    "replayComponent": plan["replayComponent"], "databaseState": state,
                    "replayAssociations": relation,
                    "components": [{"id": item["id"], "originalSource": str(Path(item["source"]).absolute()),
                                    "files": before[item["id"]]} for item in plan["components"]],
                    "files": inventory(output)}
        write_json(output / "manifest.json", manifest)
        verify_batch(output)
        return manifest
    except Exception as error:
        # Keep evidence for diagnosis; the missing manifest/FAILED marker prevents use.
        write_json(output / "FAILED.json", {"failedAt": now(), "reason": type(error).__name__})
        raise


def verify_batch(batch):
    batch = resolve_source(batch)
    require(not (batch / "FAILED.json").exists(), "Failed/incomplete backup batch cannot be restored")
    manifest = read_json(batch / "manifest.json", unique_keys=True)
    require(type(manifest.get("format")) is int and manifest["format"] == FORMAT
            and manifest.get("kind") == "joint-backup", "Unsupported backup manifest")
    # Unknown digest formats and damaged state are refused here, before restore writes anything.
    validate_database_state(manifest.get("databaseState"))
    expected = manifest["files"]
    for row in expected:
        safe_relative(row["path"])
    actual = [row for row in inventory(batch) if row["path"] != "manifest.json"]
    require(content_entries(actual) == content_entries(expected), "Batch has missing, changed, or unlisted files")
    check_release(batch / "release.tar.gz", read_json(batch / "release.manifest.json"))
    for item in manifest["components"]:
        require(ID.fullmatch(item["id"]), "Invalid manifest component ID")
        require(content_entries(inventory(batch / "files" / item["id"])) == content_entries(item["files"]),
                f"Runtime component hash mismatch: {item['id']}")
    return manifest


def unpack_release(archive, manifest, destination):
    check_release(archive, manifest)
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            relative = safe_relative(member.name)
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            content = stream.extractfile(member)
            assert content is not None
            with target.open("xb") as output:
                shutil.copyfileobj(content, output)
            target.chmod(member.mode & 0o777)


def restore(batch, destination, postgres, confirm, owner_role, runtime_role, schema_tool):
    manifest = verify_batch(batch)
    checked_name(owner_role, "owner role")
    checked_name(runtime_role, "runtime role")
    require(Path(schema_tool).is_file(), "A current deployment/schema.js path is required")
    require(confirm == postgres.database, "--confirm-new-database must exactly match the target database")
    require(postgres.database != manifest["sourceDatabase"]["database"],
            "Use a distinct new isolated database name, not the source database name")
    destination = checked_destination(destination)
    require(not destination.exists(), "Restore destination must not exist; no overwrite is supported")
    require(not destination.is_relative_to(Path(batch).absolute()), "Restore destination is inside the backup batch")
    target_metadata = postgres.metadata()
    require(target_metadata["serverVersionNum"] // 10000 >= manifest["pgDumpMajor"],
            "Target PostgreSQL must be at least the dump-client major; same source/client/target major is preferred")
    require("rowDigestFormat" not in manifest["databaseState"] or target_metadata["encoding"] == "UTF8",
            "This backup's row digest format requires a UTF8 target database")
    postgres.assert_quiet()
    postgres.assert_empty()
    new_private_directory(destination, parents=True)
    report = {"format": FORMAT, "kind": "restore-result", "startedAt": now(), "complete": False,
              "batchId": manifest["batchId"], "targetDatabase": target_metadata,
              "ownerRole": owner_role, "runtimeRole": runtime_role, "destination": str(destination)}
    write_json(destination / "restore-result.json", report)
    try:
        unpack_release(Path(batch) / "release.tar.gz", read_json(Path(batch) / "release.manifest.json"), destination / "release")
        paths = []
        for item in manifest["components"]:
            target = destination / "runtime" / item["id"]
            target.parent.mkdir(exist_ok=True)
            copy_tree(Path(batch) / "files" / item["id"], target)
            paths.append({"id": item["id"], "old": item["originalSource"], "new": str(target)})
        write_json(destination / "restore-map.json", paths)
        postgres.command("pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl",
                         "--role", owner_role, "--dbname", postgres.database, str(Path(batch) / "database.dump"))
        # Grant/verify are explicit deployment tools, never schema init or history repair.
        postgres_environment = postgres.environment.copy()
        command = ["node", str(Path(schema_tool).absolute())]
        run([*command, "grant", "--database", postgres.database, "--runtime-role", runtime_role], env=postgres_environment)
        run([*command, "verify", "--database", postgres.database, "--runtime-role", runtime_role,
             "--report", str(destination / "schema-verification.json")], env=postgres_environment)
        # Recorded before the remaining checks; only complete=true below means success.
        report["databaseStateVerification"] = verify_restored_state(manifest["databaseState"], postgres)
        restored_entries = inventory(destination / "runtime" / manifest["replayComponent"])
        relation = replay_report(restored_entries, postgres.replay_names())
        require(relation == manifest["replayAssociations"], "Restored replay association categories differ from baseline")
        for item in manifest["components"]:
            require(content_entries(inventory(destination / "runtime" / item["id"])) == content_entries(item["files"]),
                    f"Restored component differs from backup: {item['id']}")
        report.update({"complete": True, "finishedAt": now(), "databaseAndFilesVerified": True,
                       "replayAssociationsVerified": True, "linuxEngineAndNetworkVerified": False,
                       "nextAction": "Install Linux artifact, map private paths, perform service/TCP/WSS/TT acceptance; do not auto-start"})
        write_json(destination / "restore-result.json", report)
        return report
    except Exception as error:
        report.update({"failedAt": now(), "failureType": type(error).__name__,
                       "nextAction": "Keep evidence. Recreate a new empty database and new directory before retrying; do not reuse partial target"})
        if getattr(error, "category", None):
            report["failureCategory"] = error.category
        if getattr(error, "details", None):
            report["failureDetails"] = error.details
        write_json(destination / "restore-result.json", report)
        raise


def catalog_check(catalog, versions=None):
    """Validate public catalogs without loading engine, PostgreSQL or private config."""
    root = Path(catalog).absolute()
    require(root.is_dir(), "Missing catalog directory; download the catalog with git lfs pull")
    summaries = []
    for language in CATALOG_LANGUAGES:
        path = root / f"cards.{language}.cdb"
        require(path.is_file(), f"Missing catalog database: {path.name}; run git lfs pull")
        with path.open("rb") as stream:
            header = stream.read(128)
        require(not header.startswith(b"version https://git-lfs.github.com/spec/v1"),
                f"Catalog is a Git LFS pointer: {path.name}; run git lfs pull before deployment")
        require(header.startswith(b"SQLite format 3\x00"), f"Catalog is not SQLite: {path.name}")
        try:
            # These are fixed single-file artifacts, matching SQL.js's in-memory byte load.
            # immutable also prevents WAL-mode headers from creating -wal/-shm sidecars;
            # mode=ro/query_only deny writes and never create a missing database.
            connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
            try:
                connection.execute("PRAGMA query_only = ON")
                require(connection.execute("PRAGMA quick_check").fetchall() == [("ok",)],
                        f"Catalog SQLite integrity check failed: {path.name}")
                rows, names = connection.execute(
                    "SELECT COUNT(*), COUNT(CASE WHEN name IS NOT NULL AND LENGTH(TRIM(name)) > 0 THEN 1 END) "
                    "FROM (SELECT t.id, t.name FROM texts t)").fetchone()
                require(rows > 0 and names > 0, f"Catalog has no usable card names: {path.name}")
                metadata = None
                if language == "zh":
                    metadata, valid, classified = connection.execute(
                        "SELECT COUNT(*), COUNT(CASE WHEN typeof(id) = 'integer' AND id > 0 "
                        "AND typeof(type) = 'integer' AND type >= 0 "
                        "AND typeof(alias) = 'integer' AND alias >= 0 THEN 1 END), "
                        "COUNT(CASE WHEN (type & 7) <> 0 THEN 1 END) "
                        "FROM (SELECT d.id, d.type, d.alias, t.name "
                        "FROM datas d LEFT JOIN texts t ON t.id = d.id)").fetchone()
                    require(metadata > 0 and valid == metadata and classified > 0,
                            f"Chinese catalog has no usable type/alias metadata: {path.name}")
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise OpsError(f"Catalog SQLite schema/read check failed: {path.name}: {error}") from error
        summaries.append({"language": language, "file": path.name, "bytes": path.stat().st_size,
                          "sha256": digest(path), "names": names, "metadata": metadata})
    if versions:
        manifest = read_json(versions)
        rows = [row for row in manifest.get("resourceFingerprints", []) if row.get("scope") == "catalog"]
        paths = [row["path"] for row in rows]
        expected = {row["file"] for row in summaries}
        require(len(paths) == len(set(paths)) and set(paths) == expected,
                "Versions must contain exactly one catalog fingerprint for each of zh, ja, en and ko")
        fingerprints = {row["path"]: row for row in rows}
        for summary in summaries:
            row = fingerprints[summary["file"]]
            require(row.get("bytes") == summary["bytes"] and row.get("sha256") == summary["sha256"],
                    f"Catalog fingerprint/size mismatch: {summary['file']}")
    return {"checkedAt": now(), "databases": summaries, "metadataAvailable": True,
            "versionsChecked": bool(versions), "privateConfigurationRead": False}


@contextmanager
def catalog_download_directory():
    # Public temporary resources contain no credentials. Use the established Windows
    # inherited-ACL behavior instead of tempfile's restrictive Python 3.13 mkdir(0700).
    parent = Path(tempfile.gettempdir()).resolve()
    temporary = parent / ("srvpro-catalog-fetch-" + uuid.uuid4().hex)
    new_private_directory(temporary)
    try:
        yield temporary
    finally:
        require(temporary.parent == parent and temporary.resolve() == temporary
                and not temporary.is_symlink(), "Temporary catalog directory changed; refusing unsafe cleanup")

        def remove_readonly(function, path, error):
            # Git objects may have read-only file attributes on Windows.
            require(Path(path).resolve().is_relative_to(temporary), "Unsafe temporary cleanup path")
            os.chmod(path, 0o777)
            function(path)

        shutil.rmtree(temporary, onerror=remove_readonly)


def catalog_fetch(destination, versions):
    """Fetch pinned public LFS catalogs, validate them, then populate a NEW directory."""
    destination = Path(destination).absolute()
    require(not destination.exists() and not destination.is_symlink(),
            "Catalog destination must be a new directory; existing catalogs are never overwritten")
    require(not any(parent.is_symlink() for parent in destination.parents),
            "Catalog destination cannot have a symlink ancestor")
    expected_destination = destination.resolve()
    manifest = read_json(versions)
    source = manifest.get("catalogSource", {})
    repository = source.get("repository", "")
    commit = source.get("commit", "")
    directory = source.get("directory", "")
    require(isinstance(repository, str) and bool(re.fullmatch(
        r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+(?:\.git)?", repository)),
        "catalogSource.repository must be a public HTTPS GitHub URL without credentials, query or fragment")
    require(repository.rsplit("/", 1)[-1].removesuffix(".git") not in {"", ".", ".."},
            "catalogSource.repository must name a GitHub repository")
    require(isinstance(commit, str) and bool(re.fullmatch(r"[0-9a-fA-F]{40}", commit)),
            "catalogSource.commit must be an exact 40-character Git commit, not a moving branch")
    relative = safe_relative(directory)
    require(".git" not in relative.parts, "Catalog source cannot be inside Git metadata")
    if not shutil.which("git"):
        raise OpsError("Catalog download requires git and git-lfs; install both before retrying")
    environment = os.environ.copy()
    environment["GIT_LFS_SKIP_SMUDGE"] = "1"
    try:
        with catalog_download_directory() as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            run(["git", "init", "--quiet"], cwd=checkout, env=environment)
            run(["git", "remote", "add", "origin", repository], cwd=checkout, env=environment)
            run(["git", "fetch", "--depth=1", "origin", commit], cwd=checkout, env=environment)
            run(["git", "checkout", "--detach", commit], cwd=checkout, env=environment)
            run(["git", "lfs", "install", "--local"], cwd=checkout, env=environment)
            # A machine-wide lfs.storage setting must not reuse another repository's cache.
            run(["git", "config", "--local", "lfs.storage", str(checkout / ".git" / "lfs")],
                cwd=checkout, env=environment)
            run(["git", "config", "--local", "lfs.url", repository.removesuffix(".git") + ".git/info/lfs"],
                cwd=checkout, env=environment)
            include = ",".join(f"{relative.as_posix()}/cards.{language}.cdb" for language in CATALOG_LANGUAGES)
            run(["git", "lfs", "pull", "origin", "--include=" + include, "--exclude="],
                cwd=checkout, env=environment)
            catalog = resolve_source(checkout.joinpath(*relative.parts))
            for language in CATALOG_LANGUAGES:
                require(not (catalog / f"cards.{language}.cdb").is_symlink(),
                        "Downloaded catalog files must be regular files, not symlinks")
            result = catalog_check(catalog, versions)
            require(not destination.exists() and not destination.is_symlink(),
                    "Catalog destination appeared during download; refusing to overwrite it")
            owned_destination = False
            try:
                # Downloaded metadata or unrelated files do not belong in the runtime catalog.
                destination.mkdir(parents=True, exist_ok=False)
                owned_destination = True
                for language in CATALOG_LANGUAGES:
                    filename = f"cards.{language}.cdb"
                    shutil.copy2(catalog / filename, destination / filename)
                catalog_check(destination, versions)
            except Exception:
                if owned_destination and destination.exists():
                    require(not destination.is_symlink() and destination.resolve() == expected_destination,
                            "Catalog destination changed; refusing unsafe cleanup")
                    shutil.rmtree(destination)
                raise
            return {**result, "repository": repository, "commit": commit, "downloaded": True}
    except (OpsError, OSError, subprocess.SubprocessError) as error:
        raise OpsError(f"Catalog fetch failed: {error}. Check git/git-lfs installation and GitHub/LFS network access; "
                       "existing catalogs were not overwritten") from error


def windows_pe_kind(binary):
    with Path(binary).open("rb") as stream:
        header = stream.read(64)
        require(len(header) == 64 and header[:2] == b"MZ", "Expected a Windows PE binary")
        offset = struct.unpack_from("<I", header, 60)[0]
        require(64 <= offset <= Path(binary).stat().st_size - 26, "Invalid Windows PE header offset")
        stream.seek(offset)
        pe = stream.read(26)
        require(pe[:4] == b"PE\x00\x00" and struct.unpack_from("<H", pe, 4)[0] == 0x8664 and
                struct.unpack_from("<H", pe, 24)[0] == 0x20B, "Expected Windows x64 PE32+")
    return "PE32+ x64"


def preflight(application, engine, catalog, versions=None, target="linux"):
    application, engine = resolve_source(application), resolve_source(engine)
    require((application / "ygopro-server.js").is_file() and (application / "plugin-system.js").is_file(), "Missing generated server/host")
    require((application / "package-lock.json").is_file(), "Missing npm lockfile")
    _, node_version = run(["node", "--version"])
    require(node_version.startswith("v24."), "This main route is pinned to Node 24; record and validate another version separately")
    require(target in {"linux", "windows"}, "Unsupported target platform")
    if target == "linux":
        require(platform.system() == "Linux", "Linux preflight must run on native Linux")
        _, machine = run(["uname", "-m"])
        require(machine == "x86_64", "This native deployment route targets Linux x86_64")
        binary = engine / "ygopro"
        require(binary.is_file() and os.access(binary, os.X_OK), "ygopro/ygopro must be a Linux executable with execution permission")
        _, kind = run(["file", "--brief", str(binary)])
        require("ELF" in kind and "x86-64" in kind, "Engine must be Linux x86_64 ELF, not a Windows executable")
        code, dependencies = run(["ldd", str(binary)], allowed=(0, 1))
        require("not found" not in dependencies and (code == 0 or "statically linked" in dependencies), "Unresolved engine dynamic libraries")
    else:
        require(platform.system() == "Windows", "Windows preflight must run on native Windows")
        machine = platform.machine()
        require(machine.lower() in {"amd64", "x86_64"}, "Windows route targets x64")
        binary = engine / "ygopro.exe"
        require(binary.is_file(), "Missing Windows ygopro.exe")
        kind = windows_pe_kind(binary)
    required = ["cards.cdb", "lflist.conf", "script"]
    require(all((engine / name).exists() for name in required), "Incomplete runtime: need cards.cdb, lflist.conf and base scripts")
    catalog_result = catalog_check(catalog, versions)
    if versions:
        manifest = read_json(versions)
        for row in manifest.get("resourceFingerprints", []):
            scope = row.get("scope", "engine")
            require(scope in {"engine", "catalog"}, "Unknown resource fingerprint scope")
            if scope == "catalog":  # All four catalog sizes and fingerprints were checked above.
                continue
            relative = safe_relative(row["path"])
            resource_file = engine.joinpath(*relative.parts)
            require(resource_file.is_file() and digest(resource_file) == row["sha256"], f"Resource fingerprint mismatch: {scope}/{row['path']}")
    return {"checkedAt": now(), "node": node_version, "platform": target, "architecture": machine, "engineKind": kind,
            "catalog": catalog_result,
            "localResourcesChecked": True, "privateConfigurationRead": False,
            "nativeRuntimeValidated": False, "databaseAndFullBusinessChecked": False,
            "nextAction": "Run engine smoke, schema verify, then real TCP/WSS/TT and restart acceptance"}


def parse_component(value):
    require("=" in value, "Component must be ID=PATH")
    return value.split("=", 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    release_parser = sub.add_parser("release", help="Snapshot public working-tree code and explicit full engine/resources")
    release_parser.add_argument("--source", required=True)
    release_parser.add_argument("--output", required=True)
    release_parser.add_argument("--release-id", required=True)
    release_parser.add_argument("--component", action="append", default=[], type=parse_component, required=True)
    release_parser.add_argument("--include-public", action="append", default=[],
                                help="Explicit reviewed relative public file/directory; untracked files are excluded by default")
    backup_parser = sub.add_parser("backup", help="Joint offline database/files snapshot; all writers must be stopped")
    backup_parser.add_argument("--plan", required=True)
    backup_parser.add_argument("--output", required=True)
    backup_parser.add_argument("--confirm-isolated")
    backup_parser.add_argument("--pg-bin")
    backup_parser.add_argument("--pm2-lock-token", help=argparse.SUPPRESS)
    backup_parser.add_argument("--pm2-queue-root", help=argparse.SUPPRESS)
    verify_parser = sub.add_parser("verify", help="Verify batch file inventory and archive members, without a database")
    verify_parser.add_argument("--batch", required=True)
    verify_release_parser = sub.add_parser("verify-release", help="Verify a release archive and its sidecar manifest")
    verify_release_parser.add_argument("--archive", required=True)
    unpack_parser = sub.add_parser("unpack-release", help="Safely unpack a verified release into a NEW directory")
    unpack_parser.add_argument("--archive", required=True)
    unpack_parser.add_argument("--destination", required=True)
    restore_parser = sub.add_parser("restore", help="Restore to a NEW distinct empty database and NEW directory only")
    for argument in ("batch", "destination", "database", "confirm-new-database", "owner-role", "runtime-role", "schema-tool"):
        restore_parser.add_argument("--" + argument, required=True)
    restore_parser.add_argument("--pg-bin")
    preflight_parser = sub.add_parser("preflight", help="Read-only Linux x86_64 artifact checks; never read private config")
    preflight_parser.add_argument("--platform", choices=("linux", "windows"), default="linux")
    for argument in ("application", "engine", "catalog"):
        preflight_parser.add_argument("--" + argument, required=True)
    preflight_parser.add_argument("--versions")
    catalog_parser = sub.add_parser("catalog-check", help="Read-only four-language CDB/LFS checks; no engine or database required")
    catalog_parser.add_argument("--catalog", required=True)
    catalog_parser.add_argument("--versions")
    catalog_fetch_parser = sub.add_parser("catalog-fetch", help="Download fixed-commit public GitHub LFS catalogs into a NEW directory")
    catalog_fetch_parser.add_argument("--destination", required=True)
    catalog_fetch_parser.add_argument("--versions", required=True)
    arguments = parser.parse_args()
    try:
        if arguments.action == "release":
            result = release(arguments.source, arguments.output, arguments.release_id, arguments.component,
                             arguments.include_public)
        elif arguments.action == "backup":
            plan_bytes = Path(arguments.plan).read_bytes()
            plan_sha256 = hashlib.sha256(plan_bytes).hexdigest()
            plan = json.loads(plan_bytes.decode("utf-8-sig"))
            writer_check = None
            if plan.get("writerGuard"):
                require(arguments.pm2_lock_token and arguments.pm2_queue_root and not arguments.confirm_isolated,
                        "Run node ops/scripts/windows-backup.cjs backup PLAN OUTPUT PYTHON [PG_BIN]")
                def writer_check():
                    _, evidence = run(["node", Path(__file__).with_name("windows-backup.cjs"), "check",
                                       str(Path(arguments.plan).absolute()), arguments.pm2_lock_token,
                                       "--queue-root", arguments.pm2_queue_root])
                    proof = json.loads(evidence)
                    require(proof.get("planSha256") == plan_sha256, "Parsed backup plan differs from the locked plan")
                    return proof
            else:
                require(not arguments.pm2_lock_token, "PM2 lock token requires a writerGuard plan")
            result = backup(plan, arguments.output, Postgres(plan["database"], arguments.pg_bin),
                            arguments.confirm_isolated, writer_check)
        elif arguments.action == "verify":
            result = verify_batch(arguments.batch)
        elif arguments.action in ("verify-release", "unpack-release"):
            result = read_json(str(arguments.archive) + ".manifest.json")
            check_release(arguments.archive, result)
            if arguments.action == "unpack-release":
                require(not Path(arguments.destination).exists(), "Unpack destination must be a new directory")
                require(not Path(arguments.archive).absolute().is_relative_to(Path(arguments.destination).absolute()),
                        "Unpack destination cannot contain the source archive")
                unpack_release(arguments.archive, result, Path(arguments.destination))
        elif arguments.action == "restore":
            result = restore(arguments.batch, arguments.destination, Postgres(arguments.database, arguments.pg_bin),
                             arguments.confirm_new_database, arguments.owner_role, arguments.runtime_role, arguments.schema_tool)
        elif arguments.action == "catalog-check":
            result = catalog_check(arguments.catalog, arguments.versions)
        elif arguments.action == "catalog-fetch":
            result = catalog_fetch(arguments.destination, arguments.versions)
        else:
            result = preflight(arguments.application, arguments.engine, arguments.catalog, arguments.versions, arguments.platform)
        # Detailed manifests are private files. Terminal output deliberately only gives
        # outcome, timestamp and counts, not filenames/account identities/environment.
        summary = {"success": True, "action": arguments.action,
                   "completedAt": now(), "files": len(result.get("files", []))}
        if arguments.action in {"catalog-check", "catalog-fetch"}:
            summary.update(result)
        print(json.dumps(summary, ensure_ascii=False))
    except (OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        category = getattr(error, "category", None)
        print(f"ERROR: {error}" + (f" [{category}]" if category else ""), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
