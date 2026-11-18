#!/usr/bin/env bash
set -Eeuo pipefail
# Registered functions and test replacements are dispatched indirectly.
# shellcheck disable=SC2317
# shellcheck source=../lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib/common.sh"
install_traps
STATE_DIR=$CASE_DIR/state STATE_FILE=$CASE_DIR/state/state.json LOG_FILE=$CASE_DIR/workflow.log
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
ROUTE=${CASE_ROUTE:-A} DEPLOY_USER=fixture DEPLOY_HOME=$CASE_DIR DEPLOY_UID=$(id -u)
PARAMS=$CASE_DIR/params SHARED=$CASE_DIR/shared APP=$CASE_DIR/app DATABASE=srvpro_1103
# shellcheck source=../lib/workflow.sh
source "$INSTALL_ROOT/lib/workflow.sh"
for file in "$INSTALL_ROOT"/stages/*.sh; do
    # shellcheck source=/dev/null
    source "$file"
done
order_blocks
complete_before() {
    local id
    for id in "${BLOCKS[@]}"; do
        [[ $id == "$1" ]] && break
        state complete "$STATE_FILE" "$id" '{}'
    done
}
fake_action() { printf 'action\n' >> "$CASE_DIR/action"; }
no_action() { :; }
case $1 in
    land-b)
        STAGING=$CASE_DIR/staging
        h10_confirm_landing() { :; }
        chown() { [[ $* == "-R root:root $CASE_DIR/landing" ]]; }
        land_fixture() {
            local INPUT='' PARAMS=$PARAMS INSTALL_ROOT=$INSTALL_ROOT
            h10_land "$CASE_DIR/landing"
        }
        verify_landing_fixture() { verify_h10_land "$CASE_DIR/landing"; }
        BLOCK_ACTION[H10-LAND]=land_fixture BLOCK_VERIFY[H10-LAND]=verify_landing_fixture
        recover_pending
        run_block H10-LAND
        ;;
    database-probe)
        pg_scalar() { printf '%s\n' "${PG_COUNT:-0}"; return "${PG_STATUS:-0}"; }
        if [[ $ROUTE == A ]]; then probe_block A32-DATABASE; else probe_block B33-DATABASE; fi
        ;;
    first-rerun)
        complete_before L41-PARAMS
        BLOCK_ACTION[L41-PARAMS]=no_action BLOCK_ACTION[L41-ACCOUNT]=fake_action BLOCK_ACTION[L41-LAYOUT]=no_action
        run_stage 41
        selected_stage 41 0
        ;;
    bypass-cp1)
        complete_before CP1-CLIENT
        run_stage 52b
        ;;
    bypass-postboot)
        complete_before R53-POSTBOOT
        run_stage CP2
        ;;
    missing-writers)
        # No external request: model a successful drain and a missing inventory.
        maintenance_drain() { :; }
        lifecycle() { [[ $1 != list-writers ]]; }
        systemctl() { touch "$CASE_DIR/stopped"; }
        m52_stop
        ;;
    b-account)
        python3() {
            if [[ $1 == /etc/srvprotianti/maintenance.py ]]; then
                shift
                command python3 "$INSTALL_ROOT/../../scripts/maintenance.py" "$@"
            else
                command python3 "$@"
            fi
        }
        complete_before M52-ACCOUNT
        selected_stage M52-ACCOUNT 0
        ;;
    cp2-wait|cp2-drained)
        if [[ -z $(state pending "$STATE_FILE") ]]; then complete_before CP2-DRAIN; fi
        maintenance_call() {
            if [[ $1 == on && ${READY-} == yes ]]; then printf '{"maintenanceEnabled":true,"readyToStop":true}\n'
            else printf '{"maintenanceEnabled":true,"readyToStop":false}\n'; fi
        }
        recover_pending
        run_stage CP2
        ;;
    boot-unchanged)
        python3 - "$INSTALL_ROOT/lib" <<'PY'
import sys
sys.path.insert(0,sys.argv[1])
from lifecycle import check_boot
check_boot('same','same',0,10,20,400000000)
PY
        touch "$CASE_DIR/later"
        ;;
    *) exit 2 ;;
esac
