import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import deployment as dep


def profile():
    return {"format": 1, "public": {"gameHost": "game.example.invalid", "gamePort": 7911,
        "apiBaseUrl": "https://ladder.example.invalid/", "duelWebSocketUrl": "wss://duel.example.invalid/neos",
        "websiteBaseUrl": "https://ladder.example.invalid/", "webClientOrigin": "https://web.example.invalid",
        "deckImportOrigins": ["https://ladder.example.invalid"]},
        "rules": {"reviewed": True, "protocolVersion": 4962, "banlistSha256": "a" * 64,
                  "hostinfo": {name: False if name.startswith("no_") else 1 for name in dep.HOST_FIELDS}},
        "runtimeRole": "synthetic_runtime", "webResourceRevision": "1103-201103-v2", "replayRevision": "706-20261112",
        "mutablePluginAssetsReviewed": True, "mutablePluginAssets": []}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="srvpro-deployment-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_current_source_records_need_no_obsolete_branch_field(self):
        server = self.root / "server"
        server.mkdir()
        dep.ops.write_json(server / "package.json", {"scripts": {}})
        for relative in ("maintenance-state.js", "ops/scripts/engine.py", "plugins/postgres-compat/deployment/schema.js"):
            target = server / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        versions = {"repositories": {"srvprotianti": {"head": "1" * 40}}}
        with patch.object(dep.ops, "run", side_effect=lambda args, **kw: (0, "1" * 40 if "rev-parse" in args else "")):
            self.assertEqual(dep.sources_check({"srvprotianti": server}, versions)["srvprotianti"]["head"], "1" * 40)

    def test_all_rule_environments_are_checked_not_just_the_base(self):
        root = self.root / "replay"
        base = root / "706-v1"
        base.mkdir(parents=True)
        files = {}
        for name in ("scripts.data", "cards.data", "ocgcore.js", "ocgcore.wasm"):
            (base / name).write_bytes(name.encode())
            files[name] = {"bytes": len(name), "sha256": dep.ops.digest(base / name)}
        dep.ops.write_json(base / "profile.json", {"revision": "706-v1", "core": "1" * 40, "files": files})
        rows = []
        for index, name in enumerate(("706-20260907", "706-20261112")):
            folder = root / "revisions" / name
            folder.mkdir(parents=True)
            (folder / "delta.data").write_bytes(b"delta")
            p = {"format": 1, "id": name, "effectiveFromUnix": None if index == 0 else 1794432616,
                 "base": {"revision": "706-v1", "scriptsDataSha256": files["scripts.data"]["sha256"]},
                 "core": "1" * 40, "cardsDataSha256": files["cards.data"]["sha256"],
                 "delta": {"bytes": 5, "sha256": dep.ops.digest(folder / "delta.data")}}
            dep.ops.write_json(folder / "profile.json", p)
            rows.append({"id": name, "effectiveFromUnix": p["effectiveFromUnix"], "profileSha256": dep.ops.digest(folder / "profile.json")})
        dep.ops.write_json(root / "revisions/index.json", {"format": 1, "base": "706-v1", "environments": rows})
        self.assertEqual(dep.replay_check(root, "706-20261112")["ruleEnvironmentsVerified"], 2)
        (root / "revisions/706-20260907/delta.data").write_bytes(b"wrong")
        with self.assertRaisesRegex(dep.ops.OpsError, "fingerprint"):
            dep.replay_check(root, "706-20261112")

    def test_production_rejects_placeholders_and_bad_origins(self):
        self.assertEqual(dep.profile_check(profile(), fixture=True), profile())
        with self.assertRaisesRegex(dep.ops.OpsError, "test/example"):
            dep.profile_check(profile())
        for origin in ("", "https://*.site.com", "https://site.com/", "https://site.com:443", "https://user:secret@site.com"):
            with self.subTest(origin=origin):
                value = profile()
                value["public"]["deckImportOrigins"] = [origin]
                with self.assertRaises(dep.ops.OpsError):
                    dep.profile_check(value, fixture=True)

    def test_unreviewed_rules_and_wrong_resource_revision_fail(self):
        for field, value in (("reviewed", False), ("hostinfo", {}), ("protocolVersion", True)):
            data = profile()
            data["rules"][field] = value
            with self.assertRaises(dep.ops.OpsError):
                dep.profile_check(data, fixture=True)
        data = profile()
        data["replayRevision"] = "latest"
        with self.assertRaisesRegex(dep.ops.OpsError, "resource revision"):
            dep.profile_check(data, fixture=True)
        data = profile()
        data["replayRevision"] = "706-v1"
        with self.assertRaises(dep.ops.OpsError):
            dep.profile_check(data, fixture=True)
        data = profile()
        data["mutablePluginAssets"] = [{"applicationPath":"plugins/card-catalog/databases",
            "sharedPath":"plugin-assets/wrong-catalog", "backupComponent":"plugin-assets"}]
        with self.assertRaisesRegex(dep.ops.OpsError, "mutable plugin asset"):
            dep.profile_check(data, fixture=True)

    def test_wrong_source_and_missing_web_contract_fail(self):
        server, web, desktop = [self.root / name for name in ("server", "web", "desktop")]
        for folder in (server, web, desktop):
            folder.mkdir()
            dep.ops.write_json(folder / "package.json", {"scripts": {}})
        versions = {"repositories": {"srvprotiantiweb": {"head": "1" * 40, "branch": "deploy/cloudflare"}}}
        with patch.object(dep.ops, "run", return_value=(0, "2" * 40)):
            with self.assertRaisesRegex(dep.ops.OpsError, "revision mismatch"):
                dep.sources_check({"srvprotiantiweb": web}, versions)
        with patch.object(dep.ops, "run", side_effect=lambda args, **kw: (0, "1" * 40 if "rev-parse" in args else "")):
            with self.assertRaisesRegex(dep.ops.OpsError, "Wrong web branch"):
                dep.sources_check({"srvprotiantiweb": web}, versions)

    def test_actual_emitted_public_values_are_checked_before_assets(self):
        dist = self.root / "dist"
        dist.mkdir()
        data = profile()
        emitted = {key: data["public"][key] for key in ("duelWebSocketUrl", "websiteBaseUrl", "deckImportOrigins")}
        (dist / "duel-config.js").write_text("window.__SRVPRO_DUEL_CONFIG__ = " + json.dumps(emitted) + ";")
        dep.ops.write_json(dist / "deployment-info.json", {**emitted, "duelWebSocketUrl": "wss://wrong.invalid/neos", "sourceCommit": "1" * 40})
        with self.assertRaisesRegex(dep.ops.OpsError, "Built public input mismatch"):
            dep.web_check(dist, data["public"], data, "1" * 40)

    def test_private_checks_preserve_files_and_never_return_passwords(self):
        data = profile()
        config = {"version": 4962, "port": 7911, "hostinfo": data["rules"]["hostinfo"],
                  "modules": {"stop": "maintenance", "tournament_mode": {name: "/synthetic/" for name in ("deck_path", "replay_path", "log_save_path")}}}
        dep.ops.write_json(self.root / "config.json", config)
        dep.ops.write_json(self.root / "postgres-compat.json", {"enabled": True, "synchronize": False})
        dep.ops.write_json(self.root / "admin_user.json", {"users": {"test": {"password": "synthetic-secret", "permissions": {"stop": True}}}})
        (self.root / "server.env").write_text("\n".join("SRVPRO_LADDER_PG_" + key + "=" + value for key, value in
            {"HOST":"127.0.0.1", "PORT":"55433", "DATABASE":"synthetic", "USERNAME":"synthetic_runtime", "PASSWORD":"synthetic-secret"}.items()))
        for name in ("config.json", "postgres-compat.json", "admin_user.json", "server.env"):
            (self.root / name).chmod(0o600)
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        result = dep.private_check(self.root, data)
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.root.iterdir()})
        # Current installations may keep an explicit main-config PostgreSQL
        # connection, without enabling plugin environment overrides.
        config["modules"]["mysql"] = {"enabled": True, "type": "postgres", "database": "synthetic",
                                         "username": data["runtimeRole"]}
        dep.ops.write_json(self.root / "config.json", config)
        dep.ops.write_json(self.root / "postgres-compat.json", {"enabled": False, "synchronize": False})
        dep.ops.write_json(self.root / "admin_user.json", {"permission_examples": {"maintainer": {"stop": True}},
            "users": {"test": {"password": "synthetic-secret", "permissions": "maintainer"}}})
        (self.root / "server.env").write_text("NODE_ENV=production\n")
        self.assertTrue(dep.private_check(self.root, data)["privateInputsValid"])
        config["modules"]["stop"] = False
        dep.ops.write_json(self.root / "config.json", config)
        with self.assertRaisesRegex(dep.ops.OpsError, "maintenance"):
            dep.private_check(self.root, data)

    def test_changed_component_is_rejected_by_lock(self):
        data = profile()
        profile_path, versions, archive = [self.root / name for name in ("profile.json", "versions.json", "archive")]
        dep.ops.write_json(profile_path, data)
        dep.ops.write_json(versions, {})
        archive.write_bytes(b"synthetic archive")
        folders = {}
        for name in ("web", "desktop", "engine", "catalog"):
            folders[name] = self.root / name
            folders[name].mkdir()
            (folders[name] / "resource").write_text("original")
        lock = {"format":1, "kind":"deployment-lock", "fixtureOnly":True, "target":"windows",
                "profileSha256":dep.ops.digest(profile_path), "versionsSha256":dep.ops.digest(versions),
                "serverArchiveSha256":dep.ops.digest(archive),
                "components":{name:dep.ops.content_entries(dep.ops.inventory(folder)) for name,folder in folders.items()}}
        lock_path = self.root / "lock.json"
        dep.ops.write_json(lock_path, lock)
        args = SimpleNamespace(lock=lock_path, profile=profile_path, versions=versions, archive=archive,
                               web_dist=folders["web"], desktop_package=folders["desktop"], engine=folders["engine"], catalog=folders["catalog"])
        archived_files = [{**row, "path": "components/" + name + "/" + row["path"]}
                          for name in ("engine", "catalog") for row in lock["components"][name]]
        with patch.object(dep, "release_manifest", return_value={"files": archived_files}):
            self.assertTrue(dep.lock_verify(args)["artifactLockVerified"])
            (folders["engine"] / "resource").write_text("mixed revision")
            with self.assertRaisesRegex(dep.ops.OpsError, "Mixed or changed"):
                dep.lock_verify(args)

    def test_lock_uses_current_versions_without_frontend_resource_pins(self):
        data = profile()
        profile_path, versions_path, archive = [self.root / name for name in ("profile.json", "versions.json", "archive")]
        archive.write_bytes(b"synthetic archive")
        dep.ops.write_json(profile_path, data)
        versions = {"engine": {"coreHead": "d" * 40, "scriptEnvironment": {"id": data["replayRevision"], "luaTreeSha256": "a" * 64,
                    "cards": {"cardReaderSha256": "b" * 64}}, "scriptSourceCommit": {"commit": "e" * 40, "tree706": "c" * 40}}}
        dep.ops.write_json(versions_path, versions)
        folders = {name: self.root / name for name in ("web", "desktop", "engine", "catalog")}
        for folder in folders.values():
            folder.mkdir()
        (folders["engine"] / "lflist.conf").write_bytes(b"list")
        data["rules"]["banlistSha256"] = dep.ops.digest(folders["engine"] / "lflist.conf")
        dep.ops.write_json(profile_path, data)
        latest = folders["web"] / "replay/revisions" / data["replayRevision"] / "profile.json"
        latest.parent.mkdir(parents=True)
        dep.ops.write_json(latest, {"core": "d" * 40, "luaTreeSha256": "a" * 64, "cardsDataSha256": "b" * 64,
                                    "specials": {"commit": "e" * 40, "tree706": "c" * 40}})
        sources = {name: {"head": "1" * 40, "dirty": False} for name in ("srvprotianti", "srvprotiantiweb", "srvprotianti-desktop")}
        args = SimpleNamespace(output=self.root / "lock.json", profile=profile_path, versions=versions_path, archive=archive,
                               server=self.root / "server-source", web=self.root / "web-source", desktop=self.root / "desktop-source",
                               web_dist=folders["web"], desktop_package=folders["desktop"], engine=folders["engine"], catalog=folders["catalog"],
                               fixture=True, target="windows", allow_reviewed_dirty=False)
        with patch.object(dep, "sources_check", return_value=sources), \
             patch.object(dep.engine, "verify", return_value={"baseLuaCommitVerified": True, "productionEquivalentProven": False}) as verify, \
             patch.object(dep.ops, "catalog_check", return_value={"metadataAvailable": True}), \
             patch.object(dep, "release_manifest", return_value={"gitHead": "1" * 40, "dirtyWorkingTree": False}), \
             patch.object(dep, "archive_components_check"), patch.object(dep, "web_check", return_value={"ruleEnvironmentsVerified": 6}), \
             patch.object(dep, "desktop_check", return_value={"desktopBuildSourceVerified": False}):
            self.assertTrue(dep.lock_create(args)["lockCreated"])
            verify.assert_called_once_with(folders["engine"], versions_path, "windows")
        lock = dep.ops.read_json(args.output)
        self.assertEqual(lock["target"], "windows")
        self.assertFalse(lock["deploymentReproducible"])
        self.assertFalse(lock["desktopChecks"]["desktopBuildSourceVerified"])

    def test_archive_cannot_contain_a_different_engine_than_the_lock(self):
        components = {name:[{"path":"asset", "size":1, "sha256":"1"*64}] for name in ("engine", "catalog")}
        manifest = {"files":[{**row, "path":"components/" + name + "/asset"} for name in components for row in components[name]]}
        dep.archive_components_check(manifest, components)
        manifest["files"][0]["sha256"] = "2"*64
        with self.assertRaisesRegex(dep.ops.OpsError, "Archive differs"):
            dep.archive_components_check(manifest, components)

    def test_writable_immutable_root_or_ancestor_is_rejected(self):
        release = self.root / "release"
        release.mkdir()
        (release / "host.js").write_text("// immutable fixture")
        original_stat = Path.stat
        bad_path = None
        def synthetic_stat(path, *args, **kwargs):
            actual = original_stat(path, *args, **kwargs)
            return SimpleNamespace(st_mode=actual.st_mode & ~0o022, st_uid=1234 if path == bad_path else 9999)
        with patch.object(Path, "stat", synthetic_stat):
            dep.immutable_permissions(release, 1234)
            for bad_path in (release, self.root):
                with self.assertRaisesRegex(dep.ops.OpsError, "ancestor directory"):
                    dep.immutable_permissions(release, 1234)
            bad_path = None
            with patch.object(Path, "is_symlink", lambda filename: filename == release / "host.js"):
                with self.assertRaisesRegex(dep.ops.OpsError, "Unexpected link"):
                    dep.immutable_permissions(release, 1234)

    def test_gate_requires_real_bound_evidence_and_separate_migration(self):
        lock_path = self.root / "lock.json"
        dep.ops.write_json(lock_path, {"format":1, "kind":"deployment-lock", "fixtureOnly":False, "target":"linux"})
        receipts_path = self.root / "receipts.json"
        dep.ops.write_json(receipts_path, {})
        self.assertFalse(dep.gate(lock_path, receipts_path)["deploymentReproducible"])
        receipts = {name:{"status":"PASS", "lockSha256":dep.ops.digest(lock_path), "operator":"unit-fixture", "checkedAt":"2026-10-12T00:00:00+00:00",
                    "evidence":["synthetic unit evidence only"], "syntheticResultUsedAsRealDuel":False,
                    "os":"Ubuntu 24.04", "architecture":"x86_64", "processManager":"systemd", **values} for name,values in dep.STAGES.items()}
        dep.ops.write_json(receipts_path, receipts)
        self.assertTrue(dep.gate(lock_path, receipts_path)["deploymentReproducible"])
        self.assertFalse(dep.gate(lock_path, receipts_path, migration=True)["gatePassed"])
        dep.ops.write_json(lock_path, {"format":1, "kind":"deployment-lock", "fixtureOnly":False, "target":"windows"})
        for item in receipts.values():
            item["lockSha256"] = dep.ops.digest(lock_path)
        dep.ops.write_json(receipts_path, receipts)
        self.assertFalse(dep.gate(lock_path, receipts_path)["gatePassed"], "Linux evidence cannot validate Windows/PM2")
        dep.ops.write_json(lock_path, {"format":1, "kind":"deployment-lock", "fixtureOnly":False, "target":"linux"})
        for item in receipts.values():
            item["lockSha256"] = dep.ops.digest(lock_path)
        for invalid in ("2030-01-01T00:00:00+00:00", "2026-10-12"):
            self.assertFalse(dep.receipt_bound({**receipts["pg17"], "checkedAt":invalid}, dep.ops.digest(lock_path)))
        self.assertFalse(dep.receipt_bound({**receipts["pg17"], "evidence":[]}, dep.ops.digest(lock_path)))
        receipts["pg17"]["postgresMajor"] = 18
        dep.ops.write_json(receipts_path, receipts)
        self.assertFalse(dep.gate(lock_path, receipts_path)["gatePassed"])
        receipts["pg17"]["postgresMajor"] = 17
        receipts["transport"]["syntheticResultUsedAsRealDuel"] = True
        dep.ops.write_json(receipts_path, receipts)
        self.assertFalse(dep.gate(lock_path, receipts_path)["gatePassed"])
        dep.ops.write_json(lock_path, {"kind":"deployment-lock", "fixtureOnly":True})
        with self.assertRaisesRegex(dep.ops.OpsError, "fixture lock"):
            dep.gate(lock_path, receipts_path)

    def test_current_portable_desktop_needs_no_obsolete_build_files(self):
        root = self.root / "portable"
        data = root / "srvprotianti-desktop-data"
        resources = data / "resources/1103-201103-v2"
        resources.mkdir(parents=True)
        for name in ("manifest.json", "lflist.conf"):
            (resources / name).touch()
        for locale in ("zh-CN", "en-US", "ja-JP", "ko-KR"):
            (resources / locale).mkdir()
            for name in ("cards.cdb", "strings.conf"):
                (resources / locale / name).touch()
        (data / "licenses").mkdir()
        (data / "licenses/exceljs-LICENSE.txt").touch()
        (root / "srvprotianti-desktop.exe").touch()
        dep.ops.write_json(data / "config.default.json", {"server": {name: profile()["public"][name] for name in ("gameHost", "gamePort", "apiBaseUrl")}, "player": {"launchName": ""}})
        with patch.object(dep, "environment_check"), patch.object(dep.ops, "windows_pe_kind", return_value="windows-pe-x86_64"):
            result = dep.desktop_check(root, profile(), "1" * 40)
            self.assertTrue(result["controlledDefaultsVerified"])
            self.assertFalse(result["desktopBuildSourceVerified"])
            (data / "config.user.json").write_text("{}")
            with self.assertRaisesRegex(dep.ops.OpsError, "player files"):
                dep.desktop_check(root, profile(), "1" * 40)


if __name__ == "__main__":
    unittest.main()
