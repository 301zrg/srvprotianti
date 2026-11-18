#!/usr/bin/env python3
"""Read-only postconditions and bounded native/runtime probes for stages 4-6."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request

from checks import json_file
from configuration import SHARED_NAMES, comparison, diff, parameters
from lifecycle import unit, command, GAME, PG
from state import load


def config_signature(phase, snapshots):
    return hashlib.sha256(json.dumps([phase, *snapshots], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def metadata(path, uid, mode, gid=None):
    p = Path(path)
    assert not p.is_symlink()
    info = p.stat()
    assert info.st_uid == uid and info.st_mode & 0o777 == mode
    assert info.st_gid == (uid if gid is None else gid)


def layout(shared):
    import pwd
    row = pwd.getpwnam('srvpro')
    assert row.pw_shell == '/usr/sbin/nologin' and row.pw_dir == '/srv/srvprotianti'
    for name in ('', *SHARED_NAMES):
        metadata(Path(shared)/name, row.pw_uid, 0o750, row.pw_gid)
        assert (Path(shared)/name).is_dir()
    for path in ('/srv/srvprotianti', '/srv/srvprotianti/releases'):
        metadata(path, 0, 0o755)


def permissions(app, shared):
    import pwd
    account = pwd.getpwnam('srvpro')
    uid = account.pw_uid
    release = Path(app).parent
    replay = release/'components/linux-engine/replay'
    for root in (release, Path('/srv/srvprotianti-ops')):
        for p in (root, *root.rglob('*')):
            if p.is_symlink():
                continue
            info = p.stat()
            writable = p == replay or p.is_relative_to(replay)
            assert info.st_uid == (uid if writable else 0)
            assert info.st_gid == (account.pw_gid if writable else 0)
            assert not info.st_mode & 0o022
            assert info.st_mode & 0o004 or writable
            if p.is_dir() and not writable:
                assert info.st_mode & 0o777 == 0o755
            elif p.is_file() and not writable:
                assert info.st_mode & 0o666 == 0o644
    for p in (Path(shared), *Path(shared).rglob('*')):
        assert not p.is_symlink()
        mode = 0o750 if p.is_dir() else 0o640
        if p.is_file() and any(p.is_relative_to(Path(shared)/n) for n in ('config', 'privatePluginConfigs')):
            mode = 0o600
        metadata(p, uid, mode, account.pw_gid)
    metadata(replay, uid, 0o750, account.pw_gid)


def links(app, shared):
    expected = {Path(app)/'config': Path(shared)/'config', Path(app)/'logs': Path(shared)/'logs',
                Path('/srv/srvprotianti/current'): Path(app)}
    adapter = Path(shared)/'privatePluginConfigs/postgres-compat/config.json'
    if adapter.exists():
        expected[Path(app)/'plugins/postgres-compat/config.json'] = adapter
    for source, target in expected.items():
        assert source.is_symlink() and os.readlink(source) == str(target)


def smoke(shared, app):
    engine = Path(app).parent/'components/linux-engine'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    log = Path(shared)/'logs'/('engine-smoke-' + stamp + '.log')
    with log.open('x') as error:
        p = subprocess.Popen([str(engine/'ygopro'), '0', '0', '0', '0', 'F', 'F', 'F', '8000', '5', '1', '300', '0'],
                             cwd=engine, stdout=subprocess.PIPE, stderr=error, stdin=subprocess.DEVNULL)
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(p.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=15).strip()
            assert line.isdigit() and 0 < int(line) <= 65535
            with socket.create_connection(('127.0.0.1', int(line)), timeout=5):
                pass
            assert p.poll() is None
        finally:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)
            p.stdout.close()
    print('PASS native engine TCP smoke')


def readiness(params, app, wait=False, report=None):
    invocation = unit(GAME)['InvocationID']
    assert invocation
    for attempt in range(46 if wait else 1):
        listen = command('ss', '-H', '-ltn')
        ports = {int(r.split()[3].rsplit(':', 1)[1]) for r in listen.splitlines()}
        if set(params['ports'].values()) <= ports:
            break
        if wait and attempt < 45:
            time.sleep(2)
    raw = command('journalctl', '-b', '-u', GAME, '_SYSTEMD_INVOCATION_ID=' + invocation, '--no-pager', '-o', 'cat')
    if report:
        # Host authentication records may contain management account names.
        safe = re.sub(r'(?m)^.*(?:Unknown user login|Unauthorized user login|Disabled user login|'
                      r'Permission denied|Operation success)\. User:.*\n?', '', raw)
        fd = os.open(report, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(safe + '\n')
    assert set(params['ports'].values()) <= ports, 'Ports not ready within 90 seconds'
    game = unit(GAME)
    assert game['InvocationID'] == invocation and game['ActiveState'] == 'active'
    assert game['User'] == 'srvpro' and game['NRestarts'] == '0' and int(game['MainPID']) > 0
    assert Path('/proc/' + game['MainPID'] + '/cwd').resolve() == Path(app)
    assert unit(PG)['ActiveState'] == 'active'
    records = []
    lru_warning_tail = False
    for line in raw.splitlines():
        try:
            records.append(json.loads(line))
        except ValueError:
            # lru-cache's UnboundedCacheWarning is the documented exception.
            if 'UnboundedCacheWarning' in line:
                lru_warning_tail = True
            elif lru_warning_tail and '--trace-warnings' in line and 'warning was created' in line:
                lru_warning_tail = False
            else:
                assert not re.search(r'error|warn', line, re.I)
    plugins = [r.get('plugin') or r.get('name') for r in records if r.get('msg') == 'Plugin loaded']
    assert len(plugins) == len(params['enabledPlugins']) and set(plugins) == set(params['enabledPlugins'])
    assert any(r.get('msg') == 'Card catalog loaded' and r.get('cards', 0) > 0 for r in records)
    assert 'server not open due to config' in raw
    assert not any(r.get('level', 0) >= 40 for r in records)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:' + str(params['ports']['http']) + '/', timeout=10) as response:
        assert response.status == 200
    print(json.dumps(dict(invocation=invocation, mainPid=game['MainPID'], report=report)))


def ssh_ports():
    rows = command('ss', '-H', '-tlnp').splitlines()
    return sorted({int(r.split()[3].rsplit(':', 1)[1]) for r in rows if '"sshd"' in r})


def firewall(params, port):
    assert port in ssh_ports(), 'SSH port is not an sshd listener'
    status = command('ufw', 'status', 'verbose')
    assert 'Status: active' in status
    assert re.search(r'(?m)^' + str(port) + r'/tcp\s+ALLOW IN\s+Anywhere', status)
    for target in params['ports'].values():
        assert re.search(r'(?m)^' + str(target) + r'/tcp\s+ALLOW IN\s+' + re.escape(params['testCidr']) + r'(?:\s|$)', status)


def main():
    action, params_path, shared, app, *args = sys.argv[1:]
    params = json_file(params_path)
    parameters(params)
    expected = '/srv/srvpro-input/expected-config.json'
    if action == 'layout':
        layout(shared)
    elif action == 'permissions':
        permissions(app, shared)
    elif action == 'links':
        links(app, shared)
    elif action == 'smoke':
        smoke(shared, app)
    elif action in ('readiness', 'verify-readiness'):
        report = '/etc/srvprotianti/reports/start-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.log'
        readiness(params, app, action == 'readiness', report if action == 'readiness' else None)
    elif action == 'config-signature':
        phase, database = args
        print(config_signature(phase, comparison(app, shared, expected, phase, params, database)))
    elif action == 'verify-equivalence':
        state_path, block, phase, database = args
        row = load(state_path)['blocks'][block]['evidence']
        snapshots = comparison(app, shared, expected, phase, params, database)
        assert row['signature'] == config_signature(phase, snapshots)
        assert [r['key'] for r in row['differences']] == [list(key) for key in diff(*snapshots)]
        assert row['approver'] and row['at'] and all(r['reason'] for r in row['differences'])
    elif action == 'accepted':
        row = load(args[0])['blocks'][args[1]]['evidence']
        assert row['accepted'] is True and row['inspector'] and row['at']
    elif action == 'ssh-ports':
        print(json.dumps(ssh_ports()))
    elif action == 'firewall':
        firewall(params, int(args[0]))
    elif action == 'verify-firewall':
        row = load(args[0])['blocks']['N61-FIREWALL']['evidence']
        assert row['newConnectionConfirmed'] is True
        firewall(params, row['sshPort'])
    elif action == 'ports-closed':
        listen = command('ss', '-H', '-ltn')
        ports = {int(r.split()[3].rsplit(':', 1)[1]) for r in listen.splitlines()}
        assert not set(params['ports'].values()) & ports
    elif action == 'preboot-record':
        row = load(args[0])['blocks']['R53-PREBOOT']['evidence']
        assert row['bootId'] and 'execMainStartTimestamp' in row
    elif action == 'same-boot':
        row = load(args[0])['blocks']['R53-PREBOOT']['evidence']
        sys.exit(0 if row['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip() else 10)
    elif action == 'verify-backup':
        state = load(args[0])
        row = state['blocks'].get('M52-BACKUP', {}).get('evidence', {})
        if row.get('backup') == 'NOT_BACKED_UP':
            print(json.dumps(row))
            return
        if row.get('backup') == 'verified':
            batch = row['batch']
        else:
            starts = [i for i, r in enumerate(state['history']) if r.get('begin') == 'M52-BACKUP']
            assert starts
            intents = [r for r in state['history'][starts[-1] + 1:] if r.get('backupIntent') == 'M52-BACKUP']
            assert intents
            batch = intents[-1]['destination']
        assert not (Path(batch)/'FAILED.json').exists()
        subprocess.run(['python3', '/srv/srvprotianti-ops/scripts/ops.py', 'verify', '--batch', batch],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(json.dumps(dict(backup='verified', batch=batch)))
    elif action == 'diagnose-journal':
        # Diagnostics must not replay arbitrary application records or credentials.
        raw = command('journalctl', '-b', '-u', GAME, '-u', PG, '--no-pager', '-n', '100', '-o', 'json')
        rows = [json.loads(line) for line in raw.splitlines() if line]
        print(json.dumps(dict(records=len(rows), timestamps=[r.get('__MONOTONIC_TIMESTAMP') for r in rows],
                              priorities=[r.get('PRIORITY') for r in rows])))
    else:
        raise ValueError('Unknown read-only runtime action')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL runtime: postcondition failed; values withheld; inspect private evidence', file=sys.stderr)
        sys.exit(1)
