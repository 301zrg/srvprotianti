#!/usr/bin/env python3
"""Finish a Windows handover directory for ops/install/windows/install.ps1.

The operator first places in --materials: server-release.tar.gz and its .manifest.json
(from `ops.py release`), install-params.json, the four installers listed in
ops/versions.json `windowsInstallers`, windows.server.config.json (route A) or the joint
batch ZIP named in the parameters (route B). This tool then, from a CLEAN checkout:
  - checks every installer's size and SHA-256 and the release archive;
  - writes ops-input.zip (`git archive` of ops/ at HEAD) and pm2-lock/ (from Git blobs);
  - writes handover-sha256.txt and prints its own SHA-256, which must reach the operator
    through a separate channel (stage 10 asks for it).
It never overwrites an existing output file.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import ops

REQUIRED = ["server-release.tar.gz", "server-release.tar.gz.manifest.json", "ops-input.zip", "install-params.json",
            "pm2-lock\\package.json", "pm2-lock\\package-lock.json"]


def git(repo, *args):
    process = subprocess.run(["git", *args], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ops.require(process.returncode == 0, f"git {args[0]} failed: {process.stderr.decode('utf-8', 'replace').strip()[:300]}")
    return process.stdout


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plain_file(materials, name):
    """A regular file directly named inside materials (no links, no traversal)."""
    path = materials.joinpath(*name.split("\\"))
    ops.require(not path.is_symlink() and path.resolve().is_relative_to(materials), f"Unsafe material path: {name}")
    return path


def build(repo, materials):
    repo = Path(repo).resolve()
    materials = Path(materials).resolve()
    ops.require(materials.is_dir(), "Materials directory does not exist")
    top = Path(git(repo, "rev-parse", "--show-toplevel").decode("utf-8").strip()).resolve()
    ops.require(top == repo, "--repo must be the repository root")
    ops.require(not git(repo, "status", "--porcelain").strip(), "Checkout has uncommitted changes; use a clean checkout")
    commit = git(repo, "rev-parse", "HEAD").decode("ascii").strip()
    versions = json.loads(git(repo, "show", "HEAD:ops/versions.json"))
    params = ops.read_json(materials / "install-params.json")
    ops.require(isinstance(params, dict), "install-params.json must be a JSON object")
    route = params.get("route")
    ops.require(route in ("A", "B"), "install-params.json route must be A or B")
    names = list(REQUIRED)
    installers = versions["windowsInstallers"]
    for item in installers:
        ops.require(re.fullmatch(r"[A-Za-z0-9._-]+", item["file"]) and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]),
                    "Invalid installer entry in versions.json")
        path = plain_file(materials, item["file"])
        ops.require(path.is_file(), f"Missing installer: {item['file']} (download from {item['url']})")
        ops.require(path.stat().st_size == item["bytes"] and sha256(path) == item["sha256"],
                    f"Installer size or SHA-256 differs from ops/versions.json: {item['file']}")
        names.append(item["file"])
    if route == "A":
        ops.require((materials / "windows.server.config.json").is_file(), "Route A needs windows.server.config.json")
        names.append("windows.server.config.json")
    else:
        batch = params.get("batch")
        batch = batch.get("zip") if isinstance(batch, dict) else None
        # Same rule as install.ps1: a plain file name directly inside the input directory.
        ops.require(isinstance(batch, str) and re.fullmatch(r"[A-Za-z0-9._-]+\.zip", batch) and plain_file(materials, batch).is_file(),
                    "Route B needs the batch ZIP named in install-params.json")
        names.append(batch)
    archive = plain_file(materials, "server-release.tar.gz")
    ops.require(archive.is_file(), "Missing server-release.tar.gz")
    release = ops.read_json(str(archive) + ".manifest.json")
    ops.check_release(archive, release)
    # The release must come from this same commit, so ops/ and the application match.
    ops.require(release.get("gitHead") == commit and release.get("dirtyWorkingTree") is False,
                "server-release.tar.gz was not built from this clean commit")
    for output in ("ops-input.zip", "pm2-lock", "handover-sha256.txt"):
        ops.require(not os.path.lexists(materials / output), f"{output} already exists; start from a fresh materials directory")
    git(repo, "archive", "--format=zip", "-o", str(materials / "ops-input.zip"), "HEAD", "ops")
    (materials / "pm2-lock").mkdir()
    for name in ("package.json", "package-lock.json"):
        (materials / "pm2-lock" / name).write_bytes(git(repo, "show", f"HEAD:ops/windows/pm2-lock/{name}"))
    lines = [f"# handover (srvprotianti {commit[:12]}, route {route}): relative path, bytes, SHA-256"]
    for name in names:
        path = plain_file(materials, name)
        lines.append(f"{name}\t{path.stat().st_size}\t{sha256(path).upper()}")
    data = ("\r\n".join(lines) + "\r\n").encode("utf-8")
    (materials / "handover-sha256.txt").write_bytes(data)
    return {"commit": commit, "route": route, "items": len(names),
            "handoverListSha256": hashlib.sha256(data).hexdigest().upper(),
            "next": "Give the operator handoverListSha256 through a separate channel; copy the directory to C:\\srvpro-input"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, help="Clean srvprotianti checkout at the release commit")
    parser.add_argument("--materials", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps({"success": True, **build(args.repo, args.materials)}))
        return 0
    except (ops.OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
