"""Synthetic, offline contracts for stages 4-6. No systemctl/DB/HTTP invocation."""
import copy
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'lib'))
import configuration as config
import lifecycle
import runtime


class WorkflowTests(unittest.TestCase):
    def params(self):
        return dict(route='A', database='srvpro_1103', ports=dict(game=7911, http=7922, wss=7977), sshPort=22,
                    testCidr='10.0.2.0/24', managementUsername='maintenance', maintenanceMessage='original',
                    writerUnits=[lifecycle.GAME], extraMutableAssets=[], enabledPlugins=['card-catalog'])

    def test_merge_replaces_arrays_keeps_literal_dots_and_does_not_mutate(self):
        base = {'a.b': {'x': [1, 2], 'keep': False}, 'empty': [1], 'null': {'old': True}}
        other = {'a.b': {'x': [3]}, 'empty': [], 'null': None}
        snapshot = copy.deepcopy(base)
        result = config.merge(base, other)
        self.assertEqual(result, {'a.b': {'x': [3], 'keep': False}, 'empty': [], 'null': None})
        self.assertEqual(base, snapshot)
        self.assertEqual(config.diff({'a.b': False}, {'a.b': 0}), [('a.b',)])

    @unittest.skipUnless(shutil.which('node') and (ROOT.parents[2]/'node_modules/deepmerge').is_dir(), 'Existing local Node/deepmerge')
    def test_merge_matches_existing_host_deepmerge_options(self):
        repo = ROOT.parents[2]
        host = (repo/'ygopro-server.js').read_text('utf-8')
        self.assertRegex(host, r'arrayMerge:\s*function\(destination, source\)\s*\{\s*return source;')
        pairs = [({'literal.dot': {'a': [1], 'v': False}}, {'literal.dot': {'a': [], 'v': 0}}),
                 ({'v': {'a': 1}}, {'v': None}), ({'v': []}, {'v': {'x': True}})]
        body = 'const merge=require("deepmerge"); const p=JSON.parse(process.argv[1]); console.log(JSON.stringify(p.map(([a,b])=>merge(a,b,{arrayMerge:(d,s)=>s}))));'
        result = subprocess.check_output(['node', '-e', body, json.dumps(pairs)], cwd=repo, text=True)
        self.assertEqual(json.loads(result), [config.merge(a, b) for a, b in pairs])

    def test_diff_never_returns_private_values_and_redacts_credentials(self):
        snapshot = {'host': {'password': 'old-private', 'a.b': 1}, 'adapter': None}
        with patch.object(config, 'json_file', return_value={'delivered': snapshot, 'final': snapshot}), \
                patch.object(config, 'effective', return_value={'host': {'password': 'new-private', 'a.b': False}, 'adapter': None}):
            result = config.differences('app', config.DEFAULT_SHARED, 'expected', 'delivered', self.params(), 'srvpro_1103')
        self.assertEqual(result, [['host', 'a.b']])
        self.assertNotIn('private', json.dumps(result))

    def test_equivalence_compares_matching_phase_and_tolerates_only_registered_writeback(self):
        params = self.params()
        delivered = {'host': {'modules': {'mysql': {'enabled': False}}, 'literal.dot': 'old'},
                     'adapter': {'enabled': True, 'connection': {'synchronize': True}, 'environment': {'host': 'OLD'}}}
        params['pathMappings'] = [{'document': 'host', 'keys': ['literal.dot'], 'target': config.DEFAULT_SHARED+'/asset'}]
        final = copy.deepcopy(delivered)
        for keys, value in config.connection_updates(delivered, params, config.DEFAULT_SHARED,
                                                     params['database'], '<redacted>').items():
            config.set_value(final, keys, value)
        expected = {'delivered': delivered, 'final': final}
        args = ('app', config.DEFAULT_SHARED, 'expected')
        with patch.object(config, 'json_file', return_value=expected), patch.object(config, 'effective') as effective:
            effective.return_value = delivered
            self.assertEqual(config.differences(*args, 'delivered', params, params['database']), [])
            early = config.differences(*args, 'final', params, params['database'])
            self.assertIn(['adapter', 'connection', 'synchronize'], early)
            self.assertIn(['adapter', 'environment', 'host'], early)
            actual = copy.deepcopy(final)
            effective.return_value = actual
            self.assertEqual(config.differences(*args, 'final', params, params['database']), [])
            self.assertIn(['host', 'literal.dot'], config.differences(*args, 'delivered', params, params['database']))
            before = config.comparison(*args, 'final', params, params['database'])
            actual['host']['modules']['mysql']['enabled'] = True
            actual['adapter']['connection']['password'] = 'new-private'
            after = config.comparison(*args, 'final', params, params['database'])
            self.assertEqual(runtime.config_signature('final', before), runtime.config_signature('final', after))
            self.assertEqual(config.differences(*args, 'final', params, params['database']), [])
            actual['adapter']['enabled'] = False
            self.assertEqual(config.differences(*args, 'final', params, params['database']),
                             [['adapter', 'enabled'], ['host', 'modules', 'mysql', 'enabled']])

    def test_final_expected_uses_bound_retarget_and_preserves_override_differences(self):
        params = dict(self.params(), route='B', database='srvpro_restore_1103')
        params['pathMappings'] = [{'document': 'host', 'keys': ['literal.dot'], 'target': config.DEFAULT_SHARED+'/asset'}]
        delivered = {'host': {'modules': {'mysql': {'enabled': True, 'db': {}}}, 'literal.dot': 'old'},
                     'adapter': None}
        final, actual = copy.deepcopy(delivered), copy.deepcopy(delivered)
        shared, database = '/srv/srvprotianti/new-shared', 'restored_again'
        for snapshot, path, name in ((final, config.DEFAULT_SHARED, params['database']), (actual, shared, database)):
            for keys, value in config.connection_updates(delivered, params, path, name, '<redacted>').items():
                config.set_value(snapshot, keys, value)
        with patch.object(config, 'json_file', return_value={'delivered': delivered, 'final': final}), \
                patch.object(config, 'effective', return_value=actual):
            self.assertEqual(config.differences('app', shared, 'expected', 'final', params, database), [])
            final['host']['modules']['deck_log']['local'] = '/explicit-override/'
            self.assertEqual(config.differences('app', shared, 'expected', 'final', params, database),
                             [['host', 'modules', 'deck_log', 'local']])

    def test_restored_windows_json_bom_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'synthetic.json'
            path.write_bytes(b'\xef\xbb\xbf{"enabled":false}')
            self.assertEqual(config.json_file(path), {'enabled': False})

    def test_parameter_rejection(self):
        config.parameters(self.params())
        route_b = dict(self.params(), route='B')
        del route_b['managementUsername']
        config.parameters(route_b)
        with self.assertRaises(AssertionError):
            config.parameters(dict(route_b, managementUsername='old'))
        for key, value in (('sshPort', 0), ('testCidr', '0.0.0.0/0'), ('testCidr', '10.0.2.1/24'),
                           ('managementUsername', 'bad:user'), ('maintenanceMessage', 'false'),
                           ('writerUnits', []), ('writerUnits', ['missing.service']),
                           ('writerUnits', [lifecycle.GAME, lifecycle.PG]),
                           ('writerUnits', [lifecycle.GAME, '../../bad.service'])):
            params = self.params()
            params[key] = value
            with self.subTest(key=key, value=value), self.assertRaises((AssertionError, ValueError)):
                config.parameters(params)

    def test_boot_id_unchanged_missing_evidence_early_login_and_order_rejected(self):
        lifecycle.check_boot('old', 'new', 0, 10, 20, 300_000_020)
        for values in (('old', 'old', 1, 10, 20, 400_000_000),
                       ('old', 'new', None, 10, 20, 400_000_000),
                       ('old', 'new', 1, 10, 20, 299_000_000),
                       ('old', 'new', 1, 30, 20, 400_000_000)):
            with self.assertRaises(AssertionError):
                lifecycle.check_boot(*values)

    def test_missing_writers_stops_even_without_backup_and_no_unit_query(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(lifecycle, 'unit') as unit:
            with self.assertRaises(AssertionError):
                lifecycle.writers(self.params(), Path(directory)/'missing', inactive=True)
            unit.assert_not_called()

    def test_writer_inventory_drift_missing_unit_active_and_live_pid_rejected(self):
        data = {'writerUnits': [lifecycle.GAME]}
        info = types.SimpleNamespace(st_uid=0, st_mode=0o600)
        with patch.object(lifecycle.Path, 'is_file', return_value=True), \
                patch.object(lifecycle.Path, 'is_symlink', return_value=False), \
                patch.object(lifecycle.Path, 'stat', return_value=info), \
                patch.object(lifecycle, 'json_file', return_value=data):
            for row in (dict(LoadState='not-found', ActiveState='inactive', MainPID='0'),
                        dict(LoadState='loaded', ActiveState='failed', MainPID='0'),
                        dict(LoadState='loaded', ActiveState='active', MainPID='0'),
                        dict(LoadState='loaded', ActiveState='inactive', MainPID='12')):
                with patch.object(lifecycle, 'unit', return_value=row), self.assertRaises(AssertionError):
                    lifecycle.writers(self.params(), 'writers', True)
            with patch.object(lifecycle, 'unit', return_value=dict(LoadState='loaded', ActiveState='inactive', MainPID='0')):
                self.assertEqual(lifecycle.writers(self.params(), 'writers', True), data)
            data['writerUnits'] = ['different.service']
            with self.assertRaises(AssertionError):
                lifecycle.writers(self.params(), 'writers')

    def test_41_skips_game_and_52a_requires_every_unit_loaded(self):
        params = self.params()
        params['writerUnits'].append('extra.service')
        argv = ['lifecycle.py', 'units-exist', 'params', 'shared', 'db', 'A', 'state']
        with patch.object(lifecycle, 'json_file', return_value=params), patch.object(lifecycle, 'unit', return_value={'LoadState': 'loaded'}) as unit, patch.object(sys, 'argv', argv):
            lifecycle.main()
            self.assertEqual([c.args[0] for c in unit.call_args_list], ['extra.service'])
        argv[1] = 'create-writers'
        with patch.object(lifecycle, 'json_file', return_value=params), patch.object(lifecycle, 'same_or_new') as write, patch.object(lifecycle, 'unit', return_value={'LoadState': 'not-found'}) as unit, patch.object(sys, 'argv', argv):
            with self.assertRaises(AssertionError):
                lifecycle.main()
            unit.assert_called_once_with(lifecycle.GAME)
            write.assert_not_called()

    def test_component_policy_rejects_unknown_and_mutually_exclusive_components(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restore, shared = root/'restore', root/'shared'
            (restore/'runtime').mkdir(parents=True)
            shared.mkdir()
            names = ['recordings', 'host-config', 'tournament-decks', 'tournament-logs', 'deck-logs', 'unknown']
            for name in names:
                (restore/'runtime'/name).mkdir()
            manifest = {'components': [{'id': name, 'originalSource': 'source/' + name} for name in names]}
            def read(path):
                if str(path).endswith('restore-map.json'):
                    return [dict(id=r['id'], old=r['originalSource'], new=str(restore/'runtime'/r['id'])) for r in manifest['components']]
                return manifest
            with patch.object(config, 'json_file', side_effect=read), self.assertRaisesRegex(AssertionError, 'Unknown component'):
                config.component_plan(restore, shared, self.params())
            for name in ('adapter-config', 'plugin-config'):
                (restore/'runtime'/name).mkdir()
                manifest['components'].append(dict(id=name, originalSource='source/' + name))
            with patch.object(config, 'json_file', side_effect=read), self.assertRaisesRegex(AssertionError, 'Mutually exclusive'):
                config.component_plan(restore, shared, self.params())

    def test_component_plan_preserves_empty_components_skips_sidecars_and_rebuilds_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restore, shared = root/'restore', root/'shared'
            (restore/'runtime').mkdir(parents=True)
            shared.mkdir()
            names = ['recordings', 'host-config', 'tournament-decks', 'tournament-logs', 'deck-logs', 'engine', 'catalog', 'app-runtime-main']
            for name in names:
                (restore/'runtime'/name).mkdir()
            (restore/'runtime/recordings/中文.yrp').write_bytes(b'replay')
            (restore/'runtime/host-config/config.json').write_bytes(b'{}')
            (restore/'runtime/host-config/cards.cdb-wal').write_bytes(b'sidecar')
            manifest = {'components': [dict(id=n, originalSource='source/' + n) for n in names]}
            mapping = [dict(id=n, old='source/' + n, new=str(restore/'runtime'/n)) for n in names]
            with patch.object(config, 'json_file', side_effect=lambda p: mapping if str(p).endswith('restore-map.json') else manifest):
                rows = config.component_plan(restore, shared, self.params())
                policies = {r['id']: r['action'] for r in rows}
                self.assertEqual(policies['engine'], 'evidence')
                self.assertEqual(policies['app-runtime-main'], 'rebuild')
                self.assertEqual(policies['tournament-decks'], 'copy')
                pairs = config.copies(rows)
                self.assertEqual({p.name for p, _ in pairs}, {'中文.yrp', 'config.json'})
                mapping[0]['new'] = str(root/'wrong')
                with self.assertRaisesRegex(AssertionError, 'Restore map changed'):
                    config.component_plan(restore, shared, self.params())

    def test_backup_plan_includes_full_runtime_all_shared_and_deduplicates_covered_extra_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            shared = Path(directory)/'shared'
            shared.mkdir()
            for name in config.SHARED_NAMES:
                (shared/name).mkdir(parents=True, exist_ok=True)
            (shared/'admin-assets').mkdir()
            (shared/'admin-assets/template.json').write_bytes(b'{}')
            params = self.params()
            params['extraMutableAssets'] = [dict(id='templates', source='{shared}/admin-assets/template.json')]
            with patch.object(lifecycle, 'writers', return_value={'writerUnits': params['writerUnits']}):
                plan = lifecycle.backup_plan(params, str(shared), 'new_database', 'A', 'writers')
            self.assertEqual(plan['database'], 'new_database')
            self.assertEqual(plan['releaseArchive'], '/srv/srvpro-input/server-release.tar.gz')
            self.assertEqual(plan['writerUnits'], [lifecycle.GAME])
            ids = {r['id'] for r in plan['components']}
            self.assertTrue({'linux-runtime', 'recordings', 'host-config', 'plugin-config', 'auth-logs', 'service-env', 'service-config', 'shared-admin-assets'} <= ids)
            self.assertNotIn('templates', ids)
            bad = copy.deepcopy(plan)
            bad['components'] = [r for r in bad['components'] if r['id'] != 'linux-runtime']
            with self.assertRaisesRegex(AssertionError, 'Incomplete external'):
                lifecycle.validate_plan(bad, plan, 'unused-ops')
            bad = copy.deepcopy(plan)
            bad['writerUnits'] = []
            with self.assertRaises(AssertionError):
                lifecycle.validate_plan(bad, plan, 'unused-ops')

    def test_existing_different_inventory_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'writers.json'
            path.write_bytes(b'{"writerUnits":["different.service"]}')
            before = path.read_bytes()
            with patch.object(lifecycle, 'atomic') as atomic, self.assertRaises(AssertionError):
                lifecycle.same_or_new(path, {'writerUnits': [lifecycle.GAME]})
            atomic.assert_not_called()
            self.assertEqual(path.read_bytes(), before)

    def test_postboot_waits_sixty_seconds_and_rejects_pid_change(self):
        before = dict(bootId='new', mainPid='12', restarts='0')
        after = dict(before, mainPid='13')
        argv = ['lifecycle.py', 'postboot', 'params', 'shared', 'db', 'A', 'state']
        with patch.object(sys, 'argv', argv), patch.object(lifecycle, 'json_file', return_value=self.params()), \
                patch.object(lifecycle, 'boot_evidence', side_effect=[before, after]), patch.object(lifecycle.time, 'sleep') as sleep:
            with self.assertRaises(AssertionError):
                lifecycle.main()
            sleep.assert_called_once_with(60)

    def test_pending_backup_does_not_adopt_an_old_attempt(self):
        state = dict(blocks={}, history=[dict(begin='M52-BACKUP'), dict(backupIntent='M52-BACKUP', destination='old'),
                                        dict(begin='M52-BACKUP')])
        argv = ['runtime.py', 'verify-backup', 'params', 'shared', 'app', 'state']
        with patch.object(sys, 'argv', argv), patch.object(runtime, 'json_file', return_value=self.params()), \
                patch.object(runtime, 'load', return_value=state), patch.object(runtime.subprocess, 'run') as run:
            with self.assertRaises(AssertionError):
                runtime.main()
            run.assert_not_called()

    def test_readiness_checks_plugin_identity_cards_errors_and_private_output(self):
        params = self.params()
        records = [dict(msg='Plugin loaded', plugin='card-catalog'), dict(msg='Card catalog loaded', cards=1),
                   dict(msg='NOTE: server not open due to config'),
                   dict(msg='Operation success. User: private-admin, Permission needed: stop, Action: stop')]
        app = Path.cwd()/'synthetic-app'
        game = dict(InvocationID='invocation', ActiveState='active', User='srvpro', NRestarts='0', MainPID='12')
        listen = '\n'.join('LISTEN 0 10 0.0.0.0:' + str(p) + ' 0.0.0.0:*' for p in params['ports'].values())
        def command(*args):
            warning = '(node:12) UnboundedCacheWarning: TTL caching without a limit\n(Use `node --trace-warnings ...` to show where the warning was created)'
            return listen if args[0] == 'ss' else '\n'.join(json.dumps(r) for r in records) + '\n' + warning
        opener = types.SimpleNamespace(open=lambda *args, **kw: Response())
        class Response(io.BytesIO):
            status = 200
        with patch.object(runtime, 'unit', return_value=game), patch.object(runtime, 'command', side_effect=command), \
                patch.object(runtime.Path, 'resolve', return_value=app), patch.object(runtime.urllib.request, 'build_opener', return_value=opener), \
                patch('sys.stdout', new_callable=io.StringIO) as output, tempfile.TemporaryDirectory() as directory:
            report = Path(directory)/'start.log'
            runtime.readiness(params, app, report=str(report))
            self.assertEqual(json.loads(output.getvalue())['mainPid'], '12')
            self.assertIn('Plugin loaded', report.read_text('utf-8'))
            self.assertNotIn('private-admin', report.read_text('utf-8'))
            records[0]['plugin'] = 'wrong-plugin'
            with self.assertRaises(AssertionError):
                runtime.readiness(params, app)
            records[0]['plugin'] = 'card-catalog'
            records.append(dict(level=40, msg='private-value'))
            with self.assertRaises(AssertionError):
                runtime.readiness(params, app)
            self.assertNotIn('private-value', output.getvalue())

    def test_complete_flow_and_first_action_registry_contract(self):
        workflow = (ROOT/'lib/workflow.sh').read_text('utf-8')
        self.assertIn('STAGES+=(44 45 46 51 52a 61 CP1 52b 52c 52d 53a 53b CP2)', workflow)
        registry = '\n'.join(p.read_text('utf-8') for p in (ROOT/'stages').glob('*.sh'))
        for id in ('L41-ACCOUNT', 'L41-LAYOUT', 'C42-CONFIG', 'C42-ADAPTER', 'C42-ADMIN',
                   'C43-MAP', 'C44-CONNECTION', 'C44-ENVIRONMENT', 'P45-CONFIG-LINK',
                   'P45-LOGS-LINK', 'P45-ADAPTER-LINK', 'P45-CURRENT', 'D51-SYSTEMD', 'M52-TOOL', 'M52-BACKUP'):
            self.assertRegex(registry, r'(?m)^register_block ' + id + r' \S+ first no ')
        self.assertNotIn('register_block M52-RESTART', registry)
        self.assertIn('readyToStop', workflow)


if __name__ == '__main__':
    unittest.main()
