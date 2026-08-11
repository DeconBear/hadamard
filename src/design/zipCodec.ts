import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipDecodeLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

const DEFAULT_LIMITS: ZipDecodeLimits = {
  maxEntries: 128,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 100,
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryName(name: string): string {
  if (!name || name.length > 240 || name.includes('\0') || name.includes('\\') || name.startsWith('/')
    || /^[A-Za-z]:/u.test(name) || name.split('/').some(segment => segment === '..' || segment === '')) {
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  return name;
}

function u16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2); buffer.writeUInt16LE(value, 0); return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4); buffer.writeUInt32LE(value >>> 0, 0); return buffer;
}

export function encodeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('ZIP entry count exceeds format limit.');
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = safeEntryName(entry.name);
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seen.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    localParts.push(localHeader, compressed);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += localHeader.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

function findEndRecord(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= minimum; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error('ZIP end record is missing.');
}

export function decodeZip(bytes: Buffer, limits: Partial<ZipDecodeLimits> = {}): Map<string, Buffer> {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.length < 22) throw new Error('ZIP is truncated.');
  const endOffset = findEndRecord(bytes);
  const entriesCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (entriesCount > bounded.maxEntries) throw new Error('ZIP contains too many entries.');
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP central directory is invalid.');
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP central entry is invalid.');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > bytes.length) throw new Error('ZIP entry name is truncated.');
    const name = safeEntryName(bytes.subarray(cursor + 46, nameEnd).toString('utf8'));
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if ((flags & 0x0001) !== 0) throw new Error('Encrypted ZIP entries are not supported.');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`ZIP symlink entries are not allowed: ${name}`);
    if (uncompressedSize > bounded.maxEntryBytes) throw new Error(`ZIP entry exceeds size limit: ${name}`);
    if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > bounded.maxCompressionRatio) {
      throw new Error(`ZIP compression ratio exceeds limit: ${name}`);
    }
    total += uncompressedSize;
    if (total > bounded.maxTotalBytes) throw new Error('ZIP expanded content exceeds total size limit.');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header is invalid: ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > bytes.length) throw new Error(`ZIP entry data is truncated: ${name}`);
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const data = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: bounded.maxEntryBytes });
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      throw new Error(`ZIP entry checksum mismatch: ${name}`);
    }
    entries.set(name, data);
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}
