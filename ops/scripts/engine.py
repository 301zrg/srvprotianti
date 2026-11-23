#!/usr/bin/env python3
"""Prepare a new YGOPro runtime; never change an existing running directory."""

import argparse
from contextlib import closing
import hashlib
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


def reject_links(value):
    path = Path(value).absolute()
    for item in (path, *path.parents):
        try:
            details = item.lstat()
        except FileNotFoundError:
            continue
        ops.require(not item.is_symlink() and not getattr(details, "st_file_attributes", 0) & 0x400,
                    f"Symlink/reparse path is not supported: {item}")
    return path


def checked_source(value):
    return ops.resolve_source(reject_links(value))


def new_destination(value):
    destination = reject_links(value)
    destination = Path(os.path.abspath(destination))
    ops.require(not destination.exists(), "Destination must be a NEW directory")
    return destination


def portable_relative(value):
    relative = ops.safe_relative(value)
    for part in relative.parts:
        ops.require(not re.search(r'[<>:"|?*\x00-\x1f]', part) and not part.endswith((".", " ")) and not re.fullmatch(
            r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part),
            f"Nonportable path: {value}")
    return relative


def runtime_inventory(root):
    root = checked_source(root)
    for directory, directories, filenames in os.walk(root, followlinks=False):
        for name in directories + filenames:
            item = reject_links(Path(directory) / name)
            portable_relative(item.relative_to(root).as_posix())
    return ops.content_entries(ops.inventory(root))


def check_banlist(filename, profile):
    return next((entry for entry in profile["engine"]["banlists"]
                 if ops.digest(filename) == entry["sha256"] and
                 ("bytes" not in entry or filename.stat().st_size == entry["bytes"])), None)


def pool_check(pool, versions):
    pool = checked_source(pool)
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
    relative = portable_relative(source["path"])
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
    binary = checked_source(binary)
    with binary.open("rb") as stream:
        header = stream.read(64)
        if target == "linux":
            ops.require(len(header) >= 20 and header[:6] == b"\x7fELF\x02\x01" and
                        struct.unpack_from("<H", header, 18)[0] == 62, "Expected Linux x86_64 ELF")
            ops.require(os.access(binary, os.X_OK), "Linux binary lacks execute permission")
            return "ELF x86_64"
        return ops.windows_pe_kind(binary)


def lua_files(source):
    source = checked_source(source)
    ops.require(source.is_dir(), "Lua source must be a directory")
    files, names = [], set()
    for directory, directories, filenames in os.walk(source, followlinks=False):
        for name in directories + filenames:
            reject_links(Path(directory) / name)
        for name in filenames:
            if Path(name).suffix.lower() != ".lua":
                continue
            filename = checked_source(Path(directory) / name)
            ops.require(filename.is_file(), "Lua input must be a regular file")
            relative = filename.relative_to(source).as_posix()
            portable_relative(relative)
            ops.require(relative.casefold() not in names and ".git" not in relative.split("/"), "Ambiguous Lua path")
            names.add(relative.casefold())
            files.append((relative, filename))
    ops.require(files, "Lua input is empty")
    return sorted(files)


