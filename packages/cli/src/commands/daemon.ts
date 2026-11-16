/**
 * packages/cli/src/commands/daemon.ts
 *
 * CLI command to run the RouterSync background daemon (A3/A4):
 * HTTP server + interval scheduler (scan/health/plan/digest/cleanup),
 * pause/resume file, --mode observe. Scan reuses cli/src/sync/providers.ts
 * fetchModelList via the daemon's injected fetch (daemon never re-implements
 * provider fetching).
 */

import { createHash } from 'node:crypto';
import { startDaemonServer, createScheduler, setPaused, isPaused, runScanJob, runHealthJob, buildDigest, runCleanupJob, acquireLock, releaseLock, readRouterCombos } from '@routersync/daemon';
import { fetchModelList, keySourceLabel, type ProviderTarget } from '../sync/providers.js';
import { loadConfigFile } from '../config/loader.js';
import { buildViews } from './sync/sync-plan.js';
import { generatePlansForConfig, isPlanSuspect } from './plan.js';
import { loadProfile } from '../profile/manager.js';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DaemonCommandOptions {
  port?: string;
  config?: string;
  profile?: string;
  interval?: string;
  mode?: string;
  once?: boolean;
  json?: boolean;
}

function stateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
}

function pausedFile(): string {
  return path.join(stateDir(), 'daemon.paused');
}

function lockFile(): string {
  return path.join(stateDir(), 'daemon.lock');
}

export function parseScheduleMinutes(schedule: unknown): number {
  const fallback = 15;
  if (typeof schedule === 'number' && Number.isFinite(schedule) && schedule >= 1) return Math.floor(schedule);
  if (typeof schedule === 'string') {
    const m = schedule.match(/(\d+)\s*(m|min|minute)/i);
    if (m && m[1]) return Math.max(1, parseInt(m[1], 10));
    const n = Number(schedule);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
    const rec = schedule as Record<string, unknown>;
    const v = rec['intervalMinutes'] ?? rec['interval'] ?? rec['minutes'];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.floor(v);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    }
  }
  return fallback;
}

export function prefixesFromCombos(): string[] {
  const set = new Set<string>();
  for (const r of ['9router', 'omniroute'] as const) {
    try {
      const res = readRouterCombos(r);
      if (res.ok && Array.isArray(res.data)) {
        for (const c of res.data) {
          for (const m of c.models) {
            const p = m.split('/')[0]?.toLowerCase();
            if (p) set.add(p);
          }
        }
      }
    } catch {
      // unreadable router: skip
    }
  }
  return [...set];
}

