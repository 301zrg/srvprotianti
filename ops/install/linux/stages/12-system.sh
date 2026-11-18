#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L179-194, S12-APT; deployment checks, then root package operations.
s12_apt() {
    local minimum
    minimum=$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1])).get("minFreeGiB",10); assert type(value) is int and value>0; print(value)' "$PARAMS")
    as_deploy / '. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
test "$(uname -m)" = x86_64
df -h / /srv "$HOME"
MIN_FREE_GIB=${MIN_FREE_GIB:-10}
test "$(df -B1 --output=avail / | tail -n 1)" -ge "$((MIN_FREE_GIB * 1024 * 1024 * 1024))"' "MIN_FREE_GIB=$minimum"
    cd -- / || return
    apt-get update
    apt-get install -y ca-certificates curl git git-lfs python3 xz-utils file \
        build-essential pkg-config libevent-dev libsqlite3-dev liblzma-dev postgresql-common ufw
}

verify_s12_apt() {
    local package
    for package in ca-certificates curl git git-lfs python3 xz-utils file build-essential pkg-config libevent-dev libsqlite3-dev liblzma-dev postgresql-common ufw; do
        [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) == 'install ok installed' ]] || return 10
    done
}

# Manual L199-216, S12-NODE; no root build/npm and no overwrites.
s12_node() {
    as_deploy /srv/srvpro-input 'NODE_VERSION=24.15.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
awk -v f="$NODE_ARCHIVE" '\''$2==f {print}'\'' SHASUMS256.txt > "$HOME/srvpro-node.sha256"
test "$(wc -l < "$HOME/srvpro-node.sha256")" -eq 1
sha256sum --check "$HOME/srvpro-node.sha256"'
    cd -- /srv/srvpro-input || return
    test ! -e /opt/node24
    install -d -m 0755 /opt/node24
    tar --extract --xz --file node-v24.15.0-linux-x64.tar.xz --strip-components=1 --directory /opt/node24
    as_deploy /srv/srvpro-input 'node --version
npm --version
python3 --version
git lfs version'
    verify_s12_node
    BLOCK_EVIDENCE="{\"nodeArchiveSha256\":\"$(state sha /srv/srvpro-input/node-v24.15.0-linux-x64.tar.xz)\"}"
}

verify_s12_node() {
    if targets_absent /opt/node24 "$DEPLOY_HOME/srvpro-node.sha256"; then return 10; fi
    [[ -x /opt/node24/bin/node && $(/opt/node24/bin/node --version) == v24.15.0 ]] || return 20
    /opt/node24/bin/npm --version >/dev/null || return 20
}

# Manual L223-239, S12-PG; root APT/systemd, postgres peer SQL.
s12_pg() {
    cd -- / || return
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
    apt-get update
    apt-get install -y postgresql-17 postgresql-client-17
    pg_lsclusters
    systemctl cat postgresql@17-main.service
    systemctl enable --now postgresql@17-main.service
    /usr/lib/postgresql/17/bin/pg_isready -h 127.0.0.1 -p 5432 -t 3
    as_postgres '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -c '\''SHOW server_version;'\'''
    /usr/lib/postgresql/17/bin/pg_dump --version
    /usr/lib/postgresql/17/bin/pg_restore --version
    apt-cache policy postgresql-17 postgresql-client-17 postgresql-common
    dpkg-query -W postgresql-17 postgresql-client-17 postgresql-common build-essential libevent-dev libsqlite3-dev liblzma-dev
    verify_s12_pg
}

verify_s12_pg() {
    [[ -x /usr/lib/postgresql/17/bin/pg_isready ]] || return 10
    /usr/lib/postgresql/17/bin/pg_isready -h 127.0.0.1 -p 5432 -t 3 >/dev/null || return 10
    systemctl is-enabled postgresql@17-main.service >/dev/null || return 10
    [[ $(pg_scalar 'SHOW server_version_num') == 17* ]] || return 20
    [[ $(pg_scalar 'SHOW port') == 5432 ]] || return 20
    systemctl is-active --quiet postgresql@17-main.service || return 10
    pg_lsclusters --no-header | awk '$1=="17" && $2=="main" && $3=="5432" && $4=="online" {good++} END {exit !(good==1)}' || return 20
    [[ $(/usr/lib/postgresql/17/bin/pg_dump --version) == *' 17.'* && $(/usr/lib/postgresql/17/bin/pg_restore --version) == *' 17.'* ]] || return 20
}

register_block S12-APT 12 idempotent yes 179-194 s12_apt verify_s12_apt
register_block S12-NODE 12 first no 199-216 s12_node verify_s12_node
register_block S12-PG 12 idempotent yes 223-239 s12_pg verify_s12_pg

# Entry for stage 12; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 12; }
register_stage 12
