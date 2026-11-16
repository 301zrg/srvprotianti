"""Fail-closed transport tests; no real database, systemd or production data."""
import collections
import hashlib
from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("ops", Path(__file__).parents[1] / "scripts" / "ops.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)


TOKEN = "pg-row-json-copytext-c-utf8-lf-v1"
EMPTY = hashlib.sha256(b"").hexdigest()


def reference_sha(payloads, ending):
    # Independent expectation: explicit byte concatenation, never the function under test.
    return hashlib.sha256(b"".join(payload + ending for payload in payloads)).hexdigest()


def fixture_object(name, kind):
    return {"schema": "public", "name": name, "kind": kind,
            "columns": [{"name": "id", "type": "integer", "notNull": True, "default": None},
                        {"name": "label", "type": "text", "notNull": False, "default": "''::text"}],
            "constraints": ["PRIMARY KEY (id)"] if kind == "r" else [],
            "indexes": [f"CREATE UNIQUE INDEX {name}_pkey ON public.{name} USING btree (id)"] if kind == "r" else []}


FIXTURE_SCHEMA = [fixture_object("duel_log", "r"), fixture_object("duel_log_id_seq", "S"),
                  fixture_object("empty_table", "r"), fixture_object("ladder_user", "r")]
# COPY text payloads: a JSON "\n" escape is doubled by COPY, so no raw CR/LF/TAB appears.
FIXTURE_ROWS = {"duel_log": [b'{"id":1,"label":"line\\\\nbreak"}', b'{"id":2,"label":"\xe6\xb5\x8b\xe8\xaf\x951"}'],
                "empty_table": [], "ladder_user": [b'{"id":7,"label":null}']}


def fixture_state(rows=None, ending=b"\n", sequence="2", versioned=True, schema=None):
    rows = FIXTURE_ROWS if rows is None else rows
    schema = FIXTURE_SCHEMA if schema is None else schema
    tables = [{"schema": "public", "table": item["name"], "rows": len(rows[item["name"]]),
               "sha256": reference_sha(rows[item["name"]], ending)}
              for item in schema if item["kind"] == "r"]
    state = {"schema": json.loads(json.dumps(schema)), "tables": tables,
             "sequences": [{"schema": "public", "name": "duel_log_id_seq", "lastValue": sequence, "isCalled": True}]}
    return {"rowDigestFormat": TOKEN, **state} if versioned else state


class FakePostgres:
    database = "srvpro_drill_fixture"

    def __init__(self):
        self.states = 0
        self.changing = False
        self.quiet = True
        self.commands = []
        self.environment = {}
        self.encoding = "UTF8"
        self.rows = {name: list(values) for name, values in FIXTURE_ROWS.items()}
        self.schema = json.loads(json.dumps(FIXTURE_SCHEMA))
        self.sequence = "2"
        self.state_modes = []

    def assert_quiet(self):
        ops.require(self.quiet, "another connection remains")

    def assert_empty(self):
        pass

    def metadata(self):
        return {"database": self.database, "serverVersionNum": 170006, "serverVersion": "17.6",
                "encoding": self.encoding, "collate": "C", "ctype": "C", "owner": "owner", "timezone": "UTC"}

    def state(self, legacy=False):
        self.states += 1
        self.state_modes.append(legacy)
        sequence = str(self.states) if self.changing else self.sequence
        if legacy:
            return tuple(fixture_state(self.rows, ending, sequence, versioned=False, schema=self.schema)
                         for ending in (b"\n", b"\r\n"))
        return fixture_state(self.rows, b"\n", sequence, schema=self.schema)

    def replay_names(self):
        return ["中文 A.yrp", "missing.yrp", "中文 A.yrp"]

    def command(self, name, *args):
        self.commands.append((name, args))
        if name == "pg_dump" and "--version" in args:
            return 0, "pg_dump (PostgreSQL) 17.6"
        if name == "pg_dump":
            Path(args[args.index("--file") + 1]).write_bytes(b"fixture custom archive")
        return 0, ""


class OpsTest(unittest.TestCase):
    def setUp(self):
        self.temporary_parent = Path(__file__).parents[2] / ".audit-tmp" / "ops-tests"
        self.temporary_parent.mkdir(parents=True, exist_ok=True)
        self.root = self.temporary_parent / str(uuid.uuid4())
        self.root.mkdir()
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
        (self.source / "host.js").write_text("original\n", encoding="utf-8")
        (self.source / ".gitignore").write_text("config/\nnode_modules/\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet", str(self.source)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "add", "."], cwd=self.source, check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
                       cwd=self.source, check=True, stdout=subprocess.PIPE)
        self.engine = self.root / "engine"
        self.engine.mkdir()
        (self.engine / "cards.cdb").write_bytes(b"wide")
        (self.engine / "expansions").mkdir()
        (self.engine / "expansions" / "extra.cdb").write_bytes(b"pool")
        (self.engine / "ygopro").write_bytes(b"fixture engine")
        (self.engine / ".git").mkdir()
        (self.engine / ".git" / "config").write_text("private git remote", encoding="utf-8")
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        (self.recordings / "中文 A.yrp").write_bytes(b"raw\x00\xffrecording")
        (self.recordings / "historical.yrp").write_bytes(b"unlinked")
        self.private = self.root / "private"
        self.private.mkdir()
        (self.private / "config.json").write_text('{"secret":"fixture-only"}', encoding="utf-8")
        self.archive = self.root / "release.tar.gz"
        self.release_manifest = ops.release(self.source, self.archive, "test-release", [("engine", self.engine)])
        self.plan = {"format": 1, "database": "srvpro_drill_fixture", "runtimeRole": "runtime", "isolated": True,
                     "releaseArchive": str(self.archive), "writerUnits": ["game.service"],
                     "replayComponent": "recordings", "components": [
                         {"id": "recordings", "source": str(self.recordings)},
                         {"id": "private", "source": str(self.private)}]}

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(self.temporary_parent.resolve()))
        if os.name == "nt":
            # Restricted Windows tokens and short-lived Git scanners may hold fixture
            # objects. Keep ignored local evidence rather than changing ACLs/forcing
            # deletion just to make transport behavior tests pass.
            return
        shutil.rmtree(self.root, onerror=lambda function, path, info: (os.chmod(path, 0o777), function(path)))

    def batch(self, postgres=None):
        postgres = postgres or FakePostgres()
        destination = self.root / "backup"
        manifest = ops.backup(self.plan, destination, postgres, postgres.database)
        return destination, manifest

    def test_relative_paths_are_portable_and_cannot_escape(self):
        self.assertEqual(str(ops.safe_relative("中文/Case.yrp")), "中文/Case.yrp")
        for name in ("../secret", "/secret", "C:/secret", "a\\b", "a/./b", "a//b", "a/../b", ""):
            with self.subTest(name=name), self.assertRaises(ops.OpsError):
                ops.safe_relative(name)

    def test_release_captures_dirty_tracked_source_and_requires_explicit_untracked_public_selection(self):
        (self.source / "host.js").write_text("changed\n", encoding="utf-8")
        (self.source / "new-plugin.js").write_text("new public code\n", encoding="utf-8")
        (self.source / "state-secret.json").write_text("untracked runtime secret", encoding="utf-8")
        (self.source / "config").mkdir()
        (self.source / "config" / "config.json").write_text("private", encoding="utf-8")
        default = ops.release(self.source, self.root / "default.tar.gz", "default", [("engine", self.engine)])
        selected = ops.release(self.source, self.root / "selected.tar.gz", "selected", [("engine", self.engine)], ["new-plugin.js"])
        default_names = {row["path"] for row in default["files"]}
        selected_names = {row["path"] for row in selected["files"]}
        self.assertTrue(default["dirtyWorkingTree"])
        self.assertNotIn("application/new-plugin.js", default_names)
        self.assertIn("application/new-plugin.js", selected_names)
        self.assertNotIn("application/state-secret.json", selected_names)
        self.assertNotIn("application/config/config.json", selected_names)
        self.assertNotIn("components/engine/.git/config", selected_names)
        host = next(row for row in selected["files"] if row["path"] == "application/host.js")
        self.assertEqual(host["sha256"], ops.digest(self.source / "host.js"))
        ops.check_release(self.root / "selected.tar.gz", selected)

    def test_include_public_cannot_escape_or_override_secret_denylist(self):
        with self.assertRaises(ops.OpsError):
            ops.release(self.source, self.root / "escape.tar.gz", "escape", [("engine", self.engine)], ["../private"])
        directory = self.source / "plugins" / "new"
        directory.mkdir(parents=True)
        (directory / "index.js").write_text("public", encoding="utf-8")
        (directory / "config.json").write_text("private", encoding="utf-8")
        manifest = ops.release(self.source, self.root / "include.tar.gz", "include", [("engine", self.engine)], ["plugins/new"])
        names = {row["path"] for row in manifest["files"]}
        self.assertIn("application/plugins/new/index.js", names)
        self.assertNotIn("application/plugins/new/config.json", names)

    def test_release_refuses_output_inside_source_or_existing_release(self):
        for destination in (self.source / "release.tar.gz", self.archive):
            with self.subTest(destination=destination), self.assertRaises(ops.OpsError):
                ops.release(self.source, destination, "release", [("engine", self.engine)])

    def test_release_requires_explicit_complete_engine(self):
        with self.assertRaises(ops.OpsError):
            ops.release(self.source, self.root / "no-engine.tar.gz", "release", [("catalog", self.engine)])

    def catalogs(self, root=None):
        root = root or self.root / "catalog"
        root.mkdir(parents=True)
        for language in ops.CATALOG_LANGUAGES:
            with closing(sqlite3.connect(root / f"cards.{language}.cdb")) as connection, connection:
                connection.execute("CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT)")
                connection.execute("INSERT INTO texts VALUES (1, ?)", (f"Fixture {language}",))
                if language == "zh":
                    connection.execute("CREATE TABLE datas (id INTEGER PRIMARY KEY, type INTEGER, alias INTEGER)")
                    connection.execute("INSERT INTO datas VALUES (1, 8193, 0)")
        return root

    def catalog_versions(self, catalog):
        manifest = {"resourceFingerprints": [
            {"scope": "catalog", "path": f"cards.{language}.cdb",
             "bytes": (catalog / f"cards.{language}.cdb").stat().st_size,
             "sha256": ops.digest(catalog / f"cards.{language}.cdb")}
            for language in ops.CATALOG_LANGUAGES]}
        path = self.root / "versions.json"
        ops.write_json(path, manifest)
        return path, manifest

    def test_catalog_check_accepts_valid_databases_read_only_and_ignores_engine_fingerprints(self):
        catalog = self.catalogs()
        versions, manifest = self.catalog_versions(catalog)
        manifest["resourceFingerprints"].append({"scope": "engine", "path": "not-installed", "sha256": "unavailable"})
        ops.write_json(versions, manifest)
        before = ops.content_entries(ops.inventory(catalog))
        result = ops.catalog_check(catalog, versions)
        self.assertEqual([row["language"] for row in result["databases"]], ["zh", "ja", "en", "ko"])
        self.assertEqual([row["names"] for row in result["databases"]], [1, 1, 1, 1])
        self.assertEqual([row["metadata"] for row in result["databases"]], [1, None, None, None])
        self.assertTrue(result["metadataAvailable"])
        self.assertTrue(result["versionsChecked"])
        self.assertEqual(ops.content_entries(ops.inventory(catalog)), before)

    def test_catalog_check_rejects_missing_language_and_lfs_pointer_with_download_hint(self):
        catalog = self.catalogs()
        path = catalog / "cards.ja.cdb"
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ops.OpsError, "Missing catalog database.*git lfs pull"):
            ops.catalog_check(catalog)
        path.write_bytes(b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"0" * 64 + b"\nsize 100\n")
        with self.assertRaisesRegex(ops.OpsError, "Git LFS pointer.*git lfs pull"):
            ops.catalog_check(catalog)
        path.write_bytes(original)
        self.assertTrue(ops.catalog_check(catalog)["metadataAvailable"])

    def test_catalog_check_rejects_bad_header_and_corrupted_sqlite(self):
        catalog = self.catalogs()
        path = catalog / "cards.en.cdb"
        for content, expected in ((b"not a database", "not SQLite"),
                                  (b"SQLite format 3\x00" + b"invalid" * 64, "SQLite schema/read check failed")):
            with self.subTest(expected=expected):
                path.write_bytes(content)
                with self.assertRaisesRegex(ops.OpsError, expected):
                    ops.catalog_check(catalog)

    def test_catalog_check_rejects_missing_chinese_datas_type_or_alias_and_empty_metadata(self):
        for missing in ("datas", "type", "alias", "rows"):
            with self.subTest(missing=missing):
                catalog = self.catalogs(self.root / ("catalog-" + missing))
                with closing(sqlite3.connect(catalog / "cards.zh.cdb")) as connection, connection:
                    connection.execute("DROP TABLE datas")
                    if missing != "datas":
                        columns = "id INTEGER" + (", type INTEGER" if missing != "type" else "")
                        columns += ", alias INTEGER" if missing != "alias" else ""
                        connection.execute("CREATE TABLE datas (" + columns + ")")
                with self.assertRaises(ops.OpsError):
                    ops.catalog_check(catalog)

    def test_catalog_check_rejects_empty_names(self):
        catalog = self.catalogs()
        with closing(sqlite3.connect(catalog / "cards.ko.cdb")) as connection, connection:
            connection.execute("UPDATE texts SET name = ''")
        with self.assertRaisesRegex(ops.OpsError, "no usable card names"):
            ops.catalog_check(catalog)

    def test_catalog_check_wal_headers_do_not_create_sidecars_or_change_artifacts(self):
        catalog = self.catalogs()
        for language in ops.CATALOG_LANGUAGES:
            with closing(sqlite3.connect(catalog / f"cards.{language}.cdb")) as connection, connection:
                self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        before = ops.inventory(catalog)
        self.assertEqual(len(before), 4)
        versions, _ = self.catalog_versions(catalog)
        self.assertTrue(ops.catalog_check(catalog, versions)["metadataAvailable"])
        self.assertEqual(ops.inventory(catalog), before)
        self.assertFalse(list(catalog.glob("*-wal")))
        self.assertFalse(list(catalog.glob("*-shm")))

    def test_catalog_check_versions_rejects_missing_duplicate_hash_and_byte_mismatch(self):
        catalog = self.catalogs()
        versions, manifest = self.catalog_versions(catalog)
        for change in ("missing", "duplicate", "hash", "bytes"):
            with self.subTest(change=change):
                changed = json.loads(json.dumps(manifest))
                rows = changed["resourceFingerprints"]
                if change == "missing":
                    rows.pop()
                elif change == "duplicate":
                    rows.append(rows[0].copy())
                elif change == "hash":
                    rows[0]["sha256"] = "0" * 64
                else:
                    rows[0]["bytes"] += 1
                ops.write_json(versions, changed)
                with self.assertRaises(ops.OpsError):
                    ops.catalog_check(catalog, versions)

    def test_preflight_uses_catalog_check_and_keeps_engine_fingerprint_validation(self):
        catalog = self.catalogs()
        for name in ("ygopro-server.js", "plugin-system.js"):
            (self.source / name).write_text("fixture", encoding="utf-8")
        (self.engine / "lflist.conf").write_text("fixture", encoding="utf-8")
        (self.engine / "gframe").mkdir()
        (self.engine / "gframe" / "config.h").write_text("fixture", encoding="utf-8")
        (self.engine / "script").mkdir()
        responses = {"node": (0, "v24.15.0"), "uname": (0, "x86_64"),
                     "file": (0, "ELF x86-64"), "ldd": (0, "libraries resolved")}
        with patch.object(ops, "run", side_effect=lambda command, **kwargs: responses[command[0]]), \
                patch.object(ops.platform, "system", return_value="Linux"), \
                patch.object(ops.os, "access", return_value=True):
            self.assertTrue(ops.preflight(self.source, self.engine, catalog)["catalog"]["metadataAvailable"])
            original = (catalog / "cards.zh.cdb").read_bytes()
            (catalog / "cards.zh.cdb").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
            with self.assertRaisesRegex(ops.OpsError, "Git LFS pointer"):
                ops.preflight(self.source, self.engine, catalog)
            (catalog / "cards.zh.cdb").write_bytes(original)
            versions, manifest = self.catalog_versions(catalog)
            manifest["resourceFingerprints"].append({"scope": "engine", "path": "cards.cdb", "sha256": "wrong"})
            ops.write_json(versions, manifest)
            with self.assertRaisesRegex(ops.OpsError, "Resource fingerprint mismatch: engine/cards.cdb"):
                ops.preflight(self.source, self.engine, catalog, versions)

    def test_release_tracks_catalogs_only_in_explicit_component(self):
        catalog = self.catalogs(self.source / "plugins" / "card-catalog" / "databases")
        (catalog.parent / "README.md").write_text("public plugin documentation", encoding="utf-8")
        subprocess.run(["git", "add", "plugins/card-catalog"], cwd=self.source, check=True, stdout=subprocess.PIPE)
        archive = self.root / "catalog-release.tar.gz"
        manifest = ops.release(self.source, archive, "catalog-release", [("engine", self.engine), ("catalog", catalog)],
                               ["plugins/card-catalog/databases"])
        names = {row["path"] for row in manifest["files"]}
        self.assertIn("application/plugins/card-catalog/README.md", names)
        self.assertFalse(any(name.startswith("application/plugins/card-catalog/databases/") for name in names))
        self.assertEqual({name for name in names if name.startswith("components/catalog/")},
                         {f"components/catalog/cards.{language}.cdb" for language in ops.CATALOG_LANGUAGES})
        ops.check_release(archive, manifest)

    def test_catalog_check_cli_reports_public_summaries_without_card_contents(self):
        catalog = self.catalogs()
        result = subprocess.run([sys.executable, str(Path(__file__).parents[1] / "scripts" / "ops.py"),
                                 "catalog-check", "--catalog", str(catalog)], check=True, stdout=subprocess.PIPE)
        summary = json.loads(result.stdout.decode("utf-8"))
        self.assertTrue(summary["success"])
        self.assertEqual(summary["action"], "catalog-check")
        self.assertEqual(len(summary["databases"]), 4)
        self.assertNotIn("Fixture", result.stdout.decode("utf-8"))

    def fetch_versions(self, catalog):
        versions, manifest = self.catalog_versions(catalog)
        manifest["catalogSource"] = {"repository": "https://github.com/fixture/public-catalogs.git",
                                     "commit": "1" * 40, "directory": "catalog"}
        ops.write_json(versions, manifest)
        return versions, manifest

    def test_catalog_fetch_pins_commit_uses_isolated_lfs_and_validates_before_copy(self):
        catalog = self.catalogs()
        versions, manifest = self.fetch_versions(catalog)
        destination = self.root / "downloaded-catalog"
        commands = []

        def fake_run(command, *, cwd, env):
            commands.append(command)
            self.assertEqual(env["GIT_LFS_SKIP_SMUDGE"], "1")
            self.assertFalse(destination.exists())
            if command[:3] == ["git", "lfs", "pull"]:
                shutil.copytree(catalog, Path(cwd) / "catalog")
                (Path(cwd) / "catalog" / "unrelated.txt").write_text("not a runtime catalog", encoding="utf-8")
            return 0, ""

        with patch.object(ops, "run", side_effect=fake_run), patch.object(ops.shutil, "which", return_value="git"):
            result = ops.catalog_fetch(destination, versions)
        self.assertIn(["git", "fetch", "--depth=1", "origin", "1" * 40], commands)
        self.assertIn(["git", "checkout", "--detach", "1" * 40], commands)
        self.assertTrue(any(command[:4] == ["git", "config", "--local", "lfs.storage"] for command in commands))
        pull = next(command for command in commands if command[:3] == ["git", "lfs", "pull"])
        self.assertEqual(pull[-2], "--include=catalog/cards.zh.cdb,catalog/cards.ja.cdb,catalog/cards.en.cdb,catalog/cards.ko.cdb")
        self.assertEqual(pull[-1], "--exclude=")
        self.assertEqual({path.name for path in destination.iterdir()},
                         {f"cards.{language}.cdb" for language in ops.CATALOG_LANGUAGES})
        self.assertEqual(ops.content_entries(ops.inventory(destination)), ops.content_entries(ops.inventory(catalog)))
        self.assertTrue(result["downloaded"])
        self.assertEqual(result["commit"], manifest["catalogSource"]["commit"])

    def test_catalog_fetch_refuses_existing_destination_before_network(self):
        catalog = self.catalogs()
        versions, _ = self.fetch_versions(catalog)
        with patch.object(ops, "run") as run, self.assertRaisesRegex(ops.OpsError, "new directory"):
            ops.catalog_fetch(catalog, versions)
        run.assert_not_called()

    def test_catalog_fetch_rejects_untrusted_urls_moving_refs_and_source_escape(self):
        catalog = self.catalogs()
        versions, manifest = self.fetch_versions(catalog)
        invalid = [("repository", "https://user:password@github.com/fixture/catalogs.git"),
                   ("repository", "https://github.com/fixture/catalogs.git?token=secret"),
                   ("repository", "https://example.invalid/fixture/catalogs.git"),
                   ("repository", "https://github.com/fixture/.."),
                   ("commit", "main"), ("commit", "--upload-pack=bad"), ("directory", "../private")]
        for key, value in invalid:
            with self.subTest(key=key, value=value):
                changed = json.loads(json.dumps(manifest))
                changed["catalogSource"][key] = value
                ops.write_json(versions, changed)
                with patch.object(ops, "run") as run, self.assertRaises(ops.OpsError):
                    ops.catalog_fetch(self.root / "untrusted", versions)
                run.assert_not_called()

    def test_catalog_fetch_download_or_validation_failure_never_creates_destination(self):
        catalog = self.catalogs()
        versions, manifest = self.fetch_versions(catalog)
        for failure in ("download", "hash"):
            with self.subTest(failure=failure):
                destination = self.root / ("failed-" + failure)
                temporary_checkouts = []

                def fake_run(command, *, cwd, env):
                    temporary_checkouts.append(Path(cwd))
                    if command[:3] == ["git", "lfs", "pull"]:
                        if failure == "download":
                            raise ops.OpsError("fixture LFS download unavailable")
                        shutil.copytree(catalog, Path(cwd) / "catalog")
                        with closing(sqlite3.connect(Path(cwd) / "catalog" / "cards.zh.cdb")) as connection, connection:
                            connection.execute("UPDATE texts SET name = 'wrong version'")
                    return 0, ""

                with patch.object(ops, "run", side_effect=fake_run), \
                        patch.object(ops.shutil, "which", return_value="git"), \
                        self.assertRaisesRegex(ops.OpsError, "Catalog fetch failed"):
                    ops.catalog_fetch(destination, versions)
                self.assertFalse(destination.exists())
                self.assertTrue(temporary_checkouts)
                self.assertFalse(temporary_checkouts[0].exists())

    def test_catalog_fetch_destination_race_preserves_foreign_directory(self):
        catalog = self.catalogs()
        versions, _ = self.fetch_versions(catalog)
        destination = self.root / "concurrently-created"
        original_mkdir = Path.mkdir

        def fake_run(command, *, cwd, env):
            if command[:3] == ["git", "lfs", "pull"]:
                shutil.copytree(catalog, Path(cwd) / "catalog")
            return 0, ""

        def raced_mkdir(path, *args, **kwargs):
            if path == destination:
                original_mkdir(path)
                (path / "foreign.txt").write_text("owned by another operation", encoding="utf-8")
                raise FileExistsError("fixture concurrent destination creation")
            return original_mkdir(path, *args, **kwargs)

        with patch.object(ops, "run", side_effect=fake_run), \
                patch.object(ops.shutil, "which", return_value="git"), \
                patch.object(Path, "mkdir", new=raced_mkdir), \
                self.assertRaisesRegex(ops.OpsError, "Catalog fetch failed"):
            ops.catalog_fetch(destination, versions)
        self.assertEqual((destination / "foreign.txt").read_text(encoding="utf-8"), "owned by another operation")

    def test_catalog_fetch_copy_failure_removes_only_owned_partial_destination(self):
        catalog = self.catalogs()
        versions, _ = self.fetch_versions(catalog)
        destination = self.root / "copy-failed"
        copy2 = shutil.copy2

        def fake_run(command, *, cwd, env):
            if command[:3] == ["git", "lfs", "pull"]:
                shutil.copytree(catalog, Path(cwd) / "catalog")
            return 0, ""

        def broken_copy(source, target, **kwargs):
            if Path(target).parent == destination and Path(target).name == "cards.ja.cdb":
                raise OSError("fixture failed copying second catalog")
            return copy2(source, target, **kwargs)

        with patch.object(ops, "run", side_effect=fake_run), \
                patch.object(ops.shutil, "which", return_value="git"), \
                patch.object(ops.shutil, "copy2", side_effect=broken_copy), \
                self.assertRaisesRegex(ops.OpsError, "Catalog fetch failed"):
            ops.catalog_fetch(destination, versions)
        self.assertFalse(destination.exists())

    def test_archive_rejects_links_traversal_duplicates_and_unlisted_members(self):
        for kind in ("link", "traversal", "duplicate", "unlisted"):
            with self.subTest(kind=kind):
                archive = self.root / (kind + ".tar.gz")
                with tarfile.open(archive, "w:gz") as stream:
                    info = tarfile.TarInfo("../escape" if kind == "traversal" else "safe")
                    if kind == "link":
                        info.type, info.linkname = tarfile.SYMTYPE, "../../secret"
                        stream.addfile(info)
                    else:
                        info.size = 3
                        stream.addfile(info, io.BytesIO(b"abc"))
                        if kind == "duplicate":
                            stream.addfile(info, io.BytesIO(b"abc"))
                manifest = {"format": 1, "kind": "release", "archiveSha256": ops.digest(archive),
                            "files": [] if kind == "unlisted" else [{"path": info.name, "size": 3,
                                "sha256": hashlib.sha256(b"abc").hexdigest()}]}
                with self.assertRaises(ops.OpsError):
                    ops.check_release(archive, manifest)

    def test_unpack_release_verifies_bytes_and_refuses_existing_target(self):
        target = self.root / "unpacked"
        ops.unpack_release(self.archive, self.release_manifest, target)
        self.assertEqual((target / "components" / "engine" / "expansions" / "extra.cdb").read_bytes(), b"pool")
        with self.assertRaises(FileExistsError):
            ops.unpack_release(self.archive, self.release_manifest, target)

    def test_backup_and_verify_preserve_private_bytes_unicode_and_replay_baseline(self):
        batch, manifest = self.batch()
        self.assertEqual(ops.verify_batch(batch), manifest)
        self.assertEqual((batch / "files" / "recordings" / "中文 A.yrp").read_bytes(), b"raw\x00\xffrecording")
        self.assertEqual(manifest["replayAssociations"]["linkedFiles"], ["中文 A.yrp"])
        self.assertEqual(manifest["replayAssociations"]["unlinkedFiles"], ["historical.yrp"])
        self.assertEqual(manifest["replayAssociations"]["databaseWithoutFile"], ["missing.yrp"])
        self.assertFalse(manifest["quiescence"]["linuxSystemdVerified"])

    def test_failed_or_extra_or_corrupted_batch_is_refused(self):
        batch, _ = self.batch()
        extra = batch / "unexpected.txt"
        extra.write_text("extra", encoding="utf-8")
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)
        extra.unlink()
        replay = batch / "files" / "recordings" / "中文 A.yrp"
        replay.write_bytes(b"corrupted")
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)
        replay.write_bytes(b"raw\x00\xffrecording")
        (batch / "FAILED.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)

    def test_database_changes_fail_snapshot_and_leave_nonrestorable_evidence(self):
        pg = FakePostgres()
        pg.changing = True
        with self.assertRaises(ops.OpsError):
            self.batch(pg)
        self.assertTrue((self.root / "backup" / "FAILED.json").is_file())
        self.assertFalse((self.root / "backup" / "manifest.json").exists())

    def test_connected_writer_refused_before_snapshot(self):
        pg = FakePostgres()
        pg.quiet = False
        with self.assertRaises(ops.OpsError):
            self.batch(pg)
        self.assertFalse((self.root / "backup").exists())

    def test_pm2_guard_cannot_be_replaced_with_isolated_attestation(self):
        self.plan["writerGuard"] = {"manager": "pm2"}
        for isolated in (None, self.plan["database"]):
            with self.assertRaises(ops.OpsError):
                ops.backup(self.plan, self.root / "guard-bypass", FakePostgres(), isolated)
        self.assertFalse((self.root / "guard-bypass").exists())

    def test_reparse_points_are_refused_for_source_and_new_output_ancestors(self):
        with patch.object(ops, "is_reparse", side_effect=lambda path: Path(path) == self.private):
            with self.assertRaises(ops.OpsError):
                ops.resolve_source(self.private / "config.json")
            with self.assertRaises(ops.OpsError):
                ops.checked_destination(self.private / "new-backup")

    def test_pm2_guard_is_checked_twice_and_change_invalidates_batch(self):
        self.plan["writerGuard"] = {"manager": "pm2"}
        before = {"mode": "windows-pm2-offline", "apps": [{"name": "game", "status": "stopped"}]}
        guard = unittest.mock.Mock(side_effect=[before, {**before, "changed": True}])
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, self.root / "guard-change", FakePostgres(), writer_check=guard)
        self.assertEqual(guard.call_count, 2)
        self.assertTrue((self.root / "guard-change" / "FAILED.json").is_file())

    def test_systemd_requires_loaded_inactive_every_unit(self):
        for state in ("active", "failed", "activating", "deactivating"):
            with self.subTest(state=state), patch.object(ops, "run", return_value=(0, "LoadState=loaded\nActiveState=" + state)):
                with self.assertRaises(ops.OpsError):
                    ops.check_units(["game.service"])
        with patch.object(ops, "run", return_value=(0, "LoadState=not-found\nActiveState=inactive")):
            with self.assertRaises(ops.OpsError):
                ops.check_units(["missing.service"])
        with patch.object(ops, "run", return_value=(0, "LoadState=loaded\nActiveState=inactive")) as run:
            self.assertEqual(len(ops.check_units(["game.service", "bot.service"])), 2)
            self.assertEqual(run.call_count, 2)

    def test_isolated_mode_cannot_silently_bypass_production_writer_check(self):
        self.plan["database"] = "srvpro"
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, self.root / "production-bypass", FakePostgres(), "srvpro")
        self.plan["database"] = "srvpro_drill_fixture"
        self.plan["isolated"] = False
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, self.root / "no-attestation", FakePostgres(), "srvpro_drill_fixture")

    def test_plan_refuses_overlapping_sources_and_backup_inside_input(self):
        self.plan["components"].append({"id": "overlap", "source": str(self.recordings / "中文 A.yrp")})
        with self.assertRaises(ops.OpsError):
            ops.validate_plan(self.plan)
        self.plan["components"].pop()
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, self.recordings / "backup", FakePostgres(), "srvpro_drill_fixture")

    def test_restore_refuses_source_database_missing_confirmation_and_existing_directory_before_writes(self):
        batch, _ = self.batch()
        schema_tool = self.root / "schema.js"
        schema_tool.write_text("fixture", encoding="utf-8")
        for database, confirm, target in (("srvpro_drill_fixture", "srvpro_drill_fixture", self.root / "new"),
                                         ("srvpro_restore_new", "wrong", self.root / "new"),
                                         ("srvpro_restore_new", "srvpro_restore_new", self.source)):
            pg = FakePostgres()
            pg.database = database
            with self.subTest(database=database, confirm=confirm, target=target), self.assertRaises(ops.OpsError):
                ops.restore(batch, target, pg, confirm, "owner", "runtime", schema_tool)
            self.assertEqual(pg.commands, [])

    def test_restore_does_not_extract_unverified_content(self):
        batch, _ = self.batch()
        (batch / "database.dump").write_bytes(b"corrupt")
        with self.assertRaises(ops.OpsError):
            ops.restore(batch, self.root / "target", FakePostgres(), "srvpro_drill_fixture", "owner", "runtime", "schema.js")
        self.assertFalse((self.root / "target").exists())

    def legacy_batch(self, ending):
        # Shape of a batch written by the tools before the digest format existed:
        # no rowDigestFormat, digests over the raw psql record ending of that host.
        batch, manifest = self.batch()
        manifest["databaseState"] = fixture_state(ending=ending, versioned=False)
        ops.write_json(batch / "manifest.json", manifest)
        return batch, manifest

    def restore_fixture(self, batch, name="restored", postgres=None):
        schema_tool = self.root / "schema.js"
        schema_tool.write_text("fixture", encoding="utf-8")
        postgres = postgres or FakePostgres()
        postgres.database = "srvpro_restore_new"
        with patch.object(ops, "run", return_value=(0, "")):
            return postgres, ops.restore(batch, self.root / name, postgres, "srvpro_restore_new",
                                         "owner", "runtime", schema_tool)

    def failed_restore(self, batch, name, postgres=None, category=None):
        with self.assertRaises(ops.OpsError) as caught:
            self.restore_fixture(batch, name, postgres)
        if category:
            self.assertEqual(caught.exception.category, category)
        return caught.exception

    def test_backup_writes_versioned_digest_format_and_keeps_outer_format(self):
        batch, manifest = self.batch()
        self.assertEqual(manifest["format"], 1)
        self.assertEqual(manifest["databaseState"]["rowDigestFormat"], TOKEN)
        self.assertEqual(ops.read_json(batch / "manifest.json")["databaseState"], fixture_state())

    def test_backup_refuses_non_utf8_source_before_writing(self):
        postgres = FakePostgres()
        postgres.encoding = "SQL_ASCII"
        with self.assertRaises(ops.OpsError):
            self.batch(postgres)
        self.assertFalse((self.root / "backup").exists())

    def test_verify_refuses_unknown_or_malformed_digest_format_but_accepts_legacy_shape(self):
        batch, manifest = self.batch()
        for token in ("pg-row-json-copytext-c-utf8-lf-v2", "", None, True, 1, [TOKEN]):
            with self.subTest(token=token):
                changed = json.loads(json.dumps(manifest))
                changed["databaseState"]["rowDigestFormat"] = token
                ops.write_json(batch / "manifest.json", changed)
                with self.assertRaises(ops.OpsError) as caught:
                    ops.verify_batch(batch)
                self.assertEqual(caught.exception.category, "unsupported-row-digest-format")
        for label, mutate in (("missing-state", lambda m: m.pop("databaseState")),
                              ("missing-tables", lambda m: m["databaseState"].pop("tables")),
                              ("extra-key", lambda m: m["databaseState"].update(rowDigestFormats=TOKEN)),
                              ("boolean-format", lambda m: m.update(format=True))):
            with self.subTest(label=label):
                changed = json.loads(json.dumps(manifest))
                mutate(changed)
                ops.write_json(batch / "manifest.json", changed)
                with self.assertRaises(ops.OpsError):
                    ops.verify_batch(batch)
        legacy = json.loads(json.dumps(manifest))
        legacy["databaseState"] = fixture_state(ending=b"\r\n", versioned=False)
        ops.write_json(batch / "manifest.json", legacy)
        self.assertEqual(ops.verify_batch(batch), legacy)

    def test_restore_versioned_batch_is_strict_and_records_canonical_match(self):
        batch, _ = self.batch()
        postgres, report = self.restore_fixture(batch)
        self.assertTrue(report["complete"] and report["databaseAndFilesVerified"] and report["replayAssociationsVerified"])
        self.assertEqual(report["databaseStateVerification"],
                         {"algorithm": TOKEN, "matchedRecordEnding": "lf", "scope": "whole-batch",
                          "independentRowCountsVerified": True})
        self.assertEqual(postgres.state_modes, [False])
        self.assertEqual(ops.read_json(self.root / "restored" / "restore-result.json"), report)

    def test_restore_versioned_batch_never_falls_back_to_legacy_candidates(self):
        batch, manifest = self.batch()
        # The digests only match what a legacy CRLF computation of the target would give.
        manifest["databaseState"] = fixture_state(ending=b"\r\n")
        ops.write_json(batch / "manifest.json", manifest)
        postgres = FakePostgres()
        self.failed_restore(batch, "no-fallback", postgres, "database-state-mismatch")
        self.assertEqual(postgres.state_modes, [False])
        result = ops.read_json(self.root / "no-fallback" / "restore-result.json")
        self.assertFalse(result["complete"])
        self.assertNotIn("databaseAndFilesVerified", result)
        self.assertEqual(result["failureCategory"], "database-state-mismatch")

    def test_restore_legacy_batch_matches_one_whole_database_candidate(self):
        for ending, label in ((b"\n", "lf"), (b"\r\n", "crlf")):
            with self.subTest(label=label):
                batch, manifest = self.legacy_batch(ending)
                before = (batch / "manifest.json").read_bytes()
                postgres, report = self.restore_fixture(batch, "restored-" + label)
                self.assertTrue(report["complete"] and report["databaseAndFilesVerified"]
                                and report["replayAssociationsVerified"])
                self.assertEqual(report["databaseStateVerification"],
                                 {"algorithm": "legacy-psql-copy-unversioned", "matchedRecordEnding": label,
                                  "scope": "whole-batch", "independentRowCountsVerified": True})
                self.assertEqual(postgres.state_modes, [True])
                self.assertEqual((batch / "manifest.json").read_bytes(), before)
                self.assertNotIn("rowDigestFormat", manifest["databaseState"])
                shutil.rmtree(batch)

    def test_restore_legacy_batch_refuses_per_table_mixed_candidates(self):
        batch, manifest = self.legacy_batch(b"\n")
        crlf = fixture_state(ending=b"\r\n", versioned=False)
        # duel_log keeps its LF digest, ladder_user takes the CRLF one: every table matches
        # some candidate, but no single candidate matches the whole database.
        manifest["databaseState"]["tables"][2] = crlf["tables"][2]
        ops.write_json(batch / "manifest.json", manifest)
        self.failed_restore(batch, "mixed", category="legacy-no-uniform-match")
        result = ops.read_json(self.root / "mixed" / "restore-result.json")
        self.assertFalse(result["complete"])
        self.assertEqual({row["category"] for rows in result["failureDetails"]["candidates"].values() for row in rows},
                         {"content-mismatch"})

    def test_restore_legacy_all_empty_database_is_reported_ambiguous(self):
        postgres = FakePostgres()
        postgres.rows = {name: [] for name in FIXTURE_ROWS}
        batch, manifest = self.batch(postgres)
        manifest["databaseState"] = fixture_state(postgres.rows, versioned=False)
        ops.write_json(batch / "manifest.json", manifest)
        target = FakePostgres()
        target.rows = postgres.rows
        _, report = self.restore_fixture(batch, postgres=target)
        self.assertEqual(report["databaseStateVerification"]["matchedRecordEnding"], "ambiguous-empty")

    def test_restore_rejects_changed_value_count_schema_and_sequence_for_new_and_legacy(self):
        changes = {"content-mismatch": lambda pg: pg.rows["ladder_user"].__setitem__(0, b'{"id":8,"label":null}'),
                   "row-count-mismatch": lambda pg: pg.rows["ladder_user"].append(b'{"id":9,"label":null}'),
                   "schema-mismatch": lambda pg: pg.schema[3]["columns"][1].__setitem__("type", "character varying(20)"),
                   "sequence-mismatch": lambda pg: setattr(pg, "sequence", "3")}
        for legacy in (False, True):
            batch, _ = self.legacy_batch(b"\r\n") if legacy else self.batch()
            for index, (category, change) in enumerate(changes.items()):
                with self.subTest(legacy=legacy, category=category):
                    postgres = FakePostgres()
                    change(postgres)
                    name = f"changed-{legacy}-{index}"
                    self.failed_restore(batch, name, postgres)
                    result = ops.read_json(self.root / name / "restore-result.json")
                    self.assertFalse(result["complete"])
                    details = result["failureDetails"]
                    found = (details["candidates"]["crlf"] if legacy else details["differences"])
                    self.assertEqual([row["category"] for row in found], [category])
                    serialized = json.dumps(result)
                    self.assertNotIn("label", serialized)
                    self.assertFalse(any(row["sha256"] in serialized for row in fixture_state()["tables"]))
            shutil.rmtree(batch)

    def test_restore_tampered_manifest_digest_fails_comparison_not_verify(self):
        batch, manifest = self.batch()
        row = manifest["databaseState"]["tables"][0]
        row["sha256"] = ("0" if row["sha256"][0] != "0" else "1") + row["sha256"][1:]
        ops.write_json(batch / "manifest.json", manifest)
        ops.verify_batch(batch)
        self.failed_restore(batch, "tampered", category="database-state-mismatch")

    def test_restore_unknown_digest_format_is_refused_before_any_target_write(self):
        batch, manifest = self.batch()
        manifest["databaseState"]["rowDigestFormat"] = "future-format"
        ops.write_json(batch / "manifest.json", manifest)
        postgres = FakePostgres()
        self.failed_restore(batch, "unknown-format", postgres, "unsupported-row-digest-format")
        self.assertFalse((self.root / "unknown-format").exists())
        self.assertEqual((postgres.commands, postgres.state_modes), ([], []))

    def test_restore_versioned_batch_requires_utf8_target_before_writes(self):
        batch, _ = self.batch()
        postgres = FakePostgres()
        postgres.encoding = "LATIN1"
        self.failed_restore(batch, "latin1", postgres)
        self.assertFalse((self.root / "latin1").exists())

    def test_restore_later_component_failure_keeps_incomplete_result_after_digest_match(self):
        batch, _ = self.batch()
        postgres = FakePostgres()
        with patch.object(postgres, "replay_names", return_value=["other.yrp"]):
            postgres.database = "srvpro_restore_new"
            schema_tool = self.root / "schema.js"
            schema_tool.write_text("fixture", encoding="utf-8")
            # The baseline was taken with the default names; a different relation must fail.
            with patch.object(ops, "run", return_value=(0, "")), self.assertRaises(ops.OpsError):
                ops.restore(batch, self.root / "late", postgres, "srvpro_restore_new", "owner", "runtime", schema_tool)
        result = ops.read_json(self.root / "late" / "restore-result.json")
        self.assertFalse(result["complete"])
        self.assertNotIn("replayAssociationsVerified", result)
        self.assertEqual(result["databaseStateVerification"]["matchedRecordEnding"], "lf")

    def reorder_manifest(self, batch, order):
        manifest = ops.read_json(batch / "manifest.json")
        manifest["files"] = order(manifest["files"])
        for item in manifest["components"]:
            item["files"] = order(item["files"])
        ops.write_json(batch / "manifest.json", manifest)
        return manifest

    def test_file_inventory_order_of_another_platform_is_accepted_for_verify_and_restore(self):
        # Windows sorts sibling paths case-insensitively and Linux by code point, so a batch
        # lists the same files in a different order than the restoring host computes.
        for name in ("Zed.yrp", "apple.yrp", "Beta.yrp"):
            (self.recordings / name).write_bytes(name.encode("ascii"))
        batch, _ = self.batch()
        orders = {"code-point": lambda rows: sorted(rows, key=lambda row: row["path"]),
                  "case-insensitive": lambda rows: sorted(rows, key=lambda row: row["path"].lower()),
                  "reversed": lambda rows: list(reversed(rows))}
        for label, order in orders.items():
            with self.subTest(label=label):
                manifest = self.reorder_manifest(batch, order)
                self.assertEqual(ops.verify_batch(batch), manifest)
                _, report = self.restore_fixture(batch, "ordered-" + label)
                self.assertTrue(report["complete"] and report["databaseAndFilesVerified"])
        names = [row["path"] for row in orders["code-point"](ops.read_json(batch / "manifest.json")["files"])]
        self.assertNotEqual(names, sorted(names, key=str.lower))

    def test_reordered_file_inventory_still_refuses_missing_duplicate_changed_and_extra_entries(self):
        batch, original = self.batch()
        changes = {"missing": lambda rows: rows.pop(), "duplicate": lambda rows: rows.append(dict(rows[0])),
                   "size": lambda rows: rows[0].update(size=rows[0]["size"] + 1),
                   "sha": lambda rows: rows[0].update(sha256="0" * 64),
                   "extra": lambda rows: rows.append({"path": "files/recordings/ghost.yrp", "size": 1, "sha256": "0" * 64}),
                   "renamed": lambda rows: rows[0].update(path=rows[0]["path"] + ".x")}
        for target in ("files", "component"):
            for label, change in changes.items():
                with self.subTest(target=target, label=label):
                    manifest = json.loads(json.dumps(original))
                    rows = manifest["files"] if target == "files" else manifest["components"][0]["files"]
                    rows.reverse()
                    change(rows)
                    ops.write_json(batch / "manifest.json", manifest)
                    with self.assertRaises(ops.OpsError):
                        ops.verify_batch(batch)

    def test_malformed_manifest_file_lists_are_a_controlled_refusal(self):
        batch, original = self.batch()
        changes = {"files null": lambda m: m.update(files=None), "file row null": lambda m: m["files"].__setitem__(0, None),
                   "components null": lambda m: m.update(components=None),
                   "component not object": lambda m: m["components"].__setitem__(0, []),
                   "component files null": lambda m: m["components"][0].update(files=None),
                   "component row null": lambda m: m["components"][0]["files"].__setitem__(0, None),
                   "component id number": lambda m: m["components"][0].update(id=7),
                   "root list": lambda m: None}
        for label, change in changes.items():
            with self.subTest(label=label):
                manifest = json.loads(json.dumps(original))
                change(manifest)
                ops.write_json(batch / "manifest.json", [manifest] if label == "root list" else manifest)
                with self.assertRaises(ops.OpsError):
                    ops.verify_batch(batch)
                target = self.root / ("malformed-" + label.replace(" ", "-"))
                self.failed_restore(batch, target.name)
                self.assertFalse(target.exists())

    def test_same_content_is_an_exact_multiset_comparison(self):
        a = {"path": "a", "size": 1, "sha256": "a" * 64, "mode": 0o644}
        b = {"path": "a", "size": 2, "sha256": "b" * 64}
        c = {"path": "B", "size": 3, "sha256": "c" * 64}
        self.assertTrue(ops.same_content([a, b, c], [c, b, {**a, "mode": 0o600}]))
        self.assertTrue(ops.same_content([], []))
        for other in ([a, c], [a, a, c], [a, b, {**c, "path": "b"}], [a, b, {**c, "size": 4}], [a, b, c, c]):
            self.assertFalse(ops.same_content([a, b, c], other))

    def test_backup_copy_and_source_change_checks_remain_effective(self):
        original = ops.copy_tree

        def corrupting_copy(source, destination):
            original(source, destination)
            if destination.name == "recordings":
                (destination / "historical.yrp").write_bytes(b"changed in copy")

        with patch.object(ops, "copy_tree", side_effect=corrupting_copy), self.assertRaises(ops.OpsError):
            self.batch()
        self.assertTrue((self.root / "backup" / "FAILED.json").is_file())

    def counting(self, name):
        calls = collections.Counter()
        original = getattr(ops, name)

        def counted(value, *rest):
            calls[Path(value).absolute()] += 1
            return original(value, *rest)

        return calls, patch.object(ops, name, side_effect=counted)

    def small_tree(self):
        tree = self.root / "tree"
        (tree / "a" / "b").mkdir(parents=True)
        for name in ("x", "y", "z"):
            (tree / "a" / "b" / name).write_bytes(name.encode("ascii"))
        (tree / "top").write_bytes(b"top")
        return tree

    def test_inventory_checks_every_path_and_ancestor_for_links_exactly_once(self):
        # 79k replays in one directory used to re-check the same ancestor chain for every file.
        tree = self.small_tree()
        calls, counted = self.counting("is_reparse")
        with counted:
            entries = ops.inventory(tree)
        self.assertEqual(sorted(row["path"] for row in entries), ["a/b/x", "a/b/y", "a/b/z", "top"])
        expected = {tree, *tree.parents, tree / "a", tree / "a" / "b", tree / "top",
                    *(tree / "a" / "b" / name for name in ("x", "y", "z"))}
        self.assertEqual(set(calls), expected)
        self.assertEqual({path.name: count for path, count in calls.items() if count != 1}, {})

    def test_inventory_refuses_a_link_at_any_level_of_the_tree(self):
        tree = self.small_tree()
        for target in (tree.parent, tree, tree / "a", tree / "a" / "b", tree / "a" / "b" / "y", tree / "top"):
            with self.subTest(target=target.name):
                with patch.object(ops, "is_reparse", side_effect=lambda path: Path(path) == target):
                    with self.assertRaises(ops.OpsError):
                        ops.inventory(tree)

    def test_is_reparse_on_real_paths_missing_file_directory_and_links(self):
        tree = self.small_tree()
        self.assertFalse(ops.is_reparse(tree / "missing"))
        self.assertFalse(ops.is_reparse(tree / "top" / "below-a-file"))
        self.assertFalse(ops.is_reparse(tree / "top"))
        self.assertFalse(ops.is_reparse(tree / "a"))
        self.assertFalse(ops.is_reparse(str(tree / "a")))
        for name, target in (("link-to-file", tree / "top"), ("link-to-directory", tree / "a"),
                             ("dangling-link", tree / "missing")):
            link = tree / name
            try:
                link.symlink_to(target, target_is_directory=target.is_dir())
            except OSError:
                self.skipTest("this account cannot create symbolic links")
            self.assertTrue(ops.is_reparse(link), name)
        with self.assertRaises(ops.OpsError):
            ops.inventory(tree)

    def test_is_reparse_reports_the_windows_reparse_attribute(self):
        tree = self.small_tree()
        real = os.lstat(tree / "a")

        class Junction:
            st_mode = real.st_mode
            st_file_attributes = 0x410

        class Plain:
            st_mode = real.st_mode
            st_file_attributes = 0x10

        for details, expected in ((Junction, True), (Plain, False)):
            with patch("os.lstat", return_value=details), patch.object(Path, "lstat", return_value=details):
                self.assertEqual(ops.is_reparse(tree / "a"), expected)

    def test_inventory_refuses_an_entry_that_disappears_or_is_not_a_regular_file(self):
        tree = self.small_tree()
        victim = tree / "a" / "b" / "y"
        original = ops.resolve_source

        def vanish(value, *rest):
            result = original(value, *rest)
            if Path(value) == victim:
                victim.unlink()
            return result

        with patch.object(ops, "resolve_source", side_effect=vanish), self.assertRaises(ops.OpsError):
            ops.inventory(tree)

    def test_inventory_rows_carry_size_hash_and_permission_bits_of_each_file(self):
        tree = self.small_tree()
        rows = {row["path"]: row for row in ops.inventory(tree)}
        self.assertEqual(sorted(rows), ["a/b/x", "a/b/y", "a/b/z", "top"])
        for name, payload in (("a/b/x", b"x"), ("top", b"top")):
            details = os.stat(tree.joinpath(*name.split("/")))
            self.assertEqual(rows[name], {"path": name, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                                          "mode": details.st_mode & 0o777})
        single = ops.inventory(tree / "top")
        self.assertEqual(single, [{**rows["top"], "path": "top"}])

    def test_verify_hashes_every_batch_file_once(self):
        batch, manifest = self.batch()
        calls, counted = self.counting("digest")
        with counted:
            self.assertEqual(ops.verify_batch(batch), manifest)
        components = {path: count for path, count in calls.items() if path.is_relative_to(batch / "files")}
        self.assertEqual(len(components), 3)
        self.assertEqual(set(components.values()), {1})
        self.assertEqual(calls[batch / "database.dump"], 1)

    def test_verify_still_requires_every_component_directory_and_its_exact_file_list(self):
        empty = self.root / "empty-component"
        empty.mkdir()
        self.plan["components"].append({"id": "empty", "source": str(empty)})
        batch, manifest = self.batch()
        self.assertEqual(ops.verify_batch(batch), manifest)
        (batch / "files" / "empty").rmdir()
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)
        (batch / "files" / "empty").write_bytes(b"")
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)
        (batch / "files" / "empty").unlink()
        (batch / "files" / "empty").mkdir()
        self.assertEqual(ops.verify_batch(batch), manifest)
        # A file moved between two components keeps the batch-wide list intact only if the
        # manifest is edited too; the per-component list must still catch it.
        moved = json.loads(json.dumps(manifest))
        (batch / "files" / "private" / "config.json").rename(batch / "files" / "empty" / "config.json")
        for row in moved["files"]:
            if row["path"] == "files/private/config.json":
                row["path"] = "files/empty/config.json"
        ops.write_json(batch / "manifest.json", moved)
        with self.assertRaises(ops.OpsError) as caught:
            ops.verify_batch(batch)
        self.assertIn("component", str(caught.exception).lower())

    def test_backup_hashes_sources_and_copies_twice_and_lists_exactly_what_is_on_disk(self):
        calls, counted = self.counting("digest")
        with counted:
            batch, manifest = self.batch()
        sources = [self.recordings / "中文 A.yrp", self.recordings / "historical.yrp", self.private / "config.json"]
        copies = [batch / "files" / "recordings" / "中文 A.yrp", batch / "files" / "recordings" / "historical.yrp",
                  batch / "files" / "private" / "config.json"]
        # Sources: before and after the dump. Copies: after copying and in the final self-check.
        self.assertEqual({path.name: calls[path] for path in sources}, {path.name: 2 for path in sources})
        self.assertEqual({path.name: calls[path] for path in copies}, {path.name: 2 for path in copies})
        on_disk = [row for row in ops.inventory(batch) if row["path"] != "manifest.json"]
        self.assertEqual(manifest["files"], on_disk)
        self.assertEqual(ops.read_json(batch / "manifest.json")["files"], on_disk)

    def test_backup_lists_batch_files_in_inventory_order_with_mixed_case_names(self):
        for name in ("Zed.yrp", "apple.yrp", "Beta.yrp"):
            (self.recordings / name).write_bytes(name.encode("ascii"))
        batch, manifest = self.batch()
        self.assertEqual(manifest["files"], [row for row in ops.inventory(batch) if row["path"] != "manifest.json"])

    def test_backup_fails_when_a_copy_changes_after_its_check(self):
        postgres = FakePostgres()
        dump = postgres.command

        def command(name, *args):
            result = dump(name, *args)
            if name == "pg_dump" and "--file" in args:
                # After the copy was compared with its source, before the manifest is written.
                (self.root / "backup" / "files" / "recordings" / "historical.yrp").write_bytes(b"bit rot")
            return result

        postgres.command = command
        with self.assertRaises(ops.OpsError):
            self.batch(postgres)
        self.assertTrue((self.root / "backup" / "FAILED.json").is_file())

    def test_restore_hashes_every_batch_and_restored_file_once(self):
        batch, _ = self.batch()
        calls, counted = self.counting("digest")
        with counted:
            _, report = self.restore_fixture(batch, "counted")
        self.assertTrue(report["complete"])
        restored = {path: count for path, count in calls.items() if path.is_relative_to(self.root / "counted" / "runtime")}
        packed = {path: count for path, count in calls.items() if path.is_relative_to(batch / "files")}
        self.assertEqual((len(restored), set(restored.values())), (3, {1}))
        self.assertEqual((len(packed), set(packed.values())), (3, {1}))

    def test_replay_report_does_not_fabricate_one_to_one_associations(self):
        result = ops.replay_report([{"path": "child/nested.yrp"}, {"path": "historical.yrp"}, {"path": "readme.txt"}],
                                   ["missing.yrp", "../invalid.yrp", "missing.yrp"])
        self.assertEqual(result["unlinkedFiles"], ["historical.yrp"])
        self.assertEqual(result["nestedFiles"], ["child/nested.yrp"])
        self.assertEqual(result["unsafeDatabaseFilenames"], ["../invalid.yrp"])
        self.assertEqual(result["databaseReferenceCount"], 3)


