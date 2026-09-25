# Slack Agent experience: decision

Evaluated 2026-09-25 against Slack's current developer documentation and this
checkout. **Keep this change documentation-only.** Bot session controls fit the
CLI, but adding three legacy wrappers would not make an agent listen or respond
in the side panel. Establish the receiving/lifecycle contract first; add small
bot-only controls once a caller can use them end to end.

| Feature | Fit | Decision |
| --- | --- | --- |
| Session status and title | Yes, later | Useful bot presentation; target current session APIs, with explicit completion handling. |
| Dynamic suggested prompts | Later | Useful for contextual entry points; fixed prompts suffice initially. |
| Agent event receiver | Later | Necessary for native interaction; separate from the user-oriented `tail`. |
| Slack MCP alongside slack-term | Yes | Agents with an approved connection can use its user-context tools. |
| Replace slack-term with MCP | No | Preserve shell workflows, bot identity, confirmation gates, `ask`/`poll`, `todo`, and scheduling. |

The Agent messaging experience (`agent_view`) uses the regular Messages tab and
threaded conversations; the older `assistant_view` uses Chat/History tabs. A
settings label alone is insufficient to choose an API contract. The new DM-open
signal is `app_home_opened` with `tab="messages"`, not
`assistant_thread_started`. See the [launch announcement](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/).

## Bot controls and credentials

Use the installed app's **granular bot token (`xoxb`)**, never silently fall back
to the default user token (`xoxc` plus cookie or `xoxp`). The existing
`requireBotToken`/`resolveBotWrite` paths in [cli.ts](../ts/cli.ts) provide useful
identity-selection patterns; raw channel IDs avoid unnecessary directory scans.

