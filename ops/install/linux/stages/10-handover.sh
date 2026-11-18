#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L72-88, H10-LAND: root landing; target must be new.
h10_confirm_landing() {
    local confirmation
    python3 - "$PARAMS" "$DEPLOY_USER" "$DEPLOY_HOME" <<'PY' >/dev/tty
import json, sys
p = json.load(open(sys.argv[1], encoding='utf-8'))
print(json.dumps({key: p[key] for key in ('route','releaseName','ports')}, ensure_ascii=False, indent=2))
print('Deploy account:', sys.argv[2], 'HOME:', sys.argv[3])
PY
    ask_text confirmation "Route $ROUTE, release linux-r4-1, DB $DATABASE; inspect handover ports and confirm yes"
    [[ $confirmation == yes ]] || die 'Parameter page not confirmed'
}

h10_land() {
    local landing=${1:-/srv/srvpro-input}
    h10_confirm_landing
    cd -- / || return
    test -d "$STAGING"
    if [[ $ROUTE == B ]]; then test -d "$STAGING/joint-batch"; fi
    if [[ -d $STAGING/joint-batch ]]; then
        python3 - "$STAGING/joint-batch" <<'PY'
import pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
for path in [root, *root.rglob('*')]:
    assert stat.S_IMODE(path.lstat().st_mode) == (0o700 if path.is_dir() else 0o600), 'Private staging batch must have manual 0700/0600 modes'
PY
    fi
    test ! -e "$landing"
    test ! -L "$landing"
    cp -a "$STAGING" "$landing"
    chown -R root:root "$landing"
    find "$landing" -path "$landing/joint-batch" -prune -o -type d -exec chmod 0755 {} +
    find "$landing" -path "$landing/joint-batch" -prune -o -type f -exec chmod 0644 {} +
    if test -d "$landing/joint-batch"; then
        find "$landing/joint-batch" -type d -exec chmod 0700 {} +
        find "$landing/joint-batch" -type f -exec chmod 0600 {} +
    fi
    INPUT=$landing
    PARAMS=$INPUT/handover-params.json
    INSTALL_ROOT=$INPUT/ops/install/linux
}

verify_h10_land() {
    local landing=${1:-/srv/srvpro-input}
    if targets_absent "$landing"; then return 10; fi
    [[ -d $landing && ! -L $landing ]] || return 20
    python3 - "$INSTALL_ROOT/lib" "$landing" <<'PY' || return 20
import pathlib, stat, sys
sys.path.insert(0, sys.argv[1])
from state import manifest
root = pathlib.Path(sys.argv[2])
manifest(root)
for path in [root, *root.rglob('*')]:
    info = path.lstat()
    assert info.st_uid == info.st_gid == 0
    private = path == root/'joint-batch' or root/'joint-batch' in path.parents
    mode = (0o700 if path.is_dir() else 0o600) if private else (0o755 if path.is_dir() else 0o644)
    assert stat.S_IMODE(info.st_mode) == mode
PY
}

# Manual L95-101, H10-INDEPENDENT: independent-channel checkpoint.
h10_independent() {
    local file size expected_sha actual_sha accepted=''
    for file in handover.tsv handover-files.sha256; do
        if [[ -f /srv/srvpro-input/$file ]]; then
            stat -c '%n %s bytes' "/srv/srvpro-input/$file" >/dev/tty
            sha256sum "/srv/srvpro-input/$file" >/dev/tty
            ask_text size "Independent channel byte count for $file (not the parameter page)"
            ask_text expected_sha "Independent channel SHA-256 for $file"
            [[ $size =~ ^[0-9]+$ && $expected_sha =~ ^[a-fA-F0-9]{64}$ ]] || die 'Invalid independent manifest evidence'
            actual_sha=$(state sha "/srv/srvpro-input/$file")
            [[ $(stat -c %s "/srv/srvpro-input/$file") == "$size" && $actual_sha == "${expected_sha,,}" ]] || die 'Independent-channel manifest mismatch'
            accepted+="$file:$size:$actual_sha;"
        fi
    done
    [[ -n $accepted ]] || die 'No manifest'
    BLOCK_EVIDENCE=$(python3 -c 'import json,sys; print(json.dumps({"independentManifests":sys.argv[1],"inspector":sys.argv[2]}))' "$accepted" "$DEPLOY_USER")
}

verify_h10_independent() {
    # Human acceptance cannot be inferred from interrupted prompts.
    if block_done H10-INDEPENDENT; then return 0; fi
    return 10
}

# Manual L106-146, H10-INVENTORY; design 10.8 unifies both manifest formats.
h10_inventory() {
    local actual
    actual=$(state manifest /srv/srvpro-input)
    [[ $actual == "$HANDOVER_DIGEST" ]] || die 'Landing differs from bound inventory'
    test -f /srv/srvpro-input/ops/scripts/ops.py
    test -f /srv/srvpro-input/ops/scripts/engine-source.py
    test -f /srv/srvpro-input/server-release.tar.gz.manifest.json
    test -f /srv/srvpro-input/linux-build-input/manifest.json
    BLOCK_EVIDENCE="{\"inventorySha256\":\"$actual\"}"
}

verify_h10_inventory() { h10_inventory; }

# Manual L154-169, H10-REMOVE-STAGING; B only, after verified landing.
h10_remove_staging() {
    cd -- / || return
    printf '%s\n' 'Next invocation: sudo bash /srv/srvpro-input/ops/install/linux/install.sh run' >/dev/tty
    test "$(realpath -e -- "$DEPLOY_HOME")" = "$DEPLOY_HOME"
    case "$DEPLOY_HOME" in /home/*) ;; *) die 'Expected deploy HOME under /home' ;; esac
    test "$(realpath -e -- "$STAGING")" = "$STAGING"
    case "$STAGING" in "$DEPLOY_HOME"/*) ;; *) die 'Staging must be below deploy HOME' ;; esac
    test -d "$STAGING/joint-batch"
    test -d /srv/srvpro-input/joint-batch
    test "$(state manifest "$STAGING")" = "$(state manifest /srv/srvpro-input)"
    local file
    for file in handover.tsv handover-files.sha256; do
        if [[ -f /srv/srvpro-input/$file ]]; then cmp -- "$STAGING/$file" "/srv/srvpro-input/$file"; fi
    done
    rm -rf --one-file-system -- "$STAGING"
    test ! -e "$STAGING"
}

verify_h10_remove_staging() {
    if [[ ! -e $STAGING && ! -L $STAGING ]]; then return 0; fi
    return 20
}

register_block H10-LAND 10 first no 72-88 h10_land verify_h10_land
register_block H10-INDEPENDENT 10 readonly yes 95-101 h10_independent verify_h10_independent
register_block H10-INVENTORY 10 readonly yes 106-146 h10_inventory verify_h10_inventory
if [[ $ROUTE == B ]]; then register_block H10-REMOVE-STAGING 10 first no 154-169 h10_remove_staging verify_h10_remove_staging; fi

# Entry for stage 10; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 10; }
register_stage 10
