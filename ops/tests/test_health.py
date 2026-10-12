from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import health


class HealthTests(unittest.TestCase):
    def test_actual_ladder_shapes_and_all_existing_ranking_modes(self):
        for basis in ("points", "wins", "diff", "winRate"):
            responses = {"/api/ladder-config":{"rankingBasis":basis}, "/api/ladder":{"total":0,"ladder":[]},
                         "/api/card-catalog/status":{"ok":True,"metadataAvailable":True,"cardCount":14981,"languagesLoaded":4}}
            opener = SimpleNamespace(open=lambda url, **kw: io.BytesIO(json.dumps(responses[url.removeprefix("http://127.0.0.1:7922")]).encode()))
            with patch.object(health.urllib.request, "build_opener", return_value=opener):
                self.assertTrue(all(row["status"] == "PASS" for row in health.api_checks("http://127.0.0.1:7922").values()))
                responses["/api/card-catalog/status"]["metadataAvailable"] = False
                self.assertEqual(health.api_checks("http://127.0.0.1:7922")["/api/card-catalog/status"]["status"], "FAIL")

    def test_network_rejects_external_and_credential_urls_before_request(self):
        for url in ("https://server.example.org", "http://user:secret@127.0.0.1:7922", "http://127.0.0.1:7922?token=secret"):
            with self.assertRaises(health.ops.OpsError):
                health.api_checks(url)

    def test_stale_or_future_batch_does_not_count_as_recent_backup(self):
        for delta in (-3, 3):
            created = datetime.now(timezone.utc) + timedelta(days=delta)
            with patch.object(health.ops, "verify_batch", return_value={"createdAt": created.isoformat()}):
                with self.assertRaises(health.ops.OpsError):
                    health.backup_health(Path("synthetic-only"), 24)

    def test_capacity_failure_is_detected_without_writes(self):
        with tempfile.TemporaryDirectory(prefix="srvpro-health-test-") as root:
            with patch.object(health.shutil, "disk_usage", return_value=SimpleNamespace(total=100, used=95, free=5)):
                with self.assertRaises(health.ops.OpsError):
                    health.capacity([root], 10)


if __name__ == "__main__":
    unittest.main()
