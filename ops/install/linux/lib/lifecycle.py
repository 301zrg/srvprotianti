#!/usr/bin/env python3
"""Writer inventory, complete backup plans, and journal-based reboot evidence."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time

from checks import json_file
from configuration import canonical, parameters
from state import atomic, load, now


GAME = 'srvprotianti.service'
PG = 'postgresql@17-main.service'


def command(*args):
    return subprocess.check_output(args, text=True, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL).strip()


def unit(name):
    return dict(row.split('=', 1) for row in command('systemctl', 'show', name,
                '--property=LoadState,ActiveState,MainPID,NRestarts,User,ExecMainStartTimestamp,InvocationID,ControlGroup').splitlines())


def writers(params, path, inactive=False):
    assert Path(path).is_file() and not Path(path).is_symlink(), 'writers.json is required even without backup'
    info = Path(path).stat()
    assert info.st_uid == 0 and info.st_mode & 0o777 == 0o600
    data = json_file(path)
    assert set(data) == {'writerUnits'} and data['writerUnits'] == params['writerUnits']
    for name in data['writerUnits']:
        row = unit(name)
        assert row['LoadState'] == 'loaded', 'Writer unit must exist'
        if inactive:
            assert row['ActiveState'] == 'inactive' and row['MainPID'] == '0', 'Every writer must be inactive'
            group = row.get('ControlGroup', '')
            if group:
                root = Path('/sys/fs/cgroup')/group.lstrip('/')
                for file in root.rglob('cgroup.procs'):
                    assert not file.read_text().strip(), 'Writer cgroup still has processes'
    return data


def same_or_new(path, data):
    path = Path(path)
    assert not path.is_symlink()
    if path.exists():
        assert json_file(path) == data, 'Existing plan/inventory differs; preserve it'
        assert path.stat().st_uid == 0 and path.stat().st_mode & 0o777 == 0o600
    else:
        atomic(path, data)


def backup_plan(params, shared, database, route, writers_path):
    units = writers(params, writers_path)['writerUnits']
    shared = canonical(shared)
    release = Path('/srv/srvprotianti/releases/linux-r4-1')
    names = {'replays': 'recordings', 'config': 'host-config', 'privatePluginConfigs': 'plugin-config',
             'logs': 'auth-logs', 'tournament-decks': 'tournament-decks', 'tournament-logs': 'tournament-logs', 'deck_log': 'deck-logs'}
    assert set(names) <= {p.name for p in shared.iterdir()}, 'Missing shared component'
    rows = []
    for child in sorted(shared.iterdir()):
        assert not child.is_symlink() and (child.is_file() or child.is_dir()), 'Invalid shared asset'
        name = names.get(child.name, 'shared-' + child.name.replace('_', '-'))
        rows.append({'id': name, 'source': str(child)})
    # Covers the exact newly compiled ELF and all combined engine/catalog resources.
    rows += [{'id': 'linux-runtime', 'source': str(release/'components')},
             {'id': 'service-config', 'source': '/etc/systemd/system/srvprotianti.service'},
             {'id': 'service-env', 'source': '/etc/srvprotianti/server.env'}]
    for row in params['extraMutableAssets']:
        assert set(row) == {'id', 'source'}
        source = row['source'].replace('{shared}', str(shared))
        path = canonical(source)
        assert path.exists(), 'Declared mutable asset is missing'
        # Shared and Linux runtime inventories already cover their descendants.
        if not any(path == Path(r['source']) or path.is_relative_to(Path(r['source'])) for r in rows):
            rows.append({'id': row['id'], 'source': source})
    archive = '/srv/srvpro-input/server-release.tar.gz' if route == 'A' else '/private-backups/release-input1/release.tar.gz'
    return dict(format=1, database=database, runtimeRole='srvpro_runtime', releaseArchive=archive,
                replayComponent='recordings', components=rows, writerUnits=units)


def validate_plan(plan, expected, ops_path):
    assert plan['writerUnits'] == expected['writerUnits']
    assert plan['database'] == expected['database'] and plan['runtimeRole'] == 'srvpro_runtime'
    assert plan['releaseArchive'] == expected['releaseArchive'] and plan['replayComponent'] == 'recordings'
    actual = {row['id']: row['source'] for row in plan['components']}
    assert len(actual) == len(plan['components'])
    # Additional nonoverlapping sources are permitted; all inventoried sources are mandatory.
    assert all(actual.get(row['id']) == row['source'] for row in expected['components']), 'Incomplete external backup plan'
    for row in plan['components']:
        canonical(row['source'])
    spec = importlib.util.spec_from_file_location('installer_ops', ops_path)
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    ops.validate_plan(plan)
    assert Path(plan['releaseArchive']).is_file() and Path(plan['releaseArchive'] + '.manifest.json').is_file()


def check_boot(previous, current, kernel, pg, game, accepted):
    assert previous != current, 'Boot ID unchanged: machine has not rebooted'
    assert all(t is not None for t in (kernel, pg, game, accepted)), 'Missing boot journal evidence'
    assert kernel <= pg <= game < accepted and accepted - game >= 300_000_000, 'Startup must precede first Accepted by five minutes'


def journal(*args):
    raw = command('journalctl', '-b', '--no-pager', '-o', 'json', *args)
    return [json.loads(row) for row in raw.splitlines() if row]


def boot_evidence(state_path):
    preboot = load(state_path)['blocks']['R53-PREBOOT']['evidence']
    current = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    assert preboot['bootId'] != current, 'Boot ID unchanged: machine has not rebooted'
    game, pg = unit(GAME), unit(PG)
    assert all(row['LoadState'] == 'loaded' and row['ActiveState'] == 'active' and int(row['MainPID']) > 0 for row in (game, pg))
    assert game['User'] == 'srvpro' and game['NRestarts'] == '0'
    assert Path('/proc/' + game['MainPID'] + '/cwd').resolve() == Path('/srv/srvprotianti/releases/linux-r4-1/application')
    kernel = journal('-k')
    ssh = journal('SYSLOG_IDENTIFIER=sshd')
    accepted = [int(row['__MONOTONIC_TIMESTAMP']) for row in ssh if re.search(r'\bAccepted\b', row.get('MESSAGE', ''))]
    def started(name, row):
        # ExecMainStartTimestamp is recorded as supplementary systemctl evidence;
        # PID 1's Started event also covers PG clusters logging to a regular file.
        assert row['InvocationID'] and row['ExecMainStartTimestamp']
        starts = journal('UNIT=' + name)
        timestamps = [int(r['__MONOTONIC_TIMESTAMP']) for r in starts
                      if r.get('MESSAGE_ID') == '39f53479d3a045ac8e11786248231fbf']
        assert len(timestamps) == 1, 'Missing or repeated service start in this boot'
        return timestamps[0]
    first_kernel = min(int(r['__MONOTONIC_TIMESTAMP']) for r in kernel) if kernel else None
    pg_time, game_time = started(PG, pg), started(GAME, game)
    first_accepted = min(accepted) if accepted else None
    check_boot(preboot['bootId'], current, first_kernel, pg_time, game_time, first_accepted)
    return dict(bootId=current, kernel=first_kernel, postgres=pg_time, game=game_time,
                firstAccepted=first_accepted, mainPid=game['MainPID'], restarts=game['NRestarts'],
                execMainStartTimestamp=game['ExecMainStartTimestamp'], verifiedAt=now())


def main():
    action, params_path, shared, database, route, state_path, *args = sys.argv[1:]
    params = json_file(params_path)
    parameters(params)
    inventory_path = '/etc/srvprotianti/writers.json'
    if action == 'units-exist':
        for name in params['writerUnits']:
            # Design 10.17: 41 checks only non-game writers; 52a checks all.
            if name != GAME:
                assert unit(name)['LoadState'] == 'loaded', 'Declared writer unit missing'
    elif action in ('writers', 'inactive', 'list-writers'):
        result = writers(params, inventory_path, action == 'inactive')
        if action == 'list-writers':
            print('\n'.join(result['writerUnits']))
    elif action == 'create-writers':
        # At 52a the game template must already have become a loaded unit.
        assert all(unit(name)['LoadState'] == 'loaded' for name in params['writerUnits'])
        same_or_new(inventory_path, {'writerUnits': params['writerUnits']})
    elif action in ('plan', 'verify-plan'):
        expected = backup_plan(params, shared, database, route, inventory_path)
        path = Path('/etc/srvprotianti/backup-plan.json')
        supplied = params.get('backupPlan')
        if supplied:
            assert isinstance(supplied, str) and not supplied.startswith('/') and '\\' not in supplied
            assert all(part not in ('', '.', '..') for part in supplied.split('/'))
        plan = json_file('/srv/srvpro-input/' + supplied) if supplied else expected
        validate_plan(plan, expected, '/srv/srvprotianti-ops/scripts/ops.py')
        if action == 'plan':
            same_or_new(path, plan)
        else:
            assert json_file(path) == plan
        print(json.dumps(plan, ensure_ascii=False))
    elif action == 'preboot':
        writers(params, inventory_path, True)
        assert all(command('systemctl', 'is-enabled', name) == 'enabled' for name in params['writerUnits'])
        assert command('systemctl', 'is-enabled', PG) == 'enabled'
        print(json.dumps(dict(bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                              execMainStartTimestamp=unit(GAME)['ExecMainStartTimestamp'])))
    elif action == 'postboot':
        before = boot_evidence(state_path)
        time.sleep(60)
        after = boot_evidence(state_path)
        assert before['bootId'] == after['bootId'] and before['mainPid'] == after['mainPid'] and after['restarts'] == '0'
        after['intervalSeconds'] = 60
        print(json.dumps(after))
    elif action == 'verify-postboot':
        recorded = load(state_path)['blocks'].get('R53-POSTBOOT', {}).get('evidence', {})
        assert recorded.get('intervalSeconds', 0) >= 60
        current = boot_evidence(state_path)
        assert recorded['bootId'] == current['bootId'] and recorded['mainPid'] == current['mainPid']
    else:
        raise ValueError('Unknown lifecycle action')


if __name__ == '__main__':
    try:
        main()
    except AssertionError as error:
        if str(error) == 'Boot ID unchanged: machine has not rebooted':
            print('FAIL 53b: boot_id unchanged; machine has not rebooted', file=sys.stderr)
        else:
            print('FAIL lifecycle: inventory, plan or journal evidence failed; preserve private reports', file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('FAIL lifecycle: missing or inconsistent inventory, plan or reboot evidence; preserve private reports', file=sys.stderr)
        sys.exit(1)
