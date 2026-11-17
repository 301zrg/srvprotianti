#!/usr/bin/env python3
"""Read-only evidence checks used for pending recovery and verify-block."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.dont_write_bytecode = True


def json_file(path):
    return json.loads(Path(path).read_text('utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree(path, omit_sidecars=False):
    path = Path(path)
    assert path.is_dir()
    result = {}
    for item in path.rglob('*'):
        assert not item.is_symlink()
        if item.is_file():
            if omit_sidecars and item.name.endswith(('.cdb-wal', '.cdb-shm')):
                continue
            result[item.relative_to(path).as_posix()] = (item.stat().st_size, sha(item))
        else:
            assert item.is_dir()
    return result


def restored(restore, database):
    restore = Path(restore)
    manifest = json_file('/srv/srvpro-input/joint-batch/manifest.json')
    report = json_file(restore / 'restore-result.json')
    assert report['batchId'] == manifest['batchId']
    assert report['destination'] == str(restore)
    assert report['targetDatabase']['database'] == database
    assert all(report[key] is True for key in ('complete', 'databaseAndFilesVerified', 'replayAssociationsVerified'))
    verification = report['databaseStateVerification']
    assert verification['scope'] == 'whole-batch'
    assert verification['independentRowCountsVerified'] is True
    spec = importlib.util.spec_from_file_location('ops', '/srv/srvprotianti-ops/scripts/ops.py')
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    # Read-only recovery rechecks the live whole-database state, not just a report
    # that may have been written before an interruption or later manual changes.
    os.environ.update(PGHOST='127.0.0.1', PGPORT='5432', PGUSER='srvpro_operator',
                      PGPASSFILE='/etc/srvprotianti/ops.pgpass')
    actual_verification = ops.verify_restored_state(manifest['databaseState'], ops.Postgres(database, '/usr/lib/postgresql/17/bin'))
    assert actual_verification == verification
    release_manifest = json_file('/srv/srvpro-input/joint-batch/release.manifest.json')
    assert tree(restore/'release') == {row['path']: (row['size'], row['sha256']) for row in release_manifest['files']}
    for component in manifest['components']:
        assert ops.same_content(ops.inventory(restore/'runtime'/component['id']), component['files'])
    if 'rowDigestFormat' in manifest['databaseState']:
        assert verification['algorithm'] == manifest['databaseState']['rowDigestFormat'] == ops.ROW_DIGEST_FORMAT
        assert verification['matchedRecordEnding'] == 'lf'
    else:
        assert verification['algorithm'] == ops.LEGACY_ROW_DIGEST
        ending = verification['matchedRecordEnding']
        assert ending in ('lf', 'crlf', 'ambiguous-empty')
        if ending == 'ambiguous-empty':
            assert all(row['rows'] == 0 for row in manifest['databaseState']['tables'])
    components = Path('/srv/srvprotianti/releases/linux-r4-1/components')
    for name in ('engine', 'catalog'):
        assert ops.content_entries(ops.inventory(restore / 'release/components' / name)) == ops.content_entries(ops.inventory(components / name))
    for name in ('engine', 'catalog'):
        origin = restore / 'runtime' / name
        if origin.exists():
            target = components / name
            if name == 'engine':
                platform = json_file('/srv/srvpro-input/handover-params.json')['runtimeEngine']
                assert platform in ('linux', 'windows'), 'Declare runtime engine in the handover path table'
                if platform == 'linux':
                    target = components / 'linux-engine'
            assert tree(origin, True) == tree(target, True), 'Independent runtime differs'


def main():
    action, *args = sys.argv[1:]
    if action == 'restore':
        restored(*args)
    elif action == 'source':
        destination = Path(args[0])
        manifest = json_file('/srv/srvpro-input/linux-build-input/manifest.json')
        expected = {row['path']: (row['bytes'], row['sha256']) for row in manifest['files']}
        assert tree(destination) == expected
    elif action == 'report':
        report = json_file(args[0])
        assert report['ok'] is True
    elif action == 'permissions':
        root = Path(args[0])
        assert root.is_dir() and root.stat().st_uid == 0
        for path in root.rglob('*'):
            if not path.is_symlink():
                assert path.stat().st_uid == 0 and path.stat().st_mode & 0o022 == 0
    elif action == 'unpacked':
        expected = json_file('/srv/srvpro-input/server-release.tar.gz.manifest.json')['files']
        assert tree(args[0]) == {row['path']: (row['size'], row['sha256']) for row in expected}
    elif action == 'binding':
        params_path, deploy_uid, deploy_home, commit, handover_digest, script_root = args
        params = json_file(params_path)
        required = {'machineName', 'route', 'releaseName', 'database', 'restoreDir', 'stagingDirectory', 'opsCommit', 'ports'}
        assert required <= params.keys(), 'Missing machine-readable handover parameter'
        assert params['route'] in ('A', 'B')
        # These are the fixed names in the approved manual, apart from B retarget.
        assert params['releaseName'] == 'linux-r4-1'
        assert params['database'] == ('srvpro_1103' if params['route'] == 'A' else 'srvpro_restore_1103')
        assert params['restoreDir'] == '/private-restores/batch1'
        assert params['opsCommit'] == commit
        assert params['machineName'] == subprocess.check_output(['hostnamectl', '--static'], text=True).strip()
        assert isinstance(params['ports'], dict)
        for key in ('game', 'http', 'wss'):
            assert isinstance(params['ports'][key], int) and 0 < params['ports'][key] <= 65535
        script_root = Path(script_root)
        delivered_root = Path(params_path).parent / 'ops/install/linux'
        scripts = {}
        for path in [script_root/'install.sh', *(script_root/'lib').glob('*'), *(script_root/'stages').glob('*.sh')]:
            if path.suffix in ('.sh', '.py'):
                relative = path.relative_to(script_root).as_posix()
                assert not path.is_symlink() and sha(path) == sha(delivered_root/relative), 'Executing scripts differ from the delivery'
                scripts[relative] = sha(path)
        script_digest = hashlib.sha256(json.dumps(scripts, sort_keys=True).encode()).hexdigest()
        print(json.dumps({'machine': params['machineName'], 'deployUid': int(deploy_uid), 'deployHome': deploy_home,
                          'scriptCommit': commit, 'handoverDigest': handover_digest, 'route': params['route'],
                          'release': params['releaseName'], 'database': params['database'], 'restoreDir': params['restoreDir'],
                          'paramsDigest': sha(params_path), 'scriptDigest': script_digest,
                          'stagingDirectory': params['stagingDirectory']}, sort_keys=True))
    else:
        raise ValueError('Unknown check')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, ValueError, KeyError, OSError, TypeError, subprocess.SubprocessError):
        print('FAIL read-only evidence check; preserve targets and inspect private reports', file=sys.stderr)
        sys.exit(20)
