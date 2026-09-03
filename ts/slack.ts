// Slack Web API client (user token, Authorization: Bearer)

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Slack rate limited — retry after ${retryAfter}s`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

function base(): string {
  return (process.env.SLACK_API_BASE ?? "https://slack.com/api").replace(/\/$/, "");
}

async function call(token: string, method: string, init: RequestInit, cookie?: string): Promise<Json> {
  const extraHeaders: Record<string, string> = {};
  if (cookie) extraHeaders["Cookie"] = `d=${cookie}`;
  const res = await fetch(`${base()}/${method}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    throw new RateLimitError(isNaN(retryAfter) ? 60 : retryAfter);
  }
  const body = (await res.json()) as { ok?: boolean; error?: string } & Record<string, Json>;
  if (body.ok !== true) {
    const err = body.error ?? "unknown";
    if (err === "ratelimited") throw new RateLimitError(60);
    // A desktop session token (xoxc-) is only accepted by the public Web API when
    // paired with its xoxd session cookie — without one, point at the xoxp fallback.
    if (err === "invalid_auth" && token.startsWith("xoxc-") && !cookie) {
      throw new Error(
        `Desktop app token (xoxc-) needs its session cookie to be accepted by the public Slack API.\n` +
        `Attach it:  slack auth chrome   (macOS)   or   slack auth firefox\n` +
        `Or replace the token with an xoxp- user token:\n` +
        `  slack auth token`,
      );
    }
    // Bot tokens (xoxb-) can't act as a user: they lack user scopes (missing_scope) and can't
    // open a DM with themselves (cannot_dm_bot, e.g. `tail @you`). Point at a user-token workspace.
    if ((err === "missing_scope" || err === "cannot_dm_bot") && token.startsWith("xoxb-")) {
      const why = err === "cannot_dm_bot"
        ? `you're authenticated as a bot, so "@you" is the bot itself and it can't DM itself`
        : `this bot token lacks the user scope this action needs`;
      throw new Error(
        `Slack error on ${method}: ${err} — ${why}.\n` +
        `Tailing/DMing people and listing users need a user session, not a bot token.\n` +
        `  Switch workspace:  slack auth ls   then   slack auth use <name>\n` +
        `  Or import your Slack desktop session:  slack auth login`,
      );
    }
    throw new Error(`Slack error on ${method}: ${err}`);
  }
  return body as Json;
}