def pinned_lua(directory, commit, files, label, prefix=None):
    _, head = ops.run(["git", "rev-parse", "HEAD"], cwd=directory)
    _, dirty = ops.run(["git", "status", "--porcelain"], cwd=directory)
    ops.require(head == commit and not dirty, f"{label} must match the pinned clean source commit")
    # Git status omits ignored inputs and can hide assume-unchanged modifications.
    # Compare every copied Lua blob against the tracked index, not only the HEAD label.
    _, tracked = ops.run(["git", "ls-files", "--stage", "-z", "--", "."], cwd=directory)
    if prefix is not None:
        _, actual_prefix = ops.run(["git", "rev-parse", "--show-prefix"], cwd=directory)
        ops.require(actual_prefix == prefix, f"{label} must use the selected repository directory")
    expected, entries = {}, []
    for entry in tracked.split("\0"):
        if not entry:
            continue
        metadata, name = entry.split("\t", 1)
        mode, object_id, stage = metadata.split()
        if Path(name).suffix.lower() != ".lua":
            continue
        ops.require(mode in {"100644", "100755"} and stage == "0", "Unsupported Lua index entry")
        expected[name] = object_id
    ops.require(set(expected) == {name for name, _ in files}, "Lua file list differs from pinned tracked sources")
    for name, filename in files:
        data = filename.read_bytes()
        candidates = (data, data.replace(b"\r\n", b"\n"))
        blob_ids = {hashlib.sha1(b"blob " + str(len(blob)).encode("ascii") + b"\0" + blob).hexdigest()
                    for blob in candidates}
        ops.require(expected[name] in blob_ids, f"Lua bytes differ from pinned source: {name}")
        entries.append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return head, entries


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
    ops.require(target in {"linux", "windows"}, "Unsupported engine platform")
    destination = new_destination(destination)
    base, binary, banlist = map(checked_source, (base, binary, banlist))
    ops.require(base.is_dir() and binary.is_file() and banlist.is_file(), "Missing engine inputs")
    ops.require(not destination.is_relative_to(base), "Destination cannot be inside the base input")
    profile = ops.read_json(versions)
    pool_check(pool, versions)
    executable_kind(binary, target)
    ops.require(check_banlist(banlist, profile), "Unreviewed banlist SHA or byte count")
    scripts = lua_files(base / "script")
    script_head, base_inputs = pinned_lua(base / "script", profile["engine"]["source"]["scriptCommit"], scripts, "Base Lua", "")
    ops.require({"constant.lua", "utility.lua", "procedure.lua"} <= {name for name, _ in scripts},
                "Base Lua lacks constant.lua, utility.lua or procedure.lua")
    overlays = lua_files(overlay) if overlay else []
    overlay_inputs = []
    if overlay:
        overlay = checked_source(overlay)
        directory = profile["engine"]["oldRulings"].get("directory", "706")
        _, overlay_inputs = pinned_lua(overlay, profile["engine"]["oldRulings"]["commit"], overlays,
                                       "Old-ruling input", portable_relative(directory).as_posix() + "/")
        ops.require(profile["engine"]["oldRulings"].get("runtimeDirectory", "specials") == "specials",
                    "Unsupported old-ruling runtime directory")
        ops.require("special.lua" in {name for name, _ in overlays} and "utility.lua" not in {name for name, _ in overlays},
                    "Overlay must supply special.lua; utility.lua is generated from the selected base")
        utility = merged_utility((base / "script" / "utility.lua").read_bytes(),
                                 (Path(overlay) / "special.lua").read_bytes())
    lua_inputs = [{**entry, "path": prefix + "/" + entry["path"]}
                  for prefix, items in (("script", base_inputs), ("specials", overlay_inputs)) for entry in items]
    destination.mkdir(parents=True, exist_ok=False)
    runtime_binary = destination / ("ygopro.exe" if target == "windows" else "ygopro")
    shutil.copy2(binary, runtime_binary)
    for dll in sorted(binary.parent.glob("*.dll")) if target == "windows" else []:
        shutil.copy2(checked_source(dll), destination / dll.name)
    shutil.copy2(checked_source(pool), destination / "cards.cdb")
    shutil.copy2(banlist, destination / "lflist.conf")
    for subdir, items in (("script", scripts), ("specials", overlays)):
        for name, filename in items:
            target_file = destination / subdir / name
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(filename, target_file)
    if overlay:
        (destination / "specials" / "utility.lua").write_bytes(utility)
    manifest = {"format": 2, "platform": target, "capturedAt": ops.now(),
                "baseLuaCommit": script_head, "baseLuaCommitVerified": True,
                "declaredSourceProfile": profile["engine"]["source"], "pool": pool_check(destination / "cards.cdb", versions),
                "binaryCompilationProvenanceVerified": False,
                "runtimeStatus": "upstream-base-candidate", "productionEquivalentProven": False,
                "sourceLuaFiles": lua_inputs,
                "oldRulings": profile["engine"]["oldRulings"] if overlay else None,
                "scriptSearchOrder": ["specials", "expansions/script", "script"],
                "files": runtime_inventory(destination), "realDuelValidated": False}
    ops.write_json(destination / "engine-manifest.json", manifest)
    return verify(destination, versions, target)


