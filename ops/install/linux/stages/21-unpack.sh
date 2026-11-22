#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L251-266, U21-UNPACK.
u21_unpack() {
    as_deploy "$DEPLOY_HOME" "$(cat <<'U21_UNPACK_BODY'
cd -- "$HOME" || return
INPUT=/srv/srvpro-input
WORK="$HOME/srvpro-linux-work"
test ! -e "$WORK"
install -d -m 0700 "$WORK" "$WORK/reports"
python3 "$INPUT/ops/scripts/ops.py" verify-release --archive "$INPUT/server-release.tar.gz" | tee "$WORK/reports/verify-release.json"
python3 "$INPUT/ops/scripts/ops.py" unpack-release --archive "$INPUT/server-release.tar.gz" --destination "$WORK/release"
test -f "$WORK/release/application/package-lock.json"
# A maintainer delivery carries the production ygopro.exe; a public production-layout engine
# (ops/docs/reproduce-scope.md) carries no binary. Either way stage 22/23 builds the Linux ELF.
test -f "$WORK/release/components/engine/ygopro.exe" || python3 -c 'import json,sys; assert json.load(open(sys.argv[1], encoding="utf-8"))["runtimeStatus"] == "public-production-layout"' "$WORK/release/components/engine/engine-manifest.json"
test -f "$WORK/release/components/engine/strings.conf"
test -d "$WORK/release/components/engine/script"
test -d "$WORK/release/components/catalog"
U21_UNPACK_BODY
)"
    BLOCK_EVIDENCE="{\"releaseArchiveSha256\":\"$(state sha /srv/srvpro-input/server-release.tar.gz)\"}"
}
verify_u21_unpack() {
    if targets_absent "$WORK"; then return 10; fi
    [[ -f $WORK/release/application/package-lock.json && -f $WORK/release/components/engine/strings.conf && -d $WORK/release/components/engine/script && -d $WORK/release/components/catalog ]] || return 20
    [[ -f $WORK/release/components/engine/ygopro.exe ]] || python3 -c 'import json,sys; assert json.load(open(sys.argv[1], encoding="utf-8"))["runtimeStatus"] == "public-production-layout"' "$WORK/release/components/engine/engine-manifest.json" 2>/dev/null || return 20
    python3 /srv/srvpro-input/ops/scripts/ops.py verify-release --archive /srv/srvpro-input/server-release.tar.gz >/dev/null || return 20
    python3 "$INSTALL_ROOT/lib/checks.py" unpacked "$WORK/release" || return 20
}
register_block U21-UNPACK 21 first no 251-266 u21_unpack verify_u21_unpack

# Entry for stage 21; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 21; }
register_stage 21
