#!/usr/bin/env python3
"""Read-only deployment contracts and artifact locks; never start or publish services."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import urlsplit

import engine
import ops


REQUIRED_WEB_SCRIPTS = {"build:cloudflare", "build:static", "test:public-config", "lint"}
HOST_FIELDS = {"lflist", "rule", "mode", "duel_rule", "no_check_deck", "no_shuffle_deck",
               "start_lp", "start_hand", "draw_count", "time_limit"}
MUTABLE_PLUGIN_ASSETS = {"plugins/deck_analysis/deck_analysis.json", "plugins/deck_analysis/deck_display.json",
                         "plugins/deck_analysis/deck_templates", "plugins/ladder-web/example-decks.json",
                         "plugins/ladder-web/web/example_decks"}
STAGES = {
    "artifact-lock": {"artifactLockVerified": True},
    "installation-inputs": {"privateInputsVerified": True, "layoutAndPermissionsVerified": True,
                            "maintenanceKeptUntilAuthorization": True},
    "pg17": {"postgresMajor": 17, "tables": 20, "runtimeDdlDenied": True, "typeOrmDmlVerified": True},
    "linux-engine": {"nativeCompilationVerified": True, "nativeStartupVerified": True, "productionRulesCompared": True},
    "transport": {"nativeFullDuel": True, "wssFullDuel": True, "invalidOrigin403": True, "playerIpVerified": True},
    "tt-recordings": {"completedGames": 3, "sideDeckVerified": True, "settledOnce": True,
                      "registrationVerified": True, "wrongPasswordRejected": True, "reconnectObserveVerified": True,
                      "rulesAndPoolCompared": True, "recordingPlaybackVerified": True, "usageProjectionVerified": True},
    "system": {"systemdChildrenStopped": True, "rebootVerified": True},
    "backup-security": {"restoreContentAndSequencesVerified": True, "offHostCopyVerified": True,
                        "securityReviewAccepted": True},
    "clients": {"ygoproVerified": True, "koishiProVerified": True, "desktopSettingsPreserved": True, "mobileBrowserVerified": True},
}


def public_url(value, schemes, origin=False, fixture=False):
    ops.require(isinstance(value, str) and value and value == value.strip() and
                not re.search(r"[\s\\]", value) and "?" not in value and "#" not in value,
                "Public URL is empty or ambiguous")
    url = urlsplit(value)
    ops.require(url.scheme in schemes and url.hostname and not url.username and not url.password and
                "@" not in url.netloc and "*" not in url.netloc, "Public URL has an invalid scheme/authority")
    try:
        port = url.port
    except ValueError as error:
        raise ops.OpsError("Invalid public port") from error
    ops.require(port is None or 1 <= port <= 65535, "Invalid public port")
    canonical = url.scheme + "://" + url.hostname.lower()
    if port is not None and port != {"https": 443, "wss": 443}.get(url.scheme):
        canonical += ":" + str(port)
    if origin:
        ops.require(value == canonical, "Origin must be exact, without path, slash or normalization")
    if not fixture:
        ops.require(not url.hostname.endswith((".invalid", ".test", ".example")) and
                    not any(url.hostname == domain or url.hostname.endswith("." + domain) for domain in
                            ("localhost", "example.com", "example.org", "example.net")),
                    "Replace test/example domains before a deployment lock")
    return url


def profile_check(profile, fixture=False):
    ops.require(profile["format"] == 1, "Unsupported deployment input format")
    public = profile["public"]
    public_url(public["duelWebSocketUrl"], {"wss"}, fixture=fixture)
    website = public_url(public["websiteBaseUrl"], {"https"}, fixture=fixture)
    api = public_url(public["apiBaseUrl"], {"https"}, fixture=fixture)
    origins = public["deckImportOrigins"]
    ops.require(isinstance(origins, list) and len(origins) == len(set(origins)), "Origins must be an explicit unique array")
    for origin in origins:
        public_url(origin, {"https"}, origin=True, fixture=fixture)
    ops.require(website.netloc == api.netloc, "Website/API origins differ; explicitly review a different topology first")
    ops.require(api.path == "/", "This API deployment contract requires a canonical root base URL ending in /")
    public_url(public["apiBaseUrl"].rstrip("/"), {"https"}, origin=True, fixture=fixture)
    ops.require(not origins or ("https://" + api.netloc) in origins, "Website/API is missing from the import allowlist")
    public_url(public["webClientOrigin"], {"https"}, origin=True, fixture=fixture)
    ops.require(re.fullmatch(r"[A-Za-z0-9.-]+", public["gameHost"]) and 1 <= public["gamePort"] <= 65535,
                "Invalid public game address")
    public_url("https://" + public["gameHost"], {"https"}, fixture=fixture)
    ops.require(type(public["gamePort"]) is int and
                not any(not label or label.startswith("-") or label.endswith("-") for label in public["gameHost"].split(".")),
                "Invalid public game host/port")
    ops.require(profile.get("mutablePluginAssetsReviewed") is True, "Review mutable plugin assets before installation")
    assets = profile.get("mutablePluginAssets")
    ops.require(isinstance(assets, list), "Mutable asset mapping must be an array")
    seen_assets = set()
    for row in assets:
        application_path = ops.safe_relative(row["applicationPath"])
        shared_path = ops.safe_relative(row["sharedPath"])
        ops.require(application_path.as_posix() in MUTABLE_PLUGIN_ASSETS and
                    row["applicationPath"] not in seen_assets and shared_path.parts[0] == "plugin-assets" and
                    re.fullmatch(r"[a-z0-9][a-z0-9-]*", row["backupComponent"]), "Invalid mutable plugin asset mapping")
        seen_assets.add(row["applicationPath"])
    rules = profile["rules"]
    ops.require(rules["reviewed"] is True and HOST_FIELDS <= rules["hostinfo"].keys(), "Provide reviewed HostInfo, not implicit upstream defaults")
    ops.require(type(rules["protocolVersion"]) is int and rules["protocolVersion"] > 0, "Protocol version must be explicit")
    ops.require(all(value is not None for value in rules["hostinfo"].values()), "HostInfo contains unset values")
    for name in HOST_FIELDS:
        expected_type = bool if name in {"no_check_deck", "no_shuffle_deck"} else int
        ops.require(type(rules["hostinfo"][name]) is expected_type, "Incorrect HostInfo type: " + name)
    ops.require(re.fullmatch(r"[0-9a-f]{64}", rules["banlistSha256"]), "Provide the audited full banlist SHA")
    ops.require(profile["webResourceRevision"] == "1103-201103-v1" and profile["replayRevision"] == "706-v1",
                "Unreviewed resource revision")
    return profile


def sources_check(roots, versions, candidate=False):
    records = {}
    for name, value in roots.items():
        root = ops.resolve_source(value)
        expected = versions["repositories"][name]
        _, head = ops.run(["git", "rev-parse", "HEAD"], cwd=root)
        _, dirty = ops.run(["git", "status", "--porcelain=v1"], cwd=root)
        exact = head == expected["head"]
        if not exact and candidate:
            code, _ = ops.run(["git", "merge-base", "--is-ancestor", expected["head"], head], cwd=root, allowed=(0, 1))
            ops.require(code == 0, "Wrong source lineage: " + name)
        else:
            ops.require(exact, "Source revision mismatch: " + name)
        package = ops.read_json(root / "package.json")
        scripts = package.get("scripts", {})
        if name == "srvprotiantiweb":
            ops.require(REQUIRED_WEB_SCRIPTS <= scripts.keys(), "Wrong web branch: deployment scripts missing")
            for relative in ("scripts/public_operator_config.mjs", "scripts/package_test_release.py",
                             "scripts/package_bilitoy_release.py", "docs/public-deployment-config.md"):
                ops.require((root / relative).is_file(), "Missing web deployment contract: " + relative)
        elif name == "srvprotianti":
            for relative in ("maintenance-state.js", "ops/scripts/engine.py", "plugins/postgres-compat/deployment/schema.js"):
                ops.require((root / relative).is_file(), "Missing project runtime/deployment source: " + relative)
        else:
            tauri = ops.read_json(root / "src-tauri/tauri.conf.json")
            cargo = (root / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
            cargo_version = re.search(r'^version = "([^"]+)"', cargo, re.M)
            ops.require(cargo_version and package["version"] == tauri["version"] == cargo_version[1], "Desktop versions disagree")
        records[name] = {"head": head, "dirty": bool(dirty), "reviewBaselineExact": exact,
                         "requiredBranch": expected["branch"]}
    return records


def verify_files(root, rows):
    for row in rows:
        relative = ops.safe_relative(row["path"])
        filename = ops.resolve_source(Path(root).joinpath(*relative.parts))
        ops.require(filename.is_file() and ops.digest(filename) == row["sha256"], "Artifact fingerprint mismatch: " + row["path"])


def release_manifest(archive):
    archive = ops.resolve_source(archive)
    manifest = ops.read_json(ops.resolve_source(str(archive) + ".manifest.json"))
    ops.check_release(archive, manifest)
    return manifest


def archive_components_check(manifest, components):
    for name in ("engine", "catalog"):
        prefix = "components/" + name + "/"
        archived = [{"path": row["path"][len(prefix):], "size": row["size"], "sha256": row["sha256"]}
                    for row in manifest["files"] if row["path"].startswith(prefix)]
        ops.require(sorted(archived, key=lambda row: row["path"]) == sorted(components[name], key=lambda row: row["path"]),
                    "Archive differs from locked component: " + name)


def web_check(dist, public, profile, web_head, resource_pins=None, source_dirty=None):
    dist = ops.resolve_source(dist)
    content = (dist / "duel-config.js").read_text(encoding="utf-8")
    match = re.search(r"window\.__SRVPRO_DUEL_CONFIG__\s*=\s*(\{[^\n]*\})\s*;", content)
    ops.require(match is not None, "Missing emitted public operator configuration")
    config = json.loads(match[1])
    info = ops.read_json(dist / "deployment-info.json")
    for name in ("duelWebSocketUrl", "deckImportOrigins", "websiteBaseUrl"):
        metadata_config = info.get("publicConfig", info)
        ops.require(config.get(name) == public[name] == metadata_config.get(name), "Built public input mismatch: " + name)
    ops.require(info.get("sourceCommit") == web_head, "Web artifact source commit mismatch")
    if source_dirty is not None:
        ops.require(info.get("sourceDirty", info.get("workingTreeDirty")) is source_dirty, "Web build dirty-state mismatch")
    ops.require(info.get("basePath", "/") == "/", "Wrong page base path for this root deployment")
    for name in ("index.html", "neos-assets/sql-wasm.wasm"):
        ops.require((dist / name).is_file(), "Missing web runtime artifact: " + name)
    environment = dist / "environment" / profile["webResourceRevision"]
    manifest = ops.read_json(environment / "manifest.json")
    if resource_pins:
        ops.require(ops.digest(environment / "manifest.json") == resource_pins["webEnvironmentManifestSha256"],
                    "Web environment differs from the reviewed fixed snapshot")
    ops.require(manifest["revision"] == profile["webResourceRevision"] and manifest["cardCount"] == 5267,
                "Web environment revision/card count mismatch")
    ops.require(manifest["banlistProtocolHash"] == "0x73ec4051" and ops.digest(environment / "lflist.conf") == manifest["banlistSha256"], "Web banlist mismatch")
    for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR"):
        record = manifest["locales"][locale]
        database = environment / locale / "cards.cdb"
        ops.require(ops.digest(database) == record["cardsSha256"] and
                    ops.digest(environment / locale / "strings.conf") == record["stringsSha256"], "Web locale checksum mismatch")
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            ops.require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok" and
                        db.execute("SELECT count(*) FROM datas").fetchone()[0] == 5267, "Invalid web SQLite")
    replay = dist / "replay" / profile["replayRevision"]
    replay_profile = ops.read_json(replay / "profile.json")
    if resource_pins:
        sha = hashlib.sha256(json.dumps(replay_profile, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        ops.require(sha == resource_pins["replayProfileCanonicalJsonSha256"], "Replay profile differs from the reviewed source")
    ops.require(replay_profile["revision"] == profile["replayRevision"], "Replay revision mismatch")
    verify_files(replay, [{"path": name, "sha256": row["sha256"]} for name, row in replay_profile["files"].items()])
    return {"publicInputsMatch": True, "fourLanguageSqliteVerified": True, "replayFilesVerified": True}


def desktop_check(folder, profile, head, resource_pins=None, source_dirty=None):
    folder = ops.resolve_source(folder)
    info = ops.read_json(folder / "deployment-info.json")
    ops.require(info["sourceCommit"] == head and info["productionDefaults"] is True, "Desktop lacks controlled release metadata")
    if source_dirty is not None:
        ops.require(info.get("sourceDirty") is source_dirty, "Desktop build dirty-state mismatch")
    settings = ops.read_json(folder / "srvprotianti-desktop-data/config.default.json")
    server = settings["server"]
    for name in ("gameHost", "gamePort", "apiBaseUrl"):
        ops.require(server[name] == profile["public"][name], "Desktop endpoint mismatch: " + name)
    ops.require(settings["player"]["launchName"] == "", "Player credentials are not release inputs")
    ops.require(info.get("environmentRevision") == profile["webResourceRevision"], "Desktop environment revision mismatch")
    environment = folder / "srvprotianti-desktop-data/resources" / profile["webResourceRevision"]
    manifest = ops.read_json(environment / "manifest.json")
    if resource_pins:
        sha = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        ops.require(sha == resource_pins["desktopEnvironmentManifestCanonicalJsonSha256"], "Desktop environment snapshot differs from reviewed inputs")
    for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR"):
        record = manifest["locales"][locale]
        verify_files(environment, [{"path": locale + "/cards.cdb", "sha256": record["cardsSha256"]},
                                   {"path": locale + "/strings.conf", "sha256": record["stringsSha256"]}])
    ops.require(manifest["revision"] == profile["webResourceRevision"] and manifest["cardCount"] == 5267 and
                ops.digest(environment / "lflist.conf") == manifest["banlistSha256"], "Desktop environment/banlist mismatch")
    snapshot = ops.read_json(folder / "page-snapshot.json")
    snapshot_sha = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    ops.require(snapshot_sha == info.get("pageSnapshotSha256"), "Desktop snapshot provenance mismatch")
    actual = ops.content_entries(ops.inventory(folder))
    actual = [{"path": row["path"], "bytes": row["size"], "sha256": row["sha256"]}
              for row in actual if row["path"] != "deployment-info.json"]
    ops.require(sorted(actual, key=lambda row: row["path"]) == sorted(info.get("files", []), key=lambda row: row["path"]),
                "Desktop package differs from its release inventory")
    ops.windows_pe_kind(folder / "srvprotianti-desktop.exe")
    ops.require(not list(folder.rglob("config.user.json")), "Desktop package contains player settings")
    return {"controlledDefaultsVerified": True, "existingUserSettingsRead": False}


def private_check(root, profile):
    root = ops.resolve_source(root)
    config = ops.read_json(root / "config.json")
    postgres = ops.read_json(root / "postgres-compat.json")
    admin = ops.read_json(root / "admin_user.json")
    env = {}
    for line in (root / "server.env").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            name, separator, value = line.partition("=")
            ops.require(separator and name not in env, "Invalid or duplicate environment field")
            env[name] = value.strip().strip('"\'')
    ops.require(bool(config["modules"]["stop"]), "New installation must remain in maintenance")
    ops.require(config["port"] == profile["public"]["gamePort"], "Private TCP port mismatch")
    ops.require(config["version"] == profile["rules"]["protocolVersion"] and
                all(config["hostinfo"].get(name) == value for name, value in profile["rules"]["hostinfo"].items()),
                "Private rules differ from the reviewed profile")
    ops.require(postgres["enabled"] is True and postgres["synchronize"] is False, "Postgres plugin must be enabled with synchronize=false")
    for name in ("HOST", "PORT", "DATABASE", "USERNAME", "PASSWORD"):
        ops.require(bool(env.get("SRVPRO_LADDER_PG_" + name)), "Missing required PG environment field: " + name)
    ops.require(env["SRVPRO_LADDER_PG_USERNAME"] == profile["runtimeRole"], "Runtime role mismatch")
    ops.require(any(user.get("enabled", True) and user.get("password") and user.get("permissions", {}).get("stop") is True
                    for user in admin["users"].values()), "No enabled stop-permission management account")
    for name in ("deck_path", "replay_path", "log_save_path"):
        value = config["modules"]["tournament_mode"][name]
        ops.require(isinstance(value, str) and value.endswith("/"), "Writable directory must have explicit trailing slash: " + name)
    if sys.platform.startswith("linux"):
        for filename in ("config.json", "postgres-compat.json", "admin_user.json", "server.env"):
            ops.require((root / filename).stat().st_mode & 0o077 == 0, "Private input has group/world permissions")
    return {"privateInputsValid": True, "privateValuesIncludedInReport": False,
            "linuxModeChecked": sys.platform.startswith("linux"), "maintenanceKeptEnabled": True}


def immutable_permissions(root, uid, allowed_links=()):
    root = ops.resolve_source(root)
    for filename in (root, *root.parents, *root.rglob("*")):
        if filename.is_symlink():
            ops.require(filename in allowed_links, "Unexpected link in immutable release content")
            continue
        details = filename.stat()
        ops.require(not (details.st_uid == uid and details.st_mode & 0o200) and not details.st_mode & 0o022,
                    "Runtime can write immutable content or an ancestor directory")


def layout_check(application, runtime, catalog, shared, uid, profile):
    ops.require(sys.platform.startswith("linux"), "Installation permission checks require native Linux")
    ops.require(uid > 0, "Runtime must use a non-root UID")
    application, runtime, catalog, shared = map(ops.resolve_source, (application, runtime, catalog, shared))
    expected = {"ygopro": runtime, "plugins/card-catalog/databases": catalog,
                "config": shared / "config", "logs": shared / "logs",
                "plugins/postgres-compat/config.json": shared / "privatePluginConfigs/postgres-compat/config.json"}
    for row in profile["mutablePluginAssets"]:
        expected[row["applicationPath"]] = shared / row["sharedPath"]
    for link in application.glob("plugins/*/config.json"):
        if link.is_symlink():
            relative = link.relative_to(application).as_posix()
            expected[relative] = shared / "privatePluginConfigs" / link.parent.name / "config.json"
    for relative, target in expected.items():
        link = application / relative
        ops.require(link.is_symlink() and target.exists() and link.resolve() == target.resolve(),
                    "Installed link differs from its explicit component/shared target: " + relative)
    mutable = ("config", "replays", "logs", "deck_log", "tournament-decks", "tournament-logs")
    for relative in mutable:
        folder = ops.resolve_source(shared / relative)
        details = folder.stat()
        ops.require(folder.is_dir() and details.st_uid == uid and details.st_mode & 0o200 and
                    not details.st_mode & 0o022, "Writable directory owner/mode is wrong: " + relative)
    for row in profile["mutablePluginAssets"]:
        target = ops.resolve_source(shared / row["sharedPath"])
        for path in (target, target.parent):
            details = path.stat()
            ops.require(details.st_uid == uid and details.st_mode & 0o200 and not details.st_mode & 0o022,
                        "Mutable plugin asset or its replacement directory has wrong owner/mode")
    immutable_permissions(application, uid, {application / relative for relative in expected})
    for root in (runtime, catalog):
        immutable_permissions(root, uid)
    return {"layoutAndPermissionsVerified": True, "linuxRuntimeUidChecked": True,
            "mutablePluginAssetsMapped": len(profile["mutablePluginAssets"]), "backupMappingsRequirePlanReview": True}


def lock_create(args):
    destination = Path(args.output).absolute()
    ops.require(not destination.exists() and not destination.is_symlink(), "Lock output must be new")
    ops.require(not any(parent.is_symlink() for parent in destination.parents), "Lock output has a symlink ancestor")
    profile = profile_check(ops.read_json(args.profile), args.fixture)
    versions = ops.read_json(args.versions)
    roots = {"srvprotianti": args.server, "srvprotiantiweb": args.web, "srvprotianti-desktop": args.desktop}
    sources = sources_check(roots, versions, candidate=True)
    dirty = any(row["dirty"] for row in sources.values())
    ops.require(not dirty or args.allow_reviewed_dirty, "Commit/review public sources before locking artifacts")
    engine_result = engine.verify(args.engine, args.versions, "linux")
    ops.require(engine_result["baseLuaCommitVerified"], "Reassemble the runtime from verified base Lua before locking")
    catalog = ops.catalog_check(args.catalog, args.versions)
    archive = release_manifest(args.archive)
    ops.require(archive["gitHead"] == sources["srvprotianti"]["head"] and
                bool(archive["dirtyWorkingTree"]) == sources["srvprotianti"]["dirty"], "Server archive source differs from the source lock")
    ops.require(ops.digest(Path(args.engine) / "lflist.conf") == profile["rules"]["banlistSha256"], "Engine banlist differs from the reviewed rules")
    web_check(args.web_dist, profile["public"], profile, sources["srvprotiantiweb"]["head"], versions["frontendResources"], sources["srvprotiantiweb"]["dirty"])
    desktop_check(args.desktop_package, profile, sources["srvprotianti-desktop"]["head"], versions["frontendResources"], sources["srvprotianti-desktop"]["dirty"])
    components = {name: ops.content_entries(ops.inventory(getattr(args, key))) for name, key in
                  (("web", "web_dist"), ("desktop", "desktop_package"), ("engine", "engine"), ("catalog", "catalog"))}
    archive_components_check(archive, components)
    lock = {"format": 1, "kind": "deployment-lock", "createdAt": ops.now(), "sources": sources,
            "profileSha256": ops.digest(args.profile), "versionsSha256": ops.digest(args.versions),
            "serverArchiveSha256": ops.digest(args.archive), "components": components,
            "catalogMetadataAvailable": catalog["metadataAvailable"], "fixtureOnly": args.fixture,
            "dirtyPublicSourcesExplicitlyReviewed": bool(dirty and args.allow_reviewed_dirty),
            "deploymentReproducible": False, "productionMigrationValidated": False}
    destination.parent.mkdir(parents=True, exist_ok=True)
    ops.write_json(destination, lock)
    return {"lockCreated": True, "deploymentReproducible": False, "fixtureOnly": args.fixture}


def lock_verify(args):
    lock = ops.read_json(args.lock)
    ops.require(lock["format"] == 1 and lock["kind"] == "deployment-lock", "Invalid deployment lock")
    ops.require(ops.digest(args.profile) == lock["profileSha256"] and ops.digest(args.versions) == lock["versionsSha256"] and
                ops.digest(args.archive) == lock["serverArchiveSha256"], "Locked input/archive changed")
    profile_check(ops.read_json(args.profile), lock["fixtureOnly"])
    archive_components_check(release_manifest(args.archive), lock["components"])
    for name, key in (("web", "web_dist"), ("desktop", "desktop_package"), ("engine", "engine"), ("catalog", "catalog")):
        actual = ops.content_entries(ops.inventory(getattr(args, key)))
        ops.require(actual == lock["components"][name], "Mixed or changed deployment component: " + name)
    return {"artifactLockVerified": True, "fixtureOnly": lock["fixtureOnly"], "deploymentReproducible": False}


def receipt_bound(receipt, sha):
    try:
        checked = datetime.fromisoformat(receipt["checkedAt"])
        return (receipt.get("status") == "PASS" and receipt.get("lockSha256") == sha and
                isinstance(receipt.get("operator"), str) and bool(receipt["operator"].strip()) and
                isinstance(receipt.get("evidence"), list) and bool(receipt["evidence"]) and
                all(isinstance(item, str) and item.strip() for item in receipt["evidence"]) and
                receipt.get("syntheticResultUsedAsRealDuel") is False and checked.tzinfo is not None and
                checked <= datetime.now(timezone.utc))
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def gate(lock_path, receipts_path, migration=False):
    lock = ops.read_json(lock_path)
    receipts = ops.read_json(receipts_path)
    ops.require(lock.get("kind") == "deployment-lock" and not lock.get("fixtureOnly"), "A fixture lock cannot authorize deployment")
    sha = ops.digest(lock_path)
    stages = []
    for name, expected in STAGES.items():
        receipt = receipts.get(name)
        status = "NOT_RUN" if receipt is None else receipt.get("status", "FAIL")
        if status == "PASS":
            valid = (receipt_bound(receipt, sha) and
                     all(type(receipt.get(key)) is type(value) and receipt.get(key) == value for key, value in expected.items()))
            if name in {"pg17", "linux-engine", "system", "installation-inputs"}:
                valid = valid and receipt.get("os") == "Ubuntu 24.04" and receipt.get("architecture") == "x86_64"
            status = "PASS" if valid else "FAIL"
        ops.require(status in {"PASS", "FAIL", "NOT_RUN", "BLOCKED"}, "Unknown gate status")
        stages.append({"stage": name, "status": status})
    passed = all(stage["status"] == "PASS" for stage in stages)
    migration_passed = bool(passed and receipt_bound(receipts.get("migration", {}), sha) and
                            all(receipts.get("migration", {}).get(key) is True for key in
                                ("privateRestoreVerified", "cutoverAndNoDoubleWriteVerified", "rollbackVerified")))
    return {"stages": stages, "deploymentReproducible": passed,
            "productionMigrationValidated": migration_passed, "gatePassed": migration_passed if migration else passed,
            "receiptEvidenceAuthenticityAutomaticallyProven": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    source = commands.add_parser("sources")
    for name in ("server", "web", "desktop", "versions"):
        source.add_argument("--" + name, required=True)
    source.add_argument("--candidate", action="store_true", help="Allow reviewed-baseline descendants; never claims deployment compatibility")
    inputs = commands.add_parser("inputs")
    inputs.add_argument("--profile", required=True)
    inputs.add_argument("--private-directory", help="Operator explicitly supplies private inputs; reports contain no values")
    inputs.add_argument("--fixture", action="store_true")
    layout = commands.add_parser("layout")
    for name in ("application", "engine", "catalog", "shared"):
        layout.add_argument("--" + name, required=True)
    layout.add_argument("--runtime-uid", type=int, required=True)
    layout.add_argument("--profile", required=True)
    web_artifact = commands.add_parser("web-artifact")
    for name in ("dist", "profile", "versions", "commit"):
        web_artifact.add_argument("--" + name, required=True)
    web_artifact.add_argument("--fixture", action="store_true")
    for command in ("lock", "verify-lock"):
        sub = commands.add_parser(command)
        for name in ("profile", "versions", "archive", "web-dist", "desktop-package", "engine", "catalog"):
            sub.add_argument("--" + name, required=True)
        if command == "lock":
            for name in ("server", "web", "desktop", "output"):
                sub.add_argument("--" + name, required=True)
            sub.add_argument("--fixture", action="store_true")
            sub.add_argument("--allow-reviewed-dirty", action="store_true", help="Only after reviewing public generated/source diff; records dirty status")
        else:
            sub.add_argument("--lock", required=True)
    gates = commands.add_parser("gate")
    gates.add_argument("--lock", required=True)
    gates.add_argument("--receipts", required=True)
    gates.add_argument("--migration", action="store_true")
    for name in ("profile", "versions", "archive", "web-dist", "desktop-package", "engine", "catalog"):
        gates.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        if args.command == "sources":
            result = {"sources": sources_check({"srvprotianti": args.server, "srvprotiantiweb": args.web,
                      "srvprotianti-desktop": args.desktop}, ops.read_json(args.versions), args.candidate), "deploymentReproducible": False}
        elif args.command == "inputs":
            profile = profile_check(ops.read_json(args.profile), args.fixture)
            result = {"publicInputsValid": True, "fixtureOnly": args.fixture, "privateInputsChecked": False}
            if args.private_directory:
                result.update(private_check(args.private_directory, profile))
        elif args.command == "layout":
            profile = profile_check(ops.read_json(args.profile))
            result = layout_check(args.application, args.engine, args.catalog, args.shared, args.runtime_uid, profile)
        elif args.command == "web-artifact":
            profile = profile_check(ops.read_json(args.profile), args.fixture)
            result = web_check(args.dist, profile["public"], profile, args.commit, ops.read_json(args.versions)["frontendResources"])
        elif args.command == "lock":
            result = lock_create(args)
        elif args.command == "verify-lock":
            result = lock_verify(args)
        else:
            lock_verify(args)
            result = gate(args.lock, args.receipts, args.migration)
        print(json.dumps({"success": True, **result}, ensure_ascii=False))
        return 2 if args.command == "gate" and not result["gatePassed"] else 0
    except (ops.OpsError, OSError, KeyError, ValueError, TypeError, AttributeError, sqlite3.Error) as error:
        # Never print input values or third-party parse errors that could contain a password.
        print("ERROR: deployment check failed: " + (str(error) if isinstance(error, ops.OpsError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
