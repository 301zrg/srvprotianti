#!/usr/bin/env python3
"""Pack the pinned Linux engine sources for install stage 22 (no Git history).

Input is a directory made by `engine-source.py --platform linux`. Every source file is read
from the pinned Git commits (blobs, not the working tree, so a Windows checkout's line-ending
conversion cannot leak in); Lua and premake come from the SHA-checked dependency archives.
The output is a NEW directory holding linux-build-source.tar.gz and manifest.json in the
format stage 22 verifies.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

import engine
import ops


def git(directory, *args):
    process = subprocess.run(["git", *args], cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ops.require(process.returncode == 0, f"git {args[0]} failed in {directory.name}")
    return process.stdout


def tree_entries(directory, commit):
    """(path, mode, object) for every blob, recursing into submodules at their own HEAD."""
    rows = []
    for record in git(directory, "ls-tree", "-r", "-z", commit).split(b"\0"):
        if not record:
            continue
        meta, name = record.split(b"\t", 1)
        mode, kind, object_id = meta.decode("ascii").split()
        name = name.decode("utf-8")
        if kind == "commit":
            sub = directory / name
            head = git(sub, "rev-parse", "HEAD").decode("ascii").strip()
            ops.require(head == object_id, f"Submodule {name} is not at the recorded commit")
            rows += [(name + "/" + path, sub_mode, sub_object, sub) for path, sub_mode, sub_object, _ in tree_entries(sub, head)]
        else:
            ops.require(kind == "blob" and mode in {"100644", "100755"}, f"Unsupported tree entry: {name}")
            rows.append((name, mode, object_id, directory))
    return rows


def read_blobs(entries):
    by_repo = {}
    for name, mode, object_id, repo in entries:
        by_repo.setdefault(repo, []).append((name, mode, object_id))
    files = {}
    for repo, items in by_repo.items():
        request = "".join(object_id + "\n" for _, _, object_id in items).encode("ascii")
        output = subprocess.run(["git", "cat-file", "--batch"], cwd=repo, input=request,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
        offset = 0
        for name, mode, object_id in items:
            header_end = output.index(b"\n", offset)
            got, kind, size = output[offset:header_end].decode("ascii").split()
            ops.require(got == object_id and kind == "blob", f"Unexpected object for {name}")
            start = header_end + 1
            data = output[start:start + int(size)]
            ops.require(hashlib.sha1(b"blob " + size.encode() + b"\0" + data).hexdigest() == object_id,
                        f"Blob content check failed: {name}")
            files["source/" + name] = (data, 0o755 if mode == "100755" else 0o644)
            offset = start + int(size) + 1
    return files


def pack(source_dir, versions, output):
    source_dir = engine.checked_source(source_dir)
    output = engine.new_destination(output)
    profile = ops.read_json(versions)["engine"]
    report = ops.read_json(source_dir / "source-report.json")
    ops.require(report.get("platform") == "linux" and report.get("source") == profile["source"],
                "Input was not prepared by engine-source.py --platform linux for these versions")
    checkout = source_dir / "source"
    for directory, key in (("", "commit"), ("ocgcore", "coreCommit"), ("script", "scriptCommit")):
        head = git(checkout / directory if directory else checkout, "rev-parse", "HEAD").decode("ascii").strip()
        ops.require(head == profile["source"][key], f"Pinned {directory or 'ygopro'} commit mismatch")
    entries = [row for row in tree_entries(checkout, profile["source"]["commit"])]
    ops.require(not any(".git" in Path(name).parts for name, *_ in entries), "Git metadata in source list")
    files = read_blobs(entries)
    dependencies = []
    for name in ("lua", "premake-linux"):
        spec = profile["buildDependencies"][name]
        archive = engine.checked_source(source_dir / "downloads" / (name + ".tar.gz"))
        content = archive.read_bytes()
        ops.require(hashlib.sha256(content).hexdigest() == spec["sha256"], f"Dependency archive SHA mismatch: {name}")
        dependencies.append({"name": name, "sha256": spec["sha256"], "url": spec["url"]})
        with tarfile.open(fileobj=io.BytesIO(content)) as archive_file:
            for member in archive_file.getmembers():
                if not member.isfile():
                    ops.require(member.isdir(), f"Unsupported member in {name}: {member.name}")
                    continue
                relative = Path(member.name.removeprefix("./"))
                ops.require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe dependency path")
                if name == "lua":
                    ops.require(relative.parts[0] == spec["archiveRoot"], "Unexpected Lua archive root")
                    target = Path("source/lua").joinpath(*relative.parts[1:]).as_posix()
                    mode = 0o644
                else:
                    if relative.as_posix() != spec["executable"]:
                        continue
                    target, mode = "source/" + Path(spec["executable"]).name, 0o755
                ops.require(target not in files, f"Duplicate source path: {target}")
                files[target] = (archive_file.extractfile(member).read(), mode)
    ops.require("source/lua/src/lua.h" in files and "source/premake5" in files, "Lua or premake is missing")
    output.mkdir(parents=True, exist_ok=False)
    archive = output / "linux-build-source.tar.gz"
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as target:
        for name, (data, mode) in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size, member.mode, member.mtime = len(data), mode, 0
            target.addfile(member, io.BytesIO(data))
    with tarfile.open(archive) as check:
        members = check.getmembers()
        ops.require(len(members) == len(files), "Archive member count differs")
        for member in members:
            ops.require(check.extractfile(member).read() == files[member.name][0], f"Archive content differs: {member.name}")
    manifest = {"source": profile["source"], "sourceCacheReverified": True, "dependencyArchives": dependencies,
                "archiveSha256": ops.digest(archive), "archiveBytes": archive.stat().st_size,
                "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                          for name, (data, _) in sorted(files.items())],
                "readFromGitBlobs": True, "nativeCompilationPerformed": False,
                "productionEquivalentProven": False, "gitHistoryIncluded": False}
    ops.write_json(output / "manifest.json", manifest)
    return {"archiveBytes": manifest["archiveBytes"], "archiveSha256": manifest["archiveSha256"], "files": len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="Directory made by engine-source.py --platform linux")
    parser.add_argument("--versions", required=True)
    parser.add_argument("--output", required=True, help="NEW directory, e.g. <inputs>/linux-build-input")
    args = parser.parse_args()
    try:
        print(json.dumps({"success": True, **pack(args.source, args.versions, args.output)}))
        return 0
    except (ops.OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
