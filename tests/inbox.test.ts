// .slack-hub/ inbox/outbox, the fan-out, restrict and the registry. Bun-only.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOutbox, deliver, listInbox, listOutbox, markDone, overdue, recordFailure, recordSent, type Incoming } from "../ts/inbox.ts";
import { findScope, initScope, isRestricted, listAliases, readSettings, registeredScopes, RestrictedError, setAlias, unsetAlias, whoSubscribes } from "../ts/scope.ts";

let root: string;
const prevHome = process.env.SLACK_HUB_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inbox-"));
  process.env.SLACK_HUB_HOME = join(root, "global");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.SLACK_HUB_HOME;
  else process.env.SLACK_HUB_HOME = prevHome;
});

const ROOT_TS = "1700000000.000100";
const msg = (o: Partial<Incoming> = {}): Incoming => ({
  channel: { id: "D00000001", name: "@alice" }, ts: "1700000000.000200", thread_ts: ROOT_TS,
  user: { id: "U00000002", name: "alice" }, text: "please check", permalink: "https://acme.slack.com/archives/D00000001/p1700000000000200", ...o,
});
const lane = (name: string) => {
  initScope(join(root, "tree", name));
  return findScope(join(root, "tree", name));
};
// A fake secret built at run time, never a literal.
const fakeGithub = (): string => ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

describe("registry + who", () => {
  test("init registers the dir; who finds the lane that subscribes a thread", () => {
    const a = lane("design");
    lane("other");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    expect(registeredScopes().map((s) => s.dir).sort()).toEqual([a.dir, join(root, "tree", "other", ".slack-hub")].sort());
    expect(whoSubscribes("D00000001", ROOT_TS).map((x) => [x.scope.dir, x.name])).toEqual([[a.dir, "board"]]);
    expect(whoSubscribes("D00000001", "1700000000.000900")).toEqual([]);
  });
  test("a removed dir drops out of the registry", () => {
    lane("gone");
    rmSync(join(root, "tree", "gone"), { recursive: true });
    expect(registeredScopes()).toEqual([]);
  });
});

describe("deliver", () => {
  test("writes one text-only file per subscribing scope, redacted, with the files count", () => {
    const a = lane("design");
    const b = lane("review");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    setAlias(b, "dm", { channel: "D00000001" }); // channel-wide
    const secret = fakeGithub();
    const dirs = deliver(msg({ text: `token ${secret} here`, files: 2 }));
    expect(dirs.sort()).toEqual([a.dir, b.dir].sort());
    const [entry] = listInbox(a);
    expect(entry!.entry.text).toBe("token [redacted:github-pat] here");
    expect(entry!.entry.redacted).toEqual(["github-pat"]);
    expect(entry!.entry.files).toBe(2);
    expect(entry!.entry.alias).toBe("board");
    expect(readFileSync(entry!.file, "utf8")).not.toContain(secret);
  });
  test("the same message twice is written once (inbox or archived)", () => {
    const a = lane("design");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    expect(deliver(msg())).toEqual([a.dir]);
    expect(deliver(msg())).toEqual([]);
    markDone(a, "1700000000.000200");
    expect(deliver(msg())).toEqual([]);
  });
  test("nobody subscribes: nothing is written", () => {
    lane("design");
    expect(deliver(msg())).toEqual([]);
  });
  test("auto_subscribe: a new top-level DM is subscribed (settings.yml, t-<ts>) and delivered", () => {
    const shr = lane("shr");
    writeFileSync(join(shr.dir, "settings.yml"), "auto_subscribe: [D00000001]\n");
    const top = msg({ ts: "1700000000.000500", thread_ts: null });
    expect(deliver(top)).toEqual([shr.dir]);
    expect(listAliases(shr).map((a) => [a.name, a.thread_ts, a.file])).toEqual([["t-1700000000.000500", "1700000000.000500", "settings.yml"]]);
    // its replies now route there too
    expect(deliver(msg({ ts: "1700000000.000600", thread_ts: "1700000000.000500" }))).toEqual([shr.dir]);
  });
  test("auto_subscribe in settings.local.yml is ignored", () => {
    const shr = lane("shr");
    writeFileSync(join(shr.dir, "settings.local.yml"), "auto_subscribe: [D00000001]\n");
    expect(deliver(msg({ thread_ts: null }))).toEqual([]);
  });
});

describe("restrict_to_subscriptions", () => {
  test("settings.local.yml can neither add subscriptions nor switch it off", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), 'restrict_to_subscriptions: true\nsubscriptions:\n  board:\n    channel: D00000001\n    thread_ts: "1700000000.000100"\n');
    writeFileSync(join(a.dir, "settings.local.yml"), 'restrict_to_subscriptions: false\nsubscriptions:\n  sneaky:\n    channel: D00000001\n    thread_ts: "1700000000.000900"\n');
    expect(isRestricted(a)).toBe(true);
    expect(listAliases(a).map((x) => x.name)).toEqual(["board"]);
    expect(Object.keys(readSettings(a).subscriptions ?? {})).toEqual(["board"]);
    expect(whoSubscribes("D00000001", "1700000000.000900")).toEqual([]);
  });
  test("a lane's alias set refuses; the owner's --shared write works", () => {
    const a = lane("design");
    const shrTree = join(root, "tree", "shr");
    writeFileSync(join(a.dir, "settings.yml"), `# owned by shr\nrestrict_to_subscriptions: true\nowner: ${shrTree}\n`);
    expect(() => setAlias(a, "x", { channel: "D00000001", thread_ts: ROOT_TS })).toThrow(RestrictedError);
    // the lane itself cannot use --shared on its own dir
    expect(() => setAlias(a, "x", { channel: "D00000001", thread_ts: ROOT_TS }, { shared: true, cwd: join(root, "tree", "design") })).toThrow(/owned by/);
    setAlias(a, "x", { channel: "D00000001", thread_ts: ROOT_TS }, { shared: true, cwd: join(shrTree, "sub") });
    expect(listAliases(a).map((x) => [x.name, x.file])).toEqual([["x", "settings.yml"]]);
    // the owner's comment header survives the rewrite
    expect(readFileSync(join(a.dir, "settings.yml"), "utf8")).toStartWith("# owned by shr\n");
  });
});

