import copy
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
        "runtimeRole": "synthetic_runtime", "webResourceRevision": "1103-201103-v1", "replayRevision": "706-v1",
        "mutablePluginAssetsReviewed": True, "mutablePluginAssets": []}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="srvpro-deployment-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

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
        lock = {"format":1, "kind":"deployment-lock", "fixtureOnly":True,
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
        dep.ops.write_json(lock_path, {"kind":"deployment-lock", "fixtureOnly":False})
        receipts_path = self.root / "receipts.json"
        dep.ops.write_json(receipts_path, {})
        self.assertFalse(dep.gate(lock_path, receipts_path)["deploymentReproducible"])
        receipts = {name:{"status":"PASS", "lockSha256":dep.ops.digest(lock_path), "operator":"unit-fixture", "checkedAt":"2026-10-12T00:00:00+00:00",
                    "evidence":["synthetic unit evidence only"], "syntheticResultUsedAsRealDuel":False,
                    "os":"Ubuntu 24.04", "architecture":"x86_64", **values} for name,values in dep.STAGES.items()}
        dep.ops.write_json(receipts_path, receipts)
        self.assertTrue(dep.gate(lock_path, receipts_path)["deploymentReproducible"])
        self.assertFalse(dep.gate(lock_path, receipts_path, migration=True)["gatePassed"])
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


if __name__ == "__main__":
    unittest.main()
