#!/usr/bin/env python3
"""Offline installer contract tests. Only synthetic temporary files are used."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('installer_state', ROOT / 'lib/state.py')
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)


class Contracts(unittest.TestCase):
    def test_python_syntax(self):
        for path in ROOT.rglob('*.py'):
            ast.parse(path.read_text('utf-8'), filename=str(path))

    def test_stage_traps_are_owned_by_common(self):
        for path in (ROOT / 'stages').glob('*.sh'):
            body = path.read_text('utf-8')
            self.assertNotRegex(body, r'(?m)^\s*(?:trap\b|set\s+\+e\b)')
        common = (ROOT / 'lib/common.sh').read_text('utf-8')
        self.assertIn('set -Eeuo pipefail\\n', common)
        self.assertIn('env -i HOME=', common)

    def test_entire_manual_is_mapped(self):
        lines = (ROOT.parents[1] / 'docs/linux-install.md').read_text('utf-8').splitlines()
        spans = []
        start = None
        for line, text in enumerate(lines, 1):
            if re.fullmatch(r'```(?:bash|sql)', text):
                start = line
            elif text == '```' and start is not None:
                spans.append(f'{start}-{line}')
                start = None
        mapping = (ROOT / 'MAPPING.md').read_text('utf-8')
        for span in spans:
            self.assertIn(f'| {span} |', mapping)
        self.assertEqual(len(spans), 44)

    def test_encodings(self):
        for path in ROOT.rglob('*'):
            if path.is_file() and '__pycache__' not in str(path):
                raw = path.read_bytes()
                self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), str(path))
                self.assertNotIn(b'\r', raw, str(path))
                raw.decode('utf-8')

    def test_manifest_formats_and_complete_set(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'material').write_bytes(b'synthetic')
            sha = hashlib.sha256(b'synthetic').hexdigest()
            (root / 'handover.tsv').write_text(f'9\t{sha}\tmaterial\n', encoding='utf-8')
            first = STATE.manifest(root)
            (root / 'handover-files.sha256').write_text(f'{sha}  ./material\n', encoding='utf-8')
            self.assertEqual(STATE.manifest(root), first)
            (root / 'extra').write_bytes(b'not-listed')
            with self.assertRaises(AssertionError):
                STATE.manifest(root)

    def test_manifest_refuses_traversal_duplicate_special_and_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'material').write_bytes(b'x')
            sha = hashlib.sha256(b'x').hexdigest()
            for name in ('../material', '/material', 'dir//material', 'C:/material'):
                (root / 'handover.tsv').write_text(f'1\t{sha}\t{name}\n', encoding='utf-8')
                with self.assertRaises(AssertionError):
                    STATE.manifest(root)
            (root / 'handover.tsv').write_text(f'1\t{sha}\tmaterial\n' * 2, encoding='utf-8')
            with self.assertRaises(AssertionError):
                STATE.manifest(root)
            (root / 'material').write_bytes(b'')
            (root / 'handover.tsv').write_text(f'0\t{hashlib.sha256(b"").hexdigest()}\tmaterial\n', encoding='utf-8')
            with self.assertRaises(AssertionError):
                STATE.manifest(root)

    @unittest.skipUnless(os.name == 'posix', 'POSIX links and FIFO')
    def test_manifest_rejects_links_and_special_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'ordinary').write_bytes(b'x')
            sha = hashlib.sha256(b'x').hexdigest()
            (root / 'handover.tsv').write_text(f'1\t{sha}\tordinary\n', encoding='utf-8')
            (root / 'link').symlink_to(root / 'ordinary')
            with self.assertRaises(AssertionError):
                STATE.manifest(root)
            (root / 'link').unlink()
            os.mkfifo(root / 'fifo')
            with self.assertRaises(AssertionError):
                STATE.manifest(root)

    @unittest.skipUnless(hasattr(STATE.os, 'O_DIRECTORY'), 'POSIX directory fsync')
    def test_atomic_write_syncs_file_then_rename_then_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            events = []
            replace = STATE.os.replace
            fsync = STATE.os.fsync
            def synced(fd):
                events.append('fsync')
                fsync(fd)
            def renamed(source, target):
                events.append('rename')
                replace(source, target)
            with patch.object(STATE.os, 'fsync', side_effect=synced), patch.object(STATE.os, 'replace', side_effect=renamed):
                target = Path(temporary) / 'state.json'
                STATE.atomic(target, {'fixture': True})
            self.assertEqual(events, ['fsync', 'rename', 'fsync'])
            self.assertEqual(json.loads(target.read_text('utf-8')), {'fixture': True})

    @unittest.skipUnless(hasattr(STATE.os, 'O_DIRECTORY'), 'POSIX directory fsync')
    def test_failed_file_sync_does_not_publish_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'state.json'
            with patch.object(STATE.os, 'fsync', side_effect=OSError('synthetic failure')):
                with self.assertRaises(OSError):
                    STATE.atomic(target, {'fixture': True})
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.iterdir()), [])

    @unittest.skipUnless(hasattr(STATE.os, 'O_DIRECTORY'), 'POSIX directory fsync')
    def test_directory_sync_failure_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'state.json'
            with patch.object(STATE.os, 'fsync', side_effect=[None, OSError('synthetic directory failure')]):
                with self.assertRaises(OSError):
                    STATE.atomic(target, {'pending': 'fixture'})
            self.assertEqual(json.loads(target.read_text('utf-8')), {'pending': 'fixture'})


if __name__ == '__main__':
    unittest.main()