describe("restricted: the owner decides", () => {
  test("no owner named: nobody may write --shared", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), "restrict_to_subscriptions: true\n");
    expect(() => setAlias(a, "x", { channel: "D00000001" }, { shared: true, cwd: root })).toThrow(/names no `owner`/);
  });
  test("a sibling dir whose name starts like the owner's is not under it", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), `restrict_to_subscriptions: true\nowner: ${join(root, "tree", "shr")}\n`);
    expect(() => setAlias(a, "x", { channel: "D00000001" }, { shared: true, cwd: join(root, "tree", "shr-evil") })).toThrow(/owned by/);
  });
  test("prefix, as_bot and channel from settings.local.yml are ignored when restricted", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), 'restrict_to_subscriptions: true\nprefix: "[design]"\nas_bot: true\n');
    writeFileSync(join(a.dir, "settings.local.yml"), 'prefix: "[shr]"\nas_bot: false\nchannel: C00000009\nowner: /\n');
    expect(readSettings(a)).toEqual({ restrict_to_subscriptions: true, prefix: "[design]", as_bot: true });
  });
  test("auto_subscribe still subscribes (it is the owner's own rule)", () => {
    const shr = lane("shr");
    writeFileSync(join(shr.dir, "settings.yml"), `restrict_to_subscriptions: true\nowner: ${join(root, "elsewhere")}\nauto_subscribe: [D00000001]\n`);
    expect(deliver(msg({ ts: "1700000000.000700", thread_ts: null }))).toEqual([shr.dir]);
  });
  test("unset of a settings.yml alias follows the same owner rule", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), `restrict_to_subscriptions: true\nowner: ${join(root, "tree", "shr")}\nsubscriptions:\n  x:\n    channel: D00000001\n`);
    expect(() => unsetAlias(a, "x", true, join(root, "tree", "design"))).toThrow(/owned by/);
    expect(unsetAlias(a, "x", true, join(root, "tree", "shr"))).toBe("removed");
  });
});

describe("done / outbox", () => {
  test("done moves the entry to archived/, by ts or file name", () => {
    const a = lane("design");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    deliver(msg());
    expect(markDone(a, "D00000001-1700000000.000200.yml")).toBe(join(a.dir, "archived", "D00000001-1700000000.000200.yml"));
    expect(listInbox(a)).toEqual([]);
    expect(markDone(a, "1700000000.000200")).toBeUndefined();
  });
  test("an outbox entry is redacted before it is written", () => {
    const a = lane("design");
    const secret = fakeGithub();
    const r = addOutbox(a, { to: "board", text: `use ${secret}` });
    expect(r.redacted).toEqual(["github-pat"]);
    expect(readFileSync(r.file, "utf8")).not.toContain(secret);
  });
  test("sent: record in sent/ with ts + permalink, outbox emptied, the answered inbox entry archived", () => {
    const a = lane("design");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    deliver(msg());
    addOutbox(a, { to: "board", text: "done", in_reply_to: "1700000000.000200" });
    const [item] = listOutbox(a);
    const to = recordSent(a, item!, { ts: "1700000000.000300", permalink: "https://acme.slack.com/archives/D00000001/p1700000000000300", channel: "D00000001", thread_ts: ROOT_TS });
    expect(readFileSync(to, "utf8")).toContain('ts: "1700000000.000300"');
    expect(listOutbox(a)).toEqual([]);
    expect(listInbox(a)).toEqual([]);
    expect(readdirSync(join(a.dir, "archived"))).toEqual(["D00000001-1700000000.000200.yml"]);
  });
  test("a failure stays queued with error and attempts", () => {
    const a = lane("design");
    addOutbox(a, { to: "board", text: "done" });
    recordFailure(listOutbox(a)[0]!, "channel_not_found");
    recordFailure(listOutbox(a)[0]!, "channel_not_found");
    expect(listOutbox(a)[0]!.entry).toEqual(expect.objectContaining({ attempts: 2, error: "channel_not_found" }));
  });
  test("overdue: entries waiting past nudge_after_min", () => {
    const a = lane("design");
    writeFileSync(join(a.dir, "settings.yml"), "nudge_after_min: 10\n");
    setAlias(a, "board", { channel: "D00000001", thread_ts: ROOT_TS });
    deliver(msg());
    expect(overdue(a)).toEqual([]);
    const f = listInbox(a)[0]!.file;
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(f, old, old);
    expect(overdue(a).map((i) => i.entry.ts)).toEqual(["1700000000.000200"]);
    expect(existsSync(f)).toBe(true);
  });
});
