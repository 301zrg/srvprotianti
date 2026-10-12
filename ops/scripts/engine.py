#!/usr/bin/env python3
"""Prepare a new YGOPro runtime; never change an existing running directory."""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import platform
import queue
import re
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import threading

import ops


def new_destination(value):
    destination = Path(value).absolute()
    ops.require(not destination.exists() and not destination.is_symlink(), "Destination must be a NEW directory")
    ops.require(not any(p.is_symlink() for p in destination.parents), "Destination cannot have a symlink ancestor")
    return destination


def pool_check(pool, versions):
    pool = ops.resolve_source(pool)
    expected = ops.read_json(versions)["enginePoolSource"]
    ops.require(pool.is_file() and pool.stat().st_size == expected["bytes"], "Engine pool byte count mismatch")
    ops.require(ops.digest(pool) == expected["sha256"], "Engine pool SHA-256 mismatch")
    with pool.open("rb") as stream:
        ops.require(stream.read(16) == b"SQLite format 3\x00", "Engine pool is not SQLite; check Git LFS content")
    with closing(sqlite3.connect(pool.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        ops.require(db.execute("PRAGMA quick_check").fetchone() == ("ok",), "Engine pool integrity check failed")
        columns = {row[1] for row in db.execute("PRAGMA table_info(datas)")}
        ops.require({"id", "type", "alias", "atk", "def", "level", "race", "attribute"} <= columns,
                    "Engine datas schema is incomplete")
        counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("datas", "texts")}
        ops.require(all(count == expected["cardCount"] for count in counts.values()), "Engine pool card count mismatch")
        ops.require(db.execute("SELECT COUNT(*) FROM datas d LEFT JOIN texts t ON d.id=t.id WHERE t.id IS NULL")
                    .fetchone()[0] == 0, "Engine pool has missing text IDs")
    return {"bytes": pool.stat().st_size, "sha256": ops.digest(pool), "cardCount": counts["datas"]}


def pool_fetch(destination, versions):
    destination = new_destination(destination)
    source = ops.read_json(versions)["enginePoolSource"]
    repository, commit = source["repository"], source["commit"]
    ops.require(re.fullmatch(r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+(?:\.git)?", repository),
                "Engine pool repository must be a public HTTPS GitHub URL")
    ops.require(re.fullmatch(r"[0-9a-f]{40}", commit), "Engine pool commit must be an exact SHA")
    relative = ops.safe_relative(source["path"])
    ops.require(".git" not in relative.parts and relative.suffix == ".cdb", "Invalid engine pool path")
    environment = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}
    with ops.catalog_download_directory() as temporary:
        checkout = Path(temporary) / "checkout"
        checkout.mkdir()
        for args in (["init", "--quiet"], ["remote", "add", "origin", repository],
                     ["fetch", "--depth=1", "origin", commit], ["checkout", "--detach", commit],
                     ["lfs", "install", "--local"],
                     ["config", "--local", "lfs.storage", str(checkout / ".git" / "lfs")],
                     ["config", "--local", "lfs.url", repository.removesuffix(".git") + ".git/info/lfs"],
                     ["lfs", "pull", "origin", "--include=" + relative.as_posix(), "--exclude="]):
            ops.run(["git", *args], cwd=checkout, env=environment)
        pool = checkout.joinpath(*relative.parts)
        result = pool_check(pool, versions)
        destination.mkdir(parents=True, exist_ok=False)
        # A failure leaves a visibly incomplete new directory for inspection, never deletes unknown files.
        shutil.copy2(pool, destination / "cards.cdb")
        pool_check(destination / "cards.cdb", versions)
        return {**result, "commit": commit, "downloaded": True}


def executable_kind(binary, target):
    binary = ops.resolve_source(binary)
    with binary.open("rb") as stream:
        header = stream.read(64)
        if target == "linux":
            ops.require(len(header) >= 20 and header[:6] == b"\x7fELF\x02\x01" and
                        struct.unpack_from("<H", header, 18)[0] == 62, "Expected Linux x86_64 ELF")
            ops.require(os.access(binary, os.X_OK), "Linux binary lacks execute permission")
            return "ELF x86_64"
        return ops.windows_pe_kind(binary)


def lua_files(source):
    source = ops.resolve_source(source)
    ops.require(source.is_dir(), "Lua source must be a directory")
    files = []
    names = set()
    for filename in sorted(source.rglob("*.lua")):
        filename = ops.resolve_source(filename)
        ops.require(filename.is_file(), "Lua input must be a regular file")
        relative = filename.relative_to(source).as_posix()
        ops.safe_relative(relative)
        ops.require(relative.casefold() not in names and ".git" not in relative.split("/"), "Ambiguous Lua path")
        names.add(relative.casefold())
        files.append((relative, filename))
    ops.require(files, "Lua input is empty")
    return files


def merged_utility(base, special):
    base, special = base.decode("utf-8").replace("\r\n", "\n"), special.decode("utf-8").replace("\r\n", "\n")
    marker = "NULL_VALUE=-10\n"
    ops.require(base.startswith("Auxiliary={}\naux=Auxiliary\n") and marker in base and
                "function Auxiliary.PreloadUds()" in special and "Auxiliary.PreloadUds()" not in base,
                "Unsupported utility/special structure; review compatibility before merging")
    header, remainder = base.split(marker, 1)
    return (header + marker + "\n-- Generated 706 compatibility overlay; base script remains unchanged.\n" +
            special + "\nAuxiliary.PreloadUds()\n\n" + remainder).encode("utf-8")


def assemble(base, binary, pool, banlist, destination, versions, target, overlay=None):
    destination = new_destination(destination)
    base, binary, banlist = map(ops.resolve_source, (base, binary, banlist))
    ops.require(base.is_dir() and binary.is_file() and banlist.is_file(), "Missing engine inputs")
    ops.require(not destination.is_relative_to(base), "Destination cannot be inside the base input")
    profile = ops.read_json(versions)
    pool_check(pool, versions)
    executable_kind(binary, target)
    allowed_lists = profile["engine"]["banlists"]
    ops.require(ops.digest(banlist) in {entry["sha256"] for entry in allowed_lists}, "Unreviewed banlist SHA")
    scripts = lua_files(base / "script")
    _, script_head = ops.run(["git", "rev-parse", "HEAD"], cwd=base / "script")
    _, script_dirty = ops.run(["git", "status", "--porcelain"], cwd=base / "script")
    ops.require(script_head == profile["engine"]["source"]["scriptCommit"] and not script_dirty,
                "Base Lua must match the pinned clean source commit")
    ops.require({"constant.lua", "utility.lua", "procedure.lua"} <= {name for name, _ in scripts},
                "Base Lua lacks constant.lua, utility.lua or procedure.lua")
    overlays = lua_files(overlay) if overlay else []
    if overlay:
        parent = ops.resolve_source(overlay).parent
        _, head = ops.run(["git", "rev-parse", "HEAD"], cwd=parent)
        _, dirty = ops.run(["git", "status", "--porcelain", "--", Path(overlay).name], cwd=parent)
        ops.require(head.strip() == profile["engine"]["oldRulings"]["commit"] and not dirty,
                    "Old-ruling input must match the pinned clean source commit")
        ops.require("special.lua" in {name for name, _ in overlays} and "utility.lua" not in {name for name, _ in overlays},
                    "Overlay must supply special.lua; utility.lua is generated from the selected base")
        utility = merged_utility((base / "script" / "utility.lua").read_bytes(),
                                 (Path(overlay) / "special.lua").read_bytes())
    destination.mkdir(parents=True, exist_ok=False)
    runtime_binary = destination / ("ygopro.exe" if target == "windows" else "ygopro")
    shutil.copy2(binary, runtime_binary)
    for dll in sorted(binary.parent.glob("*.dll")) if target == "windows" else []:
        shutil.copy2(ops.resolve_source(dll), destination / dll.name)
    shutil.copy2(ops.resolve_source(pool), destination / "cards.cdb")
    shutil.copy2(banlist, destination / "lflist.conf")
    for subdir, items in (("script", scripts), ("specials", overlays)):
        for name, filename in items:
            target_file = destination / subdir / name
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(filename, target_file)
    if overlay:
        (destination / "specials" / "utility.lua").write_bytes(utility)
    manifest = {"format": 1, "platform": target, "capturedAt": ops.now(),
                "baseLuaCommit": script_head, "baseLuaCommitVerified": True,
                "declaredSourceProfile": profile["engine"]["source"], "pool": pool_check(destination / "cards.cdb", versions),
                "binaryCompilationProvenanceVerified": False,
                "oldRulings": profile["engine"]["oldRulings"] if overlay else None,
                "scriptSearchOrder": ["specials", "expansions/script", "script"],
                "files": ops.content_entries(ops.inventory(destination)), "realDuelValidated": False}
    ops.write_json(destination / "engine-manifest.json", manifest)
    return verify(destination, versions, target)


def verify(engine, versions, target):
    engine = ops.resolve_source(engine)
    manifest = ops.read_json(engine / "engine-manifest.json")
    expected_source = ops.read_json(versions)["engine"]["source"]
    ops.require(manifest.get("declaredSourceProfile") == expected_source, "Engine source profile differs from the selected versions")
    ops.require(manifest["format"] == 1 and manifest["platform"] == target, "Engine manifest platform mismatch")
    actual = ops.content_entries(ops.inventory(engine))
    actual = [row for row in actual if row["path"] != "engine-manifest.json"]
    ops.require(actual == manifest["files"], "Engine files changed or contain unexpected extra files")
    pool = pool_check(engine / "cards.cdb", versions)
    binary = engine / ("ygopro.exe" if target == "windows" else "ygopro")
    return {"platform": target, "engineKind": executable_kind(binary, target), "pool": pool,
            "baseLuaCommitVerified": manifest.get("baseLuaCommitVerified") is True and manifest.get("baseLuaCommit") == expected_source["scriptCommit"],
            "files": len(actual), "oldRulingsEnabled": manifest["oldRulings"] is not None,
            "realDuelValidated": False}


def smoke(engine, versions, target):
    result = verify(engine, versions, target)
    ops.require(platform.system().lower() == ("windows" if target == "windows" else "linux"),
                "Native smoke test must run on the target OS; cross-platform header checks are insufficient")
    engine = ops.resolve_source(engine)
    binary = engine / ("ygopro.exe" if target == "windows" else "ygopro")
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if target == "windows" else {}
    process = subprocess.Popen([str(binary), "0", "0", "0", "0", "F", "F", "F", "8000", "5", "1", "300", "0"],
                               cwd=engine, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kwargs)
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=15).strip()
        ops.require(line.isdigit() and 0 < int(line) <= 65535, "Engine did not report a valid ephemeral port")
        with socket.create_connection(("127.0.0.1", int(line)), timeout=5):
            pass
        result.update({"nativeStartupAndTcpValidated": True, "hostOS": platform.system(), "architecture": platform.machine()})
        return result
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("fetch-pool", "check-pool", "assemble", "verify", "smoke"):
        command = commands.add_parser(action)
        command.add_argument("--versions", required=True)
        if action == "fetch-pool":
            command.add_argument("--destination", required=True)
        elif action == "check-pool":
            command.add_argument("--pool", required=True)
        else:
            command.add_argument("--platform", choices=("linux", "windows"), required=True)
            if action == "assemble":
                for name in ("base", "binary", "pool", "banlist", "destination"):
                    command.add_argument("--" + name, required=True)
                command.add_argument("--overlay", help="Pinned clean 706 directory; omit to use base Lua only")
            else:
                command.add_argument("--engine", required=True)
        command.add_argument("--report", help="Write a NEW local report; never overwrite an existing report")
    args = parser.parse_args()
    try:
        if args.report:
            report = Path(args.report).absolute()
            ops.require(not report.exists() and not report.is_symlink(), "Report must be a new file")
            ops.require(not any(p.is_symlink() for p in report.parents), "Report cannot have a symlink ancestor")
        if args.action == "fetch-pool":
            result = pool_fetch(args.destination, args.versions)
        elif args.action == "check-pool":
            result = pool_check(args.pool, args.versions)
        elif args.action == "assemble":
            result = assemble(args.base, args.binary, args.pool, args.banlist, args.destination, args.versions, args.platform, args.overlay)
        elif args.action == "verify":
            result = verify(args.engine, args.versions, args.platform)
        else:
            result = smoke(args.engine, args.versions, args.platform)
        result = {"success": True, "action": args.action, "checkedAt": ops.now(), **result}
        if args.report:
            report.parent.mkdir(parents=True, exist_ok=True)
            with report.open("x", encoding="utf-8") as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ops.OpsError, OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError, queue.Empty) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
