"""Outsider route: public production-layout engine, Linux source pack, Windows handover."""

from contextlib import closing
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import engine  # noqa: E402


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pack = load("pack_linux_source", "pack-linux-source.py")
handover = load("windows_handover", "windows-handover.py")


def run_git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", *args],
                   cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def pe_bytes():
    pe = bytearray(256)
    pe[:2] = b"MZ"
    struct.pack_into("<I", pe, 60, 64)
    pe[64:68] = b"PE\x00\x00"
    struct.pack_into("<H", pe, 68, 0x8664)
    struct.pack_into("<H", pe, 88, 0x20B)
    return bytes(pe)


def elf_bytes():
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, 62)
    return bytes(header)


class PublicLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-public-layout-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / "source"
        (self.base / "script").mkdir(parents=True)
        for name in ("constant.lua", "procedure.lua", "c1.lua"):
            (self.base / "script" / name).write_text(f"-- upstream {name}\n")
        (self.base / "script" / "utility.lua").write_text("Auxiliary={}\naux=Auxiliary\n-- upstream\n")
        (self.base / "strings.conf").write_text("!system 1 test\n")
        (self.base / "LICENSE").write_text("GPL\n")
        self.overlay = self.root / "specials" / "706"
        self.overlay.mkdir(parents=True)
        (self.overlay / "special.lua").write_text("function Auxiliary.PreloadUds() end\n")
        (self.overlay / "c1.lua").write_text("-- old ruling c1\n")
        self.assets = self.root / "assets"
        self.assets.mkdir()
        with closing(sqlite3.connect(self.assets / "cards.cdb")) as db:
            db.execute("CREATE TABLE datas(id INTEGER PRIMARY KEY, type INTEGER, alias INTEGER, atk INTEGER, def INTEGER, level INTEGER, race INTEGER, attribute INTEGER)")
            db.execute("CREATE TABLE texts(id INTEGER PRIMARY KEY, name TEXT)")
            db.execute("INSERT INTO datas VALUES(1,1,0,100,100,1,1,1)")
            db.execute("INSERT INTO texts VALUES(1,'Synthetic')")
            db.commit()
        (self.assets / "utility.lua").write_bytes(b"Auxiliary={}\naux=Auxiliary\n-- combined production utility\n")
        (self.assets / "lflist.conf").write_bytes(b"!2011.3.1\n1 0\n!2026.7\n")
        digest = engine.ops.digest
        pool, utility, banlist = (self.assets / n for n in ("cards.cdb", "utility.lua", "lflist.conf"))
        self.profile = {
            "resourceFingerprints": [{"scope": "engine", "path": "cards.cdb", "sha256": digest(pool)},
                                     {"scope": "engine", "path": "lflist.conf", "sha256": digest(banlist)},
                                     {"scope": "catalog", "path": "cards.zh.cdb", "sha256": "0" * 64}],
            "enginePoolSource": {"repository": "https://github.com/example/resources.git", "commit": "3" * 40,
                                 "path": "engine/1103-706/cards.cdb", "bytes": pool.stat().st_size,
                                 "sha256": digest(pool), "cardCount": 1},
            "engineAssetSource": {"repository": "https://github.com/example/resources.git", "commit": "3" * 40,
                                  "pool": "engine/1103-706/cards.cdb",
                                  "utility": {"path": "engine/1103-706/utility.lua", "sha256": digest(utility)},
                                  "banlist": {"path": "engine/1103-706/lflist.conf", "sha256": digest(banlist),
                                              "bytes": banlist.stat().st_size}},
            "engine": {"source": {"scriptCommit": "1" * 40},
                       "oldRulings": {"commit": "2" * 40, "directory": "706"},
                       "scriptEnvironment": {"utilitySha256": digest(utility)},
                       "publicLayout": {"scriptTreeSha256": engine.lua_tree_sha256(engine.lua_files(self.base / "script")),
                                        "overlayTreeSha256": engine.lua_tree_sha256(engine.lua_files(self.overlay))}}}
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
                rows.append(f"100644 {hashlib.sha1(b'blob ' + str(len(blob)).encode() + b'\0' + blob).hexdigest()} 0\t{name}\0")
            return 0, "".join(rows)
        return 0, ""

    def assemble(self, destination, target="linux", binary=None):
        with patch.object(engine.ops, "run", side_effect=self.git_output):
            return engine.assemble_production(self.base, self.overlay, self.assets, destination, self.versions, target, binary)

    def test_linux_layout_matches_production_structure_without_binary(self):
        destination = self.root / "engine-linux"
        result = self.assemble(destination)
        self.assertEqual(result["runtimeStatus"], "public-production-layout")
        self.assertEqual((destination / "expansions/script/utility.lua").read_bytes(), (self.assets / "utility.lua").read_bytes())
        self.assertTrue((destination / "expansions/script/special.lua").exists())
        self.assertEqual((destination / "script/utility.lua").read_text(), "Auxiliary={}\naux=Auxiliary\n-- upstream\n")
        self.assertFalse((destination / "ygopro").exists() or (destination / "ygopro.exe").exists())
        self.assertFalse((destination / "specials").exists())
        manifest = engine.ops.read_json(destination / "engine-manifest.json")
        self.assertEqual(manifest["runtimeOverlayDirectory"], "expansions/script")
        with self.assertRaisesRegex(engine.ops.OpsError, "lacks the compiled ygopro"):
            engine.verify_production(destination, self.versions, "linux", installed=True)
        (destination / "ygopro").write_bytes(elf_bytes())
        (destination / "ygopro").chmod(0o755)
        self.assertTrue(engine.verify_production(destination, self.versions, "linux", installed=True)["installedBinaryChecked"])
        with self.assertRaisesRegex(engine.ops.OpsError, "unexpected extra files"):
            engine.verify_production(destination, self.versions, "linux")

    def test_windows_layout_copies_binary_and_dlls(self):
        build = self.root / "build"
        build.mkdir()
        (build / "ygopro.exe").write_bytes(pe_bytes())
        (build / "irrklang.dll").write_bytes(b"dll")
        destination = self.root / "engine-win"
        self.assemble(destination, "windows", build / "ygopro.exe")
        self.assertTrue((destination / "ygopro.exe").exists() and (destination / "irrklang.dll").exists())
        self.assertEqual(engine.verify_production(destination, self.versions, "windows")["platform"], "windows")

    def test_binary_rules_per_platform(self):
        with self.assertRaisesRegex(engine.ops.OpsError, "needs --binary"):
            self.assemble(self.root / "w", "windows")
        (self.root / "ygopro").write_bytes(elf_bytes())
        with self.assertRaisesRegex(engine.ops.OpsError, "carries no binary"):
            self.assemble(self.root / "l", "linux", self.root / "ygopro")

    def test_tampered_inputs_are_rejected_before_output(self):
        (self.assets / "utility.lua").write_bytes(b"Auxiliary={}\n-- altered\n")
        with self.assertRaisesRegex(engine.ops.OpsError, "utility.lua SHA"):
            self.assemble(self.root / "e1")
        self.assertFalse((self.root / "e1").exists())

    def test_banlist_bytes_and_overlay_utility_are_rejected(self):
        (self.assets / "lflist.conf").write_bytes(b"!2011.3.1\r\n1 0\r\n!2026.7\r\n")
        with self.assertRaisesRegex(engine.ops.OpsError, "lflist.conf"):
            self.assemble(self.root / "e2")
        self.setUp()
        (self.overlay / "utility.lua").write_text("-- must not be in 706\n")
        with self.assertRaisesRegex(engine.ops.OpsError, "must not contain utility.lua"):
            self.assemble(self.root / "e3")

    def test_base_tree_digest_mismatch_is_rejected(self):
        profile = json.loads(self.versions.read_text(encoding="utf-8"))
        profile["engine"]["publicLayout"]["scriptTreeSha256"] = "f" * 64
        engine.ops.write_json(self.versions, profile)
        with self.assertRaisesRegex(engine.ops.OpsError, "Base Lua tree digest"):
            self.assemble(self.root / "e4")

    def test_verify_detects_changed_overlay_file_after_assembly(self):
        destination = self.root / "engine-v"
        self.assemble(destination)
        (destination / "expansions/script/c1.lua").write_text("-- changed later\n")
        with self.assertRaises(engine.ops.OpsError):
            engine.verify_production(destination, self.versions, "linux")

    def test_asset_profile_requires_one_lock_set(self):
        profile = json.loads(self.versions.read_text(encoding="utf-8"))
        profile["engine"]["scriptEnvironment"]["utilitySha256"] = "e" * 64
        with self.assertRaisesRegex(engine.ops.OpsError, "rule environment"):
            engine.asset_profile(profile)
        profile = json.loads(self.versions.read_text(encoding="utf-8"))
        profile["engineAssetSource"]["commit"] = "4" * 40
        with self.assertRaisesRegex(engine.ops.OpsError, "differ"):
            engine.asset_profile(profile)

    def test_tree_digest_ignores_line_endings(self):
        a, b = self.root / "a", self.root / "b"
        a.mkdir()
        b.mkdir()
        (a / "x.lua").write_bytes(b"x\ny\n")
        (b / "x.lua").write_bytes(b"x\r\ny\r\n")
        self.assertEqual(engine.lua_tree_sha256(engine.lua_files(a)), engine.lua_tree_sha256(engine.lua_files(b)))


class PackLinuxSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-pack-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source_dir = self.root / "engine-source"
        checkout = self.source_dir / "source"
        commits = {}
        for name in ("ocgcore", "script"):
            repo = checkout / name
            repo.mkdir(parents=True)
            run_git(repo, "init", "-q")
            (repo / f"{name}.txt").write_bytes(b"a\r\nb\n")
            run_git(repo, "add", "-A")
            run_git(repo, "commit", "-q", "-m", name)
            commits[name] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        run_git(checkout, "init", "-q")
        (checkout / "premake").mkdir()
        (checkout / "premake" / "build.sh").write_bytes(b"#!/bin/sh\n")
        (checkout / "strings.conf").write_bytes(b"!system 1 x\n")
        run_git(checkout, "add", "premake/build.sh", "strings.conf")
        run_git(checkout, "update-index", "--chmod=+x", "premake/build.sh")
        for name in ("ocgcore", "script"):
            run_git(checkout, "update-index", "--add", "--cacheinfo", f"160000,{commits[name]},{name}")
        run_git(checkout, "commit", "-q", "-m", "root")
        root_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
        downloads = self.source_dir / "downloads"
        downloads.mkdir()
        self.deps = {}
        for name, members in (("lua", {"lua-5.4.8/src/lua.h": b"/* lua */\n"}), ("premake-linux", {"premake5": b"\x7fELF"})):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                for member_name, data in members.items():
                    info = tarfile.TarInfo(member_name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            (downloads / (name + ".tar.gz")).write_bytes(buffer.getvalue())
            self.deps[name] = hashlib.sha256(buffer.getvalue()).hexdigest()
        self.source = {"repository": "https://github.com/example/ygopro.git", "commit": root_commit,
                       "coreCommit": commits["ocgcore"], "scriptCommit": commits["script"]}
        engine.ops.write_json(self.source_dir / "source-report.json", {"platform": "linux", "source": self.source})
        self.versions = self.root / "versions.json"
        engine.ops.write_json(self.versions, {"engine": {"source": self.source, "buildDependencies": {
            "lua": {"url": "https://www.lua.org/lua.tar.gz", "sha256": self.deps["lua"], "archiveRoot": "lua-5.4.8"},
            "premake-linux": {"url": "https://github.com/p.tar.gz", "sha256": self.deps["premake-linux"], "executable": "premake5"}}}})

    def test_pack_reads_committed_bytes_and_modes(self):
        checkout = self.source_dir / "source"
        (checkout / "strings.conf").write_text("changed in working tree but not committed\n")
        output = self.root / "linux-build-input"
        result = pack.pack(self.source_dir, self.versions, output)
        manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["archiveSha256"], result["archiveSha256"])
        with tarfile.open(output / "linux-build-source.tar.gz") as archive:
            members = {m.name: m for m in archive.getmembers()}
            self.assertEqual(archive.extractfile("source/strings.conf").read(), b"!system 1 x\n")
            self.assertEqual(archive.extractfile("source/script/script.txt").read(), b"a\r\nb\n")
            self.assertEqual(members["source/premake/build.sh"].mode, 0o755)
            self.assertEqual(members["source/premake5"].mode, 0o755)
            self.assertIn("source/lua/src/lua.h", members)
            self.assertFalse(any(".git" in Path(n).parts for n in members))
        self.assertEqual({row["path"] for row in manifest["files"]}, set(members))

    def test_wrong_dependency_or_submodule_commit_is_rejected(self):
        (self.source_dir / "downloads" / "lua.tar.gz").write_bytes(b"not the pinned archive")
        with self.assertRaisesRegex(engine.ops.OpsError, "SHA mismatch: lua"):
            pack.pack(self.source_dir, self.versions, self.root / "out1")
        self.setUp()
        script = self.source_dir / "source" / "script"
        (script / "extra.txt").write_text("x")
        run_git(script, "add", "-A")
        run_git(script, "commit", "-q", "-m", "moved")
        with self.assertRaisesRegex(engine.ops.OpsError, "commit mismatch"):
            pack.pack(self.source_dir, self.versions, self.root / "out2")


class WindowsHandoverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-handover-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        (self.repo / "ops" / "windows" / "pm2-lock").mkdir(parents=True)
        (self.repo / "ops" / "windows" / "pm2-lock" / "package.json").write_bytes(b'{"dependencies":{"pm2":"6.0.14"}}\n')
        (self.repo / "ops" / "windows" / "pm2-lock" / "package-lock.json").write_bytes(b"{}\n")
        self.materials = self.root / "materials"
        self.materials.mkdir()
        installers = []
        for name in ("node.msi", "python.exe"):
            data = name.encode() * 10
            (self.materials / name).write_bytes(data)
            installers.append({"file": name, "url": "https://example.invalid/" + name, "bytes": len(data),
                               "sha256": hashlib.sha256(data).hexdigest()})
        (self.repo / "ops" / "versions.json").write_text(json.dumps({"windowsInstallers": installers}))
        run_git(self.repo, "init", "-q")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "init")
        (self.materials / "install-params.json").write_text(json.dumps({"route": "A"}))
        (self.materials / "windows.server.config.json").write_text("{}")
        (self.materials / "server-release.tar.gz").write_bytes(b"archive")
        (self.materials / "server-release.tar.gz.manifest.json").write_text("{}")

    def build(self):
        with patch.object(handover.ops, "check_release", return_value=None):
            return handover.build(self.repo, self.materials)

    def test_writes_ops_zip_locks_and_crlf_list(self):
        result = self.build()
        listing = (self.materials / "handover-sha256.txt").read_bytes()
        self.assertEqual(hashlib.sha256(listing).hexdigest().upper(), result["handoverListSha256"])
        lines = listing.decode("utf-8").split("\r\n")
        names = [line.split("\t")[0] for line in lines[1:] if line]
        self.assertIn("pm2-lock\\package-lock.json", names)
        self.assertIn("windows.server.config.json", names)
        self.assertIn("node.msi", names)
        with zipfile.ZipFile(self.materials / "ops-input.zip") as archive:
            self.assertIn("ops/versions.json", archive.namelist())
        self.assertEqual((self.materials / "pm2-lock" / "package-lock.json").read_bytes(), b"{}\n")
        with self.assertRaisesRegex(handover.ops.OpsError, "already exists"):
            self.build()

    def test_installer_mismatch_and_dirty_checkout_are_rejected(self):
        (self.materials / "node.msi").write_bytes(b"tampered")
        with self.assertRaisesRegex(handover.ops.OpsError, "node.msi"):
            self.build()
        self.setUp()
        (self.repo / "ops" / "new.txt").write_text("uncommitted")
        with self.assertRaisesRegex(handover.ops.OpsError, "uncommitted"):
            self.build()

    def test_route_b_needs_the_named_batch(self):
        (self.materials / "install-params.json").write_text(json.dumps({"route": "B", "batch": {"zip": "b.zip", "top": "b"}}))
        with self.assertRaisesRegex(handover.ops.OpsError, "batch ZIP"):
            self.build()
        (self.materials / "b.zip").write_bytes(b"zip")
        self.build()
        self.assertIn("b.zip\t", (self.materials / "handover-sha256.txt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
