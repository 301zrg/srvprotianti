#!/usr/bin/env python3
"""Read-only loopback API, PostgreSQL, capacity and joint-batch health checks."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
import urllib.request

import ops


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_checks(base):
    url = urlsplit(base)
    ops.require(url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"} and
                url.port and not url.username and not url.password and not url.query and not url.fragment,
                "Health API must be an explicit credential-free loopback HTTP endpoint")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    checks = {}
    validators = {
        "/api/ladder-config": lambda value: value.get("rankingBasis") in {"points", "wins", "diff", "winRate"},
        "/api/ladder": lambda value: type(value.get("total")) is int and isinstance(value.get("ladder"), list),
        "/api/card-catalog/status": lambda value: value.get("ok") is True and value.get("metadataAvailable") is True and
            type(value.get("cardCount")) is int and value["cardCount"] > 0 and value.get("languagesLoaded") == 4,
    }
    for endpoint, validate in validators.items():
        try:
            with opener.open(base.rstrip("/") + endpoint, timeout=5) as response:
                raw = response.read(262145)
                ops.require(len(raw) <= 262144, "Oversized health response")
                value = json.loads(raw)
                ops.require(isinstance(value, dict) and validate(value), "API contract check failed")
            checks[endpoint] = {"status": "PASS"}
        except Exception:
            checks[endpoint] = {"status": "FAIL"}
    return checks


def capacity(paths, min_free_percent):
    ops.require(paths and 0 < min_free_percent < 100, "Capacity needs explicit writable paths and a valid threshold")
    for path in paths:
        path = ops.resolve_source(path)
        usage = shutil.disk_usage(path)
        ops.require(usage.free * 100 / usage.total >= min_free_percent, "Writable volume free-space threshold failed")
    return {"status": "PASS", "checkedVolumes": len(paths), "minimumFreePercent": min_free_percent}


def backup_health(batch, max_age_hours):
    manifest = ops.verify_batch(batch)
    created = datetime.fromisoformat(manifest["createdAt"])
    ops.require(created.tzinfo is not None and max_age_hours > 0, "Invalid batch age policy")
    age = (datetime.now(timezone.utc) - created).total_seconds() / 3600
    ops.require(0 <= age <= max_age_hours, "Latest verified joint batch is stale or future-dated")
    return {"status": "PASS", "batchHashesVerified": True, "ageHours": round(age, 2),
            "restoreOrOffHostCopyProven": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--pg-bin")
    parser.add_argument("--writable", action="append", required=True)
    parser.add_argument("--min-free-percent", type=float, default=10)
    parser.add_argument("--backup-batch", required=True)
    parser.add_argument("--max-backup-age-hours", type=float, required=True, help="Operator-approved backup freshness policy")
    args = parser.parse_args()
    try:
        checks = api_checks(args.api)
        try:
            db = ops.Postgres(args.database, args.pg_bin)
            metadata = db.metadata()
            ops.require(metadata["serverVersionNum"] // 10000 == 17, "Expected PostgreSQL 17")
            ops.require(int(db.sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")) >= 20,
                        "Application tables missing")
            checks["postgres17"] = {"status": "PASS", "schemaAndRoleVerificationStillRequired": True}
        except Exception:
            checks["postgres17"] = {"status": "FAIL"}
        for name, operation in (("capacity", lambda: capacity(args.writable, args.min_free_percent)),
                                ("backup", lambda: backup_health(args.backup_batch, args.max_backup_age_hours))):
            try:
                checks[name] = operation()
            except Exception:
                checks[name] = {"status": "FAIL"}
        ready = all(value["status"] == "PASS" for value in checks.values())
        print(json.dumps({"checkedAt": ops.now(), "basicHealthPassed": ready, "checks": checks,
                          "fullGameServerValidated": False, "credentialsOrApiPayloadIncluded": False}))
        return 0 if ready else 2
    except (ops.OpsError, ValueError, OSError) as error:
        print("ERROR: invalid health input: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
