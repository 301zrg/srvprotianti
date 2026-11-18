#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
[[ $ROUTE == B ]] || return 0
# Manual L763-825: classify EVERY actual component before copying to fresh shared.
c43_map() {
    # This block is sensitive (its output is discarded); surface the tool's value-free reason via die.
    local reason
    if ! reason=$(config plan-map "$RESTORE" 2>&1 >/dev/tty); then die "plan-map: ${reason##*$'
'}"; fi
    ask_yes 'Every component classified; paths, rebuild/evidence exclusions and additional assets reviewed'
    if ! reason=$(config copy-map "$RESTORE" 2>&1 >/dev/null); then die "copy-map: ${reason##*$'
'}"; fi
}
verify_c43_map() { config verify-map "$RESTORE" || return 20; }
register_block C43-MAP 43 first no 783-817 c43_map verify_c43_map 1
register_block C43-EQUIVALENCE 43 readonly yes 689-714 config_equivalence verify_equivalence 1
stage_main() { stage_blocks 43; }
register_stage 43
