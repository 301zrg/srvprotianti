#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L839-884: keep B's connection mode, modify only declared paths.
c44_connection() {
    config params /srv/srvpro-input/expected-config.json
    [[ $(cat /etc/srvprotianti/database-name) == "$DATABASE" ]] || die 'Database selection changed'
    read_secret RUNTIME_PASSWORD 'This machine PostgreSQL runtime password'
    RUNTIME_PASSWORD=$RUNTIME_PASSWORD config connection "$DATABASE"
    unset RUNTIME_PASSWORD
    config verify-connection "$DATABASE"
}
verify_c44_connection() { config verify-connection "$DATABASE" || return 20; }
c44_environment() {
    test ! -e /etc/srvprotianti/server.env
    test ! -L /etc/srvprotianti/server.env
    printf 'NODE_ENV=production\n' > /etc/srvprotianti/server.env
    chmod 0600 /etc/srvprotianti/server.env
}
verify_c44_environment() {
    if targets_absent /etc/srvprotianti/server.env; then return 10; fi
    [[ ! -L /etc/srvprotianti/server.env && $(stat -c '%u:%a' /etc/srvprotianti/server.env) == 0:600 ]] || return 20
    [[ $(cat /etc/srvprotianti/server.env) == NODE_ENV=production ]] || return 20
}
register_block C44-CONNECTION 44 first no 839-884 c44_connection verify_c44_connection 1
register_block C44-ENVIRONMENT 44 first no 880-882 c44_environment verify_c44_environment
register_block C44-EQUIVALENCE 44 readonly yes 886-889 config_equivalence verify_equivalence 1
stage_main() { stage_blocks 44; }
register_stage 44
