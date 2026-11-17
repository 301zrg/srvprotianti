"""Offline handover tests: synthetic materials and a mocked Git object store only."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]/'scripts'))
import handover


class HandoverTests(unittest.TestCase):
    def params(self, route='A'):
        return dict(machineName='new-host', route=route, releaseName='linux-r4-1',
                    database='srvpro_1103' if route == 'A' else 'srvpro_restore_1103', restoreDir='/private-restores/batch1',
                    stagingDirectory='/home/deploy/new', ports=dict(game=7911, http=7922, wss=7977),
                    sshPort=22, testCidr='10.0.2.0/24', managementUsername='maintenance',
                    maintenanceMessage='Maintenance', writerUnits=['srvprotianti.service'],
                    extraMutableAssets=[], enabledPlugins=['card-catalog'])

    def materials(self, root, route='A'):
        names = ['server-release.tar.gz', 'server-release.tar.gz.manifest.json',
                 'node-v24.15.0-linux-x64.tar.xz', 'SHASUMS256.txt',
                 'linux-build-input/linux-build-source.tar.gz', 'linux-build-input/manifest.json']
        names += ['linux.server.config.json'] if route == 'A' else ['joint-batch/manifest.json']
        root.mkdir()
        for name in names:
            p = root/name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'synthetic material\n')
        if route == 'B':
            (root/'joint-batch/empty').write_bytes(b'')
            (root/'joint-batch/empty-component').mkdir()

    def git(self, args, **kwargs):
        if 'ls-tree' in args:
            names = ['ops/install/linux/' + name for name in ('install.sh', 'lib/workflow.sh',
                     'lib/configuration.py', 'lib/lifecycle.py', 'lib/runtime.py',
                     'stages/41-layout.sh', 'stages/53-reboot.sh', 'stages/61-firewall.sh')]
            names += ['ops/scripts/maintenance.py', 'ops/scripts/handover.py']
            return b''.join(b'100644 blob abc\t' + name.encode() + b'\0' for name in names)
        self.assertEqual(args[-3:], ['cat-file', 'blob', 'abc'])
        return b'#!/usr/bin/env bash\n'

    def test_both_routes_export_exact_blobs_params_and_complete_manifest(self):
        for route in ('A', 'B'):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.materials(root/'materials', route)
                params = self.params(route)
                source = copy.deepcopy(params)
                expected = {'host': {'literal.dot': {'enabled': False}, 'password': 'old-private'}, 'adapter': None}
                with patch.object(handover.subprocess, 'check_output', side_effect=self.git):
                    independent = handover.assemble(root, 'a'*40, root/'materials', root/'out', params, expected)
                out = root/'out'
                self.assertEqual(params, source)
                self.assertEqual(json.loads((out/'handover-params.json').read_text('utf-8'))['opsCommit'], 'a'*40)
                self.assertNotIn('old-private', (out/'expected-config.json').read_text('utf-8'))
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
                    self.assertTrue((out/'joint-batch/empty-component').is_dir())
                with self.assertRaises(AssertionError):
                    handover.assemble(root, 'a'*40, root/'materials', out, params, expected)

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
