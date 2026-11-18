/**
 * packages/cli/src/watchdog.ts
 *
 * C15 Q1.1: watchdog follows the command classification.
 */

import { classifyCommand, watchdogDelayMs, type CommandClass } from './command-classification.js';

/** Exposed for tests / diagnostics. */
export function watchdogClass(argv: string[]): CommandClass {
  return classifyCommand(argv);
}

/**
 * Install the watchdog. Returns a cleanup function.
 * - long-running: never watched
 * - interactive: watched only when stdin is NOT a TTY
 * - short: always watched
 * ROUTERSYNC_WATCHDOG_MS=0 disables all watches.
 */
export function installWatchdog(argv: string[], ms: number = watchdogDelayMs()): () => void {
  if (ms === 0) return () => {};
  const cls = classifyCommand(argv);
  if (cls === 'long-running') return () => {};
  if (cls === 'interactive' && process.stdin.isTTY === true) return () => {};

  const timer = setTimeout(() => {
    process.stderr.write(`[routersync] watchdog: timeout (${cls} command), exit 124\n`);
    process.exit(124);
  }, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
