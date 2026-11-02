// Redaction: gitleaks' rules ported in-process + ours. Every fake secret is
// built at run time from a seeded generator, so no token-shaped literal sits
// in the repo (and none of them is real).
import { describe, expect, test } from "bun:test";
import { findSecrets, goToJs, redact, secretRules } from "../ts/redact.ts";

let seed = 0x5eed;
const rand = (): number => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rnd = (n: number, abc = AN): string => Array.from({ length: n }, () => abc[Math.floor(rand() * abc.length)]).join("");
const dig = (n: number): string => rnd(n, "0123456789");
const hex = (n: number): string => rnd(n, "0123456789abcdef");

/** One generator per kind taku listed (11-02). */
const FAKES: Record<string, () => string> = {
  slack_bot: () => ["xox", "b-", dig(12), "-", dig(13), "-", rnd(24)].join(""),
  slack_user: () => ["xox", "p-", dig(12), "-", dig(12), "-", dig(13), "-", hex(32)].join(""),
  slack_app: () => ["xap", "p-1-A", rnd(10, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "-", dig(13), "-", hex(64)].join(""),
  github_pat: () => ["gh", "p_", rnd(36)].join(""),
  github_oauth: () => ["gh", "o_", rnd(36)].join(""),
  github_fine: () => ["github", "_pat_", rnd(22), "_", rnd(59)].join(""),
  openai: () => ["sk", "-proj-", rnd(48), "T3Blbk", "FJ", rnd(48)].join(""),
  anthropic: () => ["sk", "-ant-api03-", rnd(93), "AA"].join(""),
  openrouter: () => ["sk", "-or-v1-", hex(64)].join(""),
  aws: () => ["AK", "IA", rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")].join(""),
  jwt: () => ["ey", "JhbGciOiJIUzI1NiJ9.", "ey", "J", rnd(40), ".", rnd(43)].join(""),
  pem: () => ["-----BEGIN RSA PRIVATE ", "KEY-----\n", rnd(64), "\n", rnd(64), "\n-----END RSA PRIVATE KEY-----"].join(""),
  url_param: () => `https://example.com/cb?${["token", "key", "secret", "password", "sig"][Math.floor(rand() * 5)]}=${rnd(32)}&x=1`,
  otp: () => (rand() < 0.5 ? `認証コード ${dig(6)} です` : `your verification code: ${dig(6)}`),
};

/** Look-alikes that are NOT secrets: the false-positive control. */
const BENIGN: (() => string)[] = [
  () => `ts 17${dig(8)}.${dig(6)}`, () => `2026-11-02T03:${dig(2)}:00Z`, () => `PR #${dig(3)}`, () => `commit ${hex(40)}`,
  () => `https://github.com/acme/repo/pull/${dig(3)}?w=1`, () => `合計 ${dig(6)} 円`, () => `channel C0000000${dig(1)}`, () => `order ${dig(6)} shipped`,
  () => `uuid ${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`, () => "`sk-` prefixed keys are rotated monthly",
  () => "use ?token=<your token> in the URL", () => `version 1.48.0, build ${dig(6)}`, () => "https://acme.slack.com/archives/C00000001/p1700000000000100",
];
const WORDS = "deploy the board thread reply status done check build review merge test relay worker pinlog alias lane design".split(" ");
const JA = "デプロイ 完了 確認 お願いします スレッド 返信 ボード 状況 了解 修正 レビュー".split(" ");
const filler = (n: number): string => Array.from({ length: n }, (_, i) => ((i % 3 ? WORDS : JA)[Math.floor(rand() * 11)])).join(" ");

describe("goToJs", () => {
  test("a leading (?i) becomes the i flag", () => expect(goToJs("(?i)abc")).toEqual({ source: "abc", flags: "i" }));
  test("a mid-pattern (?i) is scoped to the end of its group", () => {
    const { source, flags } = goToJs("(a(?i)b)c");
    expect(source).toBe("(a(?i:b))c");
    const re = new RegExp(source, flags);
    expect(re.test("aBc")).toBe(true);
    expect(re.test("abC")).toBe(false);
  });
  test("(?P<name> and POSIX classes", () => {
    expect(goToJs("(?P<x>[[:alnum:]]+)").source).toBe("(?<x>[A-Za-z0-9]+)");
  });
  test("every gitleaks rule with a regex compiles", () => {
    expect(secretRules().length).toBeGreaterThan(200);
  });
});

describe("redact: one test per kind", () => {
  for (const [kind, make] of Object.entries(FAKES)) {
    test(kind, () => {
      const secret = make();
      const r = redact(`before ${secret} after`);
      expect(r.text).not.toContain(secret.length > 12 ? secret.slice(4, -4) : secret);
      expect(r.text).toMatch(/^before .*\[redacted:[a-z0-9-]+\].* after$/s);
      expect(r.kinds.length).toBeGreaterThan(0);
    });
  }
});

describe("redact: positive control (nothing to redact)", () => {
  for (const make of BENIGN) {
    const text = make();
    test(text.slice(0, 50), () => expect(redact(text)).toEqual({ text, kinds: [] }));
  }
  test("plain prose is returned as is", () => {
    const text = "完了しました。deploy done, see the board thread.";
    expect(redact(text)).toEqual({ text, kinds: [] });
  });
});

describe("redact: shape of the output", () => {
  test("names the rule and keeps the text around it", () => {
    const secret = FAKES.github_pat!();
    expect(redact(`token ${secret} ok`).text).toBe("token [redacted:github-pat] ok");
  });
  test("overlapping hits become one span", () => {
    const secret = FAKES.openai!();
    const r = redact(secret);
    expect(r.text.match(/\[redacted:/g)?.length).toBe(1);
  });
  test("a 6-digit number without a code word stays", () => expect(redact("order 482913 shipped").kinds).toEqual([]));
});

describe("spans come from the match's own group (rechrome #55)", () => {
  test("a value equal to the param name: the VALUE is masked, the name kept", () => {
    expect(redact("see https://example.com/x?secret=secret&y=1").text).toBe("see https://example.com/x?secret=[redacted:url-secret-param]&y=1");
  });
});

describe("known values (the 4th rule)", () => {
  test("an exact value the caller handled is masked wherever it appears", () => {
    const v = rnd(12);
    expect(redact(`a ${v} b ${v}`, { known: [v] }).text).toBe("a [redacted:known-secret] b [redacted:known-secret]");
  });
  test("its JSON-string spelling too", () => {
    const v = `pa"ss\\${rnd(8)}`;
    const json = JSON.stringify({ p: v });
    expect(redact(json, { known: [v] }).text).toBe('{"p":"[redacted:known-secret]"}');
  });
  test("longest first, so a value inside another is not cut in two", () => {
    const short = rnd(8);
    const long = `${short}${rnd(8)}`;
    expect(redact(`x ${long} y`, { known: [short, long] }).text).toBe("x [redacted:known-secret] y");
  });
  test("values under 6 chars are ignored", () => expect(redact("abc abc", { known: ["abc"] }).kinds).toEqual([]));
});

describe("the 1,000-message bench set (synthetic)", () => {
  test("catches every planted secret, flags no clean message, ~0.1 ms/msg", () => {
    seed = 0x5eed;
    const kinds = Object.keys(FAKES);
    const msgs = Array.from({ length: 1000 }, (_, i) => {
      const text = filler(5 + Math.floor(rand() * 120));
      if (i % 10) return { text: i % 2 ? `${text} ${BENIGN[i % BENIGN.length]!()} ${filler(3)}` : text };
      return { text: `${text} ${FAKES[kinds[(i / 10) % kinds.length]!]!()} ${filler(5)}`, planted: true };
    });
    secretRules(); // load once, outside the timing
    const t0 = performance.now();
    let caught = 0;
    let falsePositive = 0;
    for (const m of msgs) {
      const hit = findSecrets(m.text).length > 0;
      if (m.planted && hit) caught++;
      if (!m.planted && hit) falsePositive++;
    }
    const msPerMsg = (performance.now() - t0) / msgs.length;
    expect(caught).toBe(100);
    expect(falsePositive).toBe(0);
    // Generous: measured 0.10-0.13 ms on a loaded 4-CPU box.
    expect(msPerMsg).toBeLessThan(5);
  });
});
