#!/usr/bin/env python3
"""Synthetic controlling-terminal tests; never use real passwords here."""
import os
from pathlib import Path
import pty
import select
import signal
import sys
import time


def attempt(harness, case, first, second, succeeds):
    case.mkdir()
    env = dict(os.environ, CASE_DIR=str(case))
    import subprocess
    subprocess.run(['bash', harness, 'init'], env=env, check=True, stdout=subprocess.DEVNULL)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe('bash', ['bash', harness, 'password'], env)
    output = b''
    sent = 0
    deadline = time.monotonic() + 10
    prompts = (b'New fixture password: ', b'Repeat password: ')
    exit_status = None
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            if sent < 2 and prompts[sent] in output:
                # Wait for the read builtin to disable echo before delivering bytes.
                import termios
                if not termios.tcgetattr(fd)[3] & termios.ECHO:
                    os.write(fd, (first, second)[sent] + b'\n')
                    sent += 1
        waited, status = os.waitpid(pid, os.WNOHANG)
        if not waited:
            raise AssertionError('Password child timed out')
        exit_status = status
        assert (os.waitstatus_to_exitcode(exit_status) == 0) == succeeds
        # Check stdout/stderr (pty), log and serialized state for both synthetic samples.
        for sample in (first, second):
            if sample:
                assert sample not in output, 'Secret in terminal output'
                for path in case.rglob('*'):
                    if path.is_file():
                        assert sample not in path.read_bytes(), 'Secret persisted'
    finally:
        if exit_status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)


if __name__ == '__main__':
    harness, root = sys.argv[1:]
    root = Path(root)
    attempt(harness, root/'special', b"pA*[ss]?':\\$() old-credential", b"pA*[ss]?':\\$() old-credential", True)
    attempt(harness, root/'mismatch', b'first-password', b'second-password', False)
    attempt(harness, root/'empty', b'', b'', False)
    attempt(harness, root/'nul', b'invalid\x00password', b'invalid\x00password', False)
