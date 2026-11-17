#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L671-685 and design 10.9/10.17: root, new target machine.
l41_params() {
    config params /srv/srvpro-input/expected-config.json
    lifecycle units-exist
    ask_yes 'Expected config is present; all non-game writer units exist; parameter page reviewed'
}
verify_l41_params() { config params /srv/srvpro-input/expected-config.json || return 10; lifecycle units-exist || return 10; }
l41_account() {
    if getent passwd srvpro >/dev/null; then die 'srvpro already exists; preserve it'; fi
    useradd --system --user-group --no-create-home --home-dir /srv/srvprotianti --shell /usr/sbin/nologin srvpro
}
verify_l41_account() {
    local row
    row=$(getent passwd srvpro) || return 10
    [[ $row == *:/srv/srvprotianti:/usr/sbin/nologin ]] || return 20
    [[ $(id -gn srvpro) == srvpro ]] || return 20
    [[ $(id -u srvpro) -gt 0 ]] || return 20
}
l41_layout() {
    chown root:root /srv/srvprotianti /srv/srvprotianti/releases
    chmod 0755 /srv/srvprotianti /srv/srvprotianti/releases
    test ! -e "$SHARED"
    test ! -L "$SHARED"
    install -d -m 0750 -o srvpro -g srvpro "$SHARED"
    local name
    for name in config replays tournament-decks tournament-logs deck_log logs privatePluginConfigs privatePluginConfigs/postgres-compat; do
        install -d -m 0750 -o srvpro -g srvpro "$SHARED/$name"
    done
}
verify_l41_layout() { [[ -e $SHARED ]] || return 10; runtime layout || return 20; }
register_block L41-PARAMS 41 readonly yes 689-714 l41_params verify_l41_params
register_block L41-ACCOUNT 41 first no 675-676 l41_account verify_l41_account
register_block L41-LAYOUT 41 first no 677-684 l41_layout verify_l41_layout
stage_main() { stage_blocks 41; }
register_stage 41