// Internal Slack API caller — does NOT reject xoxc tokens.
// Used for hidden endpoints (drafts, etc.) only accessible via session tokens.
// cookie: raw xoxd value (without "d=" prefix); injected as Cookie header when present.
async function callSession(token: string, method: string, init: RequestInit, cookie?: string): Promise<Json> {
  const extraHeaders: Record<string, string> = {};
  if (cookie) extraHeaders["Cookie"] = `d=${cookie}`;
  const res = await fetch(`${base()}/${method}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    throw new RateLimitError(isNaN(retryAfter) ? 60 : retryAfter);
  }
  const body = (await res.json()) as { ok?: boolean; error?: string } & Record<string, Json>;
  if (body.ok !== true) {
    const err = body.error ?? "unknown";
    if (err === "ratelimited") throw new RateLimitError(60);
    if ((err === "invalid_auth" || err === "not_authed") && !token.startsWith("xoxc-")) {
      throw new Error(
        `The draft API requires a desktop app session token (xoxc-).\n` +
        `Import from Slack desktop:  slack auth login`,
      );
    }
    if ((err === "invalid_auth" || err === "not_authed") && !cookie) {
      throw new Error(
        `drafts.list also requires the xoxd session cookie.\n` +
        `Attach it with:  slack auth chrome   (macOS)   or   slack auth firefox`,
      );
    }
    throw new Error(`Slack error on ${method}: ${err}`);
  }
  return body as Json;
}

function postSession(token: string, method: string, params: Record<string, string> = {}, cookie?: string): Promise<Json> {
  // Internal Slack APIs accept form-encoded body with token field.
  const body = new URLSearchParams({ token, ...params });
  return callSession(token, method, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, cookie);
}

function get(token: string, method: string, params: Record<string, string>, cookie?: string): Promise<Json> {
  const qs = new URLSearchParams(params).toString();
  return call(token, `${method}?${qs}`, { method: "GET" }, cookie);
}

function post(token: string, method: string, body: Record<string, Json>, cookie?: string): Promise<Json> {
  return call(token, method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, cookie);
}

export async function authTest(
  token: string,
  cookie?: string,
): Promise<{ team: string; teamId: string; url: string; user: string; userId: string }> {
  const resp = (await get(token, "auth.test", {}, cookie)) as {
    team?: string; team_id?: string; url?: string; user?: string; user_id?: string;
  };
  return {
    team: resp.team ?? "",
    teamId: resp.team_id ?? "",
    url: resp.url ?? "",
    user: resp.user ?? "",
    userId: resp.user_id ?? "",
  };
}

// auth.test plus the token's granted scopes. Slack returns the granted bot/user
// scopes in the `X-OAuth-Scopes` response header on every Web API call, which is
// the only way to learn what a token can do without probing each endpoint.
export async function authScopes(token: string, cookie?: string): Promise<{
  userId: string; user: string; botId: string; team: string; url: string; scopes: string[];
}> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (cookie) headers["Cookie"] = `d=${cookie}`;
  const res = await fetch(`${base()}/auth.test`, { method: "GET", headers });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    throw new RateLimitError(isNaN(retryAfter) ? 60 : retryAfter);
  }
  const scopesHeader = res.headers.get("x-oauth-scopes") ?? "";
  const body = (await res.json()) as {
    ok?: boolean; error?: string; user_id?: string; user?: string; bot_id?: string; team?: string; url?: string;
  };
  if (body.ok !== true) throw new Error(`Slack error on auth.test: ${body.error ?? "unknown"}`);
  return {
    userId: body.user_id ?? "",
    // The token owner's @handle (for a bot token, the bot user's name) — lets a
    // caller name the sending identity without a second auth.test round-trip.
    user: body.user ?? "",
    botId: body.bot_id ?? "",
    team: body.team ?? "",
    url: body.url ?? "",
    scopes: scopesHeader.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

// Resolve a bot's app_id (and bot user id) from its bot_id — needed to build the
// app-settings deep link in messaging diagnostics.
export async function botsInfo(token: string, botId: string, cookie?: string): Promise<{ appId: string; userId: string }> {
  const resp = (await get(token, "bots.info", { bot: botId }, cookie)) as {
    bot?: { app_id?: string; user_id?: string };
  };
  return { appId: resp.bot?.app_id ?? "", userId: resp.bot?.user_id ?? "" };
}

export async function history(
  token: string,
  channel: string,
  limit = 20,
  oldest?: string,
  cursor?: string,
  cookie?: string,
  // `oldest` is EXCLUSIVE by default — the message at that exact ts is left out.
  // Set this to get it back, which is what a caller polling a message it just
  // posted (its reactions, its reply_count) actually needs. Only sent when true
  // so every existing caller's request is byte-identical to before.
  inclusive?: boolean,
): Promise<Json> {
  const params: Record<string, string> = { channel, limit: String(limit) };
  if (oldest !== undefined) params.oldest = oldest;
  if (cursor !== undefined) params.cursor = cursor;
  if (inclusive) params.inclusive = "true";
  return get(token, "conversations.history", params, cookie);
}

export async function replies(
  token: string,
  channel: string,
  ts: string,
  limit = 50,
  cookie?: string,
): Promise<Json> {
  return get(token, "conversations.replies", { channel, ts, limit: String(limit) }, cookie);
}

// Metadata for a single uploaded file (files.info). Carries url_private_download,
// which requires an Authorization: Bearer token (+ xoxd cookie for session tokens)
// to actually fetch the bytes.
export async function filesInfo(token: string, fileId: string, cookie?: string): Promise<Json> {
  return get(token, "files.info", { file: fileId }, cookie);
}

// files.list — list files visible to the token. Paginated by page number (not a
// cursor); the response's `paging.pages` tells the caller how many pages exist.
// `types` is Slack's comma-separated filter (images,pdfs,gdocs,snippets,zips,
// spaces,all). Note: canvases and Slack Lists shown in the web "unified files"
// view are largely NOT returned here — those live behind internal APIs the CLI's
// token type can't reach — so this surfaces conventional file uploads.
export async function filesList(
  token: string,
  opts: { page?: number; count?: number; types?: string; channel?: string; user?: string } = {},
  cookie?: string,
): Promise<Json> {
  const params: Record<string, string> = {
    count: String(Math.min(Math.max(opts.count ?? 100, 1), 200)),
    page: String(Math.max(opts.page ?? 1, 1)),
  };
  if (opts.types) params.types = opts.types;
  if (opts.channel) params.channel = opts.channel;
  if (opts.user) params.user = opts.user;
  return get(token, "files.list", params, cookie);
}

// Slack Lists ("tasklist"). The public slackLists.* Web API rejects the CLI's
// xoxc desktop token (not_allowed_token_type) and needs a bot token with
// lists:read; the web client instead uses the internal lists.records.list, which
// DOES accept an xoxc token + the d cookie — so this reuses the CLI's existing
// session auth. `listId` is the list's file id (F…), taken from its URL; there
// is no list-enumeration API, so the caller must supply the id. Paginated by
// cursor via response_metadata.next_cursor.
export async function listRecords(
  token: string,
  listId: string,
  opts: { limit?: number; cursor?: string } = {},
  cookie?: string,
): Promise<Json> {
  const params: Record<string, string> = { list_id: listId };
  if (opts.limit) params.limit = String(opts.limit);
  if (opts.cursor) params.cursor = opts.cursor;
  return postSession(token, "lists.records.list", params, cookie);
}

export async function searchPage(
  token: string,
  query: string,
  count: number,
  page: number,
  cookie?: string,
): Promise<Json> {
  return get(token, "search.messages", {
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: String(Math.min(Math.max(count, 1), 100)),
    page: String(Math.max(page, 1)),
  }, cookie);
}

export async function search(token: string, query: string, cookie?: string): Promise<Json> {
  return searchPage(token, query, 100, 1, cookie);
}

export async function searchAll(token: string, query: string, max: number, cookie?: string): Promise<Json> {
  const perPage = 100;
  let page = 1;
  const all: Json[] = [];
  let last: Json = { ok: true, messages: {} };
  while (true) {
    const resp = await searchPage(token, query, perPage, page, cookie);
    const matches = getPath(resp, ["messages", "matches"]);
    const arr = Array.isArray(matches) ? matches : [];
    all.push(...arr);
    const pages = Number(getPath(resp, ["messages", "paging", "pages"]) ?? 1);
    last = resp;
    if (arr.length === 0 || page >= pages || all.length >= max) break;
    page += 1;
  }
  const out = last as { messages?: { matches?: Json } };
  if (!out.messages) out.messages = {};
  out.messages.matches = all.slice(0, max);
  return out as Json;
}

export async function send(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  replyBroadcast?: boolean,
  cookie?: string,
  // Post the text as-is, with no `blocks`. Slack REWRITES the stored `text`
  // when blocks are attached — newlines collapse to spaces and emoji become
  // `:one:` — so a message whose body has to be read back verbatim (`ask`,
  // `poll`) must not carry them. Verified against a real workspace 2026-08-20.
  plain?: boolean,
): Promise<string> {
  const body: Record<string, Json> = plain
    ? { channel, text }
    : { channel, text, blocks: [{ type: "markdown", text }] };
  if (threadTs !== undefined) body.thread_ts = threadTs;
  // "Also send to channel": broadcast a threaded reply back to the channel.
  // Only meaningful alongside thread_ts; Slack ignores it on top-level sends.
  if (replyBroadcast && threadTs !== undefined) body.reply_broadcast = true;
  const resp = (await post(token, "chat.postMessage", body, cookie)) as { ts?: string };
  return resp.ts ?? "";
}

export async function scheduleMessage(
  token: string,
  channel: string,
  text: string,
  postAt: number,
  threadTs?: string,
  cookie?: string,
): Promise<string> {
  const body: Record<string, Json> = {
    channel,
    text,
    post_at: postAt,
    blocks: [{ type: "markdown", text }],
  };
  if (threadTs !== undefined) body.thread_ts = threadTs;
  const resp = (await post(token, "chat.scheduleMessage", body, cookie)) as { scheduled_message_id?: string };
  return resp.scheduled_message_id ?? "";
}

export async function listScheduledMessages(
  token: string,
  channel?: string,
  cookie?: string,
): Promise<Json> {
  const params: Record<string, string> = {};
  if (channel) params.channel = channel;
  return get(token, "chat.scheduledMessages.list", params, cookie);
}

export async function deleteScheduledMessage(
  token: string,
  channel: string,
  scheduledMessageId: string,
  cookie?: string,
): Promise<void> {
  await post(token, "chat.deleteScheduledMessage", {
    channel,
    scheduled_message_id: scheduledMessageId,
  }, cookie);
}

export async function getPermalink(
  token: string,
  channel: string,
  messageTs: string,
  cookie?: string,
): Promise<string> {
  const resp = (await get(token, "chat.getPermalink", {
    channel,
    message_ts: messageTs,
  }, cookie)) as { permalink?: string };
  return resp.permalink ?? "";
}

export async function editMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  cookie?: string,
  /** As in `send`: no blocks, so the stored text survives verbatim. */
  plain?: boolean,
): Promise<string> {
  const resp = (await post(token, "chat.update", plain
    ? { channel, ts, text }
    : { channel, ts, text, blocks: [{ type: "markdown", text }] },
  cookie)) as { ts?: string };
  return resp.ts ?? ts;
}

export async function deleteMessage(
  token: string,
  channel: string,
  ts: string,
  cookie?: string,
): Promise<void> {
  await post(token, "chat.delete", { channel, ts }, cookie);
}

// Add or remove an emoji reaction on a message. `name` is the emoji shortcode
// without colons (e.g. "eyes", "white_check_mark"). Slack's reactions.add
// returns already_reacted when the reaction exists; reactions.remove returns
// no_reaction when it doesn't — both surface to the caller as API errors.
export async function reactionAdd(
  token: string,
  channel: string,
  ts: string,
  name: string,
  cookie?: string,
): Promise<void> {
  await post(token, "reactions.add", { channel, timestamp: ts, name }, cookie);
}

// Read the reactions currently on a message. Returns one entry per emoji with
// the user IDs that reacted, so callers can tell "someone reacted" from "I
// reacted". Never cached — reaction state is exactly what todo commands mutate.
export async function reactionsGet(
  token: string,
  channel: string,
  ts: string,
  cookie?: string,
): Promise<{ name: string; users: string[] }[]> {
  const resp = (await get(token, "reactions.get", { channel, timestamp: ts, full: "true" }, cookie)) as {
    message?: { reactions?: Array<{ name?: string; users?: string[] }> };
  };
  return (resp.message?.reactions ?? []).map((r) => ({
    name: String(r.name ?? ""),
    users: Array.isArray(r.users) ? r.users.map(String) : [],
  }));
}

export async function reactionRemove(
  token: string,
  channel: string,
  ts: string,
  name: string,
  cookie?: string,
): Promise<void> {
  await post(token, "reactions.remove", { channel, timestamp: ts, name }, cookie);
}

// Create a public (or private) channel via conversations.create. Slack
// lowercases the name and rejects spaces/most punctuation; the raw API error
// (e.g. name_taken, invalid_name_specials) surfaces to the caller. Returns the
// new channel's { id, name }.
export async function createChannel(
  token: string,
  name: string,
  isPrivate = false,
  cookie?: string,
): Promise<{ id: string; name: string }> {
  const resp = (await post(token, "conversations.create", {
    name,
    is_private: isPrivate,
  }, cookie)) as { channel?: { id?: string; name?: string } };
  return { id: resp.channel?.id ?? "", name: resp.channel?.name ?? name };
}

// Invite users to a channel via conversations.invite (up to ~1000 ids).
export async function inviteToChannel(
  token: string,
  channel: string,
  userIds: string[],
  cookie?: string,
): Promise<void> {
  await post(token, "conversations.invite", { channel, users: userIds.join(",") }, cookie);
}

export async function listConversations(token: string, cookie?: string): Promise<Json> {
  const allChannels: Json[] = [];
  let cursor = "";
  while (true) {
    const params: Record<string, string> = { limit: "200", types: "public_channel,private_channel,im,mpim" };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "conversations.list", params, cookie)) as {
      channels?: Json[];
      response_metadata?: { next_cursor?: string };
    };
    allChannels.push(...(resp.channels ?? []));
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return { channels: allChannels };
}

export async function openDm(token: string, userId: string, cookie?: string): Promise<string> {
  const resp = (await post(token, "conversations.open", { users: userId }, cookie)) as {
    channel?: { id?: string };
  };
  const id = resp.channel?.id;
  if (!id) throw new Error(`Failed to open DM with user ${userId}`);
  return id;
}

/** The existing IM with `userId`, or "" when there is none. Paginated: a
 *  workspace with many DMs pages its im list like any other conversation, and
 *  reading only the first page is how a DM that exists reads as missing. */
async function findExistingDm(token: string, userId: string, cookie?: string): Promise<string> {
  let cursor = "";
  while (true) {
    const params: Record<string, string> = { types: "im", limit: "200" };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "conversations.list", params, cookie)) as {
      channels?: Array<{ id?: string; user?: string }>;
      response_metadata?: { next_cursor?: string };
    };
    for (const ch of resp.channels ?? []) {
      if (ch.user === userId) return String(ch.id ?? "");
    }
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return "";
}

/** The DM channel with a known user id. Read-only on purpose: opening a DM
 *  needs im:write, which plenty of read tokens do not carry, so an absent DM is
 *  reported rather than created. */
async function dmWithUser(token: string, userId: string, cookie?: string, label?: string): Promise<string> {
  const dm = await findExistingDm(token, userId, cookie);
  if (dm) return dm;
  const who = label ? `${label} (${userId})` : userId;
  throw new Error(`No existing DM with ${who}. Open it once in Slack first.`);
}

/** Normalize for loose matching: lowercase + strip hyphens/underscores/whitespace.
 *  Lets `@deploy-bot` match handles like `deploybot` or display names like `Deploy-Bot`. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

type Member = {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

function memberMatches(u: Member, nameNorm: string): boolean {
  const n = normName(u.name ?? "");
  const rn = normName(u.real_name ?? u.profile?.real_name ?? "");
  const dn = normName(u.profile?.display_name ?? "");
  return n === nameNorm || rn === nameNorm || (!!dn && dn === nameNorm);
}

/** What a `@name` lookup found, and — when it found nothing — which populations
 *  it actually searched. The counts are the whole point: "not found" out of 40
 *  people is a wrong handle, "not found" out of 0 is a broken token, and the
 *  caller cannot tell those apart from the sentence alone. */
type UserSearch = {
  /** "" when nothing matched. */
  id: string;
  /** The existing IM with them, when the match came from the DM scan. */
  dm?: string;
  workspaceCount: number;
  connectCount: number;
};

/** Search every population this token can see for `@name`.
 *
 *  `users.list` is scoped to YOUR workspace, so a Slack Connect counterpart —
 *  who belongs to another team entirely — is never in it, no matter what
 *  parameters the call is given. The only place they exist is the membership of
 *  a conversation you share, and for a person you DM the cheapest such place is
 *  your own IM list: it costs one `users.info` per external DM partner and hands
 *  back the channel id the caller was about to look up anyway. */
async function searchUsers(token: string, nameNorm: string, cookie?: string): Promise<UserSearch> {
  let workspaceCount = 0;
  const known = new Set<string>();
  let cursor = "";
  while (true) {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "users.list", params, cookie)) as {
      members?: Member[];
      response_metadata?: { next_cursor?: string };
    };
    for (const u of resp.members ?? []) {
      workspaceCount++;
      if (u.id) known.add(u.id);
      if (memberMatches(u, nameNorm)) return { id: u.id ?? "", workspaceCount, connectCount: 0 };
    }
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }

  let connectCount = 0;
  let dmCursor = "";
  while (true) {
    const params: Record<string, string> = { types: "im", limit: "200" };
    if (dmCursor) params.cursor = dmCursor;
    const resp = (await get(token, "conversations.list", params, cookie)) as {
      channels?: Array<{ id?: string; user?: string }>;
      response_metadata?: { next_cursor?: string };
    };
    for (const ch of resp.channels ?? []) {
      const uid = ch.user;
      if (!uid || known.has(uid)) continue;
      known.add(uid);
      connectCount++;
      let u: Member | undefined;
      try {
        u = ((await get(token, "users.info", { user: uid }, cookie)) as { user?: Member }).user;
      } catch {
        // One profile we cannot read costs us that person, not the whole scan.
        continue;
      }
      if (u && memberMatches(u, nameNorm)) {
        return { id: uid, dm: String(ch.id ?? ""), workspaceCount, connectCount };
      }
    }
    dmCursor = resp.response_metadata?.next_cursor ?? "";
    if (!dmCursor) break;
  }
  return { id: "", workspaceCount, connectCount };
}

/** The error for a lookup that came back empty. An empty roster and a wrong
 *  handle must not share a sentence: the first is a token or scope fault the
 *  caller can fix, the second is a typo, and "User not found" told both stories
 *  at once — so a lookup that could not see its population reported absence. */
function userNotFoundError(ref: string, found: UserSearch): Error {
  if (found.workspaceCount === 0) {
    return new Error(
      `Cannot resolve ${ref}: users.list returned no members at all, so nothing could have matched.\n` +
      `That is a token or scope fault, not a wrong handle — this says nothing about whether ${ref} exists.\n` +
      `  Check who you are:  slack auth ls`,
    );
  }
  const searched = found.connectCount
    ? `${found.workspaceCount} workspace account(s) and ${found.connectCount} Slack Connect DM partner(s)`
    : `${found.workspaceCount} workspace account(s)`;
  return new Error(
    `User not found: ${ref} — searched ${searched}, none matched.\n` +
    `Slack Connect people from another workspace are not in users.list, so if they never\n` +
    `DMed you they cannot be found by name at all. Look them up and use their ID:\n` +
    `  slack user ls --external`,
  );
}

/**
 * Resolve `@name` (or a raw U…/W… id) to a user ID. Used when DMing as a bot:
 * the lookup runs on a *user* token (which has users:read), then the caller
 * opens the DM with the bot token — so the bot never needs users:read.
 */
export async function resolveUserId(token: string, ref: string, cookie?: string): Promise<string> {
  // `@U0123456789` — an id wearing the `@` that every other user target takes.
  // Nobody is NAMED that, so the name walk below would end in "user not found"
  // and point at the wrong problem: the user is there, only the `@` is not.
  const bare = ref.startsWith("@") ? ref.slice(1) : ref;
  if (isUserId(bare)) return bare;
  if (!ref.startsWith("@")) throw new Error(`Expected @user or a user ID, got: ${ref}`);
  const nameNorm = normName(bare);
  const selfInfo = (await get(token, "auth.test", {}, cookie)) as { user_id?: string; user?: string };
  if (nameNorm === "you" || nameNorm === "me" || normName(selfInfo.user ?? "") === nameNorm) {
    if (!selfInfo.user_id) throw new Error("auth.test did not return user_id");
    return selfInfo.user_id;
  }
  const found = await searchUsers(token, nameNorm, cookie);
  if (found.id) return found.id;
  throw userNotFoundError(ref, found);
}

/** Parse a Slack permalink, returning channel ID, optional message ts, and optional thread_ts.
 *  Supports both forms:
 *    https://app.slack.com/client/T.../C...[/p1700000000000100]
 *    https://<ws>.slack.com/archives/C...[/p1700000000000100][?thread_ts=...][&cid=C...]
 */
export function parseSlackPermalink(s: string): { channel: string; ts?: string; threadTs?: string } | undefined {
  const m = s.match(
    /(?:app\.slack\.com\/client\/T[A-Za-z0-9]+|[A-Za-z0-9-]+\.slack\.com\/archives)\/([A-Za-z0-9]+)(?:\/p(\d{10})(\d{6}))?/,
  );
  if (!m) return undefined;
  const channel = m[1]!;
  const ts = m[2] && m[3] ? `${m[2]}.${m[3]}` : undefined;
  const qsStart = s.indexOf("?");
  const qs = qsStart >= 0 ? new URLSearchParams(s.slice(qsStart)) : undefined;
  const threadTs = qs?.get("thread_ts") ?? undefined;
  const cidFromQs = qs?.get("cid") ?? undefined;
  const resolvedChannel = cidFromQs ?? channel;
  const result: { channel: string; ts?: string; threadTs?: string } = { channel: resolvedChannel };
  if (ts) result.ts = ts;
  if (threadTs) result.threadTs = threadTs;
  return result;
}

function parseSlackUrl(s: string): string | undefined {
  return parseSlackPermalink(s)?.channel;
}

/** A Slack conversation ID: `C…` (channel), `D…` (DM), `G…` (group). Length is
 *  not fixed across workspaces, hence the range rather than an exact count. */
function isChannelId(s: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(s);
}

/** A Slack user ID: `U…` (member) or `W…` (Enterprise Grid member). Upper-case
 *  only — that is what keeps a lowercase handle like `@u1234567` reading as a
 *  name instead of being swallowed by the id branch. */
function isUserId(s: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(s);
}

export async function resolveChannel(token: string, ref: string, cookie?: string): Promise<string> {
  // Accept Slack permalinks directly
  const fromUrl = parseSlackUrl(ref);
  if (fromUrl) return fromUrl;
  // Accept raw IDs (C..., D..., G...) as-is
  if (!ref.startsWith("@") && !ref.startsWith("#")) {
    if (isChannelId(ref)) return ref;
    // A bare `U…` names a person, and the conversation meant by a person is the
    // DM with them. Refusing it as a malformed target sent callers hunting for a
    // syntax error when what they had handed over was a perfectly good user.
    if (isUserId(ref)) return dmWithUser(token, ref, cookie);
    throw new Error(`Target must start with # or @ (or be a Slack URL/ID), got: ${ref}`);
  }
  // `#C0123456789` — an ID that was given the `#` every other target form takes.
  // Slack has no channel NAMED that, so the name lookup below would walk every
  // conversation and end in "channel not found", pointing at the wrong problem:
  // the channel exists, only the `#` does not belong. Accept it instead of
  // sending people to look for a channel that was never missing.
  if (ref.startsWith("#") && isChannelId(ref.slice(1))) return ref.slice(1);
  const isIm = ref.startsWith("@");
  const rawName = ref.slice(1);
  const nameNorm = normName(rawName);

  if (isIm) {
    // `@U0123456789` — the id form wearing the `@`, same reasoning as the bare
    // id above: resolve it as a person, not as a name nobody has.
    if (isUserId(rawName)) return dmWithUser(token, rawName, cookie);
    // Use auth.test to check if @name refers to self (avoids users:read scope requirement).
    // auth.test is always available; users.list requires users:read which xoxc- tokens lack.
    const selfInfo = (await get(token, "auth.test", {}, cookie)) as { user_id?: string; user?: string };
    const isSelf = nameNorm === "you" || nameNorm === "me" || normName(selfInfo.user ?? "") === nameNorm;
    if (isSelf) {
      const userId = selfInfo.user_id;
      if (!userId) throw new Error("auth.test did not return user_id");
      const dm = await findExistingDm(token, userId, cookie);
      return dm || openDm(token, userId, cookie);
    }

    const found = await searchUsers(token, nameNorm, cookie);
    if (!found.id) throw userNotFoundError(ref, found);
    // The Connect scan already walked the IM list to find them, so it knows the
    // channel — asking again would only pay for the same pages twice.
    if (found.dm) return found.dm;
    return dmWithUser(token, found.id, cookie, ref);
  }

  // Channel lookup
  const lcName = rawName.toLowerCase();
  let cursor = "";
  while (true) {
    const params: Record<string, string> = {
      limit: "200",
      types: "public_channel,private_channel",
      exclude_archived: "true",
    };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "conversations.list", params, cookie)) as {
      channels?: Array<Record<string, Json>>;
      response_metadata?: { next_cursor?: string };
    };
    for (const ch of resp.channels ?? []) {
      if (String(ch.name ?? "").toLowerCase() === lcName) {
        return String(ch.id ?? "");
      }
    }
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  throw new Error(`channel not found: ${ref}`);
}

