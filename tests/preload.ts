// Mocks answer 429 on purpose; a test must see the RateLimitError at once,
// not sit out the Retry-After the CLI waits for real Slack. Tests that cover
// the wait set it back with setRateLimitWait().
process.env.SLACK_RATELIMIT_WAIT_SEC ??= "0";
