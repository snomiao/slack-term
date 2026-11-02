// Mocks answer 429 on purpose; a test must see the RateLimitError at once,
// not sit out the Retry-After the CLI waits for real Slack. Tests that cover
// the wait set it back with setRateLimitWait().
process.env.SLACK_RATELIMIT_WAIT_SEC ??= "0";

// The suite itself often runs inside an agent (Claude Code, ay): without this,
// every CLI test that sends as the user session would hit the agent guard
// (ts/identity.ts). Tests of that guard set these variables themselves.
for (const k of ["AY_AGENT_ID", "AGENT_YES_PID", "CLAUDECODE"]) delete process.env[k];
