"""No HTTP requests: capture loopback operations in an in-memory opener."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).parents[1]/'scripts'))
import maintenance


class Opener:
    def __init__(self, enabled=True, ready=True):
        self.enabled, self.ready, self.requests = enabled, ready, []

    def open(self, request, timeout):
        self.requests.append(request)
        if isinstance(request, str):
            return io.BytesIO(b"['stop ok', 1]")
        return io.BytesIO(json.dumps(dict(maintenanceEnabled=self.enabled, readyToStop=self.ready,
                                         private='not-for-output')).encode())


class MaintenanceTests(unittest.TestCase):
    def record(self, password='synthetic', enabled=True, permissions=None):
        return dict(password=password, enabled=enabled,
                    permissions={'stop': True} if permissions is None else permissions)

    def test_b_account_selection_and_operations_keep_restored_credentials_private(self):
        name, password = 'restored-first-admin', "p a&s=s+%$'\":\\[]?特殊"
        users = {'disabled-admin': self.record(enabled=False),
                 'no-stop-admin': self.record(permissions={'stop': False}),
                 'invalid:name': self.record(),
                 name: self.record(password, permissions='operator'),
                 'restored-second-admin': self.record()}
        expected = {'selected': True, 'usernameSha256Prefix': hashlib.sha256(name.encode()).hexdigest()[:12]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'admin_user.json'
            path.write_text(json.dumps(dict(users=users, permission_examples={'operator': {'stop': True}})), 'utf-8-sig')
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(maintenance.main(['select', '--admin-file', str(path)]), 0)
            self.assertEqual(json.loads(stdout.getvalue()), expected)
            operation_args = ['on', '--admin-file', str(path), '--port', '8899', '--message', 'Original message',
                              '--account-evidence', json.dumps(expected)]
            opener = Opener()
            with patch.object(maintenance.urllib.request, 'build_opener', return_value=opener), \
                    patch.object(maintenance.getpass, 'getpass') as prompt, redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(maintenance.main(operation_args), 0)
                prompt.assert_not_called()
            self.assertEqual(parse_qs(urlsplit(opener.requests[0]).query),
                             {'username': [name], 'pass': [password], 'stop': ['Original message']})
            token = base64.b64encode((name + ':' + password).encode()).decode()
            self.assertEqual(opener.requests[1].get_header('Authorization'), 'Basic ' + token)
            self.assertEqual(json.loads(stdout.getvalue().splitlines()[-1]), dict(maintenanceEnabled=True, readyToStop=True))
            with patch.object(maintenance, 'operate', side_effect=ValueError(name + password)), \
                    redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(maintenance.main(operation_args), 1)
            self.assertEqual(maintenance.load_credentials(path), (name, password))
            self.assertNotIn(name, stdout.getvalue() + stderr.getvalue())
            self.assertNotIn(password, stdout.getvalue() + stderr.getvalue())
            self.assertNotIn(token, stdout.getvalue() + stderr.getvalue())

    def test_b_rejects_missing_stop_account_or_changed_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'admin_user.json'
            path.write_text(json.dumps({'users': {'disabled': self.record(enabled=False), 'reader':
                                                  self.record(permissions='read-only')}}), 'utf-8')
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(maintenance.main(['select', '--admin-file', str(path)]), 1)
            self.assertEqual(stdout.getvalue(), '')
            self.assertNotIn('read-only', stderr.getvalue())
            path.write_text(json.dumps({'users': {'another-account': self.record()}}), 'utf-8')
            with patch.object(maintenance, 'operate') as operate, redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(maintenance.main(['status', '--admin-file', str(path), '--port', '80',
                                                   '--message', 'm', '--account-evidence', '{}']), 1)
                operate.assert_not_called()
            self.assertNotIn('another-account', stderr.getvalue())

    def test_b_selection_matches_object_entries_for_numeric_account_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'admin_user.json'
            path.write_text(json.dumps({'users': {name: self.record() for name in ('first', '10', '2', '01')}}), 'utf-8')
            self.assertEqual(maintenance.load_credentials(path), ('2', 'synthetic'))

    def test_status_is_authenticated_read_only_and_bounded(self):
        opener = Opener(ready=False)
        result = maintenance.operate('status', 8899, 'old-admin', 'Original message', 'p&=+"特殊', opener)
        self.assertEqual(len(opener.requests), 1)
        request = opener.requests[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8899/api/maintenance/status')
        self.assertEqual(request.get_header('Authorization'), 'Basic ' + base64.b64encode('old-admin:p&=+"特殊'.encode()).decode())
        self.assertEqual(result, dict(maintenanceEnabled=True, readyToStop=False))

    def test_on_keeps_message_and_off_uses_literal_false(self):
        for action, value in (('on', '原文 &=+'), ('off', 'false')):
            opener = Opener(enabled=action == 'on')
            result = maintenance.operate(action, 8899, 'old-admin', '原文 &=+', 'p&=+', opener)
            parsed = urlsplit(opener.requests[0])
            self.assertEqual(parsed.netloc, '127.0.0.1:8899')
            self.assertEqual(parse_qs(parsed.query), dict(username=['old-admin'], **{'pass': ['p&=+'], 'stop': [value]}))
            self.assertEqual(result['maintenanceEnabled'], action == 'on')

    def test_invalid_parameters_fail_before_any_request(self):
        for action, port, user, message, password in (
                ('invalid', 80, 'u', 'm', 'p'), ('on', True, 'u', 'm', 'p'),
                ('on', 0, 'u', 'm', 'p'), ('on', 65536, 'u', 'm', 'p'),
                ('on', 80, 'u:x', 'm', 'p'), ('on', 80, '', 'm', 'p'),
                ('on', 80, 'u', 'false', 'p'), ('on', 80, 'u', 'm\n', 'p'),
                ('on', 80, 'u', 'm', ''), ('on', 80, 'u', 'm', 'p\x00')):
            opener = Opener()
            with self.assertRaises(ValueError):
                maintenance.operate(action, port, user, message, password, opener)
            self.assertEqual(opener.requests, [])

    def test_state_mismatch_and_non_boolean_response_rejected(self):
        with self.assertRaises(ValueError):
            maintenance.operate('off', 80, 'u', 'm', 'p', Opener(enabled=True))
        with self.assertRaises(ValueError):
            maintenance.operate('status', 80, 'u', 'm', 'p', Opener(enabled='true'))


if __name__ == '__main__':
    unittest.main()
