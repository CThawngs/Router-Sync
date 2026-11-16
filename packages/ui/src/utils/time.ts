/**
 * packages/ui/src/utils/time.ts
 *
 * R18-5.2: the daemon measures ISO-8601 timestamps; the owner reads a clock.
 *
 * `formatClock` turns `lastProbeAt` (and anything else carrying a raw ISO
 * stamp) into a local, readable clock value. The instant itself is never
 * changed — only how it is printed.
 *
 * `timeZone` exists for tests: a fixed zone makes the assertion independent of
 * the machine running the suite. Production calls omit it and get local time.
 */
export function formatClock(iso?: string | undefined, timeZone?: string | undefined): string | undefined {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return undefined;
  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}
