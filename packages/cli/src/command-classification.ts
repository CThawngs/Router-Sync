/**
 * packages/cli/src/command-classification.ts
 *
 * C15 Q1.1: every registered commander command is classified as
 * short | long-running | interactive. Only `short` commands get the watchdog;
 * `interactive` commands only get it when stdin is not a TTY.
 */

export type CommandClass = 'short' | 'long-running' | 'interactive';

/** Full command paths as registered in index.ts. */
export const COMMAND_CLASSES: Record<string, CommandClass> = {
  init: 'short',
  scan: 'short',
  plan: 'short',
  apply: 'interactive',
  rollback: 'interactive',
  status: 'short',
  doctor: 'short',
  mcp: 'long-running',
  'mcp install': 'short',
  'mcp serve-http': 'long-running',
  'mcp pair': 'short',
  'mcp revoke': 'short',
  'mcp selftest': 'short',
  'mcp list': 'short',
  research: 'short',
  'research run': 'short',
  'research status': 'short',
  'research queue': 'short',
  'research evidence': 'short',
  'research price-confirm': 'short',
  'research submit': 'short',
  inbox: 'short',
  'inbox list': 'short',
  'inbox ack': 'short',
  'inbox snooze': 'short',
  diff: 'short',
  'dead-models': 'short',
  'confirm-absent': 'interactive',
  daemon: 'long-running',
  'daemon pause': 'short',
  'daemon resume': 'short',
  'daemon log': 'short',
  'daemon log export': 'short',
  tick: 'short',
  schedule: 'short',
  verify: 'short',
  track: 'short',
  'track once': 'short',
  'track watch': 'long-running',
  'track status': 'short',
  'track autostart': 'long-running',
  maintain: 'interactive',
  'maintain plan': 'short',
  'maintain apply': 'interactive',
  'maintain authorize': 'interactive',
  'maintain grant-status': 'short',
  'maintain revoke-grant': 'interactive',
  'maintain secret-selftest': 'short',
  'maintain create': 'interactive',
  sync: 'interactive',
  undo: 'interactive',
  'sync-status': 'short',
  rank: 'interactive',
  health: 'short',
  sim: 'short',
  storage: 'short',
  'storage inspect': 'short',
  discover: 'short',
  autopilot: 'short',
  'autopilot plan': 'short',
  profile: 'interactive',
  'profile init': 'interactive',
  'profile show': 'short',
  'profile export': 'short',
  'profile interview': 'interactive',
  export: 'short',
  'export litellm': 'short',
  apps: 'short',
  'apps inspect': 'short',
  'apps drift': 'short',
  agents: 'short',
  'agents discover': 'short',
  'agents dry-run': 'short',
  'agents apply': 'interactive',
  'agents rollback': 'interactive',
  'agents update': 'interactive',
  combos: 'short',
  'combos stale': 'short',
  // C32 M1: probe l�m vi?c m?ng nhi?u ph�t, kh�ng du?c watchdog 120s c?t.
  'combos probe': 'long-running',
  // C33 N3: plan đọc DB + ghi một file kế hoạch, tính bằng giây.
  'combos plan': 'short',
  // C35 R1: watch chạy nhiều phút, không bị watchdog 120s cắt.
  'router': 'long-running',
  'router watch': 'long-running',
};

/** Classify argv (process.argv.slice(2)). Unknown commands default to short. */
export function classifyCommand(argv: string[]): CommandClass {
  const tokens = argv.filter((a) => !a.startsWith('-') && !a.includes('='));
  let best: CommandClass = 'short';
  let bestLen = 0;
  for (let start = 0; start < tokens.length; start += 1) {
    for (let n = tokens.length - start; n > bestLen; n -= 1) {
      const key = tokens.slice(start, start + n).join(' ');
      const value: CommandClass | undefined = COMMAND_CLASSES[key];
      if (value !== undefined) {
        best = value;
        bestLen = n;
        break;
      }
    }
  }
  return best;
}

/** Override from the environment. 0 disables the watchdog entirely. */
export function watchdogDelayMs(): number {
  const raw = process.env['ROUTERSYNC_WATCHDOG_MS'];
  if (raw === undefined) return 120_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 120_000;
}

