/** Minimal single-file ZIP builder for Lambda deployment packages (stored, no compression). */

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildMinimalZip(filename: string, content: Buffer): Buffer {
  const filenameBytes = Buffer.from(filename);
  const checksum = crc32(content);

  const localHeader = Buffer.alloc(30 + filenameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(filenameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  filenameBytes.copy(localHeader, 30);

  const centralDir = Buffer.alloc(46 + filenameBytes.length);
  centralDir.writeUInt32LE(0x02014b50, 0);
  centralDir.writeUInt16LE(20, 4);
  centralDir.writeUInt16LE(20, 6);
  centralDir.writeUInt16LE(0, 8);
  centralDir.writeUInt16LE(0, 10);
  centralDir.writeUInt16LE(0, 12);
  centralDir.writeUInt16LE(0, 14);
  centralDir.writeUInt32LE(checksum, 16);
  centralDir.writeUInt32LE(content.length, 20);
  centralDir.writeUInt32LE(content.length, 24);
  centralDir.writeUInt16LE(filenameBytes.length, 28);
  centralDir.writeUInt16LE(0, 30);
  centralDir.writeUInt16LE(0, 32);
  centralDir.writeUInt16LE(0, 34);
  centralDir.writeUInt16LE(0, 36);
  centralDir.writeUInt32LE(0, 38);
  centralDir.writeUInt32LE(0, 42);
  filenameBytes.copy(centralDir, 46);

  const centralDirOffset = localHeader.length + content.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, content, centralDir, eocd]);
}

export function buildNodeLambdaHandlerZip(bodyExpression = "'ok'"): Buffer {
  const handler = `exports.handler = async (event) => ({ statusCode: 200, body: ${bodyExpression} });`;
  return buildMinimalZip("index.js", Buffer.from(handler, "utf8"));
}
