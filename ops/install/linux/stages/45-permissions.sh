#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L896-938; each link is a separate first-action boundary.
p45_link() {
    local target=$1 source=$2
    test ! -e "$target"
    test ! -L "$target"
    ln -s "$source" "$target"
}
p45_config() { p45_link "$APP/config" "$SHARED/config"; }
p45_logs() { p45_link "$APP/logs" "$SHARED/logs"; }
p45_adapter() {
    if [[ -f $SHARED/privatePluginConfigs/postgres-compat/config.json ]]; then
        p45_link "$APP/plugins/postgres-compat/config.json" "$SHARED/privatePluginConfigs/postgres-compat/config.json"
    fi
}
p45_current() { p45_link /srv/srvprotianti/current "$APP"; }
verify_link() { [[ -L $1 && $(readlink -- "$1") == "$2" ]] || return 20; }
verify_p45_config() { verify_link "$APP/config" "$SHARED/config"; }
verify_p45_logs() { verify_link "$APP/logs" "$SHARED/logs"; }
verify_p45_adapter() {
    if [[ -f $SHARED/privatePluginConfigs/postgres-compat/config.json ]]; then
        verify_link "$APP/plugins/postgres-compat/config.json" "$SHARED/privatePluginConfigs/postgres-compat/config.json" || return 20
    fi
}
verify_p45_current() { verify_link /srv/srvprotianti/current "$APP"; }
p45_permissions() {
    local release=${APP%/application}
    chown -R root:root "$release" /srv/srvprotianti-ops
    find "$release" /srv/srvprotianti-ops -type d -exec chmod 0755 {} +
    find "$release" /srv/srvprotianti-ops -type f -exec chmod a+r,u+w,go-w {} +
    chmod 0755 "$release/components/linux-engine/ygopro"
    chown -R srvpro:srvpro "$SHARED"
    find "$SHARED" -type d -exec chmod 0750 {} +
    find "$SHARED" -type f -exec chmod 0640 {} +
    find "$SHARED/config" "$SHARED/privatePluginConfigs" -type f -exec chmod 0600 {} +
    install -d -m 0750 -o srvpro -g srvpro "$release/components/linux-engine/replay"
    chown srvpro:srvpro "$release/components/linux-engine/replay"
    chmod 0750 "$release/components/linux-engine/replay"
    verify_p45_permissions
}
verify_p45_permissions() {
    runtime permissions || return 10
    as_srvpro "$APP" 'test -r config/config.json || exit 1
test -x /opt/node24/bin/node || exit 1
test -x ygopro/ygopro || exit 1
test -r plugins/card-catalog/databases/cards.zh.cdb || exit 1
test -w config || exit 1
test -w logs || exit 1
test -w ygopro/replay || exit 1
test ! -w . || exit 1
test ! -w ygopro || exit 1
test ! -w ygopro/cards.cdb || exit 1' || return 10
}
register_block P45-CONFIG-LINK 45 first no 902-908 p45_config verify_p45_config
register_block P45-LOGS-LINK 45 first no 909 p45_logs verify_p45_logs
register_block P45-ADAPTER-LINK 45 first no 910-914 p45_adapter verify_p45_adapter
register_block P45-PERMISSIONS 45 idempotent yes 915-925 p45_permissions verify_p45_permissions
register_block P45-CURRENT 45 first no 927-929 p45_current verify_p45_current
stage_main() { stage_blocks 45; }
register_stage 45
