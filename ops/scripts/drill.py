#!/usr/bin/env python3
"""Run fresh-schema + joint restore drills against an explicitly isolated PostgreSQL.

Only NEW srvpro_drill_* databases/ops_drill_* roles are created. No production
configuration, real recording or real account is read; no DROP/cleanup is performed.
This is a database/files exercise, not Linux engine, network or systemd acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

import ops


SEED = """
BEGIN;
SET LOCAL ROLE {runtime};
INSERT INTO ladder_user(name,"displayName",pass,"wins","losses","monthWins","monthLosses",
 "currentWinStreak","duelPoints","monthDuelPoints","monthKey","createdAt")
VALUES ('drill_alpha','演练 Alpha','synthetic-password-hash',12,3,7,1,7,1142,1098,'202610','2026-10-01'),
 ('drill_beta','演练 Beta','synthetic-password-hash',6,8,2,4,0,963,977,'202610','2026-10-02');
INSERT INTO ladder_month_record(name,"monthKey","duelPoints",wins,losses,"scoreDiff")
VALUES ('drill_alpha','202610',1098,7,1,6),('drill_beta','202610',977,2,4,-2);
INSERT INTO duel_log("time",name,"roomId","cloudReplayId","replayFileName","roomMode","duelCount")
VALUES ('2026-10-10 12:00:00','fixture-match',11,0,'中文 Case A.yrp',1,1),
 ('2026-10-10 12:05:00','fixture-missing',12,0,'not-saved.yrp',1,2),
 ('2026-10-10 12:03:00','fixture-match-g2',11,0,'fixture-g2.yrp',1,2),
 ('2026-10-10 12:07:00','fixture-match-g3',11,0,'fixture-g3.yrp',1,3);
INSERT INTO ladder_match("matchKey","roomId","monthKey","winnerName","loserName",
 "playerAName","playerBName","playerADisplayName","playerBDisplayName","duelLogId",
 "playerADuelPointsDelta","playerBDuelPointsDelta","playerADuelPointsBefore","playerBDuelPointsBefore",
 "playerADuelPointsAfter","playerBDuelPointsAfter","g1FirstPlayer","coinWinner","createTime")
VALUES ('ops-drill-match',11,'202610','drill_alpha','drill_beta','drill_alpha','drill_beta','演练 Alpha','演练 Beta',1,
 12,-12,1130,975,1142,963,'drill_beta','drill_alpha','2026-10-10 12:10:00');
UPDATE ladder_user SET "lastMatchId"=1 WHERE name IN ('drill_alpha','drill_beta');
INSERT INTO ladder_match_game("matchId","duelLogId","playerName","opponentName","winnerName",
 "duelCount","isFirst","isMain","createTime")
VALUES (1,1,'drill_alpha','drill_beta','drill_alpha',1,0,1,'2026-10-10 12:00:00'),
 (1,1,'drill_beta','drill_alpha','drill_alpha',1,1,1,'2026-10-10 12:00:00');
INSERT INTO ladder_match_game("matchId","duelLogId","playerName","opponentName","winnerName",
 "duelCount","isFirst","isMain","createTime")
VALUES (1,3,'drill_alpha','drill_beta','drill_beta',2,1,0,'2026-10-10 12:03:00'),
 (1,3,'drill_beta','drill_alpha','drill_beta',2,0,0,'2026-10-10 12:03:00'),
 (1,4,'drill_alpha','drill_beta','drill_alpha',3,0,0,'2026-10-10 12:07:00'),
 (1,4,'drill_beta','drill_alpha','drill_alpha',3,1,0,'2026-10-10 12:07:00');
