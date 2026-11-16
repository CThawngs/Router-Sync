/**
 * packages/cli/src/commands/daemon-log.ts
 *
 * `routersync daemon log export`: print jobs.jsonl entries (JSONL) to stdout
 * or a file. Read-only; never mutates the log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export function jobLogPath(): string {
  const dir = process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
  return path.join(dir, 'jobs.jsonl');
}

export function readJobLogRaw(): string {
  try {
    return fs.readFileSync(jobLogPath(), 'utf8');
  } catch {
    return '';
  }
}

export async function runDaemonLogExport(options: { out?: string; json?: boolean }): Promise<void> {
  const raw = readJobLogRaw();
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, raw.endsWith('\n') || raw === '' ? raw : raw + '\n', 'utf8');
    if (!options.json) console.log(`[routersync-daemon] Exported ${lines.length} job log entries to ${options.out}`);
  } else if (lines.length > 0) {
    console.log(lines.join('\n'));
  }
}
