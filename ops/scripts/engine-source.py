#!/usr/bin/env python3
"""Fetch pinned public build inputs into a new directory; compilation is separate."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile

import engine
import ops


MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def checked_archive(path, dependency):
    archive = engine.checked_source(path)
    ops.require(archive.is_file(), "Dependency archive must be a regular file")
    ops.require(archive.stat().st_size < MAX_ARCHIVE_BYTES, "Oversized dependency archive")
    ops.require(ops.digest(archive) == dependency["sha256"], "Dependency archive SHA mismatch")
    return archive


def download_dependency(name, dependency, archive, local_archive=None):
    ops.require(dependency["url"].startswith(("https://github.com/", "https://www.lua.org/", "https://www.sqlite.org/")),
                "Unsupported public dependency host")
    archive = engine.reject_links(archive)
    ops.require(not archive.exists(), "Dependency output must be new")
    if local_archive is not None:
        ops.require(name == "lua", "Local archive input is only supported for Lua")
        local_archive = checked_archive(local_archive, dependency)
        response = local_archive.open("rb")
    else:
        try:
            response = urllib.request.urlopen(dependency["url"], timeout=60)
        except urllib.error.URLError as error:
            recovery = " Check applied network policy or supply the identical pinned archive with --lua-archive." if name == "lua" else ""
            raise ops.OpsError(f"Dependency download failed ({name}): {error}.{recovery}") from error
    with response, archive.open("xb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            ops.require(total < MAX_ARCHIVE_BYTES, "Oversized dependency download")
            output.write(chunk)
    # Recheck the delivered bytes, including an offline input that changed during copying.
    ops.require(ops.digest(archive) == dependency["sha256"], f"Dependency SHA mismatch: {name}")
    return {"name": name, "url": dependency["url"], "sha256": dependency["sha256"],
            "bytes": total, "inputMode": "local-archive" if local_archive is not None else "https"}


def extract_archive(archive, destination):
    destination = engine.reject_links(destination)
    ops.require(not destination.exists(), "Extraction target must be new")
    names, tree = set(), {}
    def check(name, directory):
        while name.startswith("./"):
            name = name[2:]
        name = name.rstrip("/")
        if name in {"", "."}:
            ops.require(directory, "Invalid archive root file")
            return
        relative = engine.portable_relative(name)
        parts = relative.parts
        for index in range(1, len(parts) + 1):
            path = "/".join(parts[:index])
            is_directory = index < len(parts) or directory
            previous = tree.get(path.casefold())
            ops.require(previous is None or previous == (path, is_directory),
                        "Archive case collision or file/directory conflict")
            tree[path.casefold()] = (path, is_directory)
        ops.require(name.casefold() not in names, "Duplicate archive path")
        names.add(name.casefold())
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                check(member.filename, member.is_dir())
                ops.require((member.external_attr >> 16) & 0o170000 != 0o120000, "Archive symlink is forbidden")
            ops.require(sum(member.file_size for member in source.infolist()) < 512 * 1024 * 1024, "Oversized archive")
            source.extractall(destination)
    else:
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                ops.require(member.isdir() or member.isfile(), "Archive links/devices are forbidden")
                check(member.name, member.isdir())
            ops.require(sum(member.size for member in source.getmembers()) < 512 * 1024 * 1024, "Oversized archive")
            source.extractall(destination, filter="data")


def prepare(destination, versions, target, lua_archive=None):
    destination = engine.new_destination(destination)
    profile = ops.read_json(versions)["engine"]
    source = profile["source"]
    ops.require(target in {"linux", "windows"}, "Unsupported source target")
    ops.require(re.fullmatch(r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.git", source["repository"]),
                "Source must be a public HTTPS GitHub repository")
    ops.require(re.fullmatch(r"[0-9a-f]{40}", source["commit"]), "Source commit must be fixed")
    if lua_archive is not None:
        # Reject missing or altered cache input before creating a tree or fetching Git.
        lua_archive = checked_archive(lua_archive, profile["buildDependencies"]["lua"])
    destination.mkdir(parents=True, exist_ok=False)
    checkout = destination / "source"
    checkout.mkdir()
    for args in (["init", "--quiet"], ["remote", "add", "origin", source["repository"]],
                 ["fetch", "--depth=1", "origin", source["commit"]], ["checkout", "--detach", source["commit"]],
                 ["submodule", "update", "--init", "--recursive"]):
        ops.run(["git", *args], cwd=checkout)
    for name, key in (("ocgcore", "coreCommit"), ("script", "scriptCommit")):
        _, commit = ops.run(["git", "rev-parse", "HEAD"], cwd=checkout / name)
        ops.require(commit.strip() == source[key], f"Pinned {name} commit mismatch")
    dependencies = ["lua", "premake-" + target] + (["event", "sqlite", "lzma"] if target == "windows" else [])
    downloads = destination / "downloads"
    downloads.mkdir()
    archive_inputs = []
    for name in dependencies:
        dependency = profile["buildDependencies"][name]
        archive = downloads / (name + (".zip" if dependency["url"].endswith(".zip") else ".tar.gz"))
        archive_inputs.append(download_dependency(name, dependency, archive, lua_archive if name == "lua" else None))
        extracted = downloads / (name + "-extracted")
        extract_archive(archive, extracted)
        if "executable" in dependency:
            executable = extracted.joinpath(*engine.portable_relative(dependency["executable"]).parts)
            ops.require(executable.is_file(), "Premake executable is missing")
            ops.require(not (checkout / executable.name).exists(), "Premake target already exists")
            shutil.copy2(engine.checked_source(executable), checkout / executable.name)
            if target == "linux":
                (checkout / executable.name).chmod(0o755)
        else:
            origin = extracted.joinpath(*engine.portable_relative(dependency["archiveRoot"]).parts)
            target_dir = checkout.joinpath(*engine.portable_relative(dependency["directory"]).parts)
            engine.reject_links(origin)
            engine.reject_links(target_dir)
            ops.require(origin.is_dir() and not target_dir.exists(), "Invalid dependency source layout")
            shutil.copytree(origin, target_dir)
    report = {"source": source, "platform": target, "dependencies": dependencies, "checkedAt": ops.now(),
              "dependencyArchives": archive_inputs, "nativeCompilationPerformed": False,
              "productionEquivalentProven": False}
    ops.write_json(destination / "source-report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--versions", required=True)
    parser.add_argument("--platform", choices=("linux", "windows"), required=True)
    parser.add_argument("--lua-archive", help="Optional local copy of the exact pinned Lua archive; SHA verification is mandatory")
    args = parser.parse_args()
    try:
        print(prepare(args.destination, args.versions, args.platform, args.lua_archive))
        return 0
    except (ops.OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}. New output directories may contain partial files; inspect and choose a new destination.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
