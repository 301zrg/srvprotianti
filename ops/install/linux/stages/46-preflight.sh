#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L950-997; application/resource paths fixed by the R4 manual.
f46_preflight() {
    as_srvpro "$APP" 'python3 /srv/srvprotianti-ops/scripts/ops.py preflight --platform linux --application /srv/srvprotianti/releases/linux-r4-1/application --engine /srv/srvprotianti/releases/linux-r4-1/components/linux-engine --catalog /srv/srvprotianti/releases/linux-r4-1/components/catalog --versions /srv/srvprotianti-ops/versions.json'
}
verify_f46_preflight() { f46_preflight || return 10; }
f46_smoke() {
    local body
    printf -v body 'python3 %q smoke %q %q %q' "$INSTALL_ROOT/lib/runtime.py" "$PARAMS" "$SHARED" "$APP"
    as_srvpro "$APP" "$body"
}
verify_f46_smoke() { block_done F46-SMOKE || return 10; }
register_block F46-PREFLIGHT 46 readonly yes 950-959 f46_preflight verify_f46_preflight
register_block F46-SMOKE 46 readonly yes 966-997 f46_smoke verify_f46_smoke
stage_main() { stage_blocks 46; }
register_stage 46
