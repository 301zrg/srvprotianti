#!/usr/bin/env python3
"""Loopback-only maintenance operations. Passwords never enter argv or errors."""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
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


def js_truthy(value):
    return isinstance(value, (dict, list)) or bool(value)


def account_order(name):
    # Object.entries lists array-index keys first, then preserves file order.
    if re.fullmatch(r'0|[1-9][0-9]{0,9}', name) and int(name) < 2**32 - 1:
        return int(name)
    return 2**32


def load_credentials(filename):
    path = Path(filename)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Invalid restored management configuration path')
    data = json.loads(path.read_text('utf-8-sig'))
    users = data.get('users') or {}
    examples = data.get('permission_examples') or {}
    for name in sorted(users, key=account_order):
        user = users[name]
        permissions = user.get('permissions')
        if not isinstance(permissions, (dict, list)) and permissions is not None:
            if isinstance(permissions, bool):
                permissions = str(permissions).lower()
            permissions = examples.get(str(permissions))
        if (js_truthy(user.get('enabled')) and isinstance(user.get('password'), str)
                and not any(c in name for c in ':\r\n\x00')
                and isinstance(permissions, dict) and js_truthy(permissions.get('stop'))):
            return name, user['password']
    raise ValueError('No enabled account with stop permission')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('on', 'off', 'status', 'select'))
    parser.add_argument('--port', type=int)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--username')
    source.add_argument('--admin-file')
    parser.add_argument('--account-evidence')
    parser.add_argument('--message')
    args = parser.parse_args(argv)
    try:
        if args.admin_file is not None:
            username, password = load_credentials(args.admin_file)
            evidence = {'selected': True, 'usernameSha256Prefix': hashlib.sha256(username.encode('utf-8')).hexdigest()[:12]}
            if args.action == 'select':
                print(json.dumps(evidence))
                return 0
            if json.loads(args.account_evidence) != evidence:
                raise ValueError('Selected account changed')
        else:
            username = args.username
            validate(args.action, args.port, username, args.message)
            password = os.environ.pop('MAINTENANCE_PASSWORD', None)
            if password is None:
                with open('/dev/tty', 'r+') as terminal:
                    password = getpass.getpass('HTTP management password: ', stream=terminal)
        print(json.dumps(operate(args.action, args.port, username, args.message, password), ensure_ascii=False))
        return 0
    except Exception:
        print('FAIL maintenance: check parameters, permissions, port and private service logs', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
