#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L350-361, B23-COMPOSE (first part of manual block B23).
b23_compose() {
    as_deploy "$WORK/release/application" 'WORK="$HOME/srvpro-linux-work"
RELEASE="$WORK/release"
test ! -e "$RELEASE/components/linux-engine"
cp -a "$RELEASE/components/engine" "$RELEASE/components/linux-engine"
test ! -e "$RELEASE/components/linux-engine/ygopro"
install -m 0755 "$WORK/engine-build/source/bin/release/ygopro" "$RELEASE/components/linux-engine/ygopro"'
    BLOCK_EVIDENCE="{\"linuxEngineSha256\":\"$(state sha "$WORK/release/components/linux-engine/ygopro")\"}"
}
verify_b23_compose() {
    [[ -e $WORK/release/components/linux-engine ]] || return 10
    [[ -x $WORK/release/components/linux-engine/ygopro ]] || return 20
    cmp "$WORK/engine-build/source/bin/release/ygopro" "$WORK/release/components/linux-engine/ygopro" || return 20
    diff -qr --exclude=ygopro "$WORK/release/components/engine" "$WORK/release/components/linux-engine" || return 20
}

# Manual L362-367, B23-LINKS.
b23_links() {
    as_deploy "$WORK/release/application" 'test ! -e ygopro
test ! -L ygopro
test ! -e plugins/card-catalog/databases
test ! -L plugins/card-catalog/databases
ln -s ../components/linux-engine ygopro
ln -s ../../../components/catalog plugins/card-catalog/databases'
}
verify_b23_links() {
    local app=$WORK/release/application
    if [[ ! -e $app/ygopro && ! -L $app/ygopro && ! -e $app/plugins/card-catalog/databases && ! -L $app/plugins/card-catalog/databases ]]; then return 10; fi
    [[ $(readlink "$app/ygopro") == ../components/linux-engine && $(readlink "$app/plugins/card-catalog/databases") == ../../../components/catalog ]] || return 20
}

# Manual L368-372, B23-NPM; deployment user, strict pipeline failure propagation.
b23_npm() {
    as_deploy "$WORK/release/application" 'WORK="$HOME/srvpro-linux-work"
RELEASE="$WORK/release"
npm ci 2>&1 | tee "$WORK/reports/npm-ci.log"
npm run build 2>&1 | tee "$WORK/reports/npm-build.log"
python3 /srv/srvpro-input/ops/scripts/ops.py catalog-check --catalog "$RELEASE/components/catalog" --versions /srv/srvpro-input/ops/versions.json
node plugins/postgres-compat/deployment/schema.js check-contract
npm test 2>&1 | tee "$WORK/reports/npm-test.log"'
}
verify_b23_npm() {
    # Existence of node_modules/logs cannot prove npm/test exit statuses.
    if block_done B23-NPM; then return 0; fi
    return 20
}

# Manual L373-376, B23-INSTALL-RELEASE; destination is never overwritten.
b23_install_release() {
    test ! -e /srv/srvprotianti/releases/linux-r4-1
    test ! -L /srv/srvprotianti/releases/linux-r4-1
    test ! -e /srv/srvprotianti-ops
    install -d -m 0755 /srv/srvprotianti /srv/srvprotianti/releases
    cp -a "$WORK/release" /srv/srvprotianti/releases/linux-r4-1
}
verify_b23_install_release() {
    [[ -e /srv/srvprotianti/releases/linux-r4-1 ]] || return 10
    diff -qr "$WORK/release" /srv/srvprotianti/releases/linux-r4-1 || return 20
}

# Manual L377, B23-INSTALL-OPS.
b23_install_ops() {
    test ! -e /srv/srvprotianti-ops
    test ! -L /srv/srvprotianti-ops
    cp -a /srv/srvpro-input/ops /srv/srvprotianti-ops
}
verify_b23_install_ops() {
    [[ -e /srv/srvprotianti-ops ]] || return 10
    diff -qr /srv/srvpro-input/ops /srv/srvprotianti-ops || return 20
}

# Manual L378-384, B23-PERMISSIONS.
b23_permissions() {
    chown -R root:root /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops
    find /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops \
        \( -type d -o -type f \) -exec chmod go-w {} +
    local writable
    writable=$(find /srv/srvprotianti/releases/linux-r4-1 /srv/srvprotianti-ops \( -type d -o -type f \) -perm /022 -print)
    test -z "$writable"
}
verify_b23_permissions() {
    python3 "$INSTALL_ROOT/lib/checks.py" permissions /srv/srvprotianti/releases/linux-r4-1 || return 10
    python3 "$INSTALL_ROOT/lib/checks.py" permissions /srv/srvprotianti-ops || return 10
}

register_block B23-COMPOSE 23 first no 350-361 b23_compose verify_b23_compose
register_block B23-LINKS 23 first no 362-367 b23_links verify_b23_links
register_block B23-NPM 23 idempotent yes 368-372 b23_npm verify_b23_npm
register_block B23-INSTALL-RELEASE 23 first no 373-376 b23_install_release verify_b23_install_release
register_block B23-INSTALL-OPS 23 first no 377 b23_install_ops verify_b23_install_ops
register_block B23-PERMISSIONS 23 idempotent yes 378-384 b23_permissions verify_b23_permissions

# Entry for stage 23; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 23; }
register_stage 23
