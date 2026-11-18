#!/usr/bin/env python3
"""Configuration and component mapping; errors and diffs contain keys only."""
import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys

from checks import tree


def json_file(path):
    # The manual accepts BOM-bearing restored Windows configuration files.
    return json.loads(Path(path).read_text('utf-8-sig'))


SHARED_NAMES = ('config', 'replays', 'tournament-decks', 'tournament-logs', 'deck_log',
                'logs', 'privatePluginConfigs', 'privatePluginConfigs/postgres-compat')
DEFAULT_SHARED = '/srv/srvprotianti/shared'
MYSQL_ENABLED = ('host', 'modules', 'mysql', 'enabled')
LEGACY_CONNECTION = ('host', 'modules', 'mysql', 'db')
ADAPTER_CONNECTION = ('adapter', 'connection')
EXPECTED_PHASES = ('delivered', 'final')
DEFAULT_PLUGINS = ('card-catalog', 'deck-classifier', 'ladder-core', 'ladder-analytics',
                   'ladder-usage-analytics', 'ladder-replay-enrichment', 'ladder-web',
                   'public-replay-web', 'public-room-web', 'postgres-compat')


def merge(base, override):
    if not isinstance(base, dict) or not isinstance(override, dict):
        return copy.deepcopy(override)
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = merge(result[key], value) if key in result else copy.deepcopy(value)
    return result


def diff(expected, actual, prefix=()):
    if isinstance(expected, dict) and isinstance(actual, dict):
        result = []
        for key in sorted(expected.keys() | actual.keys()):
            if key not in expected or key not in actual:
                result.append(prefix + (key,))
            else:
                result.extend(diff(expected[key], actual[key], prefix + (key,)))
        return result
    return [] if type(expected) is type(actual) and expected == actual else [prefix]


def canonical(path):
    path = Path(path)
    assert path.is_absolute() and str(path) == str(path.resolve()), 'Noncanonical path'
    return path


def parameters(params):
    assert set(params['ports']) == {'game', 'http', 'wss'}
    for key in ('game', 'http', 'wss'):
        assert type(params['ports'][key]) is int and 1 <= params['ports'][key] <= 65535
    assert len(set(params['ports'].values())) == 3
    if params.get('sshPort') is not None:
        assert type(params['sshPort']) is int and 1 <= params['sshPort'] <= 65535
    network = ipaddress.ip_network(params['testCidr'], strict=True)
    assert network.is_private and not network.is_unspecified and not network.is_loopback, 'Use a private test CIDR'
    message = params['maintenanceMessage']
    assert isinstance(message, str) and message and message != 'false' and not any(c in message for c in '\r\n\x00')
    if params['route'] == 'A':
        assert params['managementUsername'] == 'maintenance', 'A uses the manual maintenance account'
    else:
        assert 'managementUsername' not in params, 'B selects its maintenance account on the target'
    units = params['writerUnits']
    assert isinstance(units, list) and units and len(set(units)) == len(units)
    assert 'srvprotianti.service' in units and 'postgresql@17-main.service' not in units
    assert all(isinstance(u, str) and re.fullmatch(r'[A-Za-z0-9_@.:-]+\.service', u) for u in units)
    assert isinstance(params['extraMutableAssets'], list)
    assert isinstance(params['enabledPlugins'], list) and params['enabledPlugins']
    assert len(set(params['enabledPlugins'])) == len(params['enabledPlugins'])
    assert all(re.fullmatch('[a-z0-9-]+', p) for p in params['enabledPlugins'])


def private_write(path, value, exclusive=False):
    import pwd
    path = Path(path)
    assert not path.is_symlink()
    account = pwd.getpwnam('srvpro')
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.chmod(path, 0o600)
    os.chown(path, account.pw_uid, account.pw_gid)


def effective(app, shared):
    app, shared = Path(app), Path(shared)
    host = merge(json_file(app/'data/default_config.json'), json_file(shared/'config/config.json'))
    adapter = shared/'privatePluginConfigs/postgres-compat/config.json'
    return {'host': host, 'adapter': json_file(adapter) if adapter.exists() else None}


