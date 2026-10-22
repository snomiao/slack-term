// Synchronous stdout/stderr for piped output.
//
// Bun (seen on 1.4.2) loses output written to a pipe that is full:
//   - once anything touches `process.stdout` (yargs does, at import), a
//     `console.log` that meets a full pipe is dropped — a contiguous block of
//     lines goes missing from the middle, the exit code stays 0 and the tail
//     arrives intact, so the reader cannot tell;
//   - `process.stdout.write` queues instead, but `process.exit()` throws the
//     queue away (still true on 1.4.3).
// A reader slower than the writer — any `subprocess.run(capture_output=True)`
// on a few hundred KB — loses a different block on every run.
//
// `writeAll` writes with `writeSync`, waiting out EAGAIN, so a line is either
// fully written or the process fails loudly: a vanished reader (EPIPE) exits
// 141 like a shell's SIGPIPE, any other write error prints to stderr and exits
// 1. Never a silent gap.

import { writeSync } from "node:fs";
import { isatty } from "node:tty";
import { format } from "node:util";

const nap = new Int32Array(new SharedArrayBuffer(4));
const EPIPE_EXIT = 141;

/** Write all of `text` to `fd`, blocking until it is accepted. */
export function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") { Atomics.wait(nap, 0, 0, 2); continue; }
      if (code === "EPIPE") process.exit(EPIPE_EXIT);
      if (fd !== 2) {
        try { writeSync(2, `slack: cannot write output (${code ?? String(e)}); output is incomplete\n`); } catch { /* stderr gone too */ }
      }
      process.exit(1);
    }
  }
}

/** One line to stdout. */
export const outLine = (line: string): void => writeAll(1, line + "\n");

/** Route `console.log/info` (stdout) and `console.error/warn` (stderr) through
 *  `writeAll` for every stream that is not a terminal. Terminals keep Bun's
 *  console (colours, inspect), and they never fill up the way a pipe does. */
export function installSyncConsole(): void {
  if (!isatty(1)) {
    console.log = (...a: unknown[]) => writeAll(1, format(...a) + "\n");
    console.info = console.log;
  }
  if (!isatty(2)) {
    console.error = (...a: unknown[]) => writeAll(2, format(...a) + "\n");
    console.warn = console.error;
  }
}
