"""Offline handover tests: synthetic materials and a mocked Git object store only."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]/'scripts'))
import handover


DEFAULTS = {'literal.dot': {'items': [1, 2], 'keep': True},
            'modules': {'mysql': {'enabled': False, 'db': {'database': 'old', 'password': 'old-private'}},
                        'tournament_mode': {}, 'deck_log': {}, 'stop': 'delivered'}}
ADAPTER = {'enabled': True, 'connection': {'password': 'old-private', 'synchronize': True},
           'environment': {'host': 'OLD_HOST', 'password': 'OLD_PASSWORD'}}


class HandoverTests(unittest.TestCase):
    def params(self, route='A'):
        params = dict(machineName='new-host', route=route, releaseName='linux-r4-1',
                      database='srvpro_1103' if route == 'A' else 'srvpro_restore_1103', restoreDir='/private-restores/batch1',
                      stagingDirectory='/home/deploy/new', ports=dict(game=7911, http=7922, wss=7977),
                      sshPort=22, testCidr='10.0.2.0/24', maintenanceMessage='Maintenance',
                      writerUnits=['srvprotianti.service'], extraMutableAssets=[], enabledPlugins=['card-catalog'])
        if route == 'A':
            params['managementUsername'] = 'maintenance'
        return params

    def materials(self, root, route='A', adapter_component='adapter-config'):
        names = ['server-release.tar.gz.manifest.json',
                 'node-v24.15.0-linux-x64.tar.xz', 'SHASUMS256.txt',
                 'linux-build-input/linux-build-source.tar.gz', 'linux-build-input/manifest.json']
        root.mkdir()
        for name in names:
            p = root/name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'synthetic material\n')
        with tarfile.open(root/'server-release.tar.gz', 'w:gz') as archive:
            data = json.dumps(DEFAULTS).encode('utf-8')
            member = tarfile.TarInfo('application/data/default_config.json')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        host = {'literal.dot': {'items': [3]}}
        if route == 'B':
            batch = root/'joint-batch'
            (batch/'files/host-config').mkdir(parents=True)
            (batch/'files/host-config/admin_user.json').write_bytes(b'synthetic bytes deliberately not JSON')
            (batch/'files/empty-component').mkdir()
            components = ['host-config', 'empty-component']
            if adapter_component:
                components.append(adapter_component)
                directory = batch/'files'/adapter_component
                if adapter_component == 'plugin-config':
                    directory /= 'postgres-compat'
                directory.mkdir(parents=True)
                handover.write(directory/'config.json', ADAPTER)
            else:
                host['modules'] = {'mysql': {'enabled': True}}
            handover.write(batch/'manifest.json', {'components': [{'id': name} for name in components]})
            (batch/'empty').write_bytes(b'')
            handover.write(batch/'files/host-config/config.json', host)
        else:
            handover.write(root/'linux.server.config.json', host)

    def git(self, args, **kwargs):
        if 'ls-tree' in args:
            names = ['ops/install/linux/' + name for name in ('install.sh', 'lib/workflow.sh',
                     'lib/configuration.py', 'lib/lifecycle.py', 'lib/runtime.py',
                     'stages/41-layout.sh', 'stages/53-reboot.sh', 'stages/61-firewall.sh')]
            names += ['ops/scripts/maintenance.py', 'ops/scripts/handover.py']
            return (b''.join(b'100644 blob abc\t' + name.encode() + b'\0' for name in names)
                    + b'100644 blob adapter\t' + handover.A_ADAPTER.encode() + b'\0')
        if args[-3:] == ['cat-file', 'blob', 'adapter']:
            return json.dumps(ADAPTER).encode('utf-8')
        self.assertEqual(args[-3:], ['cat-file', 'blob', 'abc'])
        return b'#!/usr/bin/env bash\n'

    def test_both_routes_export_exact_blobs_params_and_complete_manifest(self):
        for route in ('A', 'B'):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.materials(root/'materials', route)
                params = self.params(route)
                source = copy.deepcopy(params)
                with patch.object(handover.subprocess, 'check_output', side_effect=self.git):
                    independent = handover.assemble(root, 'a'*40, root/'materials', root/'out', params)
                out = root/'out'
                self.assertEqual(params, source)
                exported = handover.load(out/'handover-params.json')
                self.assertEqual(exported['opsCommit'], 'a'*40)
                self.assertEqual('managementUsername' in exported, route == 'A')
                self.assertNotIn('old-private', (out/'expected-config.json').read_text('utf-8'))
                expected = handover.load(out/'expected-config.json')
                delivered, final = expected['delivered'], expected['final']
                self.assertEqual(delivered['host']['literal.dot'], {'items': [3], 'keep': True})
                self.assertIs(delivered['host']['modules']['mysql']['enabled'], False)
                self.assertEqual(delivered['host']['modules']['stop'], 'delivered')
                self.assertEqual(delivered['adapter']['environment']['host'], 'OLD_HOST')
                self.assertEqual(final['adapter']['connection'],
                                 dict(type='postgres', host='127.0.0.1', port=5432, database=params['database'],
                                      username='srvpro_runtime', password='<redacted>', synchronize=False))
                self.assertEqual(final['adapter']['environment'], dict(host='', port='', database='', username='', password='<redacted>'))
                self.assertIs(final['adapter']['synchronize'], False)
                modules = final['host']['modules']
                self.assertEqual(modules['stop'], 'Maintenance')
                self.assertEqual(modules['tournament_mode'], dict(deck_path=handover.DEFAULT_SHARED+'/tournament-decks/',
                                 replay_path=handover.DEFAULT_SHARED+'/replays/', log_save_path=handover.DEFAULT_SHARED+'/tournament-logs/'))
                self.assertEqual(modules['deck_log']['local'], handover.DEFAULT_SHARED+'/deck_log/')
                self.assertEqual((out/'ops/install/linux/install.sh').read_bytes(), b'#!/usr/bin/env bash\n')
                size, sha, name = independent.split('\t')
                self.assertEqual(name, 'handover.tsv')
                self.assertEqual(int(size), (out/name).stat().st_size)
                self.assertEqual(sha, hashlib.sha256((out/name).read_bytes()).hexdigest())
                listed = set()
                for row in (out/name).read_text('utf-8').splitlines():
                    size, sha, relative = row.split('\t')
                    p = out/relative
                    self.assertEqual((int(size), sha), (p.stat().st_size, handover.digest(p)))
                    listed.add(relative)
                self.assertEqual(listed, {p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()} - {'handover.tsv'})
                if route == 'B':
                    self.assertTrue((out/'joint-batch/files/empty-component').is_dir())
                    self.assertNotIn('managementUsername', (out/'handover.md').read_text('utf-8'))
                with self.assertRaises(AssertionError):
                    handover.assemble(root, 'a'*40, root/'materials', out, params)

    def test_b_plugin_tree_and_legacy_without_adapter(self):
        for component in ('plugin-config', None):
            with self.subTest(component=component), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.materials(root/'materials', 'B', component)
                params = self.params('B')
                expected = handover.expected_configuration(root/'materials', params, None)
                final = expected['final']
                if component:
                    self.assertEqual(final['adapter']['connection']['database'], params['database'])
                else:
                    self.assertIsNone(final['adapter'])
                    connection = final['host']['modules']['mysql']['db']
                    self.assertEqual(connection['database'], params['database'])
                    self.assertEqual(connection['password'], '<redacted>')

    def test_explicit_two_phase_override_is_redacted_and_b_legacy_username_is_discarded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.materials(root/'materials', 'B')
            source = self.params('B')
            source['managementUsername'] = 'must-stay-private'
            override = {phase: {'host': {'marker': phase, 'password': 'old-private'}, 'adapter': None}
                        for phase in ('delivered', 'final')}
            with patch.object(handover.subprocess, 'check_output', side_effect=self.git), \
                    patch.object(handover, 'expected_configuration') as derive:
                handover.assemble(root, 'a'*40, root/'materials', root/'out', source, override)
                derive.assert_not_called()
            exported = handover.load(root/'out/expected-config.json')
            for phase, row in exported.items():
                self.assertEqual(row['host'], {'marker': phase, 'password': '<redacted>'})
            self.assertNotIn('must-stay-private', (root/'out/handover.md').read_text('utf-8'))
            self.assertNotIn('managementUsername', handover.load(root/'out/handover-params.json'))
            with self.assertRaises(AssertionError):
                handover.validate_expected(override['final'])

    def test_paths_and_empty_rules(self):
        for name in ('../escape', '/absolute', 'C:/absolute', 'a//b', './a', 'a\\b', 'a\nline'):
            with self.assertRaises(AssertionError):
                handover.relative(name)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'empty').write_bytes(b'')
            with self.assertRaises(AssertionError):
                handover.inventory(root)

    def test_missing_material_credentials_and_unsafe_git_export_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.materials(root/'materials')
            params = self.params()
            params['password'] = 'not-permitted'
            expected = {'host': {}, 'adapter': None}
            with self.assertRaises(AssertionError):
                handover.assemble(root, 'a'*40, root/'materials', root/'out', params, expected)
            params.pop('password')
            with patch.object(handover.subprocess, 'check_output', return_value=b'120000 blob abc\tops/install/linux/install.sh\0'):
                with self.assertRaises(AssertionError):
                    handover.assemble(root, 'a'*40, root/'materials', root/'out', params, expected)
            (root/'materials/SHASUMS256.txt').unlink()
            with self.assertRaises(AssertionError):
                handover.assemble(root, 'a'*40, root/'materials', root/'out', params, expected)


if __name__ == '__main__':
    unittest.main()