| Operation | Current API | Scope / important arguments |
| --- | --- | --- |
| Working/ready state | [`agents.sessions.setStatus`](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/) | Bot `chat:write`; `status` is `processing`, `active`, `suspended`, or `closed`. |
| Session title | [`agents.sessions.rename`](https://docs.slack.dev/reference/methods/agents.sessions.rename/) | Bot `chat:write`; `title` is 1–200 characters. |
| Suggested prompts | [`assistant.threads.setSuggestedPrompts`](https://docs.slack.dev/reference/methods/assistant.threads.setSuggestedPrompts/) | Reference lists bot `assistant:write`; `channel_id`, up to four `{title, message}` prompts, optional list `title`. |

Session methods require app membership in the channel. For a normal DM/channel
thread, supply `channel_id` and root `thread_ts`; session channels instead omit
`thread_ts`. Both session methods are Tier 3 (50+ requests/minute). Setting a
status can create the session; rename requires an existing session.

For **agent** prompts, omit `thread_ts`: Slack explicitly warns that including
it silently fails. Prompts belong to the Messages tab, not an individual agent
thread. Legacy assistant prompts use `thread_ts`. This difference rules out a
single unqualified `assistant status|title|prompts <thread>` interface.

Legacy [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
still accepts free text and clears on reply or an empty status. Its scope is in
transition: Slack documents acceptance of `assistant:write` or `chat:write`, with
`chat:write` becoming mandatory. Legacy
[`setTitle`](https://docs.slack.dev/reference/methods/assistant.threads.setTitle/)
still lists `assistant:write`. Do not assume that scope transition applies to
every assistant method.

Slack's [migration guide](https://docs.slack.dev/ai/migrating-to-agent-messaging/)
documents compatibility bridges, but recommends session methods. With those
methods, posting a reply **does not clear `processing`**: callers must set
`active` on completion, including failure/cancellation cleanup. Otherwise the
indicator can remain for an hour. Subscribe to `agent_session_stopped` only with
a handler that stops the work and updates state. Migration also removes the
synthetic `assistant_app_thread` root: the user's message is the root.

## Receiving: Events API, not RTM

[`assistant_thread_started`](https://docs.slack.dev/reference/events/assistant_thread_started/)
and [`assistant_thread_context_changed`](https://docs.slack.dev/reference/events/assistant_thread_context_changed/)
are documented as **Events API only**, with no event-specific scopes. They are
not a supported RTM subscription. Ordinary messages might appear on the user's
RTM stream, but that is not an app event delivery guarantee.

In this checkout, [rtm.ts](../ts/rtm.ts) discards everything except `message`
events (and skips edits/deletes). [tail.ts](../ts/tail.ts) selects RTM only for
`xoxc` plus cookie under certain options; otherwise it polls history. Neither
path exposes app lifecycle/context events. Polling with `--thread` merely
filters history and can miss non-broadcast replies; `--watch-thread` separately
fetches replies for a known root. Neither discovers every agent session.

A real receiver would need:

1. Bot event subscriptions: [`message.im`](https://docs.slack.dev/reference/events/message.im/)
   with bot `im:history`, plus `app_home_opened`. For the current Agent experience,
   use `app_context_changed` for viewed context; retain legacy assistant events
   only for that experience. Slack's [agent guide](https://docs.slack.dev/ai/developing-agents/)
   explains context delivery and threading. Context IDs do not grant read access.
2. An [Events API](https://docs.slack.dev/apis/events-api/) HTTP receiver with
   signing-secret verification and timely acknowledgements, or
   [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) with an
   app-level `xapp` token carrying [`connections:write`](https://docs.slack.dev/reference/methods/apps.connections.open/).
   Socket Mode transports Events API envelopes; it is not RTM. It needs app
   configuration, envelope acknowledgements, reconnect handling, and a process
   that remains running. The app token does not replace the bot API token.
3. Application logic to deduplicate retried events, ignore its own output,
   preserve workspace/channel/root/user context, dispatch work, and handle stop
   and completion. Prefer a Bolt receiver outside this CLI initially. A future
   CLI listener should emit structured events rather than only formatted text.

## Slack MCP: complementary user access

The [MCP server](https://docs.slack.dev/ai/slack-mcp-server/) offers search,
channel/thread reads, posting, reactions, files, canvases, and lists over
Streamable HTTP. It requires a registered internal or Marketplace app; unlisted
distributed apps are excluded. It is not a bot event receiver.

Use per-user OAuth authorization, not desktop cookies. Existing `xoxp` storage
does not establish the required app/scopes/consent. Search uses
`search:read.public/private/mpim/im`; reading uses the appropriate
`channels:history`, `groups:history`, `mpim:history`, or `im:history`; posting uses
user `chat:write`. Channel listing uses the corresponding `*:read` scopes.
Confidential OAuth and desktop PKCE are documented. Enterprise-managed
authorization is an [alternative to individual consent](https://docs.slack.dev/authentication/enterprise-managed-authorization/),
not something enabled by the Agent experience toggle.

MCP shares Web API action limits: channel search/list-user-channels are Tier 2
(20+/minute), channel/thread reads Tier 3 (50+/minute), and sending has special
limits. It is not a rate-limit escape hatch.

[`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/)
is also Tier 2. For the observed listing bottleneck, prefer known IDs, cached
resolution and fewer scans; respect [`Retry-After`](https://docs.slack.dev/apis/web-api/rate-limits/).
Targeted MCP search may reduce discovery work, but that is an efficiency
hypothesis, not evidence of a higher quota. Keep MCP authentication in the agent
host initially rather than adding another auth/client stack here.

## Existing behavior and minimal next step

No documented feature change requires rewriting ordinary `read`, `thread`, or
`send --as-bot`. Use the actual app DM and root timestamp: the user and bot
identities can resolve different DMs. Status updates can open a thread in the
client, so they should accompany an intended threaded response, not every send.
See the [agent interaction guide](https://docs.slack.dev/ai/developing-agents/).

`ask`/`poll` pills are emoji reactions, not suggested prompts or Block Kit
buttons. Their message/reaction mechanism remains applicable, but this is a
code-and-doc inference, not live side-panel verification. `tail` does not report
reaction answers. Use the existing answer collector; it may update the question
and therefore is not read-only QA. In `cmdAsk`, a top-level DM question accepts
DM-wide text answers, whereas an explicit thread target scopes answers. Multiple
agent conversations in one DM make that distinction important: address the
session root explicitly. Relevant code: [cli.ts](../ts/cli.ts),
[ask.ts](../ts/ask.ts), [poll.ts](../ts/poll.ts).

**First follow-up:** define and mock-test a small external receiver contract for
DM-open, message, context, duplicate, and stop events. Confirm the intended app's
manifest and available scopes before selecting the experience. Then add bot-only
session status/title commands if the receiver needs shell integration; test
token selection, thread addressing, API errors, and completion cleanup with a
mock API. Add dynamic prompts only with an explicit agent/legacy distinction.

Wrappers alone are small but not clearly useful enough yet: there is no receiver
contract in this repo, and status now carries lifecycle obligations. This
evaluation changes no runtime code, Slack app configuration, or credentials,
and performs no real Slack writes. Workspace rollout and side-panel rendering
remain unverified.
