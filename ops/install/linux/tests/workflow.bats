#!/usr/bin/env bats

setup() {
    export CASE_DIR=$BATS_TEST_TMPDIR/case
    mkdir -p "$CASE_DIR"
    bash "$BATS_TEST_DIRNAME/harness.sh" init
    HARNESS=$BATS_TEST_DIRNAME/workflow-harness.sh
}

@test "H10-LAND resumes after correcting private staging modes" {
    export CASE_ROUTE=B CASE_DIR=$BATS_TEST_TMPDIR/route-b
    mkdir -p "$CASE_DIR/staging/joint-batch"
    chmod 0755 "$CASE_DIR/staging/joint-batch"
    printf 'fixture\n' > "$CASE_DIR/staging/joint-batch/sample"
    chmod 0600 "$CASE_DIR/staging/joint-batch/sample"
    bash "$BATS_TEST_DIRNAME/harness.sh" init

    run bash "$HARNESS" land-b
    [ "$status" -ne 0 ]
    grep -F 'Private staging batch must have manual 0700/0600 modes' "$CASE_DIR/workflow.log"
    [ ! -e "$CASE_DIR/landing" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = H10-LAND ]

    chmod 0700 "$CASE_DIR/staging/joint-batch"
    ln -s "$CASE_DIR/missing" "$CASE_DIR/landing"
    run bash "$HARNESS" land-b
    [ "$status" -ne 0 ]
    [[ "$output" == *'PROBE H10-LAND: partial'* ]]
    [ -L "$CASE_DIR/landing" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = H10-LAND ]
    unlink "$CASE_DIR/landing"

    run bash "$HARNESS" land-b
    [ "$status" -eq 0 ]
    [[ "$output" == *'PROBE H10-LAND: not started (proven)'* && "$output" == *'PASS H10-LAND'* ]]
    cmp "$CASE_DIR/staging/joint-batch/sample" "$CASE_DIR/landing/joint-batch/sample"
    [ "$(stat -c %a "$CASE_DIR/landing/joint-batch")" = 700 ]
    [ "$(stat -c %a "$CASE_DIR/landing/joint-batch/sample")" = 600 ]
    [ -z "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" ]
}

@test "database absence requires a successful exact zero count" {
    local route
    for route in A B; do
        run env CASE_ROUTE="$route" PG_COUNT=0 PG_STATUS=0 bash "$HARNESS" database-probe
        [ "$status" -eq 10 ]
        [[ "$output" == *'not started (proven)'* ]]
        run env CASE_ROUTE="$route" PG_COUNT=0 PG_STATUS=1 bash "$HARNESS" database-probe
        [ "$status" -eq 20 ]
        [[ "$output" == *partial* ]]
    done
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

@test "B maintenance account selection records only confirmation and a hash in state" {
    export CASE_ROUTE=B CASE_ADMIN=synthetic-restored-admin CASE_PASSWORD="private: '&=+[]%$"
    # Reinitialize the harness with a separate B state and synthetic restored file.
    export CASE_DIR=$BATS_TEST_TMPDIR/route-b
    mkdir -p "$CASE_DIR/shared/config"
    bash "$BATS_TEST_DIRNAME/harness.sh" init
    python3 - "$CASE_DIR/shared/config/admin_user.json" <<'PY'
import json, os, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({'users': {os.environ['CASE_ADMIN']: {
    'password': os.environ['CASE_PASSWORD'], 'enabled': True, 'permissions': {'stop': True}}}}), 'utf-8')
PY
    run bash "$HARNESS" b-account
    [ "$status" -eq 0 ]
    [[ "$output" == *'PASS M52-ACCOUNT'* ]]
    [[ "$output" != *"$CASE_ADMIN"* && "$output" != *"$CASE_PASSWORD"* ]]
    python3 - "$CASE_DIR" <<'PY'
import hashlib, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
state = (root/'state/state.json').read_text('utf-8')
log = (root/'workflow.log').read_text('utf-8')
name, password = os.environ['CASE_ADMIN'], os.environ['CASE_PASSWORD']
assert name not in state + log and password not in state + log
assert json.loads(state)['blocks']['M52-ACCOUNT']['evidence'] == {
    'selected': True, 'usernameSha256Prefix': hashlib.sha256(name.encode()).hexdigest()[:12]}
PY
}
