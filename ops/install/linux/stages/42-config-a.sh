#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
[[ $ROUTE == A ]] || return 0
# Manual L720-758: first copies and maintenance account are separately tracked.
c42_host() {
    test ! -e "$SHARED/config/config.json"
    test ! -L "$SHARED/config/config.json"
    install -m 0600 -o srvpro -g srvpro /srv/srvpro-input/linux.server.config.json "$SHARED/config/config.json"
}
verify_c42_host() {
    [[ -e $SHARED/config/config.json ]] || return 10
    cmp -- /srv/srvpro-input/linux.server.config.json "$SHARED/config/config.json" || return 20
    [[ $(stat -c '%U:%G:%a' "$SHARED/config/config.json") == srvpro:srvpro:600 ]] || return 20
}
c42_adapter() {
    test ! -e "$SHARED/privatePluginConfigs/postgres-compat/config.json"
    test ! -L "$SHARED/privatePluginConfigs/postgres-compat/config.json"
    install -m 0600 -o srvpro -g srvpro /srv/srvprotianti-ops/templates/postgres-compat.config.example.json "$SHARED/privatePluginConfigs/postgres-compat/config.json"
}
verify_c42_adapter() {
    [[ -e $SHARED/privatePluginConfigs/postgres-compat/config.json ]] || return 10
    cmp -- /srv/srvprotianti-ops/templates/postgres-compat.config.example.json "$SHARED/privatePluginConfigs/postgres-compat/config.json" || return 20
    [[ $(stat -c '%U:%G:%a' "$SHARED/privatePluginConfigs/postgres-compat/config.json") == srvpro:srvpro:600 ]] || return 20
}
c42_admin() {
    ask_password MAINTENANCE_PASSWORD 'New HTTP maintenance password'
    MAINTENANCE_PASSWORD=$MAINTENANCE_PASSWORD config admin
    unset MAINTENANCE_PASSWORD
}
verify_c42_admin() {
    [[ -e $SHARED/config/admin_user.json ]] || return 10
    [[ ! -L $SHARED/config/admin_user.json && $(stat -c '%U:%G:%a' "$SHARED/config/admin_user.json") == srvpro:srvpro:600 ]] || return 20
    config verify-admin || return 20
}
register_block C42-CONFIG 42 first no 720-730 c42_host verify_c42_host 1
register_block C42-ADAPTER 42 first no 728-729 c42_adapter verify_c42_adapter 1
register_block C42-ADMIN 42 first no 736-758 c42_admin verify_c42_admin 1
register_block C42-EQUIVALENCE 42 readonly yes 689-714 config_equivalence verify_equivalence 1
stage_main() { stage_blocks 42; }
register_stage 42
