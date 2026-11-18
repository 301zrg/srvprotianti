#!/usr/bin/env bash
# Functions below are invoked by the registry or replace registered functions.
# shellcheck disable=SC2317
set -Eeuo pipefail
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"
install_traps
STATE_DIR=$CASE_DIR/state
STATE_FILE=$STATE_DIR/state.json
LOG_FILE=$CASE_DIR/install.log
mkdir -p "$STATE_DIR"
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
DEPLOY_USER=fixture DEPLOY_HOME=$CASE_DIR DEPLOY_UID=$(id -u)
ROUTE=A DATABASE=srvpro_1103

fake_action() { printf 'done\n' >> "$CASE_DIR/action"; }
fake_verify() {
    if [[ -f $CASE_DIR/action ]]; then return 0; fi
    printf 'FAIL runtime: simulated verifier output\n' >&2
    return 10
}
unknown_verify() { printf 'FAIL runtime: simulated verifier output\n'; return 20; }
later_action() { touch "$CASE_DIR/later"; }
register_block F1 10 first no 1-2 fake_action fake_verify
register_block F2 12 idempotent yes 3-4 later_action fake_verify
stage_main() { stage_blocks 10; }
register_stage 10
stage_main() { stage_blocks 12; }
register_stage 12

if [[ ${1-} == init ]]; then
    binding=$(python3 - <<'PY'
import json, os
print(json.dumps({'machine':'fixture','route':os.environ.get('CASE_ROUTE','A'),'deployUid':1000,'deployHome':'/home/fixture',
                  'scriptCommit':'a'*40,'handoverDigest':'b'*64,'paramsDigest':'c'*64,'scriptDigest':'d'*64,
                  'release':'linux-r4-1','database':'srvpro_1103','restoreDir':'/private-restores/batch1',
                  'stagingDirectory':'/home/fixture/staging'}))
PY
)
    state create "$STATE_FILE" "$binding"
    exit 0
fi
case ${1-} in
    run) recover_pending; run_stage 10 ;;
    redo) redo_stage 10 ;;
    rerun) selected_stage 10 0 ;;
    early) run_stage 12 ;;
    unknown) BLOCK_VERIFY[F1]=unknown_verify; recover_pending ;;
    idempotent) BLOCK_KIND[F1]=idempotent; recover_pending; run_stage 10 ;;
    child|pipeline|guard)
        # The fake runuser changes no identity and does not inspect inherited secrets.
        runuser() { shift 3; "$@"; }
        case $1 in
            child) BODY='false; touch "$HOME/later"' ;;
            pipeline) BODY='false | cat; touch "$HOME/later"' ;;
            guard) BODY='test -e "$HOME/missing"; touch "$HOME/later"' ;;
        esac
        fake_action() { as_deploy "$CASE_DIR" "$BODY"; }
        run_stage 10
        ;;
    environment)
        runuser() { shift 3; "$@"; }
        export LEAK_ME=secret BASH_ENV=$CASE_DIR/poison PGPASSWORD=credential
        printf 'touch "%s/poisoned"\n' "$CASE_DIR" > "$BASH_ENV"
        as_deploy "$CASE_DIR" 'env | sort; printf "cwd=%s\n" "$PWD"'
        ;;
    lock)
        # Ownership validation is exercised by the real entry on Linux. Here only
        # the temporary state directory is modelled as root-owned for nonroot bats.
        stat() {
            if [[ $* == *"$STATE_DIR/lock"* ]]; then printf '0:600\n'
            elif [[ $* == *"$STATE_DIR"* ]]; then printf '0:700\n'
            else command stat "$@"; fi
        }
        lock_state
        printf 'locked\n' > "$CASE_DIR/locked"
        read -r _ < "$CASE_DIR/release-lock"
        ;;
    password)
        fake_action() {
            ask_password RUNTIME_PASSWORD 'New fixture password'
            # Test consumer inherits a secret but never writes it to disk or argv.
            RUNTIME_PASSWORD=$RUNTIME_PASSWORD python3 -c 'import os; assert os.environ["RUNTIME_PASSWORD"]'
            unset RUNTIME_PASSWORD
        }
        BLOCK_SECRET[F1]=1
        run_stage 10
        ;;
    filter)
        RUNTIME_PASSWORD=$SAMPLE_SECRET
        say "value=$RUNTIME_PASSWORD"
        ;;
    persistence)
        state() {
            if [[ $1 == begin ]]; then return 73; fi
            python3 "$INSTALL_ROOT/lib/state.py" "$@"
        }
        run_stage 10
        ;;
    old-batch)
        fake_action() {
            printf '%s\n' "$SAMPLE_SECRET"
            printf '%s\n' "$SAMPLE_SECRET" >&2
            false
        }
        BLOCK_SECRET[F1]=1
        run_stage 10
        ;;
    *) exit 2 ;;
esac
