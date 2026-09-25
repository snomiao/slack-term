import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import type { Argv } from "yargs";
import { resolveBotToken } from "./profiles.ts";
import { renameAgentSession, resolveChannel, setAgentStatus, type AgentStatus, type AgentThread } from "./slack.ts";

const statuses: AgentStatus[] = ["processing", "active", "suspended", "closed"];
type ParseTarget = (target: string) => { ref: string; threadTs?: string };

function botToken(envName?: string): string {
  if (envName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error("--bot-token-env must name an environment variable, not contain a token.");
  }
  const token = envName === undefined ? resolveBotToken() : process.env[envName];
  if (!token?.startsWith("xoxb-")) {
    throw new Error("Agent commands require a bot token (xoxb). Set SLACK_BOT_TOKEN or --bot-token-env NAME; user tokens are refused.");
  }
  return token;
}

function validateTitle(title?: string): void {
  if (title !== undefined && (!title.trim() || [...title].length > 200)) {
    throw new Error("--title must contain 1–200 characters.");
  }
}

async function threadTarget(token: string, target: string, parse: ParseTarget): Promise<AgentThread> {
  const { ref, threadTs } = parse(target);
  if (!threadTs || !/^\d{10}\.\d{6}$/.test(threadTs)) {
    throw new Error("Target must include a thread root: C00000001:1700000000.000100, #channel:ts, or a message permalink.");
  }
  return { channel_id: await resolveChannel(token, ref), thread_ts: threadTs };
}

function report(context: string, error: unknown): void {
  console.error(`agent: ${context}: ${error instanceof Error ? error.message : "request failed"}`);
}

/** Own the command's lifetime, and serialize the last refresh before final cleanup. */
export async function runAgent(
  token: string,
  thread: AgentThread,
  command: string[],
  opts: { every: number; title?: string; close: boolean },
): Promise<number> {
  let child: ChildProcess | undefined;
  let signal: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | undefined;
  let stopping = false;
  let attempted = false;
  let code = 1;

  const stop = (received: NodeJS.Signals) => {
    if (signal) return; // repeated interrupts must not bypass the final write
    signal = received;
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(received);
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    }
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    attempted = true; // even a lost response may have set processing remotely
    await setAgentStatus(token, thread, "processing");
    if (!stopping && opts.title !== undefined) await renameAgentSession(token, thread, opts.title);
    if (!stopping) {
      child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
      const done = new Promise<number>((resolve) => {
        child!.once("error", () => {
          console.error("agent: could not start command");
          resolve(127);
        });
        child!.once("exit", (exitCode, exitSignal) => {
          resolve(exitCode ?? (exitSignal ? 128 + constants.signals[exitSignal] : 1));
        });
      });
      timer = setInterval(() => {
        if (stopping || refreshing) return;
        refreshing = setAgentStatus(token, thread, "processing")
          .then(() => {})
          .catch((error: unknown) => report("heartbeat failed; retrying on next tick", error))
          .finally(() => { refreshing = undefined; });
      }, opts.every * 1000);
      code = await done;
    }
  } catch (error) {
    report("could not start agent session", error);
  } finally {
    stopping = true;
    clearInterval(timer);
    clearTimeout(killTimer);
    // No late processing write may race with (and undo) the final active write.
    await refreshing;
    if (attempted) {
      try {
        await setAgentStatus(token, thread, opts.close ? "closed" : "active");
      } catch (error) {
        report("final status clear failed", error);
        if (code === 0) code = 1;
      }
    }
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
  return signal ? 128 + constants.signals[signal] : code;
}

export function agentCommands(y: Argv, parse: ParseTarget): Argv {
  const common = (args: Argv) => args
    .positional("target", { type: "string", demandOption: true, describe: "Thread root: raw channel ID:ts (avoids listing), #channel:ts, or permalink" })
    .option("title", { type: "string", describe: "Rename the session (1–200 characters)" })
    .option("bot-token-env", { type: "string", describe: "Environment variable holding an agent-enabled app's xoxb token (default SLACK_BOT_TOKEN); requires chat:write and channel membership" });
  return y
    .command("status <target> <status>", "Set a bot agent session's status", (args) => common(args)
      .positional("status", { type: "string", choices: statuses, demandOption: true }), async (args) => {
      validateTitle(args.title);
      const token = botToken(args["bot-token-env"]);
      const thread = await threadTarget(token, args.target, parse);
      await setAgentStatus(token, thread, args.status as AgentStatus);
      if (args.title !== undefined) await renameAgentSession(token, thread, args.title);
    })
    .command("run <target>", "Keep a thread working while a command runs: run <target> -- <command...>", (args) => common(args)
      .parserConfiguration({ "populate--": true })
      .option("every", { type: "number", default: 300, describe: "Heartbeat seconds (>0 and <3600); processing expires after one hour" })
      .option("close", { type: "boolean", default: false, describe: "Finish with closed instead of active (also on failure or interrupt)" }), async (args) => {
      validateTitle(args.title);
      if (!Number.isFinite(args.every) || args.every <= 0 || args.every >= 3600) {
        throw new Error("--every must be greater than 0 and less than 3600 seconds.");
      }
      // Preserve the exact argv, including numeric strings and the child's own --.
      const separator = process.argv.indexOf("--");
      const command = separator < 0 ? [] : process.argv.slice(separator + 1);
      if (!command[0]) throw new Error("agent run requires -- <command...>");
      const token = botToken(args["bot-token-env"]);
      const thread = await threadTarget(token, args.target, parse);
      process.exitCode = await runAgent(token, thread, command, {
        every: args.every, close: args.close,
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
    })
    .demandCommand(1, "Choose agent status or agent run.");
}
