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

async function call(token: string, method: string, init: RequestInit): Promise<Json> {
  const res = await fetch(`${base()}/${method}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const body = (await res.json()) as { ok?: boolean; error?: string } & Record<string, Json>;
  if (body.ok !== true) {
    throw new Error(`Slack error on ${method}: ${body.error ?? "unknown"}`);
  }
  return body as Json;
}

function get(token: string, method: string, params: Record<string, string>): Promise<Json> {
  const qs = new URLSearchParams(params).toString();
  return call(token, `${method}?${qs}`, { method: "GET" });
}

function post(token: string, method: string, body: Record<string, Json>): Promise<Json> {
  return call(token, method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
 *  `@example-bot` matches a Slack handle `examplebot` or real_name `ExamplePR-Bot`. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/** Extract channel ID from a Slack permalink
 *  (e.g. `https://app.slack.com/client/T.../C09QQ65QKG9`) */
function parseSlackUrl(s: string): string | undefined {
  const m = s.match(/app\.slack\.com\/client\/T[A-Za-z0-9]+\/([A-Za-z0-9]+)/);
  return m?.[1];
}

export async function resolveChannel(token: string, ref: string): Promise<string> {
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
      const resp = (await get(token, "users.list", params)) as {
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
      const resp = (await get(token, "conversations.list", params)) as {
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
    const resp = (await get(token, "conversations.list", params)) as {
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
