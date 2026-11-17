#!/usr/bin/env python3
"""Private installer state. No credentials may be passed to this module."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

VERSION = 1


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, 'Duplicate JSON key'
        result[key] = value
    return result


def invalid_constant(_value):
    raise ValueError('Non-JSON constant')


def checked_binding(value):
    keys = {'machine', 'deployUid', 'deployHome', 'scriptCommit', 'handoverDigest', 'route',
            'release', 'database', 'restoreDir', 'paramsDigest', 'scriptDigest', 'stagingDirectory'}
    assert isinstance(value, dict) and keys <= value.keys() <= keys | {'shared'}
    assert value['route'] in ('A', 'B') and type(value['deployUid']) is int and value['deployUid'] > 0
    assert all(isinstance(item, str) and item for key, item in value.items() if key != 'deployUid')
    assert re.fullmatch('[0-9a-f]{40}', value['scriptCommit'])
    for key in ('handoverDigest', 'paramsDigest', 'scriptDigest'):
        assert re.fullmatch('[0-9a-f]{64}', value[key])
    assert re.fullmatch('[a-z_][a-z0-9_]{0,62}', value['database'])
    assert value['deployHome'].startswith('/') and value['restoreDir'].startswith('/private-restores/')
    assert value['stagingDirectory'].startswith(value['deployHome'] + '/')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def atomic(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load(path):
    path = Path(path)
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_uid == os.geteuid(), 'State owner mismatch'
    value = json.loads(path.read_text('utf-8'), object_pairs_hook=unique_object, parse_constant=invalid_constant)
    assert set(value) == {'version', 'binding', 'blocks', 'pending', 'history'}
    assert value['version'] == VERSION, 'Unsupported state version'
    checked_binding(value['binding'])
    assert isinstance(value['blocks'], dict)
    assert isinstance(value['history'], list) and all(isinstance(row, dict) for row in value['history'])
    assert value['pending'] is None or isinstance(value['pending'], str)
    for key, row in value['blocks'].items():
        assert isinstance(key, str) and isinstance(row, dict)
        assert set(row) == {'completedAt', 'evidence'}
        assert isinstance(row['completedAt'], str) and isinstance(row['evidence'], dict)
        datetime.datetime.fromisoformat(row['completedAt'])
    return value


def manifest(root):
    """Both delivery formats become (canonical name, bytes, SHA-256)."""
    root = Path(root)
    names = ('handover.tsv', 'handover-files.sha256')
    present = [name for name in names if (root / name).is_file()]
    assert present, 'No handover manifest'
    models = []
    for filename in present:
        rows = {}
        for line in (root / filename).read_text('utf-8').splitlines():
            if filename.endswith('.tsv'):
                size, sha, name = line.split('\t')
                assert size.isascii() and size.isdigit(), 'Invalid size'
                size = int(size)
            else:
                assert len(line) > 66 and line[64] == ' ' and line[65] in ' *'
                sha, name = line[:64], line[66:]
                size = None
            if name.startswith('./'):
                name = name[2:]
            assert name and not name.startswith('/') and '\\' not in name
            assert not any(p in ('', '.', '..') for p in name.split('/'))
            assert ':' not in name and not any(c in name for c in '\t\r\n\x00')
            assert name not in names and name not in rows, 'Self entry or duplicate'
            assert len(sha) == 64 and all(c in '0123456789abcdefABCDEF' for c in sha)
            path = root / name
            ancestor = root
            for part in name.split('/'):
                ancestor = ancestor / part
                assert not ancestor.is_symlink(), 'Link in manifest path'
            assert path.is_file() and not path.is_symlink(), 'Not a regular file'
            actual = path.stat().st_size
            assert actual > 0 or name.startswith('joint-batch/'), 'Empty material'
            assert size is None or actual == size, 'Size mismatch'
            assert digest(path) == sha.lower(), 'SHA mismatch'
            rows[name] = (actual, sha.lower())
        assert rows, 'Empty manifest'
        models.append(rows)
    actual = set()
    for path in root.rglob('*'):
        info = path.lstat()
        assert stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'Link or special file'
        name = path.relative_to(root).as_posix()
        if path.is_file() and name not in names:
            actual.add(name)
    assert actual == models[0].keys(), 'Incomplete file inventory'
    assert all(model == models[0] for model in models), 'Manifests disagree'
    canonical = json.dumps(models[0], sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(canonical).hexdigest()


def main():
    action, *args = sys.argv[1:]
    if action == 'manifest':
        print(manifest(args[0]))
        return
    if action == 'sha':
        print(digest(args[0]))
        return
    path = Path(args.pop(0))
    if action == 'create':
        assert not path.exists(), 'State exists'
        binding = json.loads(args[0])
        checked_binding(binding)
        atomic(path, dict(version=VERSION, binding=binding, blocks={}, pending=None, history=[]))
        return
    state = load(path)
    if action == 'show':
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return
    if action == 'binding':
        print(json.dumps(state['binding'], ensure_ascii=False, sort_keys=True))
        return
    if action == 'check-binding':
        expected = json.loads(args[0])
        retargets = [row for row in state['history'] if 'retargetFrom' in row]
        if retargets:
            assert retargets[0]['retargetFrom'] == expected
            for previous, following in zip(retargets, retargets[1:]):
                assert previous['retargetTo'] == following['retargetFrom']
            assert retargets[-1]['retargetTo'] == state['binding']
        else:
            assert state['binding'] == expected, 'Installation binding changed; stop'
        return
    if action == 'pending':
        print(state['pending'] or '')
        return
    if action == 'done':
        sys.exit(0 if args[0] in state['blocks'] else 1)
    if action == 'validate-blocks':
        assert set(state['blocks']) <= set(args)
        assert state['pending'] is None or state['pending'] in args
        return
    if action == 'begin':
        assert state['pending'] is None, 'Unresolved pending block'
        state['pending'] = args[0]
        state['history'].append({'at': now(), 'begin': args[0]})
    elif action == 'complete':
        assert state['pending'] in (None, args[0]), 'Different pending block'
        evidence = json.loads(args[1])
        if not evidence and args[0] in state['blocks']:
            evidence = state['blocks'][args[0]]['evidence']
        state['blocks'][args[0]] = {'completedAt': now(), 'evidence': evidence}
        state['pending'] = None
    elif action == 'clear-pending':
        assert state['pending'] == args[0]
        state['pending'] = None
    elif action == 'invalidate':
        assert state['pending'] is None
        old_blocks = {key: state['blocks'][key] for key in args if key in state['blocks']}
        for block in args:
            state['blocks'].pop(block, None)
        state['history'].append({'at': now(), 'invalidated': args, 'previousBlocks': old_blocks})
    elif action == 'backup-intent':
        block, destination = args
        assert state['pending'] == block == 'M52-BACKUP'
        assert destination.startswith('/private-backups/1103-')
        state['history'].append({'at': now(), 'backupIntent': block, 'destination': destination})
    elif action == 'retarget':
        assert state['binding']['route'] == 'B'
        database, restore_dir, shared, *invalidated = args
        assert database != state['binding']['database']
        assert restore_dir != state['binding']['restoreDir']
        old = dict(state['binding'])
        old_blocks = {key: state['blocks'][key] for key in invalidated if key in state['blocks']}
        old_pending = state['pending']
        state['binding']['database'] = database
        state['binding']['restoreDir'] = restore_dir
        if shared:
            state['binding']['shared'] = shared
        checked_binding(state['binding'])
        state['pending'] = None
        for block in invalidated:
            state['blocks'].pop(block, None)
        state['history'].append({'at': now(), 'retargetFrom': old, 'retargetTo': dict(state['binding']),
                                 'invalidated': invalidated, 'previousBlocks': old_blocks, 'previousPending': old_pending})
    else:
        raise ValueError('Unknown state action')
    atomic(path, state)


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, ValueError, KeyError, OSError, TypeError) as error:
        # JSON exceptions and OS paths may contain private inputs. Keep errors bounded.
        reason = str(error) if isinstance(error, AssertionError) else type(error).__name__
        reason = reason or 'Invalid structure or permissions'
        action = sys.argv[1] if len(sys.argv) > 1 else 'arguments'
        print(f'FAIL state/{action}: {reason}; preserve evidence', file=sys.stderr)
        sys.exit(1)
