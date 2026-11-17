#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L647-663, V34-RUNTIME; root, new machine's runtime credentials only.
v34_runtime() {
    local selected
    selected=$(cat /etc/srvprotianti/database-name)
    [[ $selected == "$DATABASE" ]] || die 'Database selection differs from state'
    cd -- /srv/srvprotianti/releases/linux-r4-1/application || return
    read_secret PGPASSWORD 'PostgreSQL runtime password'
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_runtime PGPASSWORD=$PGPASSWORD \
        env -u PGPASSFILE -u PGOPTIONS node plugins/postgres-compat/deployment/schema.js verify --database "$DATABASE" \
        --runtime-role srvpro_runtime --report /etc/srvprotianti/reports/schema-runtime.json
    unset PGPASSWORD
    python3 "$INSTALL_ROOT/lib/checks.py" report /etc/srvprotianti/reports/schema-runtime.json
}
verify_v34_runtime() {
    # Reauthenticate without writing the original report.
    [[ -f /etc/srvprotianti/database-name && $(cat /etc/srvprotianti/database-name) == "$DATABASE" ]] || return 20
    cd -- /srv/srvprotianti/releases/linux-r4-1/application || return 20
    local result=0
    read_secret PGPASSWORD 'PostgreSQL runtime password (read-only verify)'
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_runtime PGPASSWORD=$PGPASSWORD \
        env -u PGPASSFILE -u PGOPTIONS node plugins/postgres-compat/deployment/schema.js verify --database "$DATABASE" \
        --runtime-role srvpro_runtime >/dev/null 2>/dev/null || result=20
    unset PGPASSWORD
    return "$result"
}

register_block V34-RUNTIME 34 readonly yes 647-663 v34_runtime verify_v34_runtime 1

# Entry for stage 34; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 34; }
register_stage 34
