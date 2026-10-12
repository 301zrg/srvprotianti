"""Archive boundaries for pinned public build inputs."""

import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
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

    def test_existing_target_is_preserved(self):
        target = self.root / "existing"
        target.mkdir()
        (target / "retain").write_text("keep")
        with self.assertRaises(source.ops.OpsError):
            source.extract_archive(self.root / "not-opened.zip", target)
        self.assertEqual((target / "retain").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
