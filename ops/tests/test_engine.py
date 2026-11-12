"""Runtime assembly and platform boundaries, with synthetic public resources."""

from contextlib import closing
import hashlib
import io
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import engine


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-engine-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / "base"
        (self.base / "script").mkdir(parents=True)
        self.base_utility = b"Auxiliary={}\naux=Auxiliary\nNULL_VALUE=-10\nlocal base_loaded=true\n"
        for name in ("constant.lua", "procedure.lua"):
            (self.base / "script" / name).write_text("-- synthetic base\n")
        (self.base / "script" / "utility.lua").write_bytes(self.base_utility)
        (self.base / "script" / "config.json").write_text('{"not_runtime":true}')
        self.binary = self.base / "ygopro.exe"
        pe = bytearray(256)
        pe[:2] = b"MZ"
        struct.pack_into("<I", pe, 60, 64)
        pe[64:68] = b"PE\x00\x00"
        struct.pack_into("<H", pe, 68, 0x8664)
        struct.pack_into("<H", pe, 88, 0x20B)
        self.binary.write_bytes(pe)
        self.pool = self.root / "cards.cdb"
        with closing(sqlite3.connect(self.pool)) as db:
            db.execute("CREATE TABLE datas(id INTEGER PRIMARY KEY, type INTEGER, alias INTEGER, atk INTEGER, def INTEGER, level INTEGER, race INTEGER, attribute INTEGER)")
            db.execute("CREATE TABLE texts(id INTEGER PRIMARY KEY, name TEXT)")
            db.execute("INSERT INTO datas VALUES(1,1,0,100,100,1,1,1)")
            db.execute("INSERT INTO texts VALUES(1,'Synthetic card')")
            db.commit()
        self.banlist = self.root / "lflist.conf"
        self.banlist.write_text("!Synthetic\n1 0\n")
        self.overlay = self.root / "overlays" / "706"
        self.overlay.mkdir(parents=True)
        (self.overlay / "special.lua").write_text("function Auxiliary.PreloadUds() Auxiliary.old_rules=true end\n")
        (self.overlay / "c1.lua").write_text("-- synthetic old card rule\n")
        self.profile = {"resourceFingerprints": [{"scope": "engine", "path": "cards.cdb", "sha256": engine.ops.digest(self.pool)}],
                        "enginePoolSource": {"bytes": self.pool.stat().st_size, "sha256": engine.ops.digest(self.pool), "cardCount": 1},
                        "engine": {"source": {"scriptCommit": "1" * 40}, "oldRulings": {"commit": "2" * 40},
                                   "banlists": [{"sha256": engine.ops.digest(self.banlist)}]}}
        self.versions = self.root / "versions.json"
        engine.ops.write_json(self.versions, self.profile)

    def git_output(self, args, **kwargs):
        directory = Path(kwargs["cwd"])
        if "--show-prefix" in args:
            return 0, "706/" if directory == self.overlay else ""
        if "rev-parse" in args:
            return 0, ("2" if directory == self.overlay else "1") * 40
        if "ls-files" in args:
            rows = []
            for name, filename in engine.lua_files(directory):
                blob = filename.read_bytes().replace(b"\r\n", b"\n")
                digest = hashlib.sha1(b"blob " + str(len(blob)).encode("ascii") + b"\0" + blob).hexdigest()
                rows.append(f"100644 {digest} 0\t{name}\0")
            return 0, "".join(rows)
        return 0, ""

    def assemble(self, target, overlay=None):
        with patch.object(engine.ops, "run", side_effect=self.git_output):
            return engine.assemble(self.base, self.binary, self.pool, self.banlist, target, self.versions, "windows", overlay)

    def test_overlay_preserves_base_and_generates_global_initialization(self):
        destination = self.root / "new-engine"
        result = self.assemble(destination, self.overlay)
        self.assertTrue(result["oldRulingsEnabled"])
        self.assertEqual((destination / "script" / "utility.lua").read_bytes(), self.base_utility)
        generated = (destination / "specials" / "utility.lua").read_text()
        self.assertLess(generated.index("function Auxiliary.PreloadUds()"), generated.index("\nAuxiliary.PreloadUds()\n"))
        self.assertLess(generated.index("\nAuxiliary.PreloadUds()\n"), generated.index("local base_loaded=true"))
        self.assertTrue((destination / "specials" / "c1.lua").exists())
        self.assertFalse((destination / "script" / "config.json").exists())
        self.assertFalse((destination / "cards1.cdb").exists())
        self.assertEqual((self.base / "script" / "utility.lua").read_bytes(), self.base_utility)
        self.assertFalse(result["realDuelValidated"])

    def test_base_only_and_changed_runtime_detection(self):
        destination = self.root / "base-only"
        self.assertFalse(self.assemble(destination)["oldRulingsEnabled"])
        self.assertFalse((destination / "specials").exists())
        (destination / "script" / "c1.lua").write_text("unexpected script")
        with self.assertRaisesRegex(engine.ops.OpsError, "unexpected extra"):
            engine.verify(destination, self.versions, "windows")

    def test_unpinned_or_dirty_base_lua_is_rejected_before_assembly(self):
        for head, dirty in (("3" * 40, ""), ("1" * 40, " M utility.lua")):
            destination = self.root / "refused-base"
            with patch.object(engine.ops, "run", side_effect=lambda args, **kwargs: (0, head if "rev-parse" in args else dirty)):
                with self.assertRaisesRegex(engine.ops.OpsError, "Base Lua must match"):
                    engine.assemble(self.base, self.binary, self.pool, self.banlist, destination, self.versions, "windows")
            self.assertFalse(destination.exists())

    def test_existing_destination_and_bad_pool_fail_before_writes(self):
        destination = self.root / "existing"
        destination.mkdir()
        (destination / "player-file").write_text("retain")
        with self.assertRaisesRegex(engine.ops.OpsError, "NEW directory"):
            self.assemble(destination)
        self.assertEqual((destination / "player-file").read_text(), "retain")
        self.pool.write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
        with self.assertRaises(engine.ops.OpsError):
            self.assemble(self.root / "bad-pool")
        self.assertFalse((self.root / "bad-pool").exists())

    def test_wrong_binary_architecture_and_unreviewed_banlist_are_rejected(self):
        pe = bytearray(self.binary.read_bytes())
        struct.pack_into("<H", pe, 68, 0x14C)
        self.binary.write_bytes(pe)
        with self.assertRaisesRegex(engine.ops.OpsError, "Windows x64"):
            self.assemble(self.root / "wrong-arch")
        self.assertFalse((self.root / "wrong-arch").exists())
        self.banlist.write_text("unreviewed")
        with self.assertRaisesRegex(engine.ops.OpsError, "Unreviewed banlist"):
            with patch.object(engine, "executable_kind", return_value="PE32+ x64"):
                self.assemble(self.root / "wrong-list")

    def test_overlay_rejects_wrong_commit_or_missing_global_helper(self):
        destination = self.root / "wrong-overlay"
        def wrong_overlay(args, **kwargs):
            if "rev-parse" in args and kwargs["cwd"] == self.overlay:
                return 0, "3" * 40
            return self.git_output(args, **kwargs)
        with patch.object(engine.ops, "run", side_effect=wrong_overlay):
            with self.assertRaisesRegex(engine.ops.OpsError, "pinned clean source"):
                engine.assemble(self.base, self.binary, self.pool, self.banlist, destination, self.versions, "windows", self.overlay)
        self.assertFalse(destination.exists())
        (self.overlay / "special.lua").write_text("-- no global compatibility function")
        with self.assertRaisesRegex(engine.ops.OpsError, "Unsupported utility"):
            self.assemble(self.root / "no-global", self.overlay)
        self.assertFalse((self.root / "no-global").exists())

    def test_report_cannot_change_the_engine_it_just_verified(self):
        destination = self.root / "report-engine"
        argv = ["engine.py", "assemble", "--versions", str(self.versions), "--platform", "windows",
                "--base", str(self.base), "--binary", str(self.binary), "--pool", str(self.pool),
                "--banlist", str(self.banlist), "--destination", str(destination),
                "--report", str(destination / "receipt.json")]
        with patch.object(engine.sys, "argv", argv), \
                patch.object(engine.sys, "stderr", io.StringIO()), \
                patch.object(engine, "assemble", side_effect=AssertionError("Assembly was attempted")):
            self.assertEqual(engine.main(), 1)
        self.assertFalse(destination.exists())

    def test_fetch_refuses_existing_destination_before_network(self):
        destination = self.root / "existing-download"
        destination.mkdir()
        with patch.object(engine.ops, "run", side_effect=AssertionError("network was called")):
            with self.assertRaises(engine.ops.OpsError):
                engine.pool_fetch(destination, self.versions)

    def test_cross_os_smoke_cannot_be_reported_as_native_windows(self):
        destination = self.root / "windows-files"
        self.assemble(destination)
        with patch.object(engine.platform, "system", return_value="Linux"), \
                patch.object(engine.subprocess, "Popen", side_effect=AssertionError("process was started")):
            with self.assertRaisesRegex(engine.ops.OpsError, "target OS"):
                engine.smoke(destination, self.versions, "windows")


    def test_verify_rejects_changed_versions_policy(self):
        for field, value, overlay in (
                ("oldRulings", {"commit": "3" * 40}, self.overlay),
                ("banlists", [{"sha256": "0" * 64}], None)):
            with self.subTest(field=field):
                destination = self.root / ("policy-" + field)
                self.assemble(destination, overlay)
                changed = dict(self.profile)
                changed["engine"] = {**changed["engine"], field: value}
                engine.ops.write_json(self.versions, changed)
                with self.assertRaises(engine.ops.OpsError):
                    engine.verify(destination, self.versions, "windows")
                engine.ops.write_json(self.versions, self.profile)

    def test_verify_requires_attested_source_and_essential_scripts(self):
        destination = self.root / "attested"
        self.assemble(destination)
        manifest_file = destination / "engine-manifest.json"
        manifest = engine.ops.read_json(manifest_file)
        manifest["baseLuaCommitVerified"] = False
        engine.ops.write_json(manifest_file, manifest)
        with self.assertRaises(engine.ops.OpsError):
            engine.verify(destination, self.versions, "windows")
        manifest["baseLuaCommitVerified"] = True
        (destination / "script" / "utility.lua").unlink()
        manifest["files"] = [row for row in manifest["files"] if row["path"] != "script/utility.lua"]
        engine.ops.write_json(manifest_file, manifest)
        with self.assertRaises(engine.ops.OpsError):
            engine.verify(destination, self.versions, "windows")

    def test_assembled_upstream_tree_is_only_a_candidate(self):
        result = self.assemble(self.root / "candidate", self.overlay)
        self.assertIs(result.get("productionEquivalentProven"), False)
        self.assertEqual(result.get("runtimeStatus"), "upstream-base-candidate")

    def test_copy_failure_preserves_partial_directory_without_success_manifest(self):
        destination = self.root / "partial"
        original = engine.shutil.copy2
        def fail_after_binary(src, dst):
            if Path(dst).name == "cards.cdb":
                raise OSError("Synthetic copy failure")
            return original(src, dst)
        with patch.object(engine.shutil, "copy2", side_effect=fail_after_binary):
            with self.assertRaisesRegex(OSError, "Synthetic copy"):
                self.assemble(destination)
        self.assertTrue((destination / "ygopro.exe").exists())
        self.assertFalse((destination / "engine-manifest.json").exists())

    def test_ignored_extra_or_assume_unchanged_lua_is_not_attested(self):
        directory = self.base / "script"
        tracked = self.git_output(["git", "ls-files"], cwd=directory)
        def source_git(args, **kwargs):
            return tracked if "ls-files" in args else self.git_output(args, **kwargs)
        (directory / "ignored.lua").write_text("-- ignored input")
        with patch.object(engine.ops, "run", side_effect=source_git):
            with self.assertRaisesRegex(engine.ops.OpsError, "file list"):
                engine.pinned_lua(directory, "1" * 40, engine.lua_files(directory), "Base Lua")
        (directory / "ignored.lua").unlink()
        (directory / "constant.lua").write_text("-- hidden changed bytes")
        with patch.object(engine.ops, "run", side_effect=source_git):
            with self.assertRaisesRegex(engine.ops.OpsError, "Lua bytes differ"):
                engine.pinned_lua(directory, "1" * 40, engine.lua_files(directory), "Base Lua")

    def test_real_git_rejects_hidden_modified_lua_despite_clean_status(self):
        directory = self.root / "git-scripts"
        directory.mkdir()
        (directory / "constant.lua").write_bytes(b"-- committed base\n")
        engine.ops.run(["git", "init", "--quiet"], cwd=directory)
        engine.ops.run(["git", "-c", "core.autocrlf=false", "add", "constant.lua"], cwd=directory)
        engine.ops.run(["git", "-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid",
                        "commit", "--quiet", "-m", "Synthetic fixture"], cwd=directory)
        _, commit = engine.ops.run(["git", "rev-parse", "HEAD"], cwd=directory)
        self.assertEqual(engine.pinned_lua(directory, commit, engine.lua_files(directory), "Base Lua", "")[0], commit)
        engine.ops.run(["git", "update-index", "--assume-unchanged", "constant.lua"], cwd=directory)
        (directory / "constant.lua").write_bytes(b"-- hidden worktree change\n")
        self.assertEqual(engine.ops.run(["git", "status", "--porcelain"], cwd=directory)[1], "")
        with self.assertRaisesRegex(engine.ops.OpsError, "Lua bytes differ"):
            engine.pinned_lua(directory, commit, engine.lua_files(directory), "Base Lua", "")

    def test_reparse_ancestor_is_rejected_before_any_output(self):
        target = self.root / "new-output"
        original = Path.lstat
        def attributes(path):
            if path == self.root:
                return type("ReparseStat", (), {"st_file_attributes": 0x400, "st_mode": 0o40755})()
            return original(path)
        with patch.object(Path, "lstat", attributes):
            with self.assertRaisesRegex(engine.ops.OpsError, "reparse"):
                engine.new_destination(target)
        self.assertFalse(target.exists())

    def test_native_smoke_reports_only_startup_tcp_and_stops_child(self):
        destination = self.root / "smoke-candidate"
        self.assemble(destination)
        process = MagicMock()
        process.stdout = io.BytesIO(b"12345\n")
        process.poll.return_value = None
        with patch.object(engine.platform, "system", return_value="Windows"), \
                patch.object(engine.subprocess, "CREATE_NO_WINDOW", 0, create=True), \
                patch.object(engine.subprocess, "Popen", return_value=process), \
                patch.object(engine.socket, "create_connection") as connect:
            result = engine.smoke(destination, self.versions, "windows")
        connect.assert_called_once_with(("127.0.0.1", 12345), timeout=5)
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(result["nativeStartupAndTcpValidated"])
        self.assertFalse(result["realDuelValidated"])
        self.assertFalse(result["productionEquivalentProven"])

    def test_windows_preflight_does_not_invoke_linux_tools_or_require_inactive_cdb(self):
        application = self.root / "application"
        application.mkdir()
        for name in ("ygopro-server.js", "plugin-system.js", "package-lock.json"):
            (application / name).write_text("synthetic")
        destination = self.root / "windows-runtime"
        self.assemble(destination)
        with patch.object(engine.ops.platform, "system", return_value="Windows"), \
                patch.object(engine.ops.platform, "machine", return_value="AMD64"), \
                patch.object(engine.ops, "catalog_check", return_value={"metadataAvailable": True}), \
                patch.object(engine.ops, "run", side_effect=lambda args, **kwargs: (0, "v24.15.0") if args == ["node", "--version"] else self.fail("Linux tool invoked")):
            result = engine.ops.preflight(application, destination, self.root, self.versions, target="windows")
            with self.assertRaisesRegex(engine.ops.OpsError, "native Linux"):
                engine.ops.preflight(application, destination, self.root, self.versions, target="linux")
        self.assertEqual(result["platform"], "windows")
        self.assertEqual(result["engineKind"], "PE32+ x64")
        self.assertFalse(result["nativeRuntimeValidated"])


if __name__ == "__main__":
    unittest.main()