def verify(engine, versions, target):
    ops.require(target in {"linux", "windows"}, "Unsupported engine platform")
    engine = checked_source(engine)
    manifest = ops.read_json(checked_source(engine / "engine-manifest.json"))
    profile = ops.read_json(versions)
    expected_source = profile["engine"]["source"]
    ops.require(manifest.get("declaredSourceProfile") == expected_source, "Engine source profile differs from the selected versions")
    ops.require(manifest["format"] == 2 and manifest["platform"] == target, "Engine manifest platform mismatch")
    ops.require(manifest.get("baseLuaCommitVerified") is True and
                manifest.get("baseLuaCommit") == expected_source["scriptCommit"], "Base Lua source is not verified")
    ops.require(manifest.get("binaryCompilationProvenanceVerified") is False and
                manifest.get("realDuelValidated") is False, "Unsupported engine validation claim")
    ops.require(manifest.get("runtimeStatus") == "upstream-base-candidate" and
                manifest.get("productionEquivalentProven") is False, "Engine is only an upstream-base candidate")
    ops.require(manifest.get("scriptSearchOrder") == ["specials", "expansions/script", "script"],
                "Engine script search order mismatch")
    actual = [row for row in runtime_inventory(engine) if row["path"] != "engine-manifest.json"]
    # Order-independent: the manifest may have been written on the other platform.
    ops.require(ops.same_content(actual, manifest["files"]), "Engine files changed or contain unexpected extra files")
    paths = {row["path"]: row for row in actual}
    ops.require({"script/constant.lua", "script/utility.lua", "script/procedure.lua"} <= paths.keys(),
                "Engine lacks essential base scripts")
    lua_inputs = manifest.get("sourceLuaFiles")
    ops.require(isinstance(lua_inputs, list) and lua_inputs, "Engine source Lua list is missing")
    ops.require(len({row["path"] for row in lua_inputs}) == len(lua_inputs) and
                all(paths.get(row["path"]) == row for row in lua_inputs), "Engine source Lua files changed")
    old = manifest.get("oldRulings")
    if old is not None:
        ops.require(old == profile["engine"]["oldRulings"], "Old-ruling policy differs from selected versions")
        ops.require({"specials/special.lua", "specials/utility.lua"} <= paths.keys(), "Old-ruling helpers are missing")
        generated = merged_utility((engine / "script/utility.lua").read_bytes(),
                                  (engine / "specials/special.lua").read_bytes())
        ops.require((engine / "specials/utility.lua").read_bytes() == generated, "Old-ruling utility differs from its inputs")
    else:
        ops.require(profile["engine"].get("oldRulings", {}).get("optional") is not False,
                    "Selected versions require old-ruling scripts")
        ops.require(not any(name.startswith("specials/") for name in paths), "Unexpected old-ruling files")
    expected_lua = {row["path"] for row in lua_inputs}
    if old is not None:
        expected_lua.add("specials/utility.lua")
    ops.require({name for name in paths if name.lower().endswith(".lua")} == expected_lua,
                "Engine Lua file list differs from source inputs")
    ops.require(check_banlist(engine / "lflist.conf", profile), "Unreviewed banlist SHA or byte count")
    pool = pool_check(engine / "cards.cdb", versions)
    ops.require(manifest["pool"] == pool, "Engine manifest pool metadata differs")
    binary = engine / ("ygopro.exe" if target == "windows" else "ygopro")
    return {"platform": target, "engineKind": executable_kind(binary, target), "pool": pool,
            "baseLuaCommitVerified": True, "files": len(actual), "oldRulingsEnabled": old is not None,
            "runtimeStatus": "upstream-base-candidate", "productionEquivalentProven": False,
            "binaryCompilationProvenanceVerified": False, "realDuelValidated": False}


# ---------- public production layout (outsider route; see ops/docs/reproduce-scope.md) ----------
# Same layout and resource locks as the production engine component: script/ is the pinned
# upstream base, expansions/script/ holds the pinned 706 overlay plus the published combined
# utility.lua, and cards.cdb / lflist.conf match resourceFingerprints. Only the binary is
# built by the operator; Linux adds it during install stages 22/23.
PUBLIC_LAYOUT = "public-production-layout"


