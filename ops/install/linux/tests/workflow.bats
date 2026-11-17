#!/usr/bin/env bats

setup() {
    export CASE_DIR=$BATS_TEST_TMPDIR/case
    mkdir -p "$CASE_DIR"
    bash "$BATS_TEST_DIRNAME/harness.sh" init
    HARNESS=$BATS_TEST_DIRNAME/workflow-harness.sh
}

@test "new stage first actions reject a completed stage rerun" {
    run bash "$HARNESS" first-rerun
    [ "$status" -ne 0 ]
    [[ "$output" == *'Completed first action cannot be rerun'* ]]
    [ "$(wc -l < "$CASE_DIR/action")" -eq 1 ]
}

@test "52b cannot bypass CP1" {
    run bash "$HARNESS" bypass-cp1
    [ "$status" -ne 0 ]
    [[ "$output" == *'Prerequisite CP1-CLIENT'* ]]
}

@test "CP2 cannot bypass postboot evidence" {
    run bash "$HARNESS" bypass-postboot
    [ "$status" -ne 0 ]
    [[ "$output" == *'Prerequisite R53-POSTBOOT'* ]]
}

@test "missing writer inventory stops before any systemctl stop even without backup" {
    run bash "$HARNESS" missing-writers
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/stopped" ]
}

@test "CP2 remains pending until natural drain and run resumes just the drain" {
    run bash "$HARNESS" cp2-wait
    [ "$status" -ne 0 ]
    [[ "$output" == *'Waiting for natural drain'* ]]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = CP2-DRAIN ]
    run env READY=yes bash "$HARNESS" cp2-drained
    [ "$status" -eq 0 ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = '' ]
}

@test "unchanged boot ID refuses before following action" {
    run bash "$HARNESS" boot-unchanged
    [ "$status" -ne 0 ]
    [[ "$output" == *'machine has not rebooted'* ]]
    [ ! -e "$CASE_DIR/later" ]
}

@test "maintenance rejects invalid structured arguments without exposing password" {
    run env MAINTENANCE_PASSWORD=synthetic-private python3 "$BATS_TEST_DIRNAME/../../../scripts/maintenance.py" on --port 0 --username u --message m
    [ "$status" -ne 0 ]
    [[ "$output" != *'synthetic-private'* ]]
    run env MAINTENANCE_PASSWORD=synthetic-private python3 "$BATS_TEST_DIRNAME/../../../scripts/maintenance.py" status --port 80 --username bad:user --message m
    [ "$status" -ne 0 ]
    [[ "$output" != *'synthetic-private'* ]]
}
