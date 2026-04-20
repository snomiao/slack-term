// Slack Web API client (user token, Authorization: Bearer)

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
  const body = (await res.json()) as { ok?: boolean; error?: string } & Record<string, Json>;
  if (body.ok !== true) {
    const err = body.error ?? "unknown";
    if (err === "invalid_auth" && token.startsWith("xoxc-") && !cookie) {
      throw new Error(
        `Desktop app token (xoxc-) is not accepted by the public Slack API.\n` +
        `Replace it with an xoxp- user token:\n` +
        `  slack workspace set-token <name> <xoxp-token>`,
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
  const body = (await res.json()) as { ok?: boolean; error?: string } & Record<string, Json>;
  if (body.ok !== true) {
    const err = body.error ?? "unknown";
    if ((err === "invalid_auth" || err === "not_authed") && !token.startsWith("xoxc-")) {
      throw new Error(
        `The draft API requires a desktop app session token (xoxc-).\n` +
        `Import from Slack desktop:  slack workspace import`,
      );
    }
    if ((err === "invalid_auth" || err === "not_authed") && !cookie) {
      throw new Error(
        `drafts.list also requires the xoxd session cookie.\n` +
        `Set it with:  slack workspace set-cookie <workspace-name> <xoxd-value>\n` +
        `Get xoxd from browser: DevTools → Application → Cookies → slack.com → d`,
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

function post(token: string, method: string, body: Record<string, Json>): Promise<Json> {
  return call(token, method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function authTest(token: string): Promise<{ team: string; teamId: string; url: string; user: string }> {
  const resp = (await get(token, "auth.test", {})) as {
    team?: string; team_id?: string; url?: string; user?: string;
  };
  return {
    team: resp.team ?? "",
    teamId: resp.team_id ?? "",
    url: resp.url ?? "",
    user: resp.user ?? "",
  };
}

export async function history(token: string, channel: string, limit = 20): Promise<Json> {
  return get(token, "conversations.history", { channel, limit: String(limit) });
}

export async function replies(
  token: string,
  channel: string,
  ts: string,
  limit = 50,
): Promise<Json> {
  return get(token, "conversations.replies", { channel, ts, limit: String(limit) });
}

export async function searchPage(
  token: string,
  query: string,
  count: number,
  page: number,
): Promise<Json> {
  return get(token, "search.messages", {
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: String(Math.min(Math.max(count, 1), 100)),
    page: String(Math.max(page, 1)),
  });
}

export async function search(token: string, query: string): Promise<Json> {
  return searchPage(token, query, 100, 1);
}

export async function searchAll(token: string, query: string, max: number): Promise<Json> {
  const perPage = 100;
  let page = 1;
  const all: Json[] = [];
  let last: Json = { ok: true, messages: {} };
  while (true) {
    const resp = await searchPage(token, query, perPage, page);
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
): Promise<string> {
  const body: Record<string, Json> = {
    channel,
    text,
    blocks: [{ type: "markdown", text }],
  };
  if (threadTs !== undefined) body.thread_ts = threadTs;
  const resp = (await post(token, "chat.postMessage", body)) as { ts?: string };
  return resp.ts ?? "";
}

export async function listConversations(token: string): Promise<Json> {
  return get(token, "conversations.list", {
    limit: "200",
    types: "public_channel,private_channel,im,mpim",
  });
}

export async function openDm(token: string, userId: string): Promise<string> {
  const resp = (await post(token, "conversations.open", { users: userId })) as {
    channel?: { id?: string };
  };
  const id = resp.channel?.id;
  if (!id) throw new Error(`Failed to open DM with user ${userId}`);
  return id;
}

/** Normalize for loose matching: lowercase + strip hyphens/underscores/whitespace.
 *  Lets `@deploy-bot` match handles like `deploybot` or display names like `Deploy-Bot`. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/** Extract channel ID from a Slack permalink
 *  (e.g. `https://app.slack.com/client/TXXXXXXX/CXXXXXXXX`) */
function parseSlackUrl(s: string): string | undefined {
  const m = s.match(/app\.slack\.com\/client\/T[A-Za-z0-9]+\/([A-Za-z0-9]+)/);
  return m?.[1];
}

export async function resolveChannel(token: string, ref: string, cookie?: string): Promise<string> {
  // Accept Slack permalinks directly
  const fromUrl = parseSlackUrl(ref);
  if (fromUrl) return fromUrl;
  // Accept raw IDs (C..., D..., G...) as-is
  if (!ref.startsWith("@") && !ref.startsWith("#")) {
    if (/^[A-Za-z0-9]{9,}$/.test(ref)) return ref;
    throw new Error(`Target must start with # or @ (or be a Slack URL/ID), got: ${ref}`);
  }
  const isIm = ref.startsWith("@");
  const rawName = ref.slice(1);
  const nameNorm = normName(rawName);

  if (isIm) {
    // Find user ID first via users.list (batch), then locate existing DM.
    let userId = "";
    let userCursor = "";
    while (true) {
      const params: Record<string, string> = { limit: "200" };
      if (userCursor) params.cursor = userCursor;
      const resp = (await get(token, "users.list", params, cookie)) as {
        members?: Array<{ id?: string; name?: string; real_name?: string; profile?: { display_name?: string } }>;
        response_metadata?: { next_cursor?: string };
      };
      for (const u of resp.members ?? []) {
        const n = normName(u.name ?? "");
        const rn = normName(u.real_name ?? "");
        const dn = normName(u.profile?.display_name ?? "");
        if (n === nameNorm || rn === nameNorm || (dn && dn === nameNorm)) {
          userId = u.id ?? "";
          break;
        }
      }
      if (userId) break;
      userCursor = resp.response_metadata?.next_cursor ?? "";
      if (!userCursor) break;
    }
    if (!userId) throw new Error(`User not found: ${ref}`);

    // Find an existing DM (avoids needing im:write scope)
    let dmCursor = "";
    while (true) {
      const params: Record<string, string> = { types: "im", limit: "200" };
      if (dmCursor) params.cursor = dmCursor;
      const resp = (await get(token, "conversations.list", params, cookie)) as {
        channels?: Array<{ id?: string; user?: string }>;
        response_metadata?: { next_cursor?: string };
      };
      for (const ch of resp.channels ?? []) {
        if (ch.user === userId) return String(ch.id ?? "");
      }
      dmCursor = resp.response_metadata?.next_cursor ?? "";
      if (!dmCursor) break;
    }
    throw new Error(`No existing DM with ${ref} (${userId}). Open it once in Slack first.`);
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
): Promise<[string, string]> {
  try {
    const resp = (await get(token, "users.info", { user: userId })) as {
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

export async function userName(token: string, userId: string): Promise<string> {
  try {
    const resp = (await get(token, "users.info", { user: userId })) as {
      user?: { profile?: { display_name?: string }; real_name?: string; name?: string };
    };
    const display = resp.user?.profile?.display_name;
    if (display && display.length > 0) return display;
    return resp.user?.real_name ?? resp.user?.name ?? userId;
  } catch {
    return userId;
  }
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
