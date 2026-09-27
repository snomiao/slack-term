// Minimal read-only LevelDB SSTable (.ldb) reader + Snappy decompressor.
//
// Chrome/Electron store LocalStorage in LevelDB, and its .ldb (sorted table)
// files keep data blocks Snappy-compressed, so a raw regex scan can't recover a
// value that a Snappy copy-op split apart. This module decompresses the data
// blocks and returns their concatenated bytes for scanning — it recovers record
// VALUES only (enough to find "token":"xoxc-…"); it is not a general client and
// does no key lookup, bloom/filter handling, or CRC verification.
//
// SSTable layout (github.com/google/leveldb/blob/main/doc/table_format.md):
//   file = block* + metaindex_block + index_block + footer
//   block = content-bytes + type(1) + crc32c(4)   (type 0 = raw, 1 = snappy)
//   footer (last 48 bytes) = metaindex_handle + index_handle + pad + magic(8)
//   BlockHandle = varint(offset) + varint(size)   (size excludes the 5-byte trailer)

const FOOTER_LEN = 48;

/** Read a LEB128 varint using float arithmetic so 64-bit offsets/sizes stay exact past 2^31. */
function readVarint(buf: Buffer, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, pos: p };
}

/** Decompress a Snappy block (raw format: varint uncompressed-length preamble, then tags). */
export function snappyUncompress(input: Buffer): Buffer {
  // Preamble: total uncompressed length.
  let pos = 0;
  let outLen = 0;
  let shift = 0;
  while (pos < input.length) {
    const b = input[pos++]!;
    outLen += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const out = Buffer.allocUnsafe(outLen);
  let op = 0;
  while (pos < input.length && op < outLen) {
    const tag = input[pos++]!;
    const type = tag & 0x3;
    if (type === 0) {
      // Literal: length-1 in the upper 6 bits, or in the following 1-4 bytes when >= 60.
      let len = tag >> 2;
      if (len >= 60) {
        const extra = len - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len += input[pos++]! * 2 ** (8 * i);
      }
      len += 1;
      input.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
    } else {
      // Copy: length + back-reference offset into the already-produced output.
      let length: number;
      let offset: number;
      if (type === 1) {
        length = 4 + ((tag >> 2) & 0x7);
        offset = ((tag >> 5) & 0x7) * 256 + input[pos++]!;
      } else if (type === 2) {
        length = 1 + (tag >> 2);
        offset = input[pos]! + input[pos + 1]! * 256;
        pos += 2;
      } else {
        length = 1 + (tag >> 2);
        offset = input[pos]! + input[pos + 1]! * 256 + input[pos + 2]! * 65536 + input[pos + 3]! * 16777216;
        pos += 4;
      }
      let src = op - offset;
      for (let i = 0; i < length && op < outLen; i++) out[op++] = out[src++]!;
    }
  }
  return op === outLen ? out : out.subarray(0, op);
}

type BlockHandle = { offset: number; size: number };

function decodeBlockHandle(buf: Buffer, pos: number): { handle: BlockHandle; pos: number } {
  const off = readVarint(buf, pos);
  const sz = readVarint(buf, off.pos);
  return { handle: { offset: off.value, size: sz.value }, pos: sz.pos };
}

/** Read one block's content, decompressing when the trailer marks it Snappy (type 1). */
function readBlockContent(file: Buffer, handle: BlockHandle): Buffer {
  const { offset, size } = handle;
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size];
  return type === 1 ? snappyUncompress(raw) : Buffer.from(raw);
}

/** Iterate a decompressed block's entries, yielding each value's bytes (keys reconstructed but unused here). */
function blockValues(block: Buffer): Buffer[] {
  if (block.length < 4) return [];
  const numRestarts = block.readUInt32LE(block.length - 4);
  const entriesEnd = block.length - (numRestarts + 1) * 4;
  const values: Buffer[] = [];
  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < entriesEnd) {
    const s = readVarint(block, pos);
    const ns = readVarint(block, s.pos);
    const vl = readVarint(block, ns.pos);
    pos = vl.pos;
    const shared = s.value;
    const nonShared = ns.value;
    const valueLen = vl.value;
    const keyDelta = block.subarray(pos, pos + nonShared);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    prevKey = Buffer.concat([prevKey.subarray(0, shared), keyDelta]);
    values.push(value);
  }
  return values;
}

/**
 * Decompress every data block referenced by an SSTable's index and return their
 * concatenated bytes. Record values survive intact (Slack stores a workspace's
 * config as one JSON string value), so the result can be regex-scanned.
 * Returns an empty buffer if the file isn't a parseable SSTable.
 */
export function ldbDecompressedBytes(file: Buffer): Buffer {
  if (file.length < FOOTER_LEN) return Buffer.alloc(0);
  try {
    const footerStart = file.length - FOOTER_LEN;
    const meta = decodeBlockHandle(file, footerStart);   // metaindex handle (skipped)
    const index = decodeBlockHandle(file, meta.pos);     // index handle
    const indexBlock = readBlockContent(file, index.handle);
    const chunks: Buffer[] = [];
    for (const handleBytes of blockValues(indexBlock)) {
      // Each index entry's value is a BlockHandle pointing at a data block.
      try {
        const { handle } = decodeBlockHandle(handleBytes, 0);
        chunks.push(readBlockContent(file, handle));
      } catch {
        // skip a malformed handle
      }
    }
    return Buffer.concat(chunks);
  } catch {
    return Buffer.alloc(0);
  }
}
