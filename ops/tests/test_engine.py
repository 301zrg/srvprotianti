"""Runtime assembly and platform boundaries, with synthetic public resources."""

from contextlib import closing
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

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

    def assemble(self, target, overlay=None):
        with patch.object(engine.ops, "run", side_effect=lambda args, **kwargs: (0, "2" * 40 if "rev-parse" in args else "")):
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
        with patch.object(engine.ops, "run", return_value=(0, "3" * 40)):
            with self.assertRaisesRegex(engine.ops.OpsError, "pinned clean source"):
                engine.assemble(self.base, self.binary, self.pool, self.banlist, destination, self.versions, "windows", self.overlay)
        self.assertFalse(destination.exists())
        (self.overlay / "special.lua").write_text("-- no global compatibility function")
        with self.assertRaisesRegex(engine.ops.OpsError, "Unsupported utility"):
            self.assemble(self.root / "no-global", self.overlay)
        self.assertFalse((self.root / "no-global").exists())

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
