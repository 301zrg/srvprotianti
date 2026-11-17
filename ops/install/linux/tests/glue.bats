#!/usr/bin/env bats

setup() {
    export CASE_DIR=$BATS_TEST_TMPDIR/case
    mkdir -p "$CASE_DIR"
    HARNESS=$BATS_TEST_DIRNAME/harness.sh
    bash "$HARNESS" init
}

@test "run completes once and skips a recorded first action" {
    run bash "$HARNESS" run
    [ "$status" -eq 0 ]
    [[ "$output" == *'PASS F1'* ]]
    run bash "$HARNESS" run
    [ "$status" -eq 0 ]
    [[ "$output" == *'SKIP F1'* ]]
    [ "$(wc -l < "$CASE_DIR/action")" -eq 1 ]
}

@test "first actions reject redo and stages reject missing prerequisites" {
    run bash "$HARNESS" redo
    [ "$status" -ne 0 ]
    run bash "$HARNESS" early
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/later" ]
}

@test "stage refuses an already completed first action while run can skip it" {
    bash "$HARNESS" run
    run bash "$HARNESS" rerun
    [ "$status" -ne 0 ]
    [ "$(wc -l < "$CASE_DIR/action")" -eq 1 ]
}

@test "pending complete action is recovered with a read-only probe" {
    python3 "$BATS_TEST_DIRNAME/../lib/state.py" begin "$CASE_DIR/state/state.json" F1
    printf 'done\n' > "$CASE_DIR/action"
    run bash "$HARNESS" run
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$CASE_DIR/action")" -eq 1 ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = '' ]
}

@test "uncertain pending first action stops without a replay" {
    python3 "$BATS_TEST_DIRNAME/../lib/state.py" begin "$CASE_DIR/state/state.json" F1
    run bash "$HARNESS" unknown
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/action" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = F1 ]
}

@test "not-started pending idempotent action can resume" {
    python3 "$BATS_TEST_DIRNAME/../lib/state.py" begin "$CASE_DIR/state/state.json" F1
    run bash "$HARNESS" idempotent
    [ "$status" -eq 0 ]
    [ -f "$CASE_DIR/action" ]
}

@test "damaged state is refused rather than recreated" {
    printf '{bad\n' > "$CASE_DIR/state/state.json"
    run bash "$HARNESS" run
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/action" ]
}

@test "binding changes are refused" {
    run python3 "$BATS_TEST_DIRNAME/../lib/state.py" check-binding "$CASE_DIR/state/state.json" '{"machine":"other","route":"A"}'
    [ "$status" -ne 0 ]
}

@test "failed pending persistence prevents the first action" {
    run bash "$HARNESS" persistence
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/action" ]
}

@test "lock excludes a simultaneous installer" {
    mkfifo "$CASE_DIR/release-lock"
    bash "$HARNESS" lock > "$CASE_DIR/holder.log" 2>&1 &
    holder=$!
    for ((i=0; i<100; i++)); do
        [ ! -e "$CASE_DIR/locked" ] || break
        sleep 0.02
    done
    [ -e "$CASE_DIR/locked" ]
    run bash "$HARNESS" lock
    result=$status
    printf 'release\n' > "$CASE_DIR/release-lock"
    wait "$holder"
    [ "$result" -ne 0 ]
}

@test "deployment environment is a whitelist with explicit HOME cwd PATH" {
    run bash "$HARNESS" environment
    [ "$status" -eq 0 ]
    [[ "$output" == *"HOME=$CASE_DIR"* ]]
    [[ "$output" == *"cwd=$CASE_DIR"* ]]
    [[ "$output" == *'PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin'* ]]
    [[ "$output" != *LEAK_ME* && "$output" != *PGPASSWORD* && "$output" != *BASH_ENV* ]]
    [ ! -e "$CASE_DIR/poisoned" ]
}

@test "child intermediate failure leaves pending and stops later writes" {
    run bash "$HARNESS" child
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/later" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = F1 ]
}

@test "pipeline early failure leaves pending and stops later writes" {
    run bash "$HARNESS" pipeline
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/later" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = F1 ]
}

@test "test guard failure leaves pending and stops later writes" {
    run bash "$HARNESS" guard
    [ "$status" -ne 0 ]
    [ ! -e "$CASE_DIR/later" ]
    [ "$(python3 "$BATS_TEST_DIRNAME/../lib/state.py" pending "$CASE_DIR/state/state.json")" = F1 ]
}

@test "known credentials are filtered even with glob and SQL characters" {
    export SAMPLE_SECRET="a*[x]?'\\:old-credential"
    run bash "$HARNESS" filter
    [ "$status" -eq 0 ]
    [[ "$output" != *"$SAMPLE_SECRET"* ]]
    ! grep -F -- "$SAMPLE_SECRET" "$CASE_DIR/install.log"
}

@test "tty passwords never appear in output state or logs" {
    run python3 "$BATS_TEST_DIRNAME/tty_password.py" "$HARNESS" "$CASE_DIR"
    [ "$status" -eq 0 ]
}

@test "unknown old batch credential output is suppressed on sensitive failure" {
    export SAMPLE_SECRET="old-private-batch:*?'\\:password"
    run bash "$HARNESS" old-batch
    [ "$status" -ne 0 ]
    [[ "$output" != *"$SAMPLE_SECRET"* && "$output" != *'command='* ]]
    ! grep -F -- "$SAMPLE_SECRET" "$CASE_DIR/install.log" "$CASE_DIR/state/state.json"
}
