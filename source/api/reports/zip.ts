import { deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer, written here rather than pulled in as a dependency.
 *
 * An XLSX file is a ZIP archive of XML parts, so producing one needs exactly three things:
 * a CRC-32 per entry, deflate, and the local-header/central-directory/end-of-directory
 * layout. Doing it in about a hundred lines keeps `npm audit` clean and removes the
 * spreadsheet libraries the laboratory's audit log already flagged.
 *
 * The output is deterministic: the same report always produces byte-identical bytes, so a
 * test can assert on the archive rather than on a timestamp that changes each run.
 */

const FIXED_DOS_TIME = 0; // 00:00:00
const FIXED_DOS_DATE = 0x0021; // 1 January 1980

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]!) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

type Entry = { name: Buffer; body: Buffer; method: number; crc: number; offset: number; compressed: number };

/** Builds a ZIP archive from named parts. Names are literal; no traversal is possible. */
export function zip(parts: Record<string, string>): Buffer {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(body, { level: 9 });
    // Store rather than deflate when compression does not help, so tiny parts do not grow.
    const useDeflate = deflated.length < body.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : body;
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    entries.push({ name: nameBytes, body, method, crc, offset, compressed: payload.length });
    chunks.push(local, nameBytes, payload);
    offset += local.length + nameBytes.length + payload.length;
  }

  const directory: Buffer[] = [];
  let directorySize = 0;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(entry.offset, 42);
    directory.push(central, entry.name);
    directorySize += central.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, ...directory, end]);
}
