#!/usr/bin/env python3
"""Fetch pinned public build inputs into a new directory; compilation is separate."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

import engine
import ops


def extract_archive(archive, destination):
    ops.require(not destination.exists(), "Extraction target must be new")
    names = set()
    def check(name, directory):
        while name.startswith("./"):
            name = name[2:]
        name = name.rstrip("/")
        if name in {"", "."}:
            ops.require(directory, "Invalid archive root file")
            return
        ops.safe_relative(name)
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


def prepare(destination, versions, target):
    destination = engine.new_destination(destination)
    profile = ops.read_json(versions)["engine"]
    source = profile["source"]
    ops.require(re.fullmatch(r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.git", source["repository"]),
                "Source must be a public HTTPS GitHub repository")
    ops.require(re.fullmatch(r"[0-9a-f]{40}", source["commit"]), "Source commit must be fixed")
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
    for name in dependencies:
        dependency = profile["buildDependencies"][name]
        ops.require(dependency["url"].startswith(("https://github.com/", "https://www.lua.org/", "https://www.sqlite.org/")),
                    "Unsupported public dependency host")
        archive = downloads / (name + (".zip" if dependency["url"].endswith(".zip") else ".tar.gz"))
        with urllib.request.urlopen(dependency["url"], timeout=60) as response, archive.open("xb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                ops.require(total < 128 * 1024 * 1024, "Oversized dependency download")
                output.write(chunk)
        ops.require(ops.digest(archive) == dependency["sha256"], f"Dependency SHA mismatch: {name}")
        extracted = downloads / (name + "-extracted")
        extract_archive(archive, extracted)
        if "executable" in dependency:
            executable = extracted / dependency["executable"]
            ops.require(executable.is_file(), "Premake executable is missing")
            shutil.copy2(executable, checkout / executable.name)
            if target == "linux":
                (checkout / executable.name).chmod(0o755)
        else:
            origin = extracted / dependency["archiveRoot"]
            target_dir = checkout / dependency["directory"]
            ops.require(origin.is_dir() and not target_dir.exists(), "Invalid dependency source layout")
            shutil.copytree(origin, target_dir)
    report = {"source": source, "platform": target, "dependencies": dependencies, "checkedAt": ops.now(),
              "nativeCompilationPerformed": False, "productionEquivalentProven": False}
    ops.write_json(destination / "source-report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--versions", required=True)
    parser.add_argument("--platform", choices=("linux", "windows"), required=True)
    args = parser.parse_args()
    try:
        print(prepare(args.destination, args.versions, args.platform))
        return 0
    except (ops.OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
