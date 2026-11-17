#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L1248-1291, design 10.2; never reboot or start services here.
r53_preboot() {
    BLOCK_EVIDENCE=$(lifecycle preboot)
    say 'WAIT 53a: reboot THIS machine manually, then wait at least five minutes before FIRST SSH login; resume with run' >/dev/tty
}
verify_r53_preboot() { runtime preboot-record "$STATE_FILE" || return 10; }
r53_postboot() {
    BLOCK_EVIDENCE=$(lifecycle postboot)
    runtime verify-readiness >/dev/null
    local response
    response=$(maintenance_call status)
    python3 -c 'import json,sys; assert json.loads(sys.argv[1])["maintenanceEnabled"] is True' "$response"
    unset MAINTENANCE_PASSWORD
}
verify_r53_postboot() { lifecycle verify-postboot || return 10; }
register_block R53-PREBOOT 53a readonly no 1248-1256 r53_preboot verify_r53_preboot
register_block R53-POSTBOOT 53b readonly yes 1262-1283 r53_postboot verify_r53_postboot 1
register_block CP2-CLIENT CP2 readonly no 1417-1434 client_accept verify_client_accept 1
register_block CP2-DRAIN CP2 idempotent yes 1291 maintenance_drain repeat_readonly 1
stage_main() { stage_blocks 53a; }
register_stage 53a
stage_main() { stage_blocks 53b; }
register_stage 53b
stage_main() { stage_blocks CP2; }
register_stage CP2
