// Files an agent uploaded under the owner's own account.
//
// The relay forwards the owner's messages to agents as instructions. An agent that
// uploads with the owner's token (no `--as-bot`) posts a message that IS the owner's,
// so the relay would hand the upload comment back to the agent as if the owner had
// written it. `slack upload` notes the file ids it posted from inside an agent
// (AGENT_YES_PID set); the relay skips a message whose files are all on that list.
//
// Fail-soft both ways: a failed write only means one possible echo.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEEP = 500;

export function agentUploadsPath(): string {
  return process.env.SLACK_TERM_AGENT_UPLOADS ?? join(homedir(), ".config", "slack-cli", "agent-uploads.jsonl");
}

export function recordAgentUpload(fileId: string, agentPid: number, path = agentUploadsPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ fileId, agentPid, at: Date.now() }) + "\n", { mode: 0o600 });
  } catch {
    /* bookkeeping only */
  }
}

/** The most recent agent-uploaded file ids. */
export function agentUploadIds(path = agentUploadsPath()): Set<string> {
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(-KEEP);
    const ids = new Set<string>();
    for (const l of lines) {
      try {
        const id = (JSON.parse(l) as { fileId?: unknown }).fileId;
        if (typeof id === "string") ids.add(id);
      } catch { /* skip a torn line */ }
    }
    return ids;
  } catch {
    return new Set();
  }
}
