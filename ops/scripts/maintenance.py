#!/usr/bin/env python3
"""Loopback-only maintenance operations. Passwords never enter argv or errors."""
import argparse
import base64
import getpass
import json
import os
import sys
import urllib.parse
import urllib.request


def validate(action, port, username, message):
    if action not in ('on', 'off', 'status'):
        raise ValueError('Invalid action')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Invalid HTTP port')
    if not isinstance(username, str) or not username or any(c in username for c in ':\r\n\x00'):
        raise ValueError('Invalid management username')
    if not isinstance(message, str) or not message or any(c in message for c in '\r\n\x00') or message == 'false':
        raise ValueError('Invalid maintenance message')


def operate(action, port, username, message, password, opener=None):
    validate(action, port, username, message)
    if not password or any(c in password for c in '\r\n\x00'):
        raise ValueError('Invalid password')
    # Do not inherit proxy settings, redirect authenticated requests, or log URLs.
    if opener is None:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = 'http://127.0.0.1:' + str(port)
    if action != 'status':
        query = urllib.parse.urlencode({'username': username, 'pass': password,
                                        'stop': 'false' if action == 'off' else message})
        with opener.open(base + '/api/message?' + query, timeout=15) as response:
            if not response.read().decode('utf-8').startswith("['stop ok',"):
                raise ValueError('Management operation failed')
    token = base64.b64encode((username + ':' + password).encode('utf-8')).decode('ascii')
    request = urllib.request.Request(base + '/api/maintenance/status',
                                    headers={'Authorization': 'Basic ' + token})
    with opener.open(request, timeout=15) as response:
        status = json.load(response)
    if type(status.get('maintenanceEnabled')) is not bool or type(status.get('readyToStop')) is not bool:
        raise ValueError('Invalid maintenance response')
    if action != 'status' and status['maintenanceEnabled'] != (action == 'on'):
        raise ValueError('Maintenance state differs')
    # Only fields needed by the installer; never echo arbitrary API payloads.
    return {key: status[key] for key in ('maintenanceEnabled', 'readyToStop')}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('on', 'off', 'status'))
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--message', required=True)
    args = parser.parse_args(argv)
    try:
        validate(args.action, args.port, args.username, args.message)
        password = os.environ.pop('MAINTENANCE_PASSWORD', None)
        if password is None:
            with open('/dev/tty', 'r+') as terminal:
                password = getpass.getpass('HTTP management password: ', stream=terminal)
        print(json.dumps(operate(args.action, args.port, args.username, args.message, password), ensure_ascii=False))
        return 0
    except Exception:
        print('FAIL maintenance: check parameters, permissions, port and private service logs', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