/** Look up both a display label and the `@handle` for a user.
 *  Returns `[display_name || real_name || id, name || id]`. */
export async function userInfoPair(
  token: string,
  userId: string,
  cookie?: string,
): Promise<[string, string]> {
  try {
    const resp = (await get(token, "users.info", { user: userId }, cookie)) as {
      user?: { profile?: { display_name?: string }; real_name?: string; name?: string };
    };
    const display = resp.user?.profile?.display_name;
    const first =
      display && display.length > 0
        ? display
        : (resp.user?.real_name ?? resp.user?.name ?? userId);
    const handle = resp.user?.name ?? userId;
    return [first, handle];
  } catch {
    return [userId, userId];
  }
}

export async function userName(token: string, userId: string, cookie?: string): Promise<string> {
  try {
    const resp = (await get(token, "users.info", { user: userId }, cookie)) as {
      user?: { profile?: { display_name?: string }; real_name?: string; name?: string };
    };
    const display = resp.user?.profile?.display_name;
    if (display && display.length > 0) return display;
    return resp.user?.real_name ?? resp.user?.name ?? userId;
  } catch {
    return userId;
  }
}

export async function listUsers(token: string, cookie?: string): Promise<Json> {
  const allMembers: Json[] = [];
  let cursor = "";
  while (true) {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "users.list", params, cookie)) as {
      members?: Json[];
      response_metadata?: { next_cursor?: string };
    };
    allMembers.push(...(resp.members ?? []));
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return { members: allMembers };
}

