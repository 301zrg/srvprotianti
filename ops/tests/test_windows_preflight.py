import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ops', Path(__file__).parents[1] / 'scripts/ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class WindowsPreflightTest(unittest.TestCase):
    def test_pe_requires_real_x64_optional_header_and_bounded_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'ygopro.exe'
            data = bytearray(128)
            data[:2] = b'MZ'
            struct.pack_into('<I', data, 60, 64)
            data[64:68] = b'PE\0\0'
            struct.pack_into('<H', data, 68, 0x8664)
            struct.pack_into('<H', data, 88, 0x20b)
            binary.write_bytes(data)
            self.assertEqual(ops.windows_pe_kind(binary), 'PE32+ x64')
            for index, value in [(60, 250), (68, 0x14c), (88, 0x10b)]:
                bad = bytearray(data)
                struct.pack_into('<I' if index == 60 else '<H', bad, index, value)
                binary.write_bytes(bad)
                with self.assertRaises(ops.OpsError):
                    ops.windows_pe_kind(binary)
