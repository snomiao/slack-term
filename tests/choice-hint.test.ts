import { describe, expect, test } from "./harness.ts";
import { choiceQuestionLang } from "../ts/choiceHint.ts";

describe("choice-question hint: positives (any language)", () => {
  for (const t of [
    "デプロイしますか（是／否）",
    "進めてよいですか (是/否)？",
    "続けますか（はい／いいえ）",
    "Ship it now (yes/no)?",
    "Proceed? (y/n)",
    "どちらにしますか「A/B/C」？",
    "which one? (a) keep it (b) drop it?",
    "Pick one: a) rebase b) merge?",
    "（a）残す（b）消す どちらにしますか？",
  ]) test(t, () => expect(choiceQuestionLang(t)).toBeDefined());
});

describe("choice-question hint: negatives", () => {
  for (const t of [
    "Can you check the build?",
    "ビルドを確認してもらえますか？",
    "see https://example.com/page?a=1&b=2",
    "<https://example.com/x?y=1|the doc> is updated",
    "run `curl -X POST 'https://x/?a=1'` then tell me?",
    "done: (a) fixed, (b) tested.",
    "the ratio is 3/4",
  ]) test(t, () => expect(choiceQuestionLang(t)).toBeUndefined());
});

describe("packs hot-reload, and .slack-hub/locales overrides", () => {
  test("a pack added or edited under .slack-hub/locales takes effect on the next call", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "packs-"));
    const prev = process.cwd();
    try {
      mkdirSync(join(dir, ".slack-hub", "locales"), { recursive: true });
      process.chdir(dir);
      expect(choiceQuestionLang("Tu viens (oui/non) ?")).toBeUndefined();
      const fr = join(dir, ".slack-hub", "locales", "fr.json");
      writeFileSync(fr, JSON.stringify({ lang: "fr", choice_patterns: ["\\(\\s*oui\\s*/\\s*non\\s*\\)"] }));
      expect(choiceQuestionLang("Tu viens (oui/non) ?")).toBe("fr");
      writeFileSync(fr, JSON.stringify({ lang: "fr", choice_patterns: [] }));
      const later = Date.now() / 1000 + 5;
      utimesSync(fr, later, later); // a new mtime, as an edit a moment later would have
      expect(choiceQuestionLang("Tu viens (oui/non) ?")).toBeUndefined();
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
