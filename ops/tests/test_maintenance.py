"""No HTTP requests: capture loopback operations in an in-memory opener."""
import base64
import io
import json
from pathlib import Path
import sys
import unittest
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
