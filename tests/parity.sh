#!/usr/bin/env bash
# Parity test (legacy entry). Delegates to vitest.
# See tests/parity.test.ts for the implementation.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun run test
