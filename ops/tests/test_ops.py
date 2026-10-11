"""Fail-closed transport tests; no real database, systemd or production data."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("ops", Path(__file__).parents[1] / "scripts" / "ops.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)


class FakePostgres:
    database = "srvpro_drill_fixture"

    def __init__(self):
        self.states = 0
        self.changing = False
        self.quiet = True
        self.commands = []

    def assert_quiet(self):
        ops.require(self.quiet, "another connection remains")

    def metadata(self):
        return {"database": self.database, "serverVersionNum": 170006, "serverVersion": "17.6",
                "encoding": "UTF8", "collate": "C", "ctype": "C", "owner": "owner", "timezone": "UTC"}

    def state(self):
        self.states += 1
        return {"schema": [], "tables": [], "sequences": [],
                "fixtureState": self.states if self.changing else 1}

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
        (self.engine / "cards1.cdb").write_bytes(b"pool")
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
        self.assertEqual((target / "components" / "engine" / "cards1.cdb").read_bytes(), b"pool")
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

    def test_replay_report_does_not_fabricate_one_to_one_associations(self):
        result = ops.replay_report([{"path": "child/nested.yrp"}, {"path": "historical.yrp"}, {"path": "readme.txt"}],
                                   ["missing.yrp", "../invalid.yrp", "missing.yrp"])
        self.assertEqual(result["unlinkedFiles"], ["historical.yrp"])
        self.assertEqual(result["nestedFiles"], ["child/nested.yrp"])
        self.assertEqual(result["unsafeDatabaseFilenames"], ["../invalid.yrp"])
        self.assertEqual(result["databaseReferenceCount"], 3)


if __name__ == "__main__":
    unittest.main()
