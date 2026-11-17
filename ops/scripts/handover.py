#!/usr/bin/env python3
"""Assemble a NEW offline Linux handover from explicit local inputs and Git blobs.

No network or database access. Private input filenames are arguments, never values.
The independent manifest line is printed to stdout, outside the inventoried tree.
"""
import argparse
import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys


def load(path):
    return json.loads(Path(path).read_text('utf-8-sig'))


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def ordinary(path):
    path = Path(path).absolute()
    for ancestor in (path, *path.parents):
        info = ancestor.lstat()
        assert not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400, 'Link/reparse input'
    return path


def relative(name):
    assert isinstance(name, str) and name and '\\' not in name and ':' not in name
    assert not any(c in name for c in '\t\r\n\x00')
    assert not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/'))
    return PurePosixPath(name)


def inventory(root):
    rows = []
    for path in sorted(Path(root).rglob('*')):
        ordinary(path)
        assert path.is_file() or path.is_dir(), 'Special material'
        if path.is_file():
            name = path.relative_to(root).as_posix()
            relative(name)
            assert path.stat().st_size or name.startswith('joint-batch/'), 'Empty material'
            rows.append((path.stat().st_size, digest(path), name))
    return rows


def write(path, value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    with Path(path).open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(text)
    os.chmod(path, 0o600)


def redact(value):
    if isinstance(value, dict):
        return {k: '<redacted>' if re.search(r'password|passwd|token|secret|credential|authorization', k, re.I)
                else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def validate_params(params):
    assert params['route'] in ('A', 'B') and params['releaseName'] == 'linux-r4-1'
    assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', params['machineName'])
    assert re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', params['database'])
    assert params['database'] == ('srvpro_1103' if params['route'] == 'A' else 'srvpro_restore_1103')
    assert params['restoreDir'] == '/private-restores/batch1'
    for name in ('restoreDir', 'stagingDirectory'):
        value = params[name]
        assert value.startswith('/') and str(PurePosixPath(value)) == value
        assert '..' not in value.split('/') and '\\' not in value
    assert params['restoreDir'].startswith('/private-restores/')
    assert set(params['ports']) == {'game', 'http', 'wss'}
    assert all(type(p) is int and 1 <= p <= 65535 for p in params['ports'].values())
    assert len(set(params['ports'].values())) == 3
    assert params['sshPort'] is None or type(params['sshPort']) is int and 1 <= params['sshPort'] <= 65535
    network = ipaddress.ip_network(params['testCidr'], strict=True)
    assert network.is_private and not network.is_loopback and not network.is_unspecified
    user, message = params['managementUsername'], params['maintenanceMessage']
    assert user and not any(c in user for c in ':\r\n\x00')
    assert message and message != 'false' and not any(c in message for c in '\r\n\x00')
    assert params['route'] != 'A' or user == 'maintenance'
    units = params['writerUnits']
    assert isinstance(units, list) and len(set(units)) == len(units) and 'srvprotianti.service' in units
    assert 'postgresql@17-main.service' not in units
    assert all(re.fullmatch(r'[A-Za-z0-9_@.:-]+\.service', u) for u in units)
    assert isinstance(params['extraMutableAssets'], list)
    assert isinstance(params['enabledPlugins'], list) and params['enabledPlugins']
    assert len(set(params['enabledPlugins'])) == len(params['enabledPlugins'])
    assert all(re.fullmatch(r'[a-z0-9-]+', p) for p in params['enabledPlugins'])


def assemble(repo, commit, materials, output, params, expected):
    repo, materials, output = Path(repo), ordinary(materials), Path(output).absolute()
    ordinary(output.parent)
    assert not output.exists() and not output.is_symlink(), 'Output must be new'
    assert not output.is_relative_to(materials) and not materials.is_relative_to(output), 'Overlapping material/output'
    assert re.fullmatch('[0-9a-f]{40}', commit), 'Use an explicit full ops commit'
    # The caller's source object is never changed. The exported commit is authoritative.
    params = copy.deepcopy(params)
    params['opsCommit'] = commit
    required = {'machineName', 'route', 'releaseName', 'database', 'restoreDir', 'stagingDirectory',
                'ports', 'sshPort', 'testCidr', 'managementUsername', 'maintenanceMessage',
                'writerUnits', 'extraMutableAssets', 'enabledPlugins'}
    assert required <= params.keys(), 'Incomplete parameter page'
    validate_params(params)
    assert isinstance(expected, dict) and set(expected) == {'host', 'adapter'} and isinstance(expected['host'], dict), 'Effective expected config is required'
    assert params == redact(params), 'Parameter page must not contain credentials'
    expected = redact(expected)
    for name in ('handover.tsv', 'handover-files.sha256', 'handover.md', 'handover-params.json', 'expected-config.json', 'ops'):
        assert not (materials/name).exists(), 'Reserved material name'
    inventory(materials)
    needed = ['server-release.tar.gz', 'server-release.tar.gz.manifest.json',
              'node-v24.15.0-linux-x64.tar.xz', 'SHASUMS256.txt',
              'linux-build-input/linux-build-source.tar.gz', 'linux-build-input/manifest.json']
    needed += ['linux.server.config.json'] if params['route'] == 'A' else ['joint-batch/manifest.json']
    assert all((materials/name).is_file() for name in needed), 'Missing material'
    raw = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', '-r', '-z', commit, '--', 'ops'], stderr=subprocess.DEVNULL)
    blobs = []
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t')
        mode, kind, oid = meta.decode('ascii').split()
        name = name.decode('utf-8')
        relative(name)
        assert mode in ('100644', '100755') and kind == 'blob' and name.startswith('ops/'), 'Unsafe Git export'
        blobs.append((name, oid))
    required_ops = {'ops/install/linux/' + name for name in ('install.sh', 'lib/workflow.sh',
                    'lib/configuration.py', 'lib/lifecycle.py', 'lib/runtime.py',
                    'stages/41-layout.sh', 'stages/53-reboot.sh', 'stages/61-firewall.sh')}
    required_ops |= {'ops/scripts/maintenance.py', 'ops/scripts/handover.py'}
    assert required_ops <= {name for name, _ in blobs}, 'Commit lacks complete installer'
    output.mkdir(mode=0o700)
    for child in materials.iterdir():
        if child.is_dir():
            shutil.copytree(child, output/child.name)
        else:
            shutil.copy2(child, output/child.name)
    for name, oid in blobs:
        data = subprocess.check_output(['git', '-C', str(repo), 'cat-file', 'blob', oid], stderr=subprocess.DEVNULL)
        assert b'\r' not in data, 'Exported ops contains CR'
        target = output/name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    # No circular commit/hash promise: the manual describes this export convention.
    write(output/'handover-params.json', params)
    write(output/'expected-config.json', expected)
    page = '# Linux 私有交接参数页\n\nopsCommit: `' + commit + '`（导出 Git blob，不取工作树）\n\n'
    for key in sorted(params):
        page += '- ' + key + ': ' + json.dumps(params[key], ensure_ascii=False) + '\n'
    page += '\n配置期望值见 expected-config.json；口令通过私有独立渠道提供，不能写入本页。\n'
    page += '清单自身的大小与 SHA 由工具 stdout 输出，请通过独立渠道发送给操作者。\n'
    write(output/'handover.md', page)
    for path in output.rglob('*'):
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    rows = inventory(output)
    write(output/'handover.tsv', ''.join(f'{size}\t{sha}\t{name}\n' for size, sha, name in rows))
    return f'{(output/"handover.tsv").stat().st_size}\t{digest(output/"handover.tsv")}\thandover.tsv'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'commit', 'materials', 'output', 'params', 'expected-config'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    try:
        print(assemble(args.repo, args.commit, args.materials, args.output, load(args.params), load(args.expected_config)))
        return 0
    except Exception:
        # Input paths, JSON errors and subprocess diagnostics may contain secrets.
        print('FAIL handover: inspect local inputs; preserve partial output and use a new directory', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