/** C3o O1(b): daemon dùng cùng bộ nạp config/rules/profile và cùng bộ dựng kế hoạch với CLI. */
export async function buildDaemonPlan(configPath?: string): Promise<Array<{ routerId: string; counts: string; planHash: string; suspect: boolean }>> {
  const { results } = await generatePlansForConfig(configPath);
  return results.map((r) => {
    const planHash = createHash('sha256')
      .update(JSON.stringify({ a: r.plan.additions, m: r.plan.modifications, d: r.plan.deletions, r: r.plan.reasons ?? {} }))
      .digest('hex').slice(0, 16);
    const suspect = isPlanSuspect(r.totalSteps, r.plan.deletions.length, r.keepSteps);
    return {
      routerId: r.routerId,
      counts: `add=${r.plan.additions.length} remove=${r.plan.deletions.length} keep=${r.keepSteps} total=${r.totalSteps}`,
      planHash,
      suspect,
    };
  });
}

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<void> {
  if (options.config) {
    process.env['ROUTERSYNC_CONFIG'] = options.config;
  }
  const mode = options.mode ?? 'observe';

  const port = options.port ? parseInt(options.port, 10) : 3128;

  if (isNaN(port) || port <= 0 || port > 65535) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'invalid_port', message: `Invalid port number: "${options.port}"` }));
    } else {
      console.error(`[routersync] Error: Invalid port number "${options.port}"`);
    }
    process.exit(1);
  }

  const lockPath = lockFile();
  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'second_instance', message: `Another daemon (pid ${lock.pid}) already holds the lock` }));
    } else {
      console.error(`[routersync] Another daemon instance (pid ${lock.pid}) is already running.`);
    }
    process.exit(1);
  }

  const profile = loadProfile(options.profile);
  const profileMinutes = parseScheduleMinutes((profile.profile as unknown as Record<string, unknown>)['schedule']);
  const overrideMinutes = options.interval ? parseInt(options.interval, 10) : NaN;
  if (options.interval && (Number.isNaN(overrideMinutes) || overrideMinutes < 1)) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'invalid_interval', message: `Invalid interval: "${options.interval}"` }));
    } else {
      console.error(`[routersync] Error: Invalid interval "${options.interval}" (cần số phút >= 1)`);
    }
    process.exit(1);
  }
  const intervalMinutes = Number.isNaN(overrideMinutes) ? profileMinutes : overrideMinutes;
  const minSteps = profile.profile.combos[0]?.minSteps ?? 2;

  // daemon --once (C3k K2): run one scan tick and exit; no port, no lock, no loop.
  if (options.once) {
    const { config } = loadConfigFile(options.config);
    const views = await buildViews(config, 'all');
    const targets: Array<ProviderTarget & { router: string }> = [];
    const seen = new Set<string>();
    for (const view of views) {
      for (const t of view.targets) {
        if (seen.has(t.prefix)) continue;
        seen.add(t.prefix);
        targets.push({ ...t, router: view.name });
      }
    }
    const scan = await runScanJob({
      targets: targets.map((t) => ({
        id: t.prefix,
        label: `${t.router}:${t.label} key=${keySourceLabel(t.keySource, t.router)}`,
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        skipReason: t.skipReason,
      })),
      fetchModelList: (t) => {
        const full = targets.find((x) => x.prefix === t.id) ?? (t as unknown as ProviderTarget);
        return fetchModelList(full);
      },
    });
    const ok = scan.providers.filter((p) => !p.skipped && p.flags.length === 0).length;
    if (options.json) {
      console.log(JSON.stringify({ once: true, ok, total: scan.providers.length, providers: scan.providers }, null, 2));
    } else {
      console.log(`OK ${ok}/${scan.providers.length} nhà cung cấp`);
      console.log(`scan: ${ok}/${scan.providers.length} providers ok`);
      {
        for (const p of await buildDaemonPlan(options.config)) {
          console.log(`COUNTS ${p.routerId} ${p.counts} planHash=${p.planHash}${p.suspect ? ' PLAN-SUSPECT' : ''}`);
        }
      }
      for (const p of scan.providers) console.log(`  ${p.id} status=${p.status} models=${p.models} host=${p.host}`);
    }
    releaseLock(lockPath);
    return;
  }

  try {
    const { server, port: boundPort, host } = await startDaemonServer({ port });

    // ponytail: closure lastScan, no new combo reader.
    let lastScan: Awaited<ReturnType<typeof runScanJob>> | null = null;
    const healthLabel = async (): Promise<string> => {
      const h = await runHealthJob();
      const parts: string[] = [];
      for (const r of h.routers) {
        let s = `health ${r.router}: ${r.firstComboLabel ?? 'unreadable'}`;
        if (r.warnings.length > 0) s += ` [${r.warnings.join('; ')}]`;
        parts.push(s);
      }
      return parts.join('; ') || 'health: no routers measured';
    };
    // Daemon scan targets == CLI sync targets. buildViews applies the same
    // inScope (adopt/declare/exclude) prefix filter and the 9Router-key chain
    // (incl. BORROWED-KEY for OmniRoute) as `scan --completeness`, instead of
    // the global prefixesFromCombos() list (C3k K2).
    const runScan = async (): Promise<string> => {
      const { config } = loadConfigFile(options.config);
      const views = await buildViews(config, 'all');
      const targets: Array<ProviderTarget & { router: string }> = [];
      const seen = new Set<string>();
      for (const view of views) {
        for (const t of view.targets) {
          if (seen.has(t.prefix)) continue; // same prefix + host scanned once, 9Router first
          seen.add(t.prefix);
          targets.push({ ...t, router: view.name });
        }
      }
      const scan = await runScanJob({
        targets: targets.map((t) => ({
          id: t.prefix, // plan looks up model lists by prefix
          label: `${t.router}:${t.label} key=${keySourceLabel(t.keySource, t.router)}`,
          baseUrl: t.baseUrl,
          apiKey: t.apiKey,
          skipReason: t.skipReason,
        })),
        fetchModelList: (t) => {
          const full = targets.find((x) => x.prefix === t.id) ?? (t as unknown as ProviderTarget);
          return fetchModelList(full);
        },
      });
      lastScan = scan;
      const ok = scan.providers.filter((p) => !p.skipped && p.flags.length === 0).length;
      return `scan: ${ok}/${scan.providers.length} providers ok`;
    };
    // Real scheduler wired with reused scan + readonly health.
    const scheduler = createScheduler({
      intervalMs: intervalMinutes * 60_000,
      stateDir: stateDir(),
      runJob: async (job) => {
        if (job === 'scan') {
          return runScan();
        }
        if (job === 'health') {
          return healthLabel();
        }
        if (job === 'plan') {
          // C3o O1(b): daemon plan = CLI plan (cùng generatePlansForConfig).
          const rows = await buildDaemonPlan(options.config);
          return rows.map((p) => `plan ${p.routerId}: ${p.counts} planHash=${p.planHash}${p.suspect ? ' PLAN-SUSPECT' : ''}`).join('\n') || 'plan: no routers';
        }
        if (job === 'digest') {
          const h = runHealthJob();
          return buildDigest({ health: h });
        }
        if (job === 'cleanup') {
          const c = runCleanupJob({ stateDir: stateDir() });
          return `cleanup: removed ${c.removed.length} snapshots, kept ${c.kept}`;
        }
        return `${job}:ok`;
      },
    });

    if (options.json) {
      console.log(JSON.stringify({
        status: 'running',
        host,
        port: boundPort,
        readOnly: true,
        slice: 'S1',
        mode,
        intervalMinutes,
        paused: isPaused(stateDir()),
      }));
    } else {
      console.log(`[routersync-daemon] Listening on http://${host}:${boundPort} (mode=${mode}, interval=${intervalMinutes}m)`);
      console.log('[routersync-daemon] Press Ctrl+C to terminate.');
    }

    scheduler.start();

    const shutdown = () => {
      scheduler.stop();
      releaseLock(lockPath);
      server.close(() => {
        if (!options.json) console.log('\n[routersync-daemon] Stopped.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err: unknown) {
    releaseLock(lockPath);
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ error: 'startup_failed', message }));
    } else {
      console.error(`[routersync] Daemon failed to start: ${message}`);
    }
    process.exit(1);
  }
}

export async function runDaemonPauseCommand(): Promise<void> {
  setPaused(true, stateDir());
  console.log('[routersync-daemon] Paused.');
}

export async function runDaemonResumeCommand(): Promise<void> {
  setPaused(false, stateDir());
  console.log('[routersync-daemon] Resumed.');
}

export function pausedFilePath(): string {
  return pausedFile();
}
