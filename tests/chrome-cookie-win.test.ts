import { describe, test, expect } from "./harness.ts";
import { randomBytes, createCipheriv } from "node:crypto";
import { deriveMasterKey, decryptCookieV20 } from "../ts/chromeCookieWin.ts";

// The embedded unwrap keys (public constants in Chrome's elevation service) — duplicated here
// so the round-trip proves deriveMasterKey both parses the layout AND uses the right key.
const FLAG1 = Buffer.from("b31c6e241ac846728da9c1fac4936651cffb944d143ab816276bcc6da0284787", "hex");
const FLAG2 = Buffer.from("e98f37d7f4e1fa433d19304dc2258042090e2d1d7eea7670d41f738d08729660", "hex");

/** Build the double-DPAPI blob layout: [u32 headerLen][header][u32 contentLen][flag][iv|ct|tag]. */
function buildFlagBlob(flag: 1 | 2, master: Buffer): Buffer {
  const header = Buffer.from("\x02C:\\Program Files\\Google\\Chrome", "latin1");
  const iv = randomBytes(12);
  const c = flag === 1
    ? createCipheriv("aes-256-gcm", FLAG1, iv)
    : createCipheriv("chacha20-poly1305", FLAG2, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(master), c.final()]);
  const tag = c.getAuthTag();
  const content = Buffer.concat([Buffer.from([flag]), iv, ct, tag]); // 1+12+32+16 = 61
  const hLen = Buffer.alloc(4); hLen.writeUInt32LE(header.length, 0);
  const cLen = Buffer.alloc(4); cLen.writeUInt32LE(content.length, 0);
  return Buffer.concat([hLen, header, cLen, content]);
}

describe("chromeCookieWin", () => {
  test("deriveMasterKey unwraps flag 1 (AES-256-GCM)", () => {
    const master = randomBytes(32);
    expect(deriveMasterKey(buildFlagBlob(1, master)).equals(master)).toBe(true);
  });

  test("deriveMasterKey unwraps flag 2 (ChaCha20-Poly1305)", () => {
    // ChaCha20-Poly1305 is available in Node (production) but not in every bun build;
    // skip where the runtime lacks the cipher (the module falls back to manual paste there).
    let chachaOk = true;
    try { createCipheriv("chacha20-poly1305", randomBytes(32), randomBytes(12), { authTagLength: 16 }); }
    catch { chachaOk = false; }
    if (!chachaOk) return;
    const master = randomBytes(32);
    expect(deriveMasterKey(buildFlagBlob(2, master)).equals(master)).toBe(true);
  });

  test("deriveMasterKey throws on an unsupported flag", () => {
    const blob = buildFlagBlob(1, randomBytes(32));
    const flagOff = 4 + blob.readUInt32LE(0) + 4;
    blob[flagOff] = 9; // corrupt the flag
    expect(() => deriveMasterKey(blob)).toThrow("Unsupported app-bound key flag");
  });

  test("decryptCookieV20 strips the 32-byte prefix and returns the cookie", () => {
    const master = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.concat([randomBytes(32), Buffer.from("xoxd-abc123", "utf8")]);
    const c = createCipheriv("aes-256-gcm", master, iv);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    const enc = Buffer.concat([Buffer.from("v20", "latin1"), iv, ct, c.getAuthTag()]);
    expect(decryptCookieV20(master, enc)).toBe("xoxd-abc123");
  });
});