/** List the member user IDs of a channel/DM (paginated).
 *  Used by mention encoding to reach members — including Slack Connect guests —
 *  who do not appear in the workspace-wide users.list. */
export async function listConversationMembers(token: string, channel: string, cookie?: string): Promise<string[]> {
  const all: string[] = [];
  let cursor = "";
  while (true) {
    const params: Record<string, string> = { channel, limit: "200" };
    if (cursor) params.cursor = cursor;
    const resp = (await get(token, "conversations.members", params, cookie)) as {
      members?: string[];
      response_metadata?: { next_cursor?: string };
    };
    all.push(...(resp.members ?? []));
    cursor = resp.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return all;
}

// Draft API (internal — requires xoxc session token + xoxd cookie)
export async function listDrafts(token: string, cookie?: string): Promise<Json> {
  return postSession(token, "drafts.list", {}, cookie);
}

export async function createDraft(
  token: string,
  channelId: string,
  text: string,
  cookie?: string,
): Promise<Json> {
  const { randomUUID } = await import("node:crypto");
  const blocks = JSON.stringify([{
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  }]);
  return postSession(token, "drafts.create", {
    client_msg_id: randomUUID(),
    destinations: JSON.stringify([{ channel_id: channelId }]),
    blocks,
    file_ids: JSON.stringify([]),
    is_from_composer: "true",
  }, cookie);
}

export async function updateDraft(
  token: string,
  draftId: string,
  channelId: string,
  text: string,
  cookie?: string,
): Promise<Json> {
  const blocks = JSON.stringify([{
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  }]);
  // client_last_updated_ts must be the current time (server uses it as new stored ts)
  const nowTs = (Date.now() / 1000).toFixed(6);
  return postSession(token, "drafts.update", {
    draft_id: draftId,
    client_last_updated_ts: nowTs,
    destinations: JSON.stringify([{ channel_id: channelId }]),
    blocks,
    file_ids: JSON.stringify([]),
  }, cookie);
}

// Channel info via session API (works with xoxc + xoxd cookie)
export async function conversationInfoSession(token: string, channelId: string, cookie?: string): Promise<Json> {
  return postSession(token, "conversations.info", { channel: channelId }, cookie);
}

export async function userInfo(token: string, userId: string, cookie?: string): Promise<Json> {
  return get(token, "users.info", { user: userId }, cookie);
}

export async function conversationInfo(token: string, channelId: string, cookie?: string): Promise<Json> {
  return get(token, "conversations.info", { channel: channelId }, cookie);
}

export async function deleteDraft(token: string, draftId: string, cookie?: string): Promise<Json> {
  const nowTs = (Date.now() / 1000).toFixed(6);
  return postSession(token, "drafts.delete", { draft_id: draftId, client_last_updated_ts: nowTs }, cookie);
}

// auth.test via session API (works with xoxc + xoxd cookie)
export async function authTestSession(
  token: string,
  cookie?: string,
): Promise<{ userId: string; teamId: string }> {
  const resp = (await postSession(token, "auth.test", {}, cookie)) as Record<string, Json>;
  return { userId: String(resp.user_id ?? ""), teamId: String(resp.team_id ?? "") };
}

// File upload via Slack v2 upload API (files.getUploadURLExternal → upload → completeUploadExternal)
export async function uploadFile(
  token: string,
  channel: string,
  filePath: string,
  opts: { title?: string; threadTs?: string; initialComment?: string } = {},
  cookie?: string,
): Promise<{ fileId: string; permalink?: string }> {
  const { statSync, readFileSync } = await import("node:fs");
  const { basename } = await import("node:path");

  const stat = statSync(filePath);
  const filename = basename(filePath);

  // Step 1: 外部アップロードURLを取得
  const urlResp = (await get(token, "files.getUploadURLExternal", {
    filename,
    length: String(stat.size),
  }, cookie)) as { upload_url?: string; file_id?: string };

  const uploadUrl = urlResp.upload_url;
  const fileId = urlResp.file_id;
  if (!uploadUrl || !fileId) throw new Error("files.getUploadURLExternal returned no upload_url/file_id");

  // Step 2: ファイルデータを外部URLへ PUT
  const fileData = readFileSync(filePath);
  const putResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileData,
  });
  if (!putResp.ok) throw new Error(`Upload PUT failed: ${putResp.status} ${putResp.statusText}`);

  // Step 3: アップロード完了 → チャンネルへ共有
  const completeBody: Record<string, Json> = {
    files: [{ id: fileId, title: opts.title ?? filename }],
    channel_id: channel,
  };
  if (opts.threadTs) completeBody.thread_ts = opts.threadTs;
  if (opts.initialComment) completeBody.initial_comment = opts.initialComment;

  const completeResp = (await post(token, "files.completeUploadExternal", completeBody, cookie)) as {
    files?: Array<{ permalink?: string }>;
  };

  const result: { fileId: string; permalink?: string } = { fileId };
  const plink = completeResp.files?.[0]?.permalink;
  if (plink) result.permalink = plink;
  return result;
}

// client.boot — internal endpoint that returns a WebSocket URL for RTM
export async function clientBoot(token: string, cookie: string): Promise<{ wsUrl: string; selfId: string }> {
  const resp = (await postSession(token, "client.boot", {}, cookie)) as Record<string, Json>;
  const wsUrl = typeof resp.url === "string" ? resp.url : undefined;
  if (!wsUrl) {
    const keys = Object.keys(resp).join(", ");
    throw new Error(`client.boot did not return a WebSocket URL. Keys: ${keys}`);
  }
  const self_ = resp.self && typeof resp.self === "object" && !Array.isArray(resp.self)
    ? resp.self as Record<string, Json>
    : {};
  return { wsUrl, selfId: typeof self_.id === "string" ? self_.id : "" };
}

// Safe nested access
export function getPath(obj: Json, path: readonly (string | number)[]): Json | undefined {
  let cur: Json | undefined = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key] ?? undefined;
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, Json>)[key];
    }
  }
  return cur;
}
