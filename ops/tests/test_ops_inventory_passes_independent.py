"""Independent inventory/pass audit. Synthetic files and in-memory database doubles only."""
import collections
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import random
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch


BEFORE_COMMIT = "58fb4a5"


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ops = module_from(Path(__file__).parents[1] / "scripts" / "ops.py", "passes_independent_ops")


def load_before():
    """ops.py as it was before the pass reduction, or None when history is not available."""
    try:
        source = subprocess.run(["git", "show", BEFORE_COMMIT + ":ops/scripts/ops.py"], cwd=Path(__file__).parents[2],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    target = Path(tempfile.gettempdir()) / ("ops-before-" + uuid.uuid4().hex + ".py")
    target.write_bytes(source)
    try:
        return module_from(target, "passes_before_ops")
    finally:
        target.unlink()


before = load_before()
VERSIONS = tuple(module for module in (before, ops) if module is not None)
REFERENCE = before or ops


def sha(data):
    return hashlib.sha256(data).hexdigest()


def row(name, payload, file):
    return {"path": name, "size": len(payload), "sha256": sha(payload),
            "mode": stat.S_IMODE(file.stat().st_mode) & 0o777}


def state():
    return {"rowDigestFormat": "pg-row-json-copytext-c-utf8-lf-v1",
            "schema": [], "tables": [], "sequences": []}


class MemoryDatabase:
    """No SQL, shell, network or credential access."""
    database = "srvpro_drill_passes"
    environment = {}

    def __init__(self, during_dump=None):
        self.during_dump = during_dump

    def assert_quiet(self):
        pass

    def assert_empty(self):
        pass

    def metadata(self):
        return {"database": self.database, "serverVersionNum": 170000, "encoding": "UTF8"}

    def state(self):
        return state()

    def replay_names(self):
        return []

    def command(self, name, *args):
        if name == "pg_dump" and "--version" in args:
            return 0, "pg_dump 17.0"
        if name == "pg_dump":
            Path(args[args.index("--file") + 1]).write_bytes(b"synthetic dump")
            if self.during_dump:
                self.during_dump()
        return 0, ""


class IndependentPassesTest(unittest.TestCase):
    def setUp(self):
        # mkdir's inherited ACL avoids Python 3.13's Windows mkdir(0700) ACL.
        self.root = Path(tempfile.gettempdir()) / ("ops-passes-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        base = Path(tempfile.gettempdir()).resolve()
        self.assertEqual(self.root.resolve().parent, base)
        self.assertFalse(self.root.is_symlink())
        shutil.rmtree(self.root)

    def put(self, path, data=b"x"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def tree(self, name="tree"):
        root = self.root / name
        (root / "Empty").mkdir(parents=True)
        (root / "a" / "b" / "c").mkdir(parents=True)
        self.put(root / "a" / "b" / "c" / "Deep.txt", b"deep")
        self.put(root / "a" / "Mixed.txt", b"mixed")
        self.put(root / "Zed.txt", b"zed")
        self.put(root / "apple.txt", b"apple")
        self.put(root / "中文.txt", b"utf8")
        return root

    def expected_tree(self, root):
        names = (["a/b/c/Deep.txt", "a/Mixed.txt", "apple.txt", "Zed.txt", "中文.txt"]
                 if os.name == "nt" else
                 ["Zed.txt", "a/Mixed.txt", "a/b/c/Deep.txt", "apple.txt", "中文.txt"])
        data = {"a/b/c/Deep.txt": b"deep", "a/Mixed.txt": b"mixed", "Zed.txt": b"zed",
                "apple.txt": b"apple", "中文.txt": b"utf8"}
        return [row(name, data[name], root / name) for name in names]

    @contextmanager
    def counted(self, module):
        calls = collections.Counter()
        real = module.is_reparse

        def check(path):
            calls[Path(path).absolute()] += 1
            return real(path)

        with patch.object(module, "is_reparse", side_effect=check):
            yield calls

    def assert_scan(self, root, expected, descendants):
        with self.counted(ops) as calls:
            self.assertEqual(ops.inventory(root), expected)
        self.assertEqual(calls, collections.Counter({p: 1 for p in {root, *root.parents, *descendants}}))

    def test_inventory_explicit_tree_rows_modes_order_and_checks(self):
        root = self.tree()
        descendants = [root / name for name in ("Empty", "a", "a/b", "a/b/c", "a/b/c/Deep.txt",
                                                "a/Mixed.txt", "Zed.txt", "apple.txt", "中文.txt")]
        self.assert_scan(root, self.expected_tree(root), descendants)

    def test_inventory_empty_root_checks_all_ancestors(self):
        root = self.root / "empty"
        root.mkdir()
        self.assert_scan(root, [], [])

    def test_inventory_single_file_rows_and_checks(self):
        file = self.put(self.root / "Single中文.txt", b"one")
        self.assert_scan(file, [row("Single中文.txt", b"one", file)], [])

    def test_inventory_refuses_each_static_reparse_level(self):
        root = self.tree()
        for target in (*root.parents, root, root / "a", root / "a/b", root / "a/b/c",
                       root / "a/b/c/Deep.txt", root / "Empty", root / "中文.txt"):
            with self.subTest(target=str(target)):
                with patch.object(ops, "is_reparse", side_effect=lambda p: Path(p) == target):
                    with self.assertRaises(ops.OpsError):
                        ops.inventory(root)

    def random_trees(self):
        rng = random.Random(0x79473)
        for index in range(36):
            root = self.root / f"random-{index}"
            (root / "empty" / "deep" / "void").mkdir(parents=True)
            # Same names differing only in case live under DISJOINT parents, portable on Windows.
            for name in ("left/Case/Same.txt", "right/case/same.txt", "nested/a/b/c/中文.txt"):
                self.put(root / name, rng.randbytes(rng.randrange(0, 40)))
            for number in range(rng.randrange(2, 12)):
                depth = rng.randrange(0, 6)
                parts = [rng.choice(("Alpha", "beta", "中文", "Zed")) for _ in range(depth)]
                self.put(root.joinpath(*parts, f"f{number}.bin"), rng.randbytes(rng.randrange(0, 80)))
            yield root

    @unittest.skipIf(before is None, "pre-change ops.py is not available from Git history")
    def test_inventory_36_seeded_trees_matches_before_exactly(self):
        for root in self.random_trees():
            with self.subTest(tree=root.name):
                self.assertEqual(ops.inventory(root), before.inventory(root))

    def test_batch_files_36_trees_and_file_empty_components_exactly_match_walk(self):
        for number, tree in enumerate(self.random_trees()):
            with self.subTest(tree=number):
                output = self.root / f"output-{number}"
                copied = {}
                # Reverse lexical insertion order deliberately kills unsorted assembly.
                for name, source in (("z", tree), ("a", self.put(self.root / f"Single{number}.txt", b"single"))):
                    ops.copy_tree(source, output / "files" / name)
                    copied[name] = ops.inventory(output / "files" / name)
                (output / "files" / "empty").mkdir()
                copied["empty"] = []
                self.put(output / "Top中文.txt", b"top")
                self.put(output / "database.dump", b"dump")
                self.assertEqual(ops.batch_files(output, copied), ops.inventory(output))

    def test_path_sort_order_for_windows_and_posix_flavours(self):
        names = ["z.txt", "A/child.txt", "a.txt", "中文.txt", "B/x.txt", "B/empty", "B"]
        for flavour in (PureWindowsPath, PurePosixPath):
            root = flavour("C:/batch" if flavour is PureWindowsPath else "/batch")
            all_paths = sorted(root / name for name in names)
            expected = [p for p in all_paths if str(p.relative_to(root)).replace("\\", "/") not in ("B", "B/empty")]
            rows = [name for name in reversed(names) if name not in ("B", "B/empty")]
            self.assertEqual(sorted((root.joinpath(*name.split("/")) for name in rows)), expected)

    def test_batch_files_keeps_the_prefix_of_an_unexpected_top_directory(self):
        output = self.root / "out"
        self.put(output / "files/a/replay.yrp", b"r")
        self.put(output / "unexpected/leaf.txt", b"leaf")
        copied = {"a": [row("replay.yrp", b"r", output / "files/a/replay.yrp")]}
        self.assertEqual([r["path"] for r in ops.inventory(output)], ["files/a/replay.yrp", "unexpected/leaf.txt"])
        self.assertEqual(ops.batch_files(output, copied), ops.inventory(output))

    def release(self):
        archive = self.root / ("release-" + uuid.uuid4().hex + ".tar.gz")
        with tarfile.open(archive, "w:gz"):
            pass
        manifest = {"format": 1, "kind": "release", "files": [], "archiveSha256": sha(archive.read_bytes())}
        ops.write_json(str(archive) + ".manifest.json", manifest)
        return archive, manifest

    def batch(self, name="batch"):
        batch = self.root / name
        a = self.put(batch / "files/a/replay.yrp", b"replay")
        ab = self.put(batch / "files/ab/other.txt", b"other")
        (batch / "files/empty").mkdir()
        archive, release = self.release()
        shutil.copy2(archive, batch / "release.tar.gz")
        ops.write_json(batch / "release.manifest.json", release)
        self.put(batch / "database.dump", b"dump")
        manifest = {"format": 1, "kind": "joint-backup", "batchId": name,
                    "sourceDatabase": {"database": "source"}, "pgDumpMajor": 17,
                    "databaseState": state(), "replayComponent": "a",
                    "replayAssociations": {"databaseReferenceCount": 0, "linkedFiles": [],
                        "unsafeDatabaseFilenames": [], "databaseWithoutFile": [], "unlinkedFiles": ["replay.yrp"], "nestedFiles": []},
                    "components": [{"id": "a", "originalSource": "synthetic-a", "files": [row("replay.yrp", b"replay", a)]},
                                   {"id": "ab", "originalSource": "synthetic-ab", "files": [row("other.txt", b"other", ab)]},
                                   {"id": "empty", "originalSource": "synthetic-empty", "files": []}],
                    "files": REFERENCE.inventory(batch)}
        ops.write_json(batch / "manifest.json", manifest)
        return batch, manifest

    def save(self, batch, manifest, refresh=False):
        if refresh:
            manifest["files"] = [r for r in REFERENCE.inventory(batch) if r["path"] != "manifest.json"]
        ops.write_json(batch / "manifest.json", manifest)

    def outcomes(self, batch, old_accept, new_accept, reparse=None):
        for module, accept in ((before, old_accept), (ops, new_accept)):
            if module is None:
                continue
            with self.subTest(version=module.__name__, accept=accept):
                with patch.object(module, "is_reparse", side_effect=lambda p: Path(p) == reparse if reparse else False):
                    if accept:
                        self.assertIsInstance(module.verify_batch(batch), dict)
                    else:
                        with self.assertRaises(module.OpsError):
                            module.verify_batch(batch)

    def test_verify_valid_prefix_ids_a_ab_and_empty_accept(self):
        batch, _ = self.batch()
        self.outcomes(batch, True, True)

    def test_verify_missing_empty_component_reject(self):
        batch, _ = self.batch()
        (batch / "files/empty").rmdir()
        self.outcomes(batch, False, False)

    def test_verify_component_file_old_accepts_new_rejects(self):
        batch, manifest = self.batch()
        (batch / "files/empty").rmdir()
        file = self.put(batch / "files/empty", b"x")
        manifest["components"][2]["files"] = [row("empty", b"x", file)]
        self.save(batch, manifest, refresh=True)
        self.outcomes(batch, True, False)

    def test_verify_static_component_link_reject(self):
        batch, _ = self.batch()
        self.outcomes(batch, False, False, reparse=batch / "files/empty")

    def test_verify_duplicate_component_ids_accept_identical_reject_conflicting(self):
        batch, manifest = self.batch()
        manifest["components"].append(copy.deepcopy(manifest["components"][0]))
        self.save(batch, manifest)
        self.outcomes(batch, True, True)
        manifest["components"][-1]["files"] = []
        self.save(batch, manifest)
        self.outcomes(batch, False, False)

    def test_verify_orphan_files_accept_only_if_batch_listed_empty_dirs_invisible(self):
        batch, manifest = self.batch()
        (batch / "files/orphan-empty").mkdir()
        self.outcomes(batch, True, True)
        self.put(batch / "files/orphan/file.txt", b"orphan")
        self.put(batch / "files/loose.txt", b"loose")
        self.outcomes(batch, False, False)
        self.save(batch, manifest, refresh=True)
        self.outcomes(batch, True, True)

    def test_verify_moved_file_with_updated_global_list_reject(self):
        batch, manifest = self.batch()
        (batch / "files/a/replay.yrp").rename(batch / "files/empty/replay.yrp")
        self.save(batch, manifest, refresh=True)
        self.outcomes(batch, False, False)

    def test_verify_wrong_component_digest_with_matching_global_list_reject(self):
        batch, manifest = self.batch()
        manifest["components"][0]["files"][0]["sha256"] = sha(b"wrong")
        self.save(batch, manifest)
        self.outcomes(batch, False, False)

    @unittest.skipUnless(os.name == "nt", "Windows case-insensitive path lookup")
    def test_verify_windows_component_and_container_case_differences(self):
        batch, manifest = self.batch()
        (batch / "files/a").rename(batch / "files/temporary")
        (batch / "files/temporary").rename(batch / "files/A")
        self.save(batch, manifest, refresh=True)
        # The directory must be spelled exactly like the component ID (as on a case-sensitive host).
        self.outcomes(batch, True, False)
        # A wrong empty component list must never be accepted through the case alias.
        manifest["components"][0]["files"] = []
        self.save(batch, manifest)
        self.outcomes(batch, False, False)
        manifest["components"] = [manifest["components"][2]]
        (batch / "files/empty").rename(batch / "files/temporary")
        (batch / "files/temporary").rename(batch / "files/EMPTY")
        self.save(batch, manifest)
        self.outcomes(batch, True, False)
        # Also exercise the spelling of the files container itself.
        batch2, manifest2 = self.batch("batch2")
        (batch2 / "files").rename(batch2 / "temporary")
        (batch2 / "temporary").rename(batch2 / "Files")
        self.save(batch2, manifest2, refresh=True)
        self.outcomes(batch2, True, False)
        manifest2["components"][0]["files"] = []
        manifest2["components"][1]["files"] = []
        self.save(batch2, manifest2)
        self.outcomes(batch2, False, False)

    def plan(self):
        replay = self.put(self.root / "source/replay.yrp", b"replay").parent
        archive, _ = self.release()
        return {"format": 1, "database": "srvpro_drill_passes", "runtimeRole": "runtime", "isolated": True,
                "releaseArchive": str(archive), "replayComponent": "a", "components": [{"id": "a", "source": str(replay)}]}

    def test_backup_post_copy_change_delete_add_fail_and_keep_manifest_and_failed(self):
        plan = self.plan()
        for module in VERSIONS:
            for change in ("change", "delete", "add"):
                with self.subTest(version=module.__name__, change=change):
                    output = self.root / (module.__name__ + change)

                    def mutate():
                        file = output / "files/a/replay.yrp"
                        if change == "change":
                            file.write_bytes(b"damage")
                        elif change == "delete":
                            file.unlink()
                        else:
                            self.put(output / "files/a/new.txt", b"new")

                    with self.assertRaises(module.OpsError):
                        module.backup(plan, output, MemoryDatabase(mutate), "srvpro_drill_passes")
                    self.assertTrue((output / "FAILED.json").is_file())
                    self.assertTrue((output / "manifest.json").is_file())
                    with self.assertRaises(module.OpsError):
                        module.verify_batch(output)

    def test_backup_mutation_reverted_at_manifest_write_old_fails_new_accepts(self):
        plan = self.plan()
        for module, accepted in ((before, False), (ops, True)):
            if module is None:
                continue
            with self.subTest(version=module.__name__):
                output = self.root / (module.__name__ + "transient")

                def mutate():
                    (output / "files/a/replay.yrp").write_bytes(b"temporary damage")

                write = module.write_json

                def revert(path, value):
                    if Path(path).name == "manifest.json":
                        (output / "files/a/replay.yrp").write_bytes(b"replay")
                    return write(path, value)

                with patch.object(module, "write_json", side_effect=revert):
                    if accepted:
                        result = module.backup(plan, output, MemoryDatabase(mutate), "srvpro_drill_passes")
                        self.assertEqual(module.verify_batch(output), result)
                        self.assertFalse((output / "FAILED.json").exists())
                    else:
                        with self.assertRaises(module.OpsError):
                            module.backup(plan, output, MemoryDatabase(mutate), "srvpro_drill_passes")

    def restore(self, module, batch, destination, mutate=None):
        tool = self.put(self.root / "schema-tool.js", b"// synthetic; never executed")
        real_copy = module.copy_tree

        def copy_files(source, target):
            real_copy(source, target)
            if mutate and Path(target).name == "a":
                mutate(Path(target) / "replay.yrp")

        with patch.object(module, "run", return_value=(0, "")), patch.object(module, "copy_tree", side_effect=copy_files):
            return module.restore(batch, destination, MemoryDatabase(), "srvpro_drill_passes", "owner", "runtime", tool)

    def test_restore_corrupt_replay_same_associations_must_reject(self):
        batch, _ = self.batch()
        for module in VERSIONS:
            destination = self.root / (module.__name__ + "restore-damaged")
            with self.subTest(version=module.__name__):
                with self.assertRaises(module.OpsError) as caught:
                    self.restore(module, batch, destination, lambda file: file.write_bytes(b"wrong bytes, same name"))
                self.assertIn("Restored component differs", str(caught.exception))
                self.assertFalse(module.read_json(destination / "restore-result.json")["complete"])

    def test_restore_absent_replay_duplicate_ids_and_empty_replay(self):
        for case in ("absent", "duplicate", "empty"):
            batch, manifest = self.batch(case)
            if case == "absent":
                manifest["replayComponent"] = "missing"
            elif case == "duplicate":
                manifest["components"].append(copy.deepcopy(manifest["components"][0]))
            else:
                manifest["replayComponent"] = "empty"
                manifest["replayAssociations"]["unlinkedFiles"] = []
            self.save(batch, manifest)
            self.outcomes(batch, True, True)
            for module in VERSIONS:
                with self.subTest(version=module.__name__, case=case):
                    destination = self.root / (module.__name__ + case)
                    if case == "empty":
                        self.assertTrue(self.restore(module, batch, destination)["complete"])
                    else:
                        with self.assertRaises((module.OpsError, FileExistsError)):
                            self.restore(module, batch, destination)
                        self.assertFalse(module.read_json(destination / "restore-result.json")["complete"])

    @unittest.skipIf(before is None, "pre-change ops.py is not available from Git history")
    def test_resolve_without_cache_matches_before_checks_results_and_errors(self):
        root = self.tree()
        for target in (None, root, root / "a", root.parent, root.parents[-1]):
            traces = []
            for module in VERSIONS:
                trace = []

                def check(path):
                    trace.append(Path(path))
                    return Path(path) == target

                with patch.object(module, "is_reparse", side_effect=check):
                    try:
                        result = ("ok", str(module.resolve_source(root / "a/b/c/Deep.txt")))
                    except module.OpsError as error:
                        result = ("error", str(error))
                traces.append((result, trace))
            self.assertEqual(*traces)

    def test_resolve_cache_keeps_nothing_from_a_failed_walk(self):
        first = self.put(self.root / "parent/dir/one.txt")
        second = self.put(self.root / "parent/dir/two.txt")
        rejected = self.root / "parent"
        checked = set()
        with patch.object(ops, "is_reparse", side_effect=lambda p: Path(p) == rejected):
            with self.assertRaises(ops.OpsError):
                ops.resolve_source(first, checked)
            # Nothing is cached from a failed walk, so a sibling is refused for the same ancestor.
            self.assertEqual(checked, set())
            with self.assertRaises(ops.OpsError):
                ops.resolve_source(second, checked)


if __name__ == "__main__":
    unittest.main()
