// The Chrome profile picker must never show a bare "Profile N": two profiles that
// differ only by folder are indistinguishable, and "1" vs "Profile 1" is a trap.
import { describe, test, expect } from "./harness.ts";
import { chromeProfileChoiceLabel, matchChromeProfileChoice, autoPickChromeProfile, type ChromeProfileChoice } from "../ts/auth.ts";

const choices: ChromeProfileChoice[] = [
  { profileDir: "Profile 1", profileName: "Work (alice@acme.example)", email: "alice@acme.example", workspaces: ["Acme"], hasWorkspace: false },
  { profileDir: "Profile 2", profileName: "Home (alice@example.com)", email: "alice@example.com", workspaces: ["alice-lab"], hasWorkspace: true },
  { profileDir: "Profile 3", profileName: "Profile 3", workspaces: [], hasWorkspace: false },
];

describe("chromeProfileChoiceLabel", () => {
  test("email first, then name, folder and workspaces", () => {
    expect(chromeProfileChoiceLabel(choices[0]!)).toBe("alice@acme.example (Work)  [Profile 1]  — Slack: Acme");
  });
  test("says so when Chrome has no name/email", () => {
    expect(chromeProfileChoiceLabel(choices[2]!)).toBe("(no name/email in Chrome)  [Profile 3]");
  });
});

describe("matchChromeProfileChoice", () => {
  test("by email, name or folder, case-insensitive", () => {
    expect(matchChromeProfileChoice(choices, "ALICE@example.com")).toBe(1);
    expect(matchChromeProfileChoice(choices, "work")).toBe(0);
    expect(matchChromeProfileChoice(choices, "Profile 3")).toBe(2);
  });
  test("a bare number is not a selector", () => {
    expect(matchChromeProfileChoice(choices, "1")).toBeUndefined();
  });
  test("ambiguous or unknown → undefined", () => {
    const dup = [...choices, { ...choices[0]!, profileDir: "Profile 9" }];
    expect(matchChromeProfileChoice(dup, "alice@acme.example")).toBeUndefined();
    expect(matchChromeProfileChoice(choices, "nobody")).toBeUndefined();
  });
});

describe("autoPickChromeProfile", () => {
  test("the one profile signed in to this workspace", () => {
    expect(autoPickChromeProfile(choices)?.idx).toBe(1);
  });
  test("falls back to the workspace's saved identity", () => {
    const none = choices.map((c) => ({ ...c, hasWorkspace: false }));
    expect(autoPickChromeProfile(none, "alice@acme.example")?.idx).toBe(0);
    expect(autoPickChromeProfile(none)).toBeUndefined();
  });
});