class FakeProcess:
    """In-memory psql stand-in; records whether the child was reaped or killed."""

    def __init__(self, output=b"", code=0, stdin_error=None, read_error=None):
        self.code, self.returncode, self.killed, self.waits = code, None, False, 0
        self.stdin = unittest.mock.Mock()
        if stdin_error:
            self.stdin.write.side_effect = stdin_error
        self.stdout = unittest.mock.MagicMock()
        if read_error:
            self.stdout.__iter__.side_effect = read_error
        else:
            self.stdout.__iter__.side_effect = lambda: iter(io.BytesIO(output))

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.waits += 1
        self.returncode = self.code
        return self.code

    def kill(self):
        self.killed = True
        self.code = -9


class RowDigestTest(unittest.TestCase):
    P = [b'{"id":1,"label":"a"}', b'{"id":22,"label":"\xe4\xb8\xad\xe6\x96\x87 \\\\n \\\\r\\\\n \\\\\\\\n"}', b'{"id":3,"label":null}']

    def postgres(self):
        with patch.dict(os.environ, {"PGOPTIONS": "-c bytea_output=escape", "PGCLIENTENCODING": "GBK"}):
            return ops.Postgres("srvpro_drill_fixture")

    def digest(self, process, legacy=False, postgres=None):
        calls = []

        def popen(command, **kwargs):
            calls.append((command, kwargs))
            return process

        with patch.object(ops.subprocess, "Popen", side_effect=popen):
            result = (postgres or self.postgres()).row_digest("public", "duel log", legacy)
        return result, calls[0]

    def test_lf_and_crlf_transport_give_the_same_canonical_digest(self):
        expected = hashlib.sha256(self.P[0] + b"\n" + self.P[1] + b"\n" + self.P[2] + b"\n").hexdigest()
        for ending in (b"\n", b"\r\n"):
            with self.subTest(ending=ending):
                stream = io.BytesIO(b"".join(payload + ending for payload in self.P))
                self.assertEqual(ops.scan_copy_records(stream), (3, expected, None))

    def test_legacy_scan_reproduces_both_raw_ending_digests_from_one_stream(self):
        for ending in (b"\n", b"\r\n"):
            with self.subTest(ending=ending):
                stream = io.BytesIO(b"".join(payload + ending for payload in self.P))
                self.assertEqual(ops.scan_copy_records(stream, include_crlf=True),
                                 (3, reference_sha(self.P, b"\n"), reference_sha(self.P, b"\r\n")))
        self.assertNotEqual(reference_sha(self.P, b"\n"), reference_sha(self.P, b"\r\n"))

    def test_empty_stream_is_the_empty_digest_and_duplicates_are_counted(self):
        self.assertEqual(ops.scan_copy_records(io.BytesIO(b"")), (0, EMPTY, None))
        self.assertEqual(ops.scan_copy_records(io.BytesIO(b""), include_crlf=True), (0, EMPTY, EMPTY))
        once = ops.scan_copy_records(io.BytesIO(self.P[0] + b"\n"))
        twice = ops.scan_copy_records(io.BytesIO((self.P[0] + b"\n") * 2))
        self.assertEqual((once[0], twice[0]), (1, 2))
        self.assertNotEqual(once[1], twice[1])

    def test_escaped_field_line_breaks_are_payload_and_stay_distinct(self):
        # COPY text escapes of a field holding LF, CR, CRLF and a literal backslash-n.
        fields = [b'{"v":"\\\\n"}', b'{"v":"\\\\r"}', b'{"v":"\\\\r\\\\n"}', b'{"v":"\\\\\\\\n"}']
        digests = set()
        for payload in fields:
            lf = ops.scan_copy_records(io.BytesIO(payload + b"\n"))
            crlf = ops.scan_copy_records(io.BytesIO(payload + b"\r\n"))
            self.assertEqual(lf, crlf)
            self.assertEqual(lf[1], hashlib.sha256(payload + b"\n").hexdigest())
            digests.add(lf[1])
        self.assertEqual(len(digests), len(fields))

    def test_malformed_record_framing_is_refused(self):
        row = self.P[0]
        streams = {"no terminator": row, "truncated tail": row + b"\n" + row[:5], "bare CR ending": row + b"\r",
                   "CR CR LF": row + b"\r\r\n", "CR inside": b"a\rb\n", "TAB inside": b"a\tb\n",
                   "blank line": row + b"\n\n", "blank CRLF line": b"\r\n",
                   "mixed LF then CRLF": row + b"\n" + row + b"\r\n", "mixed CRLF then LF": row + b"\r\n" + row + b"\n"}
        for label, content in streams.items():
            for legacy in (False, True):
                with self.subTest(label=label, legacy=legacy), self.assertRaises(ops.OpsError) as caught:
                    ops.scan_copy_records(io.BytesIO(content), include_crlf=legacy)
                self.assertEqual(caught.exception.category, "copy-record-framing")

    def test_row_digest_uses_canonical_profile_without_touching_shared_environment(self):
        postgres = self.postgres()
        shared = dict(postgres.environment)
        process = FakeProcess(b"".join(payload + b"\r\n" for payload in self.P))
        result, (command, kwargs) = self.digest(process, postgres=postgres)
        self.assertEqual(result, {"schema": "public", "table": "duel log", "rows": 3,
                                  "sha256": reference_sha(self.P, b"\n")})
        self.assertEqual(postgres.environment, shared)
        self.assertEqual(shared["PGOPTIONS"], "-c timezone=UTC -c datestyle=ISO,YMD")
        options = kwargs["env"]["PGOPTIONS"]
        self.assertTrue(options.startswith(shared["PGOPTIONS"]))
        for setting in ("intervalstyle=postgres", "bytea_output=hex", "extra_float_digits=3"):
            self.assertIn("-c " + setting, options)
        self.assertEqual(kwargs["env"]["PGCLIENTENCODING"], "UTF8")
        self.assertTrue({"-X", "ON_ERROR_STOP=1"} <= set(command))
        statement = process.stdin.write.call_args.args[0].decode("utf-8")
        self.assertIn('FROM "public"."duel log" t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT '
                      "WITH (FORMAT text, ENCODING 'UTF8')", statement)
        self.assertEqual((process.waits, process.killed), (1, False))

    def test_row_digest_legacy_profile_keeps_old_query_and_environment_and_returns_both_candidates(self):
        postgres = self.postgres()
        process = FakeProcess(b"".join(payload + b"\n" for payload in self.P))
        (lf, crlf), (_, kwargs) = self.digest(process, legacy=True, postgres=postgres)
        self.assertEqual(kwargs["env"], postgres.environment)
        self.assertNotIn("bytea_output", kwargs["env"]["PGOPTIONS"])
        statement = process.stdin.write.call_args.args[0].decode("utf-8")
        self.assertTrue(statement.endswith(') TO STDOUT'))
        self.assertEqual(lf, {"schema": "public", "table": "duel log", "rows": 3, "sha256": reference_sha(self.P, b"\n")})
        self.assertEqual(crlf, {**lf, "sha256": reference_sha(self.P, b"\r\n")})

    def test_row_digest_refuses_failed_exit_even_after_complete_records(self):
        for code in (1, 2, 3):
            process = FakeProcess(self.P[0] + b"\n", code=code)
            with self.subTest(code=code), self.assertRaises(ops.OpsError) as caught:
                self.digest(process)
            self.assertEqual(caught.exception.category, "copy-process-failed")
            self.assertEqual(process.waits, 1)

    def test_row_digest_reaps_child_on_framing_read_and_write_errors(self):
        cases = {"framing": (FakeProcess(self.P[0]), "copy-record-framing"),
                 "read": (FakeProcess(read_error=OSError("fixture secret-marker read")), "copy-process-failed"),
                 "write": (FakeProcess(stdin_error=BrokenPipeError("fixture secret-marker pipe")), "copy-process-failed")}
        for label, (process, category) in cases.items():
            with self.subTest(label=label), self.assertRaises(ops.OpsError) as caught:
                self.digest(process)
            self.assertEqual(caught.exception.category, category)
            self.assertNotIn("secret-marker", str(caught.exception))
            self.assertTrue(process.killed and process.waits >= 1)
            self.assertTrue(process.stdout.close.called and process.stdin.close.called)

    def state(self, counts, legacy=False, outputs=None):
        postgres = self.postgres()
        outputs = outputs or {name: b"".join(row + b"\r\n" for row in rows) for name, rows in FIXTURE_ROWS.items()}
        opened = []

        def popen(command, **kwargs):
            process = FakeProcess()
            opened.append(process)

            def write(statement):
                name = re.search(r'FROM "public"\."(\w+)" t', statement.decode("utf-8")).group(1)
                process.stdout.__iter__.side_effect = lambda: iter(io.BytesIO(outputs[name]))
            process.stdin.write.side_effect = write
            return process

        def sql(statement):
            if "count(*)" in statement:
                self.count_statement = statement
                return json.dumps(counts)
            if "last_value" in statement:
                return '{"lastValue":"2","isCalled":true}'
            return json.dumps(FIXTURE_SCHEMA)

        with patch.object(ops.subprocess, "Popen", side_effect=popen), patch.object(postgres, "sql", side_effect=sql):
            return postgres.state(legacy=legacy) if legacy else postgres.state(), opened

    def test_state_is_versioned_canonical_and_checks_independent_counts_in_one_statement(self):
        state, opened = self.state([2, 0, 1])
        self.assertEqual(state, fixture_state())
        self.assertEqual(len(opened), 3)
        self.assertEqual(self.count_statement.count("count(*)"), 3)
        for name in FIXTURE_ROWS:
            self.assertIn(f'FROM "public"."{name}"', self.count_statement)
        self.assertNotIn("ONLY", self.count_statement)

    def test_state_legacy_returns_two_whole_candidates_from_one_copy_per_table(self):
        (lf, crlf), opened = self.state([2, 0, 1], legacy=True)
        self.assertEqual(lf, fixture_state(versioned=False))
        self.assertEqual(crlf, fixture_state(ending=b"\r\n", versioned=False))
        self.assertEqual(len(opened), 3)

    def test_state_refuses_when_independent_count_disagrees_with_complete_records(self):
        dropped = dict({name: b"".join(row + b"\n" for row in rows) for name, rows in FIXTURE_ROWS.items()},
                       duel_log=FIXTURE_ROWS["duel_log"][0] + b"\n", ladder_user=b"")
        for label, counts, outputs in (("whole record lost", [2, 0, 1], dropped), ("count smaller", [1, 0, 1], None),
                                       ("empty stream nonzero count", [2, 1, 1], None),
                                       ("count list short", [2, 0], None), ("count not integer", [2, 0, "1"], None),
                                       ("count boolean", [2, 0, True], None)):
            for legacy in (False, True):
                with self.subTest(label=label, legacy=legacy), self.assertRaises(ops.OpsError) as caught:
                    self.state(counts, legacy=legacy, outputs=outputs)
                self.assertEqual(caught.exception.category, "copy-row-count-mismatch")

    def test_quiet_check_counts_every_user_session_but_not_userless_maintenance_workers(self):
        postgres = self.postgres()
        for answer, quiet in (("0", True), ("1", False), ("3", False)):
            with patch.object(postgres, "sql", return_value=answer) as sql:
                if quiet:
                    postgres.assert_quiet()
                else:
                    with self.assertRaises(ops.OpsError):
                        postgres.assert_quiet()
            statement = " ".join(sql.call_args.args[0].split())
            # Autovacuum workers have no login user; every client or replication session has one.
            # The role running the tools cannot see backend_type, so that column must not be used.
            self.assertIn("usesysid IS NOT NULL", statement)
            self.assertIn("datname=current_database()", statement)
            self.assertIn("pid<>pg_backend_pid()", statement)
            self.assertNotIn("backend_type", statement)
            self.assertNotIn("usename", statement)

    def test_database_state_validation_dispatches_on_key_presence(self):
        self.assertTrue(ops.validate_database_state(fixture_state()))
        self.assertFalse(ops.validate_database_state(fixture_state(ending=b"\r\n", versioned=False)))
        for token in ("legacy", TOKEN.upper(), TOKEN + " ", "", None, False, 0, [], {}):
            with self.subTest(token=token), self.assertRaises(ops.OpsError) as caught:
                ops.validate_database_state({**fixture_state(versioned=False), "rowDigestFormat": token})
            self.assertEqual(caught.exception.category, "unsupported-row-digest-format")

    def test_database_state_validation_refuses_malformed_structure(self):
        def changed(mutate, versioned=True):
            state = fixture_state(versioned=versioned)
            mutate(state)
            return state

        table = lambda key, value: lambda s: s["tables"][0].__setitem__(key, value)
        cases = {"not object": lambda s: None, "missing schema": lambda s: s.pop("schema"),
                 "missing sequences": lambda s: s.pop("sequences"), "tables not list": lambda s: s.update(tables={}),
                 "unknown key": lambda s: s.update(fixtureState=1), "uppercase sha": table("sha256", "A" * 64),
                 "short sha": table("sha256", "a" * 63), "negative rows": table("rows", -1),
                 "boolean rows": table("rows", True), "float rows": table("rows", 2.0),
                 "zero rows with content sha": table("rows", 0),
                 "rows with empty sha": table("sha256", EMPTY),
                 "extra table field": table("sha256crlf", "a" * 64),
                 "missing table": lambda s: s["tables"].pop(),
                 "duplicate table": lambda s: s["tables"].__setitem__(1, dict(s["tables"][0])),
                 "extra uncovered table": lambda s: s["tables"].append({"schema": "public", "table": "ghost", "rows": 0, "sha256": EMPTY}),
                 "tables reordered": lambda s: s["tables"].reverse(),
                 "duplicate schema object": lambda s: s["schema"].append(dict(s["schema"][0])),
                 "unknown relation kind": lambda s: s["schema"][0].update(kind="x"),
                 "column without type": lambda s: s["schema"][0]["columns"][0].pop("type"),
                 "sequence missing": lambda s: s["sequences"].clear(),
                 "sequence value number": lambda s: s["sequences"][0].update(lastValue=2),
                 "sequence value text": lambda s: s["sequences"][0].update(lastValue="2 "),
                 "sequence flag string": lambda s: s["sequences"][0].update(isCalled="true")}
        for label, mutate in cases.items():
            for versioned in (True, False):
                state = None if label == "not object" else changed(mutate, versioned)
                with self.subTest(label=label, versioned=versioned), self.assertRaises(ops.OpsError) as caught:
                    ops.validate_database_state(state)
                self.assertEqual(caught.exception.category, "invalid-database-state")

    def test_nonempty_double_match_is_refused_instead_of_guessed(self):
        expected = fixture_state(versioned=False)
        postgres = unittest.mock.Mock()
        postgres.state.return_value = (expected, json.loads(json.dumps(expected)))
        with self.assertRaises(ops.OpsError) as caught:
            ops.verify_restored_state(expected, postgres)
        self.assertEqual(caught.exception.category, "legacy-ambiguous-match")


if __name__ == "__main__":
    unittest.main()
