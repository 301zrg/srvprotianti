"""Archive boundaries for pinned public build inputs."""

import importlib.util
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location("engine_source", Path(__file__).parents[1] / "scripts" / "engine-source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-source-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_tar_accepts_dot_prefix_and_preserves_content(self):
        archive = self.root / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            folder = tarfile.TarInfo("./")
            folder.type = tarfile.DIRTYPE
            package.addfile(folder)
            member = tarfile.TarInfo("./package/source.c")
            member.size = 4
            package.addfile(member, io.BytesIO(b"code"))
        target = self.root / "new"
        source.extract_archive(archive, target)
        self.assertEqual((target / "package" / "source.c").read_bytes(), b"code")

    def test_tar_rejects_escape_and_symlink_before_extracting(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("package/link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                archive = self.root / "bad.tar"
                with tarfile.open(archive, "w") as package:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "../../escape"
                    package.addfile(member)
                target = self.root / "rejected"
                with self.assertRaises(source.ops.OpsError):
                    source.extract_archive(archive, target)
                self.assertFalse(target.exists())
                self.assertFalse((self.root.parent / "escape").exists())

    def test_zip_rejects_case_collision_traversal_and_symlink(self):
        for paths in (("Package/file", "package/FILE"), ("../escape",), ("package/link",)):
            with self.subTest(paths=paths):
                archive = self.root / "bad.zip"
                with zipfile.ZipFile(archive, "w") as package:
                    for path in paths:
                        member = zipfile.ZipInfo(path)
                        if path.endswith("link"):
                            member.create_system = 3
                            member.external_attr = 0o120777 << 16
                        package.writestr(member, b"input")
                target = self.root / "rejected"
                with self.assertRaises(source.ops.OpsError):
                    source.extract_archive(archive, target)
                self.assertFalse(target.exists())


    def test_zip_rejects_nonportable_names_and_case_colliding_parents(self):
        for index, paths in enumerate((("package/CON.txt",), ("package/name. ",),
                      ("Package/a", "package/b"), ("file", "file/child"))):
            with self.subTest(paths=paths):
                archive = self.root / "nonportable.zip"
                with zipfile.ZipFile(archive, "w") as package:
                    for name in paths:
                        package.writestr(name, b"input")
                target = self.root / ("rejected-portability-" + str(index))
                with self.assertRaises(source.ops.OpsError):
                    source.extract_archive(archive, target)
                self.assertFalse(target.exists())

    def test_existing_target_is_preserved(self):
        target = self.root / "existing"
        target.mkdir()
        (target / "retain").write_text("keep")
        with self.assertRaises(source.ops.OpsError):
            source.extract_archive(self.root / "not-opened.zip", target)
        self.assertEqual((target / "retain").read_text(), "keep")


class DependencyDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-source-download-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b"fixed archive bytes"
        self.dependency = {"url": "https://www.lua.org/ftp/lua-5.4.8.tar.gz",
                           "sha256": hashlib.sha256(self.content).hexdigest()}

    def test_local_archive_avoids_network_and_records_verified_bytes(self):
        cached = self.root / "lua.tar.gz"
        cached.write_bytes(self.content)
        output = self.root / "delivered.tar.gz"
        with patch.object(source.urllib.request, "urlopen", side_effect=AssertionError("Network must not be used")):
            report = source.download_dependency("lua", self.dependency, output, cached)
        self.assertEqual(output.read_bytes(), self.content)
        self.assertEqual(cached.read_bytes(), self.content)
        self.assertEqual(report, {"name": "lua", **self.dependency, "bytes": len(self.content), "inputMode": "local-archive"})

    def test_invalid_cache_is_rejected_before_git_or_destination_creation(self):
        versions = self.root / "versions.json"
        versions.write_text(json.dumps({"engine": {
            "source": {"repository": "https://github.com/mycard/ygopro.git", "commit": "1" * 40},
            "buildDependencies": {"lua": self.dependency}}}))
        corrupted = self.root / "corrupted.tar.gz"
        corrupted.write_bytes(b"wrong archive")
        for cached in (self.root / "missing.tar.gz", corrupted, self.root):
            with self.subTest(cached=cached):
                target = self.root / "new-build"
                with patch.object(source.ops, "run", side_effect=AssertionError("Git must not be called")):
                    with self.assertRaises(source.ops.OpsError):
                        source.prepare(target, versions, "linux", cached)
                self.assertFalse(target.exists())
        self.assertEqual(corrupted.read_bytes(), b"wrong archive")

    def test_local_archive_symlink_is_rejected(self):
        cached = self.root / "lua.tar.gz"
        cached.write_bytes(self.content)
        link = self.root / "linked.tar.gz"
        try:
            link.symlink_to(cached)
        except OSError:
            self.skipTest("Symlinks are unavailable for this user")
        with self.assertRaises(source.ops.OpsError):
            source.download_dependency("lua", self.dependency, self.root / "output", link)
        self.assertFalse((self.root / "output").exists())

    def test_offline_copy_rechecks_output_hash(self):
        cached = self.root / "lua.tar.gz"
        cached.write_bytes(self.content)
        output = self.root / "output"
        with patch.object(source.ops, "digest", side_effect=[self.dependency["sha256"], "0" * 64]):
            with self.assertRaisesRegex(source.ops.OpsError, "Dependency SHA mismatch"):
                source.download_dependency("lua", self.dependency, output, cached)

    def test_https_download_retains_url_timeout_and_hash_check(self):
        output = self.root / "download"
        with patch.object(source.urllib.request, "urlopen", return_value=io.BytesIO(self.content)) as request:
            report = source.download_dependency("lua", self.dependency, output)
        request.assert_called_once_with(self.dependency["url"], timeout=60)
        self.assertEqual(report["inputMode"], "https")
        self.assertEqual(output.read_bytes(), self.content)

    def test_https_bad_hash_is_rejected(self):
        with patch.object(source.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupted")):
            with self.assertRaisesRegex(source.ops.OpsError, "Dependency SHA mismatch"):
                source.download_dependency("lua", self.dependency, self.root / "download")

    def test_existing_output_is_not_overwritten_or_downloaded(self):
        output = self.root / "existing"
        output.write_bytes(b"keep")
        with patch.object(source.urllib.request, "urlopen") as request:
            with self.assertRaisesRegex(source.ops.OpsError, "output must be new"):
                source.download_dependency("lua", self.dependency, output)
        request.assert_not_called()
        self.assertEqual(output.read_bytes(), b"keep")

    def test_connect_denial_has_recovery_hint_without_automatic_fallback(self):
        output = self.root / "download"
        with patch.object(source.urllib.request, "urlopen", side_effect=urllib.error.URLError("Tunnel connection failed: 403 Forbidden")) as request:
            with self.assertRaisesRegex(source.ops.OpsError, "403 Forbidden.*--lua-archive"):
                source.download_dependency("lua", self.dependency, output)
        request.assert_called_once()
        self.assertFalse(output.exists())


class SourcePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="srvpro-prepare-inputs-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archives = {}
        for name, member_name in (("lua", "lua-fixed/src/source.c"), ("premake-linux", "premake5")):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                member = tarfile.TarInfo(member_name)
                content = b"synthetic build input"
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            self.archives[name] = buffer.getvalue()
        dependencies = {name: {"url": "https://github.com/example/fixture/" + name + ".tar.gz",
                              "sha256": hashlib.sha256(content).hexdigest()}
                        for name, content in self.archives.items()}
        dependencies["lua"].update({"archiveRoot": "lua-fixed", "directory": "lua"})
        dependencies["premake-linux"]["executable"] = "premake5"
        self.profile = {"engine": {"source": {
            "repository": "https://github.com/example/fixture.git", "commit": "1" * 40,
            "coreCommit": "2" * 40, "scriptCommit": "3" * 40}, "buildDependencies": dependencies}}
        self.versions = self.root / "versions.json"
        source.ops.write_json(self.versions, self.profile)

    def git(self, args, **kwargs):
        directory = Path(kwargs["cwd"])
        if "submodule" in args:
            (directory / "ocgcore").mkdir()
            (directory / "script").mkdir()
        if "rev-parse" in args:
            return 0, ("2" if directory.name == "ocgcore" else "3") * 40
        return 0, ""

    def response(self, url, **kwargs):
        name = url.rsplit("/", 1)[-1].removesuffix(".tar.gz")
        return io.BytesIO(self.archives[name])

    def test_complete_preparation_pins_copies_and_keeps_validation_boundaries(self):
        destination = self.root / "prepared"
        with patch.object(source.ops, "run", side_effect=self.git), \
                patch.object(source.urllib.request, "urlopen", side_effect=self.response):
            result = source.prepare(destination, self.versions, "linux")
        self.assertEqual((destination / "source/lua/src/source.c").read_bytes(), b"synthetic build input")
        self.assertEqual((destination / "source/premake5").read_bytes(), b"synthetic build input")
        self.assertEqual(source.ops.read_json(destination / "source-report.json"), result)
        self.assertFalse(result["nativeCompilationPerformed"])
        self.assertFalse(result["productionEquivalentProven"])
        self.assertEqual(result["dependencies"], ["lua", "premake-linux"])

    def test_wrong_submodule_preserves_partial_tree_without_success_report(self):
        destination = self.root / "wrong-submodule"
        def wrong(args, **kwargs):
            result = self.git(args, **kwargs)
            return (0, "4" * 40) if "rev-parse" in args else result
        with patch.object(source.ops, "run", side_effect=wrong), \
                patch.object(source.urllib.request, "urlopen", side_effect=AssertionError("Download was attempted")):
            with self.assertRaisesRegex(source.ops.OpsError, "Pinned ocgcore"):
                source.prepare(destination, self.versions, "linux")
        self.assertTrue((destination / "source").is_dir())
        self.assertFalse((destination / "source-report.json").exists())

    def test_dependency_directory_cannot_escape_source(self):
        destination = self.root / "escape-refused"
        self.profile["engine"]["buildDependencies"]["lua"]["directory"] = "../../escape"
        source.ops.write_json(self.versions, self.profile)
        with patch.object(source.ops, "run", side_effect=self.git), \
                patch.object(source.urllib.request, "urlopen", side_effect=self.response):
            with self.assertRaisesRegex(source.ops.OpsError, "relative path"):
                source.prepare(destination, self.versions, "linux")
        self.assertFalse((self.root / "escape").exists())
        self.assertFalse((destination / "source-report.json").exists())


if __name__ == "__main__":
    unittest.main()
