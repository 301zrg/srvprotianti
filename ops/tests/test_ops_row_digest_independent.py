"""Independent byte oracles and adversarial checks; no database or psql is used."""

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import unittest
import uuid
from unittest.mock import MagicMock, Mock, patch


SPEC = importlib.util.spec_from_file_location("ops_independent", Path(__file__).parents[1] / "scripts" / "ops.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)

TOKEN = "pg-row-json-copytext-c-utf8-lf-v1"
SECRET = "SYNTHETIC_PRIVATE_MARKER_4e12"
PAYLOADS = {"a": [b'{"v":"SYNTHETIC_PRIVATE_MARKER_4e12"}'],
            "b": [b'{"v":null}'], "c": [b'{"v":""}'], "e": []}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_row(name, kind="r", schema="public"):
    return {"schema": schema, "name": name, "kind": kind,
            "columns": [{"name": "v", "type": "text", "notNull": False, "default": None}],
            "constraints": [], "indexes": []}


def reference_state(ending=b"\n", versioned=True):
    # The oracle uses explicit synthetic COPY bytes, never ops digest helpers.
    state = {"schema": [object_row(name) for name in PAYLOADS] + [object_row("s", "S")],
             "tables": [{"schema": "public", "table": name, "rows": len(rows),
                         "sha256": sha(b"".join(row + ending for row in rows))}
                        for name, rows in PAYLOADS.items()],
             "sequences": [{"schema": "public", "name": "s", "lastValue": "-7", "isCalled": False}]}
    if versioned:
        state["rowDigestFormat"] = TOKEN
    return state


class MemoryProcess:
    def __init__(self, output=b'{"v":1}\n', code=0):
        self.stdin = Mock()
        self.stdout = MagicMock()
        self.stdout.__iter__.side_effect = lambda: iter(io.BytesIO(output))
        self.returncode = None
        self.code = code
        self.killed = False
        self.waits = 0

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.code = -9

    def wait(self):
        self.waits += 1
        self.returncode = self.code
        return self.returncode


class IndependentBytesTest(unittest.TestCase):
    def test_u03_u04_explicit_copy_escapes_unicode_null_and_empty_are_distinct(self):
        # JSON escapes are themselves escaped by COPY. These are COPY payloads,
        # not raw field values. No Unicode normalization is part of the oracle.
        payloads = [br'{"v":"\\n"}', br'{"v":"\\r"}', br'{"v":"\\r\\n"}',
                    br'{"v":"\\\\n"}', br'{"v":"\\t"}', br'{"v":"\\""}',
                    br'{"v":"\\\\"}', '{"v":"中文"}'.encode("utf-8"),
                    '{"v":"😀"}'.encode("utf-8"), '{"v":"e\u0301"}'.encode("utf-8"),
                    '{"v":"\u00e9"}'.encode("utf-8"), b'{"v":null}', b'{"v":""}']
        self.assertEqual(len(set(payloads)), 13)
        results = []
        for payload in payloads:
            with self.subTest(payload=payload):
                expected = (1, sha(payload + b"\n"), sha(payload + b"\r\n"))
                for ending in (b"\n", b"\r\n"):
                    actual = ops.scan_copy_records(io.BytesIO(payload + ending), include_crlf=True)
                    self.assertEqual(actual, expected)
                results.append(expected[1])
        self.assertEqual(len(set(results)), 13)

    def test_u06_duplicate_row_permutation_and_multiplicity(self):
        first, second = bytes(bytearray(b'{"v":4}')), b'{"v":4}'
        self.assertIsNot(first, second)
        once = ops.scan_copy_records(io.BytesIO(first + b"\n"))
        forward = ops.scan_copy_records(io.BytesIO(first + b"\n" + second + b"\n"))
        reverse = ops.scan_copy_records(io.BytesIO(second + b"\n" + first + b"\n"))
        self.assertEqual(once, (1, sha(b'{"v":4}\n'), None))
        self.assertEqual(forward, (2, sha(b'{"v":4}\n{"v":4}\n'), None))
        self.assertEqual(forward, reverse)
        self.assertNotEqual(once[1], forward[1])

    def test_u07_long_record_has_no_artificial_line_limit(self):
        payload = b'{"v":"' + b"x" * (2 * 1024 * 1024 + 37) + b'"}'
        for ending in (b"\n", b"\r\n"):
            self.assertEqual(ops.scan_copy_records(io.BytesIO(payload + ending)),
                             (1, sha(payload + b"\n"), None))

    def test_u07_rejects_extra_cr_leading_empty_and_incomplete_last_record(self):
        for data in (b"\r", b"\r\n", b"\r\n{}\r\n", b"{}\r\r\n", b"{}\r\r\r\n",
                     b"{}\n{}", b"{}\r\n{}\r", b"{}\n\r", b"{}\n{}\r\n"):
            for legacy in (False, True):
                with self.subTest(data=data, legacy=legacy), self.assertRaises(ops.OpsError):
                    ops.scan_copy_records(io.BytesIO(data), include_crlf=legacy)

    def test_u07_binary_iteration_splits_on_lf_only(self):
        self.assertEqual(list(io.BytesIO(b"a\rb\r\nc\n")), [b"a\rb\r\n", b"c\n"])
        with self.assertRaises(ops.OpsError):
            ops.scan_copy_records(io.BytesIO(b"a\rb\n"))

    def test_u08_interrupt_read_and_stdin_close_errors_reap_child(self):
        for stage in ("read-interrupt", "read-midstream", "close", "write-interrupt", "exit"):
            child = MemoryProcess(code=3 if stage == "exit" else 0)
            if stage == "read-interrupt":
                child.stdout.__iter__.side_effect = KeyboardInterrupt(SECRET)
            elif stage == "read-midstream":
                def broken():
                    yield b'{"v":1}\n'
                    raise OSError(SECRET)
                child.stdout.__iter__.side_effect = broken
            elif stage == "close":
                child.stdin.close.side_effect = BrokenPipeError(SECRET)
            elif stage == "write-interrupt":
                child.stdin.write.side_effect = KeyboardInterrupt(SECRET)
            with self.subTest(stage=stage), patch.object(ops.subprocess, "Popen", return_value=child):
                with self.assertRaises((KeyboardInterrupt, ops.OpsError)) as caught:
                    ops.Postgres("srvpro_drill_independent").row_digest("public", "a")
                self.assertIsNotNone(child.returncode)
                self.assertGreaterEqual(child.waits, 1)
                self.assertTrue(child.stdout.close.called and child.stdin.close.called)
                self.assertEqual(child.killed, stage != "exit")
                if isinstance(caught.exception, ops.OpsError):
                    self.assertNotIn(SECRET, str(caught.exception))

    def test_u09_u10_state_rejects_whole_record_loss_in_both_profiles(self):
        for legacy in (False, True):
            for copied, counted in ((0, 1), (1, 2), (2, 1)):
                pg = ops.Postgres("srvpro_drill_independent")
                record = {"schema": "public", "table": "a", "rows": copied,
                          "sha256": sha(b'{"v":1}\n' * copied)}
                returned = (record, {**record, "sha256": sha(b'{"v":1}\r\n' * copied)}) if legacy else record
                with self.subTest(legacy=legacy, copied=copied, counted=counted), \
                        patch.object(pg, "schema", return_value=[object_row("a")]), \
                        patch.object(pg, "row_digest", return_value=returned), \
                        patch.object(pg, "query_json", return_value=[counted]), self.assertRaises(ops.OpsError):
                    pg.state(legacy=legacy)

    def test_u09_count_query_failure_does_not_expose_raw_stderr(self):
        # Regression: this new count path currently uses run()'s raw stderr message.
        pg = ops.Postgres("srvpro_drill_independent")
        result = Mock(returncode=1, stderr=(SECRET + " SQL row payload").encode(), stdout=b"")
        with patch.object(ops.subprocess, "run", return_value=result), self.assertRaises(ops.OpsError) as caught:
            pg.row_counts([("public", "a")])
        self.assertNotIn(SECRET, str(caught.exception))

    def test_u10_count_result_length_and_integer_types_are_checked_before_zip(self):
        for counts in ([], [1, 0], [True], [1.0], ["1"], None, {}, [None]):
            with self.subTest(counts=counts), patch.object(ops.Postgres, "query_json", return_value=counts), \
                    self.assertRaises(ops.OpsError):
                ops.Postgres("srvpro_drill_independent").row_counts([("public", "a")])

    def test_u09_count_query_quotes_partition_matview_and_special_identifiers(self):
        relations = [('p"ublic', 'parent'), ('p"ublic', 'child'), ('中文', 'materialized"view')]
        pg = ops.Postgres("srvpro_drill_independent")
        with patch.object(pg, "query_json", return_value=[2, 1, 5]) as query:
            self.assertEqual(pg.row_counts(relations), [2, 1, 5])
        statement = query.call_args.args[0]
        for target in ('"p""ublic"."parent"', '"p""ublic"."child"', '"中文"."materialized""view"'):
            self.assertIn("FROM " + target, statement)
        self.assertEqual(statement.count("UNION ALL"), 2)
        self.assertNotIn("ONLY", statement)


class IndependentMatcherTest(unittest.TestCase):
    def test_u13_new_failure_cannot_fall_back_to_matching_legacy(self):
        expected = reference_state(b"\r\n")
        pg = Mock()
        pg.state.side_effect = lambda legacy=False: ((reference_state(versioned=False),
                                                     reference_state(b"\r\n", False)) if legacy else reference_state())
        with self.assertRaises(ops.OpsError):
            ops.verify_restored_state(expected, pg)
        pg.state.assert_called_once_with()

    def test_u16_three_nonempty_tables_one_opposite_ending_is_rejected(self):
        for reversed_table in range(3):
            for base, opposite in ((b"\n", b"\r\n"), (b"\r\n", b"\n")):
                expected = reference_state(base, False)
                expected["tables"][reversed_table] = reference_state(opposite, False)["tables"][reversed_table]
                pg = Mock()
                pg.state.return_value = (reference_state(versioned=False), reference_state(b"\r\n", False))
                with self.subTest(table=reversed_table, base=base), self.assertRaises(ops.OpsError):
                    ops.verify_restored_state(expected, pg)

    def test_u16_crlf_nonempty_tables_cannot_hide_tampered_empty_table(self):
        expected = reference_state(b"\r\n", False)
        expected["tables"][3]["sha256"] = sha(b"tampered")
        with self.assertRaises(ops.OpsError):
            ops.validate_database_state(expected)
        pg = Mock()
        pg.state.return_value = (reference_state(versioned=False), reference_state(b"\r\n", False))
        with self.assertRaises(ops.OpsError):
            ops.verify_restored_state(expected, pg)

    def test_u16_candidates_differ_only_in_schema_or_sequence_still_reject(self):
        for field in ("schema", "sequences"):
            expected = reference_state(b"\r\n", False)
            if field == "schema":
                expected[field][0]["columns"][0]["type"] = "integer"
            else:
                expected[field][0]["isCalled"] = True
            pg = Mock()
            pg.state.return_value = (reference_state(versioned=False), reference_state(b"\r\n", False))
            with self.subTest(field=field), self.assertRaises(ops.OpsError) as caught:
                ops.verify_restored_state(expected, pg)
            categories = {d["category"] for d in caught.exception.details["candidates"]["crlf"]}
            self.assertEqual(categories, {"schema-mismatch" if field == "schema" else "sequence-mismatch"})

    def test_u19_legal_zero_column_partition_view_matview_and_sequence_shapes(self):
        objects = [object_row('a"', "p", "中文"), object_row("b", "m"), object_row("c", "v"), object_row("d", "S")]
        objects[0]["columns"] = []
        state = {"schema": objects,
                 "tables": [{"schema": "中文", "table": 'a"', "rows": 1, "sha256": sha(b"{}\n")},
                            {"schema": "public", "table": "b", "rows": 0, "sha256": sha(b"")}],
                 "sequences": [{"schema": "public", "name": "d", "lastValue": "-9223372036854775808", "isCalled": False}]}
        self.assertFalse(ops.validate_database_state(state))
        state["rowDigestFormat"] = TOKEN
        self.assertTrue(ops.validate_database_state(state))


class IndependentBatchTest(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).parents[2] / ".audit-tmp" / "ops-tests"
        parent.mkdir(parents=True, exist_ok=True)
        # Python 3.13 TemporaryDirectory uses mkdir(0700), whose Windows ACL can
        # exclude a restricted service token. Match test_ops.py's inherited ACLs.
        self.root = parent / ("digest-independent-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.archive = self.root / "release.tar.gz"
        data = b"synthetic public engine"
        with tarfile.open(self.archive, "w:gz") as stream:
            member = tarfile.TarInfo("components/engine/engine.bin")
            member.size, member.mode = len(data), 0o644
            stream.addfile(member, io.BytesIO(data))
        self.dump_json(Path(str(self.archive) + ".manifest.json"),
                       {"format": 1, "kind": "release", "archiveSha256": sha(self.archive.read_bytes()),
                        "files": [{"path": "components/engine/engine.bin", "size": len(data), "sha256": sha(data)}]})
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        (self.recordings / "sample.yrp").write_bytes(b"synthetic replay\x00\xff")
        self.schema_tool = self.root / "schema.js"
        self.schema_tool.write_bytes(b"// never executed\n")
        self.plan = {"format": 1, "database": "srvpro_drill_independent", "runtimeRole": "runtime",
                     "isolated": True, "releaseArchive": str(self.archive), "replayComponent": "recordings",
                     "components": [{"id": "recordings", "source": str(self.recordings)}]}

    @staticmethod
    def dump_json(path, value):
        path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    def postgres(self, source=False):
        pg = Mock(spec=ops.Postgres)
        pg.database = "srvpro_drill_independent" if source else "srvpro_restore_independent"
        pg.environment = {}
        pg.metadata.return_value = {"database": pg.database, "serverVersionNum": 170006, "encoding": "UTF8"}
        pg.state.side_effect = lambda legacy=False: ((reference_state(versioned=False), reference_state(b"\r\n", False))
                                                     if legacy else reference_state())
        pg.replay_names.return_value = ["sample.yrp"]

        def command(name, *arguments):
            if name == "pg_dump" and "--version" in arguments:
                return 0, "pg_dump (PostgreSQL) 17.6"
            if name == "pg_dump":
                Path(arguments[arguments.index("--file") + 1]).write_bytes(b"synthetic dump")
            return 0, ""
        pg.command.side_effect = command
        return pg

    def batch(self):
        batch = self.root / "batch"
        manifest = ops.backup(self.plan, batch, self.postgres(source=True), self.plan["database"])
        return batch, manifest

    def restore(self, batch, target, pg):
        with patch.object(ops, "run", return_value=(0, "")):
            return ops.restore(batch, target, pg, pg.database, "owner", "runtime", self.schema_tool)

    def assert_private_result(self, target, states):
        serialized = (target / "restore-result.json").read_text(encoding="utf-8")
        self.assertNotIn(SECRET, serialized)
        for state in states:
            for row in state["tables"]:
                self.assertNotIn(row["sha256"], serialized)
        for rows in PAYLOADS.values():
            for payload in rows:
                self.assertNotIn(payload.decode(), serialized)
        return json.loads(serialized)

    def test_u18_invalid_tokens_rejected_by_verify_and_restore_before_any_target_action(self):
        batch, manifest = self.batch()
        for token in (None, "", False, True, 0, 1, 1.0, [], {}, [TOKEN], {"value": TOKEN}, TOKEN + "\n", "future"):
            changed = copy.deepcopy(manifest)
            changed["databaseState"]["rowDigestFormat"] = token
            self.dump_json(batch / "manifest.json", changed)
            original = (batch / "manifest.json").read_bytes()
            pg, target = self.postgres(), self.root / "invalid-token-target"
            with self.subTest(token=token):
                with self.assertRaises(ops.OpsError):
                    ops.verify_batch(batch)
                with self.assertRaises(ops.OpsError):
                    self.restore(batch, target, pg)
                self.assertFalse(target.exists())
                self.assertEqual(pg.mock_calls, [])
                self.assertEqual((batch / "manifest.json").read_bytes(), original)

    def test_u18_falsy_tokens_are_unsupported_not_absent_legacy_keys(self):
        for token in (None, "", False, 0, [], {}):
            state = reference_state()
            state["rowDigestFormat"] = token
            with self.subTest(token=token), self.assertRaises(ops.OpsError) as caught:
                ops.validate_database_state(state)
            self.assertEqual(caught.exception.category, "unsupported-row-digest-format")

    def test_u19_malformed_structures_rejected_before_any_target_action(self):
        batch, manifest = self.batch()
        edits = [("state-null", lambda m: m.update(databaseState=None)),
                 ("boolean-format", lambda m: m.update(format=True)),
                 ("float-format", lambda m: m.update(format=1.0)),
                 ("missing", lambda m: m["databaseState"].pop("sequences")),
                 ("unknown-key", lambda m: m["databaseState"].update(rowDigestVersion=TOKEN)),
                 ("boolean-rows", lambda m: m["databaseState"]["tables"][0].update(rows=True)),
                 ("float-rows", lambda m: m["databaseState"]["tables"][0].update(rows=1.0)),
                 ("duplicate-object", lambda m: m["databaseState"]["schema"].append(copy.deepcopy(m["databaseState"]["schema"][0]))),
                 ("duplicate-table", lambda m: m["databaseState"]["tables"].__setitem__(1, copy.deepcopy(m["databaseState"]["tables"][0]))),
                 ("sequence-bool", lambda m: m["databaseState"]["sequences"][0].update(lastValue=True)),
                 ("sequence-int-flag", lambda m: m["databaseState"]["sequences"][0].update(isCalled=1)),
                 ("column-int-flag", lambda m: m["databaseState"]["schema"][0]["columns"][0].update(notNull=0)),
                 ("non-string-index", lambda m: m["databaseState"]["schema"][0].update(indexes=[None])),
                 ("short-counts", lambda m: m["databaseState"]["tables"].pop()),
                 ("swapped-tables", lambda m: m["databaseState"]["tables"].reverse())]
        for label, edit in edits:
            for legacy in (False, True):
                changed = copy.deepcopy(manifest)
                if legacy:
                    changed["databaseState"].pop("rowDigestFormat")
                edit(changed)
                self.dump_json(batch / "manifest.json", changed)
                pg, target = self.postgres(), self.root / "invalid-shape-target"
                with self.subTest(label=label, legacy=legacy):
                    with self.assertRaises(ops.OpsError):
                        ops.verify_batch(batch)
                    with self.assertRaises(ops.OpsError):
                        self.restore(batch, target, pg)
                    self.assertFalse(target.exists())
                    self.assertEqual(pg.mock_calls, [])

    def duplicate_token_manifest(self):
        batch, manifest = self.batch()
        raw = json.dumps(manifest)
        needle = '"rowDigestFormat": ' + json.dumps(TOKEN)
        self.assertEqual(raw.count(needle), 1)
        # The first (unsupported) value must not disappear during JSON decoding.
        raw = raw.replace(needle, '"rowDigestFormat": null, ' + needle)
        (batch / "manifest.json").write_bytes(raw.encode("utf-8"))
        return batch

    def test_u19_duplicate_json_token_key_verify_rejects_ambiguous_manifest(self):
        batch = self.duplicate_token_manifest()
        with self.assertRaises(ops.OpsError):
            ops.verify_batch(batch)

    def test_u19_duplicate_json_token_key_restore_refuses_before_writes(self):
        batch = self.duplicate_token_manifest()
        target, pg = self.root / "duplicate-target", self.postgres()
        rejected = False
        try:
            self.restore(batch, target, pg)
        except ops.OpsError:
            rejected = True
        self.assertFalse(target.exists(), "duplicate key must be rejected before creating the target")
        self.assertEqual(pg.mock_calls, [])
        self.assertTrue(rejected)

    def test_u23_content_change_during_backup_leaves_failed_without_manifest(self):
        pg = self.postgres(source=True)
        changed = reference_state()
        changed["tables"][0]["sha256"] = sha(b'{"v":"changed"}\n')
        pg.state.side_effect = [reference_state(), changed]
        target = self.root / "changed-content"
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, target, pg, pg.database)
        self.assertTrue((target / "FAILED.json").is_file())
        self.assertFalse((target / "manifest.json").exists())
        self.assertEqual(pg.state.call_args_list, [unittest.mock.call(), unittest.mock.call()])

    def test_u23_sequence_change_during_backup_leaves_failed_without_manifest(self):
        pg = self.postgres(source=True)
        changed = reference_state()
        changed["sequences"][0]["lastValue"] = "-6"
        pg.state.side_effect = [reference_state(), changed]
        target = self.root / "changed-sequence"
        with self.assertRaises(ops.OpsError):
            ops.backup(self.plan, target, pg, pg.database)
        self.assertTrue((target / "FAILED.json").is_file())
        self.assertFalse((target / "manifest.json").exists())
        self.assertEqual(pg.state.call_args_list, [unittest.mock.call(), unittest.mock.call()])

    def test_u24_success_result_is_private_and_original_manifest_unchanged(self):
        batch, _ = self.batch()
        original = (batch / "manifest.json").read_bytes()
        target = self.root / "success"
        result = self.restore(batch, target, self.postgres())
        self.assertEqual(self.assert_private_result(target, [reference_state()]), result)
        self.assertTrue(result["complete"] and result["databaseAndFilesVerified"] and result["replayAssociationsVerified"])
        self.assertEqual((batch / "manifest.json").read_bytes(), original)

    def test_u24_database_mismatch_result_has_no_payload_or_either_digest(self):
        batch, _ = self.batch()
        original = (batch / "manifest.json").read_bytes()
        changed, pg = reference_state(), self.postgres()
        changed["tables"][0]["sha256"] = sha((SECRET + "different-row").encode())
        pg.state.side_effect = None
        pg.state.return_value = changed
        target = self.root / "mismatch"
        with self.assertRaises(ops.OpsError):
            self.restore(batch, target, pg)
        result = self.assert_private_result(target, [reference_state(), changed])
        self.assertFalse(result["complete"])
        self.assertEqual(result["failureCategory"], "database-state-mismatch")
        self.assertEqual((batch / "manifest.json").read_bytes(), original)

    def test_u24_raw_stderr_and_exception_text_are_absent_from_failed_json(self):
        batch, _ = self.batch()
        original = (batch / "manifest.json").read_bytes()
        for number, error in enumerate((ops.OpsError("raw stderr " + SECRET), RuntimeError(SECRET), OSError(SECRET))):
            pg, target = self.postgres(), self.root / ("exception-" + str(number))
            pg.command.side_effect = error
            with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                self.restore(batch, target, pg)
            self.assertFalse(self.assert_private_result(target, [reference_state()])["complete"])
            self.assertEqual((batch / "manifest.json").read_bytes(), original)

    def test_u25_known_unauthenticated_manifest_boundary_deleted_token_accepts_legacy_lf(self):
        # Known authentication boundary: deleting the token cannot be detected by
        # this CLI when the bytes also describe a legitimate old LF manifest.
        batch, manifest = self.batch()
        del manifest["databaseState"]["rowDigestFormat"]
        self.assertEqual(manifest["databaseState"], reference_state(versioned=False))
        self.dump_json(batch / "manifest.json", manifest)
        original = (batch / "manifest.json").read_bytes()
        self.assertEqual(ops.verify_batch(batch), manifest)
        result = self.restore(batch, self.root / "known-downgrade-boundary", self.postgres())
        self.assertEqual(result["databaseStateVerification"]["matchedRecordEnding"], "lf")
        self.assertEqual(result["databaseStateVerification"]["algorithm"], "legacy-psql-copy-unversioned")
        self.assertTrue(result["complete"])
        self.assertEqual((batch / "manifest.json").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()


class IndependentInventoryOrderTest(unittest.TestCase):
    """Explicit inventory oracles and synthetic batches; no external services."""

    def rows(self):
        return [{"path": "Zed.yrp", "size": 1, "sha256": "a" * 64},
                {"path": "apple.yrp", "size": 2, "sha256": "b" * 64}]

    def test_order_only_is_equal(self):
        self.assertTrue(ops.same_content(self.rows(), list(reversed(self.rows()))))

    def test_missing_entry_is_unequal(self):
        self.assertFalse(ops.same_content(self.rows(), self.rows()[:1]))

    def test_extra_entry_is_unequal(self):
        extra = {"path": "extra.yrp", "size": 3, "sha256": "c" * 64}
        self.assertFalse(ops.same_content(self.rows(), self.rows() + [extra]))

    def test_duplicate_with_different_counts_is_unequal(self):
        self.assertFalse(ops.same_content(self.rows(), self.rows() + self.rows()[:1]))

    def test_duplicate_replacing_another_entry_is_unequal(self):
        self.assertFalse(ops.same_content(self.rows(), [self.rows()[0], self.rows()[0]]))

    def test_size_change_is_unequal(self):
        changed = self.rows()
        changed[0]["size"] = 9
        self.assertFalse(ops.same_content(self.rows(), changed))

    def test_sha_change_is_unequal(self):
        changed = self.rows()
        changed[0]["sha256"] = "c" * 64
        self.assertFalse(ops.same_content(self.rows(), changed))

    def test_path_case_change_is_unequal(self):
        changed = self.rows()
        changed[0]["path"] = "zed.yrp"
        self.assertFalse(ops.same_content(self.rows(), changed))

    def test_mode_change_is_ignored(self):
        actual, expected = self.rows(), self.rows()
        actual[0]["mode"], expected[0]["mode"] = 0o644, 0o755
        self.assertTrue(ops.same_content(actual, expected))

    def test_verify_accepts_both_orders_independently_at_both_levels(self):
        fixture = IndependentBatchTest()
        fixture.setUp()
        for name in ("Zed.yrp", "apple.yrp", "Beta.yrp"):
            (fixture.recordings / name).write_bytes(name.encode("ascii"))
        empty = fixture.root / "empty"
        empty.mkdir()
        fixture.plan["components"].append({"id": "empty", "source": str(empty)})
        batch, original = fixture.batch()
        keys = (lambda row: row["path"], lambda row: row["path"].lower())
        for top_order in range(2):
            for component_order in range(2):
                with self.subTest(top_order=top_order, component_order=component_order):
                    manifest = copy.deepcopy(original)
                    self.assertNotEqual(sorted(manifest["files"], key=keys[0]),
                                        sorted(manifest["files"], key=keys[1]))
                    manifest["files"].sort(key=keys[top_order])
                    for item in manifest["components"]:
                        if item["id"] == "recordings":
                            self.assertNotEqual(sorted(item["files"], key=keys[0]),
                                                sorted(item["files"], key=keys[1]))
                        item["files"].sort(key=keys[component_order])
                    fixture.dump_json(batch / "manifest.json", manifest)
                    self.assertEqual(ops.verify_batch(batch), manifest)
