// slack-term → slack-hub rename: new names win, old ones still read.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubEnv, namedDir, renameNotice, scopeDirIn } from "../ts/brand.ts";

describe("brand", () => {
  test("hubEnv: SLACK_HUB_* wins, SLACK_TERM_* is the fallback", () => {
    expect(hubEnv("LANG", { SLACK_HUB_LANG: "en", SLACK_TERM_LANG: "ja" })).toBe("en");
    expect(hubEnv("LANG", { SLACK_TERM_LANG: "ja" })).toBe("ja");
    expect(hubEnv("LANG", {})).toBeUndefined();
  });

  test("namedDir / scopeDirIn: the legacy dir only when it alone exists", () => {
    const d = mkdtempSync(join(tmpdir(), "brand-"));
    expect(namedDir(d)).toBe(join(d, "slack-hub"));
    expect(scopeDirIn(d)).toBe(join(d, ".slack-hub"));
    mkdirSync(join(d, "slack-term")); mkdirSync(join(d, ".slack-term"));
    expect(namedDir(d)).toBe(join(d, "slack-term"));
    expect(scopeDirIn(d)).toBe(join(d, ".slack-term"));
    mkdirSync(join(d, "slack-hub")); mkdirSync(join(d, ".slack-hub"));
    expect(namedDir(d)).toBe(join(d, "slack-hub"));
    expect(scopeDirIn(d)).toBe(join(d, ".slack-hub"));
  });

  test("renameNotice: only under the old package name, only on a TTY", () => {
    expect(renameNotice("slack-term", true)).toContain("npm install -g slack-hub");
    expect(renameNotice("slack-term", false)).toBeUndefined();
    expect(renameNotice("slack-hub", true)).toBeUndefined();
  });
});
