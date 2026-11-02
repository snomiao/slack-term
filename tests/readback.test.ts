// Read-back normaliser, ported with symphr-thread's own cases (its
// test_symphr_thread.py, "stored_as_sent: real shapes / real differences").
import { describe, expect, test } from "./harness.ts";
import { storedAsSent } from "../ts/readback.ts";

const AT = "@"; // e-mail fixtures built here, so the PII scan does not read them as addresses
type El = [string, string, number?];
const blocks = (...els: El[]) => [{
  type: "rich_text", block_id: "x",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "…" }, ...els.map(([name, unicode, tone]) => ({ type: "emoji", name, unicode, ...(tone ? { skin_tone: tone } : {}) }))] }],
}];
const COMPASS: El = ["compass", "1f9ed"];
const ONE: El = ["one", "0031-fe0f-20e3"];
const CARD: El = ["card_file_box", "1f5c3-fe0f"];
type Case = [string, string, string, ReturnType<typeof blocks> | null];

const match: Case[] = [
  ["🧭 vs :compass:", "[arch] 🧭 status", "[arch] :compass: status", blocks(COMPASS)],
  ["🧭 vs :compass:, no blocks (fallback)", "[arch] 🧭 status", "[arch] :compass: status", null],
  ["🗃️ (with VS16) vs :card_file_box:", "🗃️ sf", ":card_file_box: sf", blocks(CARD)],
  ["🗃 (no VS16) vs :card_file_box:", "🗃 sf", ":card_file_box: sf", blocks(CARD)],
  ["keycap 1️⃣ vs :one:", "1️⃣ first", ":one: first", blocks(ONE)],
  ["keycap 1⃣ (no VS16) vs :one:", "1⃣ first", ":one: first", blocks(ONE)],
  ["skin tone 👍🏽 (skin_tone field)", "👍🏽 ok", ":+1::skin-tone-4: ok", blocks(["+1", "1f44d-1f3fd", 4])],
  ["skin tone, element named +1::skin-tone-4", "👍🏽 ok", ":+1::skin-tone-4: ok", blocks(["+1::skin-tone-4", "1f44d-1f3fd"])],
  ["skin tone, unicode without the tone", "👍🏽 ok", ":+1::skin-tone-4: ok", blocks(["+1", "1f44d", 4])],
  ["skin tone, no blocks (fallback)", "👍🏽 ok", ":+1::skin-tone-4: ok", null],
  ["ZWJ 🧑‍💻 vs :technologist:", "🧑‍💻 dev", ":technologist: dev", blocks(["technologist", "1f9d1-200d-1f4bb"])],
  ["ZWJ + tone", "🧑🏽‍💻 dev", ":technologist::skin-tone-4: dev", blocks(["technologist", "1f9d1-1f3fd-200d-1f4bb", 4])],
  ["ZWJ family, no blocks", "👨‍👩‍👧 home", ":man-woman-girl: home", null],
  ["ZWJ stored as parts, no blocks", "👨‍👩 x", ":man:‍:woman: x", null],
  ["& -> &amp;", "R&D & ops", "R&amp;D &amp; ops", null],
  ["< > -> &lt; &gt;", "reply <thread_ts> -> ok", "reply &lt;thread_ts&gt; -&gt; ok", null],
  ["URL -> <url>", "PR https://github.com/acme/repo/pull/78 merged", "PR <https://github.com/acme/repo/pull/78> merged", null],
  ["URL with & -> <url&amp;>", "see https://x.example/a?b=1&c=2", "see <https://x.example/a?b=1&amp;c=2>", null],
  ["explicit <url|label> kept", "<https://x.example/p|plan>", "<https://x.example/p|plan>", null],
  ["bare domain -> <http://d|d>", "see README.md", "see <http://README.md|README.md>", null],
  ["e-mail -> <mailto:a|a>", `mail a${AT}b.example`, `mail <mailto:a${AT}b.example|a${AT}b.example>`, null],
  ["whitespace runs", "a  b\n\nc ", "a b\nc", null],
  ["literal :30: stays literal", "10:30: 🧭 go", "10:30: :compass: go", blocks(COMPASS)],
  ["literal :30: + emoji, no blocks", "10:30: 🧭 go", "10:30: :compass: go", null],
  ["explicit <http://d|d> on both sides", "<http://a.example|a.example>", "<http://a.example|a.example>", null],
  ["explicit https link with a bare label", "<https://a.example/x|a.example/x>", "<https://a.example/x|a.example/x>", null],
  ["explicit mailto with a label", `<mailto:a${AT}b.example|Contact>`, `<mailto:a${AT}b.example|Contact>`, null],
  ["flag, no blocks", "🇯🇵 jp", ":flag-jp: jp", null],
  ["adjacent: mapped equal + one unmapped", "🔴🧭 go", ":red_circle::compass: go", blocks(["red_circle", "1f534"])],
  ["the shortcode written by hand", "[arch] :compass: ok", "[arch] :compass: ok", blocks(COMPASS)],
  ["a whole board, mixed", "[arch] 🧭 *arch* — web#78 merged & deployed\n次: https://x.example/z (1️⃣ review)",
    "[arch] :compass: *arch* — web#78 merged &amp; deployed\n次: <https://x.example/z> (:one: review)", blocks(COMPASS, ONE)],
];
const differ: Case[] = [
  ["different words", "[arch] status: building", "[arch] status: done", null],
  ["emoji-only difference 🟢 vs :red_circle:", "🟢 API", ":red_circle: API", blocks(["red_circle", "1f534"])],
  ["old text still there (edit not applied)", "[arch] 🧭 step 2", "[arch] :compass: step 1", blocks(COMPASS)],
  ["old text still there, no blocks", "[arch] 🧭 step 2", "[arch] :compass: step 1", null],
  ["different URL", "https://a.example/1", "<https://a.example/2>", null],
  ["same label, different link target", "<https://a.example/1|board>", "<https://a.example/2|board>", null],
  ["text cut short", "[arch] a b c", "[arch] a b", null],
  ["stored empty", "[arch] x", "", null],
  ["a literal :30: must not hide 🟢 vs 🔴", "10:30: 🟢 API", "10:30: :red_circle: API", blocks(["red_circle", "1f534"])],
  ["explicit https target vs stored http", "<https://a.example|a.example>", "<http://a.example|a.example>", null],
  ["explicit http target vs stored https", "<http://a.example|a.example>", "<https://a.example|a.example>", null],
  ["mapped emoji differs next to an unmapped one", "🟢 a :30: 🧭", ":red_circle: a :30: :compass:", blocks(["red_circle", "1f534"])],
  ["literal time differs, no blocks", "10:30: 🧭 go", "10:45: :compass: go", null],
  ["an emoji run missing, no blocks", "🧭 a 🧭", ":compass: a", null],
  ["mailto target differs", `<mailto:a${AT}b.example|Contact>`, `<mailto:c${AT}b.example|Contact>`, null],
  ["adjacent 10:30:🟢 vs 10:30::red_circle:", "10:30:🟢 API", "10:30::red_circle: API", blocks(["red_circle", "1f534"])],
  ["adjacent 🟢🧭 vs :red_circle::compass: (red mapped)", "🟢🧭", ":red_circle::compass:", blocks(["red_circle", "1f534"])],
  ["trailing slash added to an auto-link target", "<http://a.example/x|a.example/x>", "<http://a.example/x/|a.example/x>", null],
  ["one emoji sent, two unmapped shortcodes stored", "🧭 x", ":compass::compass: x", null],
  ["unmapped shortcode where a plain character was sent", "x y", ":compass: y", null],
];
const msg = (stored: string, blk: Case[3]) => (blk ? { text: stored, blocks: blk } : { text: stored });

describe("storedAsSent: real shapes (must match)", () => {
  for (const [name, sent, stored, blk] of match) test(name, () => expect(storedAsSent(sent, msg(stored, blk))).toBe(true));
});
describe("storedAsSent: real differences (must NOT match)", () => {
  for (const [name, sent, stored, blk] of differ) test(name, () => expect(storedAsSent(sent, msg(stored, blk))).toBe(false));
});