def lua_tree_sha256(files):
    # Line endings are normalised so a Windows checkout with autocrlf gives the same digest.
    rows = sorted(name + "\t" + hashlib.sha256(Path(filename).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
                  for name, filename in files)
    return hashlib.sha256(("\n".join(rows) + "\n").encode("utf-8")).hexdigest()


SHA256_HEX = re.compile(r"[0-9a-f]{64}")


def asset_path(value):
    relative = portable_relative(value)
    ops.require(all(part.lower() != ".git" for part in relative.parts), "Invalid asset path")
    return relative.as_posix()


def asset_profile(profile):
    source = profile["engineAssetSource"]
    pool = profile["enginePoolSource"]
    engine_locks = {}
    for row in profile["resourceFingerprints"]:
        if row.get("scope", "engine") == "engine":
            ops.require(row["path"] not in engine_locks, "Duplicate resourceFingerprints path")
            engine_locks[row["path"]] = row["sha256"]
    for value in (source["utility"]["sha256"], source["banlist"]["sha256"], pool["sha256"],
                  profile["engine"]["scriptEnvironment"]["utilitySha256"],
                  engine_locks.get("lflist.conf", ""), engine_locks.get("cards.cdb", "")):
        ops.require(isinstance(value, str) and SHA256_HEX.fullmatch(value), "Engine asset lock must be a lowercase SHA-256")
    # One lock set: the published files must be exactly the ones the installers already check.
    ops.require(source["repository"] == pool["repository"] and source["commit"] == pool["commit"] and
                source["pool"] == pool["path"], "engineAssetSource and enginePoolSource differ")
    ops.require(source["utility"]["sha256"] == profile["engine"]["scriptEnvironment"]["utilitySha256"],
                "Published utility SHA differs from the rule environment")
    ops.require(source["banlist"]["sha256"] == engine_locks["lflist.conf"] and
                pool["sha256"] == engine_locks["cards.cdb"], "Published assets differ from resourceFingerprints")
    for value in (source["pool"], source["utility"]["path"], source["banlist"]["path"]):
        asset_path(value)
    return source


def assets_check(directory, versions):
    directory = checked_source(directory)
    profile = ops.read_json(versions)
    source = asset_profile(profile)
    pool = pool_check(directory / "cards.cdb", versions)
    utility, banlist = checked_source(directory / "utility.lua"), checked_source(directory / "lflist.conf")
    ops.require(utility.is_file() and ops.digest(utility) == source["utility"]["sha256"], "utility.lua SHA mismatch")
    ops.require(banlist.is_file() and ops.digest(banlist) == source["banlist"]["sha256"] and
                banlist.stat().st_size == source["banlist"]["bytes"], "lflist.conf SHA or byte count mismatch")
    return {"pool": pool, "utilitySha256": source["utility"]["sha256"], "banlistSha256": source["banlist"]["sha256"]}


def git_blob(checkout, commit, path, required=True):
    # Read the committed bytes directly: a checkout could convert line endings.
    process = subprocess.run(["git", "cat-file", "blob", f"{commit}:{path}"], cwd=checkout,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ops.require(process.returncode == 0 or not required, f"Cannot read {path} at the pinned commit")
    return process.stdout if process.returncode == 0 else None


def assets_fetch(destination, versions):
    destination = new_destination(destination)
    profile = ops.read_json(versions)
    source = asset_profile(profile)
    repository, commit = source["repository"], source["commit"]
    ops.require(re.fullmatch(r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+(?:\.git)?", repository),
                "Asset repository must be a public HTTPS GitHub URL")
    ops.require(re.fullmatch(r"[0-9a-f]{40}", commit), "Asset commit must be an exact SHA")
    pool_path = asset_path(source["pool"])
    environment = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}
    with ops.catalog_download_directory() as temporary:
        checkout = Path(temporary) / "checkout"
        checkout.mkdir()
        for args in (["init", "--quiet"], ["config", "--local", "core.autocrlf", "false"],
                     ["config", "--local", "core.symlinks", "false"],
                     ["remote", "add", "origin", repository], ["fetch", "--depth=1", "origin", commit],
                     ["checkout", "--detach", commit], ["lfs", "install", "--local"],
                     ["config", "--local", "lfs.storage", str(checkout / ".git" / "lfs")],
                     ["config", "--local", "lfs.url", repository.removesuffix(".git") + ".git/info/lfs"],
                     ["lfs", "pull", "origin", "--include=" + pool_path, "--exclude="]):
            ops.run(["git", *args], cwd=checkout, env=environment)
        destination.mkdir(parents=True, exist_ok=False)
        # A failure leaves a visibly incomplete new directory for inspection, never deletes unknown files.
        pool_file = checked_source(checkout.joinpath(*Path(pool_path).parts))
        ops.require(pool_file.is_file(), "Pinned engine pool is not a regular file")
        shutil.copy2(pool_file, destination / "cards.cdb")
        (destination / "utility.lua").write_bytes(git_blob(checkout, commit, asset_path(source["utility"]["path"])))
        (destination / "lflist.conf").write_bytes(git_blob(checkout, commit, asset_path(source["banlist"]["path"])))
    return {**assets_check(destination, versions), "commit": commit, "downloaded": True}


def assemble_production(base, overlay, assets, destination, versions, target, binary=None):
    ops.require(target in {"linux", "windows"}, "Unsupported engine platform")
    destination = new_destination(destination)
    base, overlay, assets = map(checked_source, (base, overlay, assets))
    ops.require(base.is_dir() and overlay.is_dir() and assets.is_dir(), "Missing engine inputs")
    for item in (base, overlay, assets):
        ops.require(not destination.is_relative_to(item), "Destination cannot be inside an input directory")
    profile = ops.read_json(versions)
    layout = profile["engine"]["publicLayout"]
    assets_check(assets, versions)
    scripts = lua_files(base / "script")
    script_head, _ = pinned_lua(base / "script", profile["engine"]["source"]["scriptCommit"], scripts, "Base Lua", "")
    ops.require({"constant.lua", "utility.lua", "procedure.lua"} <= {name for name, _ in scripts},
                "Base Lua lacks constant.lua, utility.lua or procedure.lua")
    ops.require(lua_tree_sha256(scripts) == layout["scriptTreeSha256"], "Base Lua tree digest mismatch")
    overlays = lua_files(overlay)
    old = profile["engine"]["oldRulings"]
    _, _ = pinned_lua(overlay, old["commit"], overlays, "Old-ruling input", portable_relative(old.get("directory", "706")).as_posix() + "/")
    names = {name.lower() for name, _ in overlays}
    ops.require("special.lua" in names and "utility.lua" not in names,
                "Overlay must supply special.lua and must not contain utility.lua")
    ops.require(lua_tree_sha256(overlays) == layout["overlayTreeSha256"], "Old-ruling overlay digest mismatch")
    # strings.conf and LICENSE come from the pinned ygopro commit itself, not the working tree.
    source_commit = profile["engine"]["source"]["commit"]
    _, head = ops.run(["git", "rev-parse", "HEAD"], cwd=base)
    ops.require(head == source_commit, "Base source must be the pinned ygopro commit")
    strings = git_blob(base, source_commit, "strings.conf")
    license_text = git_blob(base, source_commit, "LICENSE", required=False)
    if target == "windows":
        ops.require(binary is not None, "Windows layout needs --binary (ygopro.exe built from the pinned source)")
        binary = checked_source(binary)
        executable_kind(binary, "windows")
        for item in (destination,):
            ops.require(not item.is_relative_to(binary.parent), "Destination cannot be inside the binary directory")
    else:
        ops.require(binary is None, "Linux layout carries no binary; install stages 22/23 compile and add it")
    destination.mkdir(parents=True, exist_ok=False)
    for subdir, items in (("script", scripts), ("expansions/script", overlays)):
        for name, filename in items:
            target_file = destination / subdir / name
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(filename, target_file)
    shutil.copy2(assets / "utility.lua", destination / "expansions" / "script" / "utility.lua")
    shutil.copy2(assets / "cards.cdb", destination / "cards.cdb")
    shutil.copy2(assets / "lflist.conf", destination / "lflist.conf")
    (destination / "strings.conf").write_bytes(strings)
    if license_text is not None:
        (destination / "LICENSE").write_bytes(license_text)
    if binary is not None:
        shutil.copy2(binary, destination / "ygopro.exe")
        for dll in sorted(binary.parent.iterdir()):
            if dll.suffix.lower() == ".dll" and checked_source(dll).is_file():
                shutil.copy2(dll, destination / dll.name)
    manifest = {"format": 3, "platform": target, "capturedAt": ops.now(), "runtimeStatus": PUBLIC_LAYOUT,
                "baseLuaCommit": script_head, "scriptTreeSha256": layout["scriptTreeSha256"],
                "overlayCommit": old["commit"], "overlayTreeSha256": layout["overlayTreeSha256"],
                "runtimeOverlayDirectory": "expansions/script",
                "utilitySha256": profile["engineAssetSource"]["utility"]["sha256"],
                "assetCommit": profile["engineAssetSource"]["commit"],
                "pool": pool_check(destination / "cards.cdb", versions),
                "binaryIncluded": binary is not None, "binaryCompilationProvenanceVerified": False,
                "scriptSearchOrder": ["specials", "expansions/script", "script"],
                "files": runtime_inventory(destination), "realDuelValidated": False}
    ops.write_json(destination / "engine-manifest.json", manifest)
    return verify_production(destination, versions, target)


def verify_production(engine, versions, target, installed=False):
    """Check a public production-layout engine without Git: contents are matched by digest.

    installed=True is for the Linux component after stage 23 added the compiled ygopro."""
    ops.require(target in {"linux", "windows"}, "Unsupported engine platform")
    engine = checked_source(engine)
    manifest = ops.read_json(checked_source(engine / "engine-manifest.json"))
    profile = ops.read_json(versions)
    layout = profile["engine"]["publicLayout"]
    source = asset_profile(profile)
    ops.require(isinstance(manifest, dict) and isinstance(manifest.get("files"), list) and isinstance(manifest.get("pool"), dict),
                "Malformed engine manifest")
    ops.require(manifest.get("format") == 3 and manifest.get("runtimeStatus") == PUBLIC_LAYOUT and
                manifest.get("platform") == target, "Not a public production-layout engine for this platform")
    # The manifest's own lock fields must match the selected versions, not just its file list.
    expected = {"baseLuaCommit": profile["engine"]["source"]["scriptCommit"], "scriptTreeSha256": layout["scriptTreeSha256"],
                "overlayCommit": profile["engine"]["oldRulings"]["commit"], "overlayTreeSha256": layout["overlayTreeSha256"],
                "runtimeOverlayDirectory": "expansions/script", "utilitySha256": source["utility"]["sha256"],
                "assetCommit": source["commit"], "binaryIncluded": target == "windows"}
    ops.require(all(manifest.get(key) == value for key, value in expected.items()), "Engine manifest lock fields differ from versions")
    actual = [row for row in runtime_inventory(engine) if row["path"] != "engine-manifest.json"]
    # Only the production layout is allowed: anything else (an extra .cdb, .ypk, .zip or banlist
    # under expansions/, another executable) could change what the engine loads.
    fixed = {"cards.cdb", "lflist.conf", "strings.conf", "LICENSE"}
    for row in actual:
        path = row["path"]
        lua = path.lower().endswith(".lua") and path.startswith(("script/", "expansions/script/"))
        binary_file = (target == "windows" and "/" not in path and (path == "ygopro.exe" or path.lower().endswith(".dll"))) or \
                      (target == "linux" and installed and path == "ygopro")
        ops.require(lua or path in fixed or binary_file, f"Unexpected file in the engine layout: {path}")
    extra = []
    if target == "linux" and installed:
        extra = [row for row in actual if row["path"] == "ygopro"]
        ops.require(extra, "Installed Linux engine lacks the compiled ygopro")
        executable_kind(engine / "ygopro", "linux")
    ops.require(ops.same_content([row for row in actual if row not in extra], manifest["files"]),
                "Engine files changed or contain unexpected extra files")
    scripts = lua_files(engine / "script")
    overlays = [(name, filename) for name, filename in lua_files(engine / "expansions" / "script") if name != "utility.lua"]
    ops.require(lua_tree_sha256(scripts) == layout["scriptTreeSha256"], "Base Lua tree digest mismatch")
    ops.require(lua_tree_sha256(overlays) == layout["overlayTreeSha256"], "Old-ruling overlay digest mismatch")
    ops.require({"constant.lua", "utility.lua", "procedure.lua"} <= {name for name, _ in scripts}, "Engine lacks essential base scripts")
    ops.require(any(name == "special.lua" for name, _ in overlays), "Old-ruling special.lua is missing")
    utility = engine / "expansions" / "script" / "utility.lua"
    ops.require(utility.is_file() and ops.digest(utility) == source["utility"]["sha256"], "Combined utility.lua SHA mismatch")
    for row in profile["resourceFingerprints"]:
        if row.get("scope", "engine") == "engine":
            resource = engine.joinpath(*portable_relative(row["path"]).parts)
            ops.require(resource.is_file() and ops.digest(resource) == row["sha256"], f"Resource fingerprint mismatch: {row['path']}")
    pool = pool_check(engine / "cards.cdb", versions)
    ops.require(manifest["pool"] == pool, "Engine manifest pool metadata differs")
    if target == "windows":
        executable_kind(engine / "ygopro.exe", "windows")
    return {"platform": target, "runtimeStatus": PUBLIC_LAYOUT, "files": len(actual), "pool": pool,
            "scriptTreeSha256": layout["scriptTreeSha256"], "overlayTreeSha256": layout["overlayTreeSha256"],
            "installedBinaryChecked": bool(extra) or target == "windows", "realDuelValidated": False}


def smoke(engine, versions, target, verifier=None):
    result = (verifier or verify)(engine, versions, target)
    ops.require(platform.system().lower() == ("windows" if target == "windows" else "linux"),
                "Native smoke test must run on the target OS; cross-platform header checks are insufficient")
    engine = checked_source(engine)
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
    for action in ("fetch-pool", "check-pool", "assemble", "verify", "smoke",
                   "fetch-assets", "check-assets", "assemble-production", "verify-production", "smoke-production"):
        command = commands.add_parser(action)
        command.add_argument("--versions", required=True)
        if action in ("fetch-pool", "fetch-assets"):
            command.add_argument("--destination", required=True)
        elif action == "check-pool":
            command.add_argument("--pool", required=True)
        elif action == "check-assets":
            command.add_argument("--assets", required=True)
        elif action == "assemble-production":
            command.add_argument("--platform", choices=("linux", "windows"), required=True)
            for name in ("base", "overlay", "assets", "destination"):
                command.add_argument("--" + name, required=True)
            command.add_argument("--binary", help="Windows only: ygopro.exe built from the pinned source")
        elif action in ("verify-production", "smoke-production"):
            command.add_argument("--platform", choices=("linux", "windows"), required=True)
            command.add_argument("--engine", required=True)
            if action == "verify-production":
                command.add_argument("--installed", action="store_true",
                                     help="Linux component after install stage 23 added the compiled ygopro")
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
            report = reject_links(args.report)
            ops.require(not report.exists() and not report.is_symlink(), "Report must be a new file")
            ops.require(not any(p.is_symlink() for p in report.parents), "Report cannot have a symlink ancestor")
            artifact = getattr(args, "destination", None) or getattr(args, "engine", None)
            if artifact is not None:
                artifact = Path(os.path.abspath(artifact))
                ops.require(not Path(os.path.abspath(report)).is_relative_to(artifact),
                            "Report must be outside the engine/artifact directory")
        if args.action == "fetch-pool":
            result = pool_fetch(args.destination, args.versions)
        elif args.action == "check-pool":
            result = pool_check(args.pool, args.versions)
        elif args.action == "assemble":
            result = assemble(args.base, args.binary, args.pool, args.banlist, args.destination, args.versions, args.platform, args.overlay)
        elif args.action == "verify":
            result = verify(args.engine, args.versions, args.platform)
        elif args.action == "fetch-assets":
            result = assets_fetch(args.destination, args.versions)
        elif args.action == "check-assets":
            result = assets_check(args.assets, args.versions)
        elif args.action == "assemble-production":
            result = assemble_production(args.base, args.overlay, args.assets, args.destination,
                                         args.versions, args.platform, args.binary)
        elif args.action == "verify-production":
            result = verify_production(args.engine, args.versions, args.platform, args.installed)
        elif args.action == "smoke-production":
            result = smoke(args.engine, args.versions, args.platform,
                           lambda engine, versions, target: verify_production(engine, versions, target, installed=True))
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
        print(f"ERROR: {error}. New output directories may contain partial files; inspect and choose a new destination.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
