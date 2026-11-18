#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L1010-1074: install unit once, then enable/start and inspect invocation.
d51_unit() {
    test ! -e /etc/systemd/system/srvprotianti.service
    test ! -L /etc/systemd/system/srvprotianti.service
    install -m 0644 /srv/srvprotianti-ops/templates/srvprotianti.service /etc/systemd/system/srvprotianti.service
    systemd-analyze verify /etc/systemd/system/srvprotianti.service
}
verify_d51_unit() {
    if targets_absent /etc/systemd/system/srvprotianti.service; then return 10; fi
    cmp -- /srv/srvprotianti-ops/templates/srvprotianti.service /etc/systemd/system/srvprotianti.service || return 20
    [[ ! -L /etc/systemd/system/srvprotianti.service && $(stat -c '%u:%a' /etc/systemd/system/srvprotianti.service) == 0:644 ]] || return 20
    systemd-analyze verify /etc/systemd/system/srvprotianti.service || return 20
}
d51_start() {
    systemctl daemon-reload
    systemctl enable --now srvprotianti.service
    BLOCK_EVIDENCE=$(runtime readiness)
}
verify_d51_start() { runtime verify-readiness >/dev/null || return 10; systemctl is-enabled srvprotianti.service >/dev/null || return 10; }
restart_only() {
    block_done M52-STOP || die 'restart-only requires completed drain and stop'
    [[ -z $(state pending "$STATE_FILE") ]] || die 'Resolve pending action before restart'
    lifecycle inactive
    ask_yes 'Start game in maintenance explicitly; all stages from 52b onward will require validation again'
    local id found=0
    local -a invalidated=()
    for id in "${BLOCKS[@]}"; do
        if [[ ${BLOCK_STAGE[$id]} == 52b ]]; then found=1; fi
        if (( found )); then invalidated+=("$id"); fi
    done
    state invalidate "$STATE_FILE" "${invalidated[@]}"
    systemctl start srvprotianti.service
    runtime readiness
}
register_block D51-SYSTEMD 51 first no 1010-1018 d51_unit verify_d51_unit
register_block D51-START 51 idempotent no 1019-1074 d51_start verify_d51_start
stage_main() { stage_blocks 51; }
register_stage 51
