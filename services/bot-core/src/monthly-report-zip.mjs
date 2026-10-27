import {deflateRawSync} from 'node:zlib';

const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

// Small, bounded, flat archives only; ZIP64 and filesystem traversal are unnecessary.
export function reportZip(files) {
  if (files.length > 32 || new Set(files.map(f => f.name)).size !== files.length) throw new Error('Invalid ZIP entries');
  const local = [], directory = [];
  let offset = 0;
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(file.name) || !Buffer.isBuffer(file.data) || file.data.length > 8 * 1024 * 1024) throw new Error('Invalid ZIP file');
    const name = Buffer.from(file.name), compressed = file.name.endsWith('.png') ? file.data : deflateRawSync(file.data);
    const method = file.name.endsWith('.png') ? 0 : 8, checksum = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(method, 10); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); directory.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
