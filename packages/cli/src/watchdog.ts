/**
 * packages/cli/src/watchdog.ts
 *
 * C14 (a): CLI-wide watchdog. Exits with code 124 after WATCHDOG_MS.
 * The long-running `daemon` command is exempt.
 */

export const WATCHDOG_MS = 120_000;

/** Commands that are allowed to run indefinitely. */
export function isWatchdogExempt(argv: string[]): boolean {
  return argv[2] === 'daemon';
}

/**
 * Install the watchdog. Returns a cleanup function that must be called when
 * the command finishes. The timer is unref'd so it never keeps the process alive.
 */
export function installWatchdog(argv: string[], ms: number = WATCHDOG_MS): () => void {
  if (isWatchdogExempt(argv)) return () => {};
  const timer = setTimeout(() => {
    process.stderr.write('[routersync] watchdog: timeout, exit 124\n');
    process.exit(124);
  }, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
