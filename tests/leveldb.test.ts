import { describe, test, expect } from "./harness.ts";
import { snappyUncompress, ldbDecompressedBytes } from "../ts/leveldb.ts";

// Build a minimal raw-Snappy stream by hand (format: varint uncompressed-length,
// then tags). Enough to exercise the literal and copy paths without a compressor.
describe("snappyUncompress", () => {
  test("all-literal block round-trips", () => {
    // "hello" (5 bytes): preamble=0x05, literal tag=((5-1)<<2)=0x10, then the bytes.
    const input = Buffer.from([0x05, 0x10, ...Buffer.from("hello")]);
    expect(snappyUncompress(input).toString()).toBe("hello");
  });

  test("copy op reproduces earlier bytes (overlapping back-reference)", () => {
    // Output "abcabc": literal "abc", then copy length=3 offset=3.
    // literal tag = ((3-1)<<2)=0x08; copy (type 2, 2-byte offset): tag=(3-1)<<2|2=0x0a, offset=3 LE.
    const input = Buffer.from([0x06, 0x08, ...Buffer.from("abc"), 0x0a, 0x03, 0x00]);
    expect(snappyUncompress(input).toString()).toBe("abcabc");
  });

  test("multi-byte literal length (len >= 60)", () => {
    const text = "x".repeat(100); // needs the extended literal-length encoding
    // preamble varint(100)=0x64; literal tag: len-1=99 -> tag base 60 => (60<<2)|0=0xf0,
    // then 1 extra byte = (len-1)=99=0x63, then 100 'x'.
    const input = Buffer.from([0x64, 0xf0, 0x63, ...Buffer.from(text)]);
    expect(snappyUncompress(input).toString()).toBe(text);
  });
});

describe("ldbDecompressedBytes", () => {
  test("returns empty buffer on non-SSTable input (no throw)", () => {
    expect(ldbDecompressedBytes(Buffer.from("not a leveldb table")).length).toBe(0);
  });

  test("returns empty buffer on too-short input", () => {
    expect(ldbDecompressedBytes(Buffer.alloc(8)).length).toBe(0);
  });
});