def validate_expected(expected):
    assert isinstance(expected, dict) and set(expected) == set(EXPECTED_PHASES), 'Expected config phases'
    for phase in expected.values():
        assert isinstance(phase, dict) and set(phase) == {'host', 'adapter'}, 'Expected config documents'
        assert isinstance(phase['host'], dict) and (phase['adapter'] is None or isinstance(phase['adapter'], dict))


def comparison(app, shared, expected_path, phase, params, database):
    expected = json_file(expected_path)
    validate_expected(expected)
    expected = redact(expected[phase])
    actual = redact(effective(app, shared))
    if phase == 'final' and (str(shared) != DEFAULT_SHARED or database != params['database']):
        rebase_final(expected, params, shared, database)
    # The enabled adapter makes the host save this flag as true. Keep checking
    # adapter enablement and every other setting, including legacy MySQL enablement.
    if adapter_enabled(expected) and adapter_enabled(actual):
        if value_at(expected, MYSQL_ENABLED) is False and value_at(actual, MYSQL_ENABLED) is True:
            set_value(actual, MYSQL_ENABLED, False)
    return expected, actual


def differences(app, shared, expected_path, phase, params, database):
    return [list(key) for key in diff(*comparison(app, shared, expected_path, phase, params, database))]


def redact(value):
    if isinstance(value, dict):
        return {k: '<redacted>' if re.search(r'password|passwd|token|secret|credential|authorization', k, re.I)
                else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def value_at(payloads, keys):
    node = payloads
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def set_value(payloads, keys, value):
    node = payloads
    for key in keys[:-1]:
        node = node.setdefault(key, {})
    node[keys[-1]] = value


def adapter_enabled(payloads):
    return value_at(payloads, ('adapter', 'enabled')) is True


def installation_paths(params, shared):
    shared = PurePosixPath(shared)
    paths = {('host', 'modules', 'tournament_mode', key): str(shared/name) + '/'
             for key, name in {'deck_path': 'tournament-decks', 'replay_path': 'replays',
                               'log_save_path': 'tournament-logs'}.items()}
    paths['host', 'modules', 'deck_log', 'local'] = str(shared/'deck_log') + '/'
    # Explicit tuple paths preserve literal dots; never replace arbitrary strings.
    for row in params.get('pathMappings', []):
        assert row['document'] in ('host', 'adapter') and isinstance(row['keys'], list) and row['keys']
        assert all(isinstance(k, str) and k for k in row['keys'])
        prefix = DEFAULT_SHARED + '/'
        target = row['target']
        assert isinstance(target, str) and target.startswith(prefix)
        path = target.rstrip('/')
        assert str(PurePosixPath(path)) == path and '..' not in PurePosixPath(path).parts and '\\' not in path
        paths[(row['document'], *row['keys'])] = str(shared) + '/' + target[len(prefix):]
    return paths


def connection_updates(payloads, params, shared, database, password):
    plugin = adapter_enabled(payloads)
    connection = ADAPTER_CONNECTION if plugin else LEGACY_CONNECTION
    assert plugin or value_at(payloads, MYSQL_ENABLED) is True, 'No declared database connection'
    assert isinstance(value_at(payloads, connection), dict)
    updates = {connection + (key,): value for key, value in
               dict(type='postgres', host='127.0.0.1', port=5432, database=database,
                    username='srvpro_runtime', password=password, synchronize=False).items()}
    if payloads['adapter'] is not None:
        updates['adapter', 'synchronize'] = False
        updates['adapter', 'environment'] = dict.fromkeys(('host', 'port', 'database', 'username', 'password'), '')
    updates['host', 'modules', 'stop'] = params['maintenanceMessage']
    paths = installation_paths(params, shared)
    for row in params.get('pathMappings', []):
        parent = value_at(payloads, (row['document'], *row['keys'][:-1]))
        assert isinstance(parent, dict) and row['keys'][-1] in parent, 'Undeclared configuration path'
    updates.update(paths)
    return updates


def rebase_final(expected, params, shared, database):
    connection = ADAPTER_CONNECTION if adapter_enabled(expected) else LEGACY_CONNECTION
    key = connection + ('database',)
    if value_at(expected, key) == params['database']:
        set_value(expected, key, database)
    rebound = installation_paths(params, shared)
    for keys, original in installation_paths(params, DEFAULT_SHARED).items():
        if value_at(expected, keys) == original:
            set_value(expected, keys, rebound[keys])


def update_connection(app, shared, params, database):
    shared = canonical(shared)
    host = shared/'config/config.json'
    adapter = shared/'privatePluginConfigs/postgres-compat/config.json'
    payloads = {'host': json_file(host), 'adapter': json_file(adapter) if adapter.exists() else None}
    password = os.environ.pop('RUNTIME_PASSWORD')
    assert password and not any(c in password for c in '\r\n\x00')
    effective_payloads = dict(payloads, host=merge(json_file(Path(app)/'data/default_config.json'), payloads['host']))
    updates = connection_updates(effective_payloads, params, str(shared), database, password)
    for target in installation_paths(params, str(shared)).values():
        canonical(target.rstrip('/'))
    for keys, value in updates.items():
        set_value(payloads, keys, value)
    private_write(host, payloads['host'])
    if payloads['adapter'] is not None:
        private_write(adapter, payloads['adapter'])


def connection_valid(app, shared, params, database):
    shared = Path(shared)
    payloads = effective(app, shared)
    connection = ADAPTER_CONNECTION if adapter_enabled(payloads) else LEGACY_CONNECTION
    password = value_at(payloads, connection + ('password',))
    assert isinstance(password, str) and password and not any(c in password for c in '\r\n\x00')
    for keys, value in connection_updates(payloads, params, str(shared), database, password).items():
        assert not diff(value, value_at(payloads, keys))
    # Windows drive paths are invalid on this target, including undeclared plugin paths.
    for root in (shared/'config', shared/'privatePluginConfigs'):
        for path in root.rglob('*.json'):
            if path == shared/'config/admin_user.json':
                continue
            def walk(value):
                if isinstance(value, dict):
                    for child in value.values():
                        walk(child)
                elif isinstance(value, list):
                    for child in value:
                        walk(child)
                elif isinstance(value, str):
                    assert not re.search(r'(?i)(?:^|[\s"\x27])[a-z]:[\\/]', value), 'Unmapped Windows path (value withheld)'
                    assert not value.startswith('\\\\'), 'Unmapped UNC path (value withheld)'
            walk(json_file(path))


def component_plan(restore, shared, params):
    restore, shared = canonical(restore), canonical(shared)
    manifest = json_file('/srv/srvpro-input/joint-batch/manifest.json')
    ids = {row['id'] for row in manifest['components']}
    assert len(ids) == len(manifest['components'])
    mapping = json_file(restore/'restore-map.json')
    assert isinstance(mapping, list) and len(mapping) == len(ids)
    assert {row['id'] for row in mapping} == ids, 'Restore map must cover every actual component'
    assert {p.name for p in (restore/'runtime').iterdir()} == ids, 'Uninventoried restored component'
    originals = {row['id']: row['originalSource'] for row in manifest['components']}
    for row in mapping:
        assert row['new'] == str(restore/'runtime'/row['id']) and row['old'] == originals[row['id']], 'Restore map changed'
    assert not {'adapter-config', 'plugin-config'} <= ids, 'Mutually exclusive adapter components'
    required = {'recordings': 'replays', 'host-config': 'config', 'tournament-decks': 'tournament-decks',
                'tournament-logs': 'tournament-logs', 'deck-logs': 'deck_log'}
    optional = {'adapter-config': 'privatePluginConfigs/postgres-compat', 'plugin-config': 'privatePluginConfigs', 'auth-logs': 'logs'}
    assert required.keys() <= ids, 'Missing required restored component'
    declared = params.get('componentMap', [])
    extras = {row['id']: row for row in declared}
    assert len(extras) == len(declared) and extras.keys() <= ids
    rows = []
    for name in sorted(ids):
        assert re.fullmatch('[a-z0-9][a-z0-9-]*', name)
        origin = restore/'runtime'/name
        assert origin.is_dir() and not origin.is_symlink()
        tree(origin)  # Empty component directories are valid, links are not.
        if name in required or name in optional:
            assert name not in extras, 'Standard component policy cannot be overridden'
            rows.append(dict(id=name, required=name in required, action='copy', source=str(origin),
                             target=str(shared/(required | optional)[name])))
        elif name in ('engine', 'catalog'):
            # Stage 33 has checked complete runtime content. Never overwrite the Linux ELF.
            assert name not in extras
            rows.append(dict(id=name, required=False, action='evidence', reason='verified by B33-RESTORE', source=str(origin)))
        elif name.startswith('app-runtime-') or name in ('service-config', 'service-env'):
            assert name not in extras
            rows.append(dict(id=name, required=False, action='rebuild' if name.startswith('app-runtime-') else 'evidence',
                             reason='Linux build / new unit and server.env', source=str(origin)))
        else:
            assert name in extras, 'Unknown component; supply an explicit componentMap row'
            row = dict(extras[name], source=str(origin))
            assert type(row['required']) is bool and row['action'] in ('copy', 'rebuild', 'evidence') and row['reason']
            if row['action'] == 'copy':
                target = canonical(row['target'].replace('{shared}', str(shared)))
                assert target.is_relative_to(shared) and target != shared
                row['target'] = str(target)
            rows.append(row)
    return rows


def copies(rows):
    result = []
    targets = set()
    for row in rows:
        if row['action'] != 'copy':
            continue
        origin, target = Path(row['source']), Path(row['target'])
        assert not target.is_symlink()
        for parent in target.parents:
            assert not parent.is_symlink()
        for path in origin.rglob('*'):
            assert not path.is_symlink()
            if path.is_file() and not path.name.endswith(('.cdb-wal', '.cdb-shm')):
                dest = target/path.relative_to(origin)
                for parent in dest.parents:
                    assert not parent.is_symlink()
                assert dest not in targets, 'Overlapping mapping'
                targets.add(dest)
                result.append((path, dest))
    return result


def main():
    action, params_path, shared, app, *args = sys.argv[1:]
    params = json_file(params_path)
    parameters(params)
    if action == 'params':
        assert Path(args[0]).is_file(), 'expected-config.json is required'
        validate_expected(json_file(args[0]))
    elif action == 'diff':
        expected_path, phase, database = args
        print(json.dumps(differences(app, shared, expected_path, phase, params, database), ensure_ascii=False))
    elif action == 'connection':
        update_connection(app, shared, params, args[0])
    elif action == 'verify-connection':
        connection_valid(app, shared, params, args[0])
    elif action == 'admin':
        password = os.environ.pop('MAINTENANCE_PASSWORD')
        assert password and not any(c in password for c in '\r\n\x00')
        private_write(Path(shared)/'config/admin_user.json', {'file': './config/admin_user.json', 'permission_examples': {},
                      'users': {'maintenance': {'password': password, 'enabled': True, 'permissions': {'stop': True}}}}, True)
    elif action == 'verify-admin':
        row = json_file(Path(shared)/'config/admin_user.json')['users'][params['managementUsername']]
        assert row['enabled'] is True and row['permissions']['stop'] is True and row['password']
    elif action in ('plan-map', 'copy-map', 'verify-map'):
        rows = component_plan(args[0], shared, params)
        if action == 'plan-map':
            print(json.dumps([{k: v for k, v in r.items() if k != 'source'} for r in rows], ensure_ascii=False))
        else:
            pairs = copies(rows)
            if action == 'copy-map':
                for _, dest in pairs:
                    assert not dest.exists() and not dest.is_symlink(), 'Mapping destination exists'
                for row in rows:
                    if row['action'] == 'copy':
                        Path(row['target']).mkdir(parents=True, exist_ok=True)
                for origin, dest in pairs:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(origin, dest)
            for origin, dest in pairs:
                assert dest.is_file() and not dest.is_symlink()
                assert hashlib.sha256(origin.read_bytes()).digest() == hashlib.sha256(dest.read_bytes()).digest()
            assert (Path(shared)/'config/config.json').is_file() and (Path(shared)/'config/admin_user.json').is_file()
    else:
        raise ValueError('Unknown configuration action')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL configuration: invalid structure, missing input or postcondition; values withheld', file=sys.stderr)
        sys.exit(1)