INSERT INTO ladder_usage_total_sample(id,"allDecks","validCardDecks") VALUES (1,2,2);
INSERT INTO ladder_usage_total_deck("deckTypeId","deckCount") VALUES (4095,2);
INSERT INTO ladder_usage_total_card(zone,"cardId","deckCount",copies1,copies2,copies3)
VALUES ('main',12345,2,0,0,2);
INSERT INTO public.user(key,"chatColor") VALUES ('fixture-user-key','ffffff');
INSERT INTO ban(ip,name) VALUES ('192.0.2.10','synthetic-only');
COMMIT;
"""


def expected_refusal(function, message):
    try:
        function()
    except ops.OpsError:
        return True
    raise ops.OpsError("Expected refusal did not occur: " + message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-source", required=True, help="Current reviewed SRVPro source with npm dependencies installed")
    parser.add_argument("--workdir", required=True, help="New directory; evidence is kept, never recursively deleted")
    parser.add_argument("--confirm-isolated-cluster", required=True, help="Exact PGHOST:PGPORT; operator attests it is an isolated cluster")
    parser.add_argument("--suffix", required=True, help="Unique lowercase alphanumeric identifier, maximum 20 characters")
    parser.add_argument("--pg-bin", help="Directory with psql/pg_dump/pg_restore, otherwise PATH")
    arguments = parser.parse_args()
    try:
        host, port = os.environ.get("PGHOST", ""), os.environ.get("PGPORT", "")
        ops.require(host in ("127.0.0.1", "localhost", "::1") and port.isdigit(), "Explicit local PGHOST and PGPORT are required")
        ops.require(arguments.confirm_isolated_cluster == f"{host}:{port}", "Cluster confirmation does not match PGHOST:PGPORT")
        ops.require(re.fullmatch(r"[a-z0-9]{1,20}", arguments.suffix), "suffix must be 1-20 lowercase alphanumeric characters")
        source_db = "srvpro_drill_ops_" + arguments.suffix
        restore_db = source_db + "_restore"
        owner = "ops_drill_owner_" + arguments.suffix
        runtime = "ops_drill_runtime_" + arguments.suffix
        work = Path(arguments.workdir).absolute()
        ops.require(not work.exists(), "Drill work directory must be new")
        server = ops.resolve_source(arguments.server_source)
        schema_tool = server / "plugins" / "postgres-compat" / "deployment" / "schema.js"
        ops.require(schema_tool.is_file(), "Missing current deployment/schema.js")
        admin = ops.Postgres("postgres", arguments.pg_bin)
        for name in (source_db, restore_db):
            ops.require(admin.sql("SELECT count(*) FROM pg_database WHERE datname=" + ops.sql_literal(name)) == "0", "Drill database already exists: " + name)
        for name in (owner, runtime):
            ops.require(admin.sql("SELECT count(*) FROM pg_roles WHERE rolname=" + ops.sql_literal(name)) == "0", "Drill role already exists: " + name)
        identity = admin.sql("SELECT current_user")
        admin.sql("CREATE ROLE " + ops.sql_identifier(owner) + " NOLOGIN NOCREATEDB NOCREATEROLE")
        admin.sql("CREATE ROLE " + ops.sql_identifier(runtime) + " LOGIN NOCREATEDB NOCREATEROLE NOINHERIT")
        admin.sql("GRANT " + ops.sql_identifier(owner) + " TO " + ops.sql_identifier(identity))
        for name in (source_db, restore_db):
            admin.sql("CREATE DATABASE " + ops.sql_identifier(name) + " OWNER " + ops.sql_identifier(owner) + " ENCODING 'UTF8' TEMPLATE template0")
        ops.new_private_directory(work, parents=True)
        report = {"format": 1, "startedAt": ops.now(), "hostPlatform": platform.system(),
                  "clusterOperatorAttestedIsolated": True, "sourceDatabase": source_db, "restoreDatabase": restore_db,
                  "postgres": admin.metadata(), "complete": False, "linuxSystemdValidated": False,
                  "engineAndNetworkValidated": False, "fixturesAreSynthetic": True}
        ops.write_json(work / "drill-result.json", report)
        # Separate owner is used for fresh DDL, and runtime may only perform DML.
        schema_environment = admin.environment.copy()
        schema_environment["PGOPTIONS"] += " -c role=" + owner
        ops.run(["node", schema_tool, "init", "--database", source_db, "--runtime-role", runtime,
                 "--confirm-empty", source_db, "--report", work / "fresh-schema.json"], env=schema_environment)
        source = ops.Postgres(source_db, arguments.pg_bin)
        source.sql(SEED.format(runtime=ops.sql_identifier(runtime)))
        expected_refusal(lambda: source.sql("SET ROLE " + ops.sql_identifier(runtime) + "; CREATE TABLE forbidden(x int)"), "runtime DDL")
        ops.run(["node", schema_tool, "verify", "--database", source_db, "--runtime-role", runtime,
                 "--report", work / "fresh-data-verify.json"], env=admin.environment)
        source_state = source.state()
        ops.require(len([row for row in source_state["schema"] if row["kind"] == "r"]) == 20, "Fresh schema does not have all 20 current tables")
        report["freshInstall"] = {"currentSchemaCreated": True, "runtimeDmlWorks": True, "runtimeDdlDenied": True,
                                  "tables": 20, "seededContentVerified": True,
                                  "fullGameServerValidated": False}
        # Transport fixture deliberately includes raw bytes and case-sensitive Unicode
        # filenames. These are NOT real playable recordings or an engine artifact.
        app = work / "public-source"
        app.mkdir()
        (app / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
        (app / "host.js").write_text("// synthetic transport fixture\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet", str(app)], check=True)
        subprocess.run(["git", "add", "."], cwd=app, check=True)
        subprocess.run(["git", "-c", "user.name=Ops Drill", "-c", "user.email=drill@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic fixture"], cwd=app, check=True)
        engine, recordings, private = work / "engine-fixture", work / "recordings-fixture", work / "private-fixture"
        for path in (engine, recordings, private):
            path.mkdir()
        (engine / "cards.cdb").write_bytes(b"synthetic wide CDB transport fixture")
        (engine / "cards1.cdb").write_bytes(b"synthetic historic pool transport fixture")
        (recordings / "中文 Case A.yrp").write_bytes(b"synthetic\x00\xffraw recording bytes")
        for game in (2, 3):
            (recordings / ("fixture-g" + str(game) + ".yrp")).write_bytes(b"synthetic G" + str(game).encode() + b" recording bytes")
        (recordings / "orphan-history.yrp").write_bytes(b"synthetic unlinked historical bytes")
        (private / "config.json").write_text('{"syntheticSecret":"fixture-only"}', encoding="utf-8")
        archive = work / "release.tar.gz"
        ops.release(app, archive, "synthetic-drill", [("engine", engine)])
        plan = {"format": 1, "database": source_db, "runtimeRole": runtime, "isolated": True,
                "releaseArchive": str(archive), "replayComponent": "recordings", "components": [
                    {"id": "recordings", "source": str(recordings)}, {"id": "private", "source": str(private)},
                    {"id": "engine", "source": str(engine)}]}
        ops.write_json(work / "backup-plan.json", plan)
        batch = work / "backup-batch"
        manifest = ops.backup(plan, batch, source, source_db)
        transported = work / "transported-batch"
        shutil.copytree(batch, transported)
        ops.verify_batch(transported)
        ops.require(manifest["replayAssociations"]["databaseWithoutFile"] == ["not-saved.yrp"], "Missing recording fixture not represented")
        target = ops.Postgres(restore_db, arguments.pg_bin)
        restored = ops.restore(transported, work / "restored", target, restore_db, owner, runtime, schema_tool)
        ops.require(restored["complete"] and source_state == target.state(), "Joint recovery differs from source")
        report["jointRestore"] = {"dumpAndRestoreReturnedSuccess": True, "allTableContentHashesEqual": True,
                                  "syntheticG1G2G3RowsPreserved": source.sql('SELECT count(*) FROM ladder_match_game g JOIN duel_log d ON d.id=g."duelLogId" WHERE g."duelCount"=d."duelCount"') == '6',
                                  "copiedBatchVerifiedBeforeRestore": True, "offHostCopyVerified": False,
                                  "schemaAndSequencesEqual": True, "rawFileHashesEqual": True,
                                  "accountPointsHistoryAndStreaksPreserved": True,
                                  "linkedOrphanAndMissingReplayCategoriesPreserved": True,
                                  "ownerMappedRuntimePermissionsVerified": True}
        report["refusalChecks"] = {
            "nonemptyTargetRejected": expected_refusal(lambda: ops.restore(batch, work / "occupied-refused", target,
                restore_db, owner, runtime, schema_tool), "nonempty database"),
            "sourceDatabaseRejected": expected_refusal(lambda: ops.restore(batch, work / "source-refused", source,
                source_db, owner, runtime, schema_tool), "source database")}
        original = batch / "files" / "recordings" / "中文 Case A.yrp"
        original_bytes = original.read_bytes()
        original.write_bytes(b"corrupted fixture")
        report["refusalChecks"]["corruptedRecordingRejected"] = expected_refusal(lambda: ops.verify_batch(batch), "file corruption")
        original.write_bytes(original_bytes)
        ops.verify_batch(batch)
        # A post-restore runtime insertion checks sequence usability after map/grants.
        next_id = int(target.sql("SET ROLE " + ops.sql_identifier(runtime) +
                                 "; INSERT INTO ban(ip,name) VALUES ('192.0.2.20','after-restore') RETURNING id"))
        ops.require(next_id > 1, "Restored sequence reused an existing ID")
        report["jointRestore"]["newRuntimeWriteAndSequenceUsable"] = True
        report.update({"complete": True, "finishedAt": ops.now(), "sourceFilesAndDatabaseUnmodified": source.state() == source_state,
                       "cleanup": "Evidence, isolated databases and roles retained; operator may remove ONLY the listed drill resources after review"})
        ops.write_json(work / "drill-result.json", report)
        print(json.dumps({"success": True, "report": str(work / "drill-result.json"),
                          "postgresVersion": report["postgres"]["serverVersion"],
                          "linuxSystemdValidated": False, "engineAndNetworkValidated": False}))
    except (ops.OpsError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("Drill failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
