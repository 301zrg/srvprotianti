#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L282-311, E22-SOURCE.
e22_source() {
    as_deploy "$WORK" "$(cat <<'E22_SOURCE_BODY'
WORK="$HOME/srvpro-linux-work"
INPUT=/srv/srvpro-input
cd "$WORK"
python3 - "$INPUT" "$WORK" <<'PY'
import hashlib, importlib.util, json, pathlib, sys
inputs, work = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(inputs/'ops/scripts'))
spec = importlib.util.spec_from_file_location('engine_source', inputs/'ops/scripts/engine-source.py')
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
manifest = json.loads((inputs/'linux-build-input/manifest.json').read_text('utf-8'))
versions = json.loads((inputs/'ops/versions.json').read_text('utf-8'))
assert manifest['source'] == versions['engine']['source'], 'Build source profile differs'
archive = inputs/'linux-build-input/linux-build-source.tar.gz'
assert archive.stat().st_size == manifest['archiveBytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['archiveSha256']
destination = work/'engine-build'
source.extract_archive(archive, destination)
expected = {row['path']: row for row in manifest['files']}
actual = {p.relative_to(destination).as_posix(): p for p in destination.rglob('*') if p.is_file()}
assert actual.keys() == expected.keys(), 'Source inventory differs'
for name, path in actual.items():
    assert path.stat().st_size == expected[name]['bytes'], name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected[name]['sha256'], name
print('Source files verified:', len(actual))
PY
E22_SOURCE_BODY
)"

}
# Manual L315-335, E22-BUILD.
e22_build() {
    as_deploy "$WORK/engine-build/source" "$(cat <<'E22_BUILD_BODY'
WORK="$HOME/srvpro-linux-work"
cd "$WORK/engine-build/source"
test -f ocgcore/ocgapi.cpp
test -f lua/src/lua.h
test -f gframe/config.h
chmod 0755 premake5
cp -a premake/. .
cp -a resource/. .
./premake5 gmake --use-simd=sse2 2>&1 | tee "$WORK/reports/premake.log"
make -C build -j2 config=release 2>&1 | tee "$WORK/reports/engine-build.log"
test -x bin/release/ygopro
file bin/release/ygopro
ldd bin/release/ygopro | tee "$WORK/reports/engine-ldd.log"
! grep -q 'not found' "$WORK/reports/engine-ldd.log"
sha256sum bin/release/ygopro | tee "$WORK/reports/linux-engine.sha256"
c++ --version
make --version
E22_BUILD_BODY
)"
    verify_e22_build
    BLOCK_EVIDENCE="{\"linuxEngineSha256\":\"$(state sha "$WORK/engine-build/source/bin/release/ygopro")\"}"
}
verify_e22_source() {
    [[ -e $WORK/engine-build ]] || return 10
    python3 "$INSTALL_ROOT/lib/checks.py" source "$WORK/engine-build" || return 20
}
verify_e22_build() {
    [[ -x $WORK/engine-build/source/bin/release/ygopro ]] || return 10
    as_deploy "$WORK/engine-build/source" 'WORK="$HOME/srvpro-linux-work"
description=$(file bin/release/ygopro)
grep -q "ELF 64-bit.*x86-64" <<< "$description"
libraries=$(ldd bin/release/ygopro)
if grep -q "not found" <<< "$libraries"; then exit 20; fi
test -s "$WORK/reports/linux-engine.sha256"
sha256sum --check "$WORK/reports/linux-engine.sha256"' || return 20
}
register_block E22-SOURCE 22 first no 282-311 e22_source verify_e22_source
register_block E22-BUILD 22 idempotent yes 315-335 e22_build verify_e22_build

# Entry for stage 22; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 22; }
register_stage 22
