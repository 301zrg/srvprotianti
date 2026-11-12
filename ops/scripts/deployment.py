#!/usr/bin/env python3
"""Read-only deployment contracts and artifact locks; never start or publish services."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
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
    "artifact-lock": {"artifactLockVerified": True, "desktopBuildSourceVerified": True},
    "installation-inputs": {"privateInputsVerified": True, "layoutAndPermissionsVerified": True,
                            "maintenanceKeptUntilAuthorization": True},
    "pg17": {"postgresMajor": 17, "tables": 20, "runtimeDdlDenied": True, "typeOrmDmlVerified": True},
    "native-engine": {"nativeCompilationVerified": True, "nativeStartupVerified": True, "productionRulesCompared": True},
    "transport": {"nativeFullDuel": True, "wssFullDuel": True, "invalidOrigin403": True, "playerIpVerified": True},
    "tt-recordings": {"completedGames": 3, "sideDeckVerified": True, "settledOnce": True,
                      "registrationVerified": True, "wrongPasswordRejected": True, "reconnectObserveVerified": True,
                      "rulesAndPoolCompared": True, "recordingPlaybackVerified": True, "usageProjectionVerified": True},
    "system": {"writersAndChildrenStopped": True, "rebootVerified": True},
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
    ops.require(profile["webResourceRevision"] == "1103-201103-v2" and
                re.fullmatch(r"706-\d{8}(?:-\d+)?", profile["replayRevision"]),
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
        records[name] = {"head": head, "dirty": bool(dirty), "reviewBaselineExact": exact}
    return records


def verify_files(root, rows):
    for row in rows:
        relative = ops.safe_relative(row["path"])
        filename = ops.resolve_source(Path(root).joinpath(*relative.parts))
        ops.require(filename.is_file() and ops.digest(filename) == row["sha256"], "Artifact fingerprint mismatch: " + row["path"])
        if "bytes" in row:
            ops.require(filename.stat().st_size == row["bytes"], "Artifact size mismatch: " + row["path"])


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


def replay_check(root, selected):
    root = ops.resolve_source(root)
    base = ops.read_json(root / "706-v1/profile.json")
    ops.require(base["revision"] == "706-v1", "Replay base revision mismatch")
    verify_files(root / "706-v1", [{"path": name, **row} for name, row in base["files"].items()])
    ops.require({p.name for p in (root / "706-v1").iterdir()} <= set(base["files"]) | {"profile.json", "engine.json"},
                "Unlisted replay base file")
    revisions = root / "revisions"
    index = ops.read_json(revisions / "index.json")
    rows = index["environments"]
    ops.require(index["format"] == 1 and index["base"] == base["revision"] and isinstance(rows, list) and rows,
                "Invalid replay environment index")
    ids, previous = set(), None
    for position, row in enumerate(rows):
        name, boundary = row["id"], row["effectiveFromUnix"]
        ops.require(re.fullmatch(r"706-\d{8}(?:-\d+)?", name) and name not in ids and
                    ((position == 0 and boundary is None) or
                     (position > 0 and type(boundary) is int and boundary > 0 and
                      (previous is None or boundary > previous))), "Invalid replay environment boundary/id")
        ids.add(name)
        previous = boundary
        folder = revisions / name
        verify_files(folder, [{"path": "profile.json", "sha256": row["profileSha256"]}])
        item = ops.read_json(folder / "profile.json")
        ops.require(item["format"] == 1 and item["id"] == name and item["effectiveFromUnix"] == boundary and
                    item["base"]["revision"] == base["revision"] and
                    item["base"]["scriptsDataSha256"] == base["files"]["scripts.data"]["sha256"] and
                    item["core"] == base["core"] and item["cardsDataSha256"] == base["files"]["cards.data"]["sha256"],
                    "Replay environment does not match its base")
        verify_files(folder, [{"path": "delta.data", **item["delta"]}])
        ops.require({p.name for p in folder.iterdir()} == {"profile.json", "delta.data"}, "Unlisted replay environment file")
    ops.require(selected in ids and rows[-1]["id"] == selected, "Selected replay revision is not the bundled latest environment")
    ops.require({p.name for p in revisions.iterdir()} == ids | {"index.json"}, "Unlisted replay environment")
    return {"ruleEnvironmentsVerified": len(ids), "latestRuleEnvironment": selected,
            "replayPlaybackProven": False}


def environment_check(environment, revision, source=None):
    environment = ops.resolve_source(environment)
    manifest = ops.read_json(environment / "manifest.json")
    if source is not None:
        ops.require(ops.digest(environment / "manifest.json") == ops.digest(Path(source) / "manifest.json"),
                    "Environment differs from the selected source snapshot")
    ops.require(manifest["revision"] == revision and manifest["cardCount"] == 5267 and
                manifest["banlistProtocolHash"] == "0x73ec4051" and
                ops.digest(environment / "lflist.conf") == manifest["banlistSha256"], "Environment/banlist mismatch")
    pool = None
    for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR"):
        record = manifest["locales"][locale]
        database = environment / locale / "cards.cdb"
        verify_files(environment, [{"path": locale + "/cards.cdb", "sha256": record["cardsSha256"]},
                                   {"path": locale + "/strings.conf", "sha256": record["stringsSha256"]}])
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            ops.require(db.execute("PRAGMA quick_check").fetchall() == [("ok",)], "Invalid environment SQLite")
            ids = [row[0] for row in db.execute("SELECT id FROM datas ORDER BY id")]
            ops.require(len(ids) == 5267 and len(set(ids)) == 5267 and (pool is None or ids == pool),
                        "Environment card pools differ")
            pool = ids
    return {"fourLanguageSqliteVerified": True}


def web_check(dist, public, profile, web_head, source_root=None):
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
    ops.require(info.get("basePath", "/") == "/", "Wrong page base path for this root deployment")
    for name in ("index.html", "neos-assets/sql-wasm.wasm"):
        ops.require((dist / name).is_file(), "Missing web runtime artifact: " + name)
    source_environment = Path(source_root) / "public/environment" / profile["webResourceRevision"] if source_root else None
    environment_check(dist / "environment" / profile["webResourceRevision"], profile["webResourceRevision"], source_environment)
    result = replay_check(dist / "replay", profile["replayRevision"])
    if source_root:
        source_root = Path(source_root)
        ops.require(ops.content_entries(ops.inventory(dist / "replay")) ==
                    ops.content_entries(ops.inventory(source_root / "public/replay")),
                    "Replay artifacts differ from the selected source snapshot")
        ops.require((dist / "replay/revisions/index.json").read_bytes() ==
                    (source_root / "src/replay/revisions.json").read_bytes(), "Replay index differs from the selected source")
        ops.require(ops.read_json(dist / "replay/706-v1/profile.json") ==
                    ops.read_json(source_root / "src/replay/profile.json"), "Replay base differs from the selected source")
    return {"publicInputsMatch": True, "fourLanguageSqliteVerified": True, **result}


def desktop_check(folder, profile, head, source_root=None):
    folder = ops.resolve_source(folder)
    settings = ops.read_json(folder / "srvprotianti-desktop-data/config.default.json")
    server = settings["server"]
    for name in ("gameHost", "gamePort", "apiBaseUrl"):
        ops.require(server[name] == profile["public"][name], "Desktop endpoint mismatch: " + name)
    ops.require(settings["player"]["launchName"] == "", "Player credentials are not release inputs")
    environment = folder / "srvprotianti-desktop-data/resources" / profile["webResourceRevision"]
    source_environment = Path(source_root) / "src-tauri/resources/environment" / profile["webResourceRevision"] if source_root else None
    environment_check(environment, profile["webResourceRevision"], source_environment)
    resource_files = {"manifest.json", "lflist.conf"} | {
        locale + "/" + name for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR") for name in ("cards.cdb", "strings.conf")}
    expected = {"srvprotianti-desktop.exe", "srvprotianti-desktop-data/config.default.json",
                "srvprotianti-desktop-data/licenses/exceljs-LICENSE.txt"} | {
                    "srvprotianti-desktop-data/resources/" + profile["webResourceRevision"] + "/" + name for name in resource_files}
    ops.require({row["path"] for row in ops.inventory(folder)} == expected,
                "Desktop package contains missing, unexpected or player files")
    ops.windows_pe_kind(folder / "srvprotianti-desktop.exe")
    # The current portable package has no per-EXE build/source attestation. Bind its
    # exact bytes in the lock, but leave CI/source provenance as a separate gate.
    return {"controlledDefaultsVerified": True, "existingUserSettingsRead": False,
            "declaredSourceCommit": head, "desktopBuildSourceVerified": False}


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
    ops.require(postgres.get("synchronize") is not True, "Postgres synchronize must remain false")
    connection = dict(postgres.get("connection", {})) if postgres.get("enabled") else config["modules"].get("mysql", {})
    if postgres.get("enabled"):
        mapping = postgres.get("environment", {name: "SRVPRO_LADDER_PG_" + name.upper() for name in ("host", "port", "database", "username", "password")})
        for field, variable in mapping.items():
            if env.get(variable): connection[field] = env[variable]
    else:
        ops.require(connection.get("enabled") is True and connection.get("type") == "postgres", "Main PostgreSQL connection must be enabled")
    ops.require(connection.get("database") and connection.get("username") == profile["runtimeRole"], "Runtime database/role mismatch")
    def may_stop(user):
        permissions = user.get("permissions", {})
        if isinstance(permissions, str): permissions = admin.get("permission_examples", {}).get(permissions, {})
        return user.get("enabled", True) and user.get("password") and permissions.get("stop") is True
    ops.require(any(may_stop(user) for user in admin["users"].values()), "No enabled stop-permission management account")
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
    ops.require(args.target in {"windows", "linux"}, "Unsupported deployment platform")
    engine_result = engine.verify(args.engine, args.versions, args.target)
    ops.require(engine_result["baseLuaCommitVerified"], "Reassemble the runtime from verified base Lua before locking")
    catalog = ops.catalog_check(args.catalog, args.versions)
    archive = release_manifest(args.archive)
    ops.require(archive["gitHead"] == sources["srvprotianti"]["head"] and
                bool(archive["dirtyWorkingTree"]) == sources["srvprotianti"]["dirty"], "Server archive source differs from the source lock")
    ops.require(ops.digest(Path(args.engine) / "lflist.conf") == profile["rules"]["banlistSha256"], "Engine banlist differs from the reviewed rules")
    current = versions["engine"]["scriptEnvironment"]
    ops.require(profile["replayRevision"] == current["id"], "Replay revision differs from the reviewed current environment")
    web_result = web_check(args.web_dist, profile["public"], profile, sources["srvprotiantiweb"]["head"], args.web)
    replay_latest = ops.read_json(Path(args.web_dist) / "replay/revisions" / current["id"] / "profile.json")
    ops.require(replay_latest["luaTreeSha256"] == current["luaTreeSha256"] and
                replay_latest["cardsDataSha256"] == current["cards"]["cardReaderSha256"] and
                replay_latest["core"] == versions["engine"]["coreHead"] and
                all(replay_latest["specials"][key] == versions["engine"]["scriptSourceCommit"][key]
                    for key in ("commit", "tree706")),
                "Replay resources differ from the reviewed server script environment")
    desktop_result = desktop_check(args.desktop_package, profile, sources["srvprotianti-desktop"]["head"], args.desktop)
    components = {name: ops.content_entries(ops.inventory(getattr(args, key))) for name, key in
                  (("web", "web_dist"), ("desktop", "desktop_package"), ("engine", "engine"), ("catalog", "catalog"))}
    archive_components_check(archive, components)
    lock = {"format": 1, "kind": "deployment-lock", "createdAt": ops.now(), "sources": sources, "target": args.target,
            "profileSha256": ops.digest(args.profile), "versionsSha256": ops.digest(args.versions),
            "serverArchiveSha256": ops.digest(args.archive), "components": components,
            "catalogMetadataAvailable": catalog["metadataAvailable"], "fixtureOnly": args.fixture,
            "webChecks": web_result, "desktopChecks": desktop_result, "engineChecks": engine_result,
            "dirtyPublicSourcesExplicitlyReviewed": bool(dirty and args.allow_reviewed_dirty),
            "deploymentReproducible": False, "productionMigrationValidated": False}
    destination.parent.mkdir(parents=True, exist_ok=True)
    ops.write_json(destination, lock)
    return {"lockCreated": True, "deploymentReproducible": False, "fixtureOnly": args.fixture,
            "desktopBuildSourceVerified": False}


def lock_verify(args):
    lock = ops.read_json(args.lock)
    ops.require(lock["format"] == 1 and lock["kind"] == "deployment-lock" and lock.get("target") in {"windows", "linux"},
                "Invalid deployment lock")
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
    ops.require(lock.get("format") == 1 and lock.get("kind") == "deployment-lock" and
                lock.get("target") in {"windows", "linux"} and lock.get("fixtureOnly") is False,
                "A fixture lock or invalid lock cannot authorize deployment")
    sha = ops.digest(lock_path)
    stages = []
    for name, expected in STAGES.items():
        receipt = receipts.get(name)
        status = "NOT_RUN" if receipt is None else receipt.get("status", "FAIL")
        if status == "PASS":
            valid = (receipt_bound(receipt, sha) and
                     all(type(receipt.get(key)) is type(value) and receipt.get(key) == value for key, value in expected.items()))
            if name in {"pg17", "native-engine", "system", "installation-inputs"}:
                expected_os = "Ubuntu 24.04" if lock["target"] == "linux" else "Windows Server 2022"
                valid = valid and receipt.get("os") == expected_os and receipt.get("architecture") == "x86_64"
                if name == "system":
                    valid = valid and receipt.get("processManager") == ("systemd" if lock["target"] == "linux" else "PM2")
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
            sub.add_argument("--target", choices=("windows", "linux"), required=True)
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
            versions = ops.read_json(args.versions)
            ops.require(profile["replayRevision"] == versions["engine"]["scriptEnvironment"]["id"], "Replay revision mismatch")
            result = web_check(args.dist, profile["public"], profile, args.commit)
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
