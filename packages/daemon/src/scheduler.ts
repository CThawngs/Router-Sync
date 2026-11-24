/**
 * packages/daemon/src/scheduler.ts
 *
 * Interval scheduler: jitter ±10%, exponential backoff (cap 8x), pause/resume
 * via stateDir/daemon.paused file, JSONL job log at stateDir/jobs.jsonl,
 * and cross-tier `<stateDir>/tick.lock` mutual exclusion (`C45-WP7`).
 * Clock / random / timer injected for tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseTickLock, tryAcquireTickLock } from './single-instance.js';
import { realClock, stateDir as defaultStateDir, type Clock } from './jobs.js';

export type JobName = 'scan' | 'health' | 'plan' | 'digest' | 'cleanup';

export interface JobLogEntry {
  jobId: string;
  job: JobName;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'skipped';
  summary: string;
  error?: string;
}

export const DEFAULT_INTERVAL_MINUTES = 15;
export const MAX_BACKOFF_MULT = 8;

export function pausedFile(dir?: string): string {
  return path.join(dir ?? defaultStateDir(), 'daemon.paused');
}

export function jobLogFile(dir?: string): string {
  return path.join(dir ?? defaultStateDir(), 'jobs.jsonl');
}

export function isPaused(dir?: string): boolean {
  try {
    return fs.existsSync(pausedFile(dir));
  } catch {
    return false;
  }
}

export function setPaused(paused: boolean, dir?: string): void {
  const file = pausedFile(dir);
  if (paused) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString() + '\n', 'utf8');
  } else {
    try {
      fs.unlinkSync(file);
    } catch {
      // already resumed
    }
  }
}

/** Delay with ±10% jitter. rand() in [0,1). */
export function jitteredDelay(baseMs: number, rand: () => number = Math.random): number {
  const r = Math.min(Math.max(rand(), 0), 0.999999);
  return Math.round(baseMs * (0.9 + r * 0.2));
}

/** Exponential backoff: 2^n * base, capped at MAX_BACKOFF_MULT x base. */
export function backoffDelay(consecutiveErrors: number, baseMs: number): number {
  if (consecutiveErrors <= 0) return baseMs;
  const mult = Math.min(2 ** consecutiveErrors, MAX_BACKOFF_MULT);
  return baseMs * mult;
}

export function appendJobLog(entry: JobLogEntry, dir?: string): void {
  const file = jobLogFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

export function readJobLog(dir?: string): JobLogEntry[] {
  try {
    const raw = fs.readFileSync(jobLogFile(dir), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as JobLogEntry);
  } catch {
    return [];
  }
}

export interface SchedulerOptions {
  intervalMs?: number | undefined;
  stateDir?: string | undefined;
  clock?: Clock | undefined;
  random?: (() => number) | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
  runJob?: ((job: JobName) => Promise<string>) | undefined;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  consecutiveErrors(): number;
  nextDelayMs(): number;
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const baseMs = options.intervalMs ?? DEFAULT_INTERVAL_MINUTES * 60_000;
  const dir = options.stateDir ?? defaultStateDir();
  const clock = options.clock ?? realClock;
  const rand = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const runJob = options.runJob ?? (async (job: JobName) => `${job}:ok`);

  let errors = 0;
  let timer: unknown = null;
  let stopped = true;
  let ticking = false;
  let seq = 0;

  function nextDelayMs(): number {
    return errors > 0 ? jitteredDelay(backoffDelay(errors, baseMs), rand) : jitteredDelay(baseMs, rand);
  }

  function schedule(): void {
    timer = setTimer(() => {
      void tick();
    }, nextDelayMs());
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    const started = clock.now();
    const iso = new Date(started).toISOString();
    seq += 1;
    if (isPaused(dir)) {
      appendJobLog(
        {
          jobId: `tick-${seq}`,
          job: 'scan',
          startedAt: iso,
          endedAt: new Date(clock.now()).toISOString(),
          durationMs: Math.max(0, clock.now() - started),
          status: 'skipped',
          summary: 'skipped: paused',
        },
        dir
      );
      ticking = false;
      if (!stopped) schedule();
      return;
    }

    const tickLock = tryAcquireTickLock(dir, process.pid, started);
    if (!tickLock.acquired) {
      appendJobLog(
        {
          jobId: `tick-${seq}`,
          job: 'scan',
          startedAt: iso,
          endedAt: new Date(clock.now()).toISOString(),
          durationMs: Math.max(0, clock.now() - started),
          status: 'skipped',
          summary: `skipped: tick.lock held by pid ${tickLock.holderPid ?? 'unknown'}`,
        },
        dir
      );
      ticking = false;
      if (!stopped) schedule();
      return;
    }

    try {
      const summaries: string[] = [];
      for (const job of ['scan', 'health', 'plan', 'digest', 'cleanup'] as JobName[]) {
        const jStart = clock.now();
        try {
          const summary = await runJob(job);
          summaries.push(summary);
          appendJobLog(
            {
              jobId: `${iso}-${seq}-${job}`,
              job,
              startedAt: new Date(jStart).toISOString(),
              endedAt: new Date(clock.now()).toISOString(),
              durationMs: Math.max(0, clock.now() - jStart),
              status: 'ok',
              summary,
            },
            dir
          );
        } catch (err) {
          appendJobLog(
            {
              jobId: `${iso}-${seq}-${job}`,
              job,
              startedAt: new Date(jStart).toISOString(),
              endedAt: new Date(clock.now()).toISOString(),
              durationMs: Math.max(0, clock.now() - jStart),
              status: 'error',
              summary: 'error',
              error: err instanceof Error ? err.message : String(err),
            },
            dir
          );
          throw err;
        }
      }
      errors = 0;
    } catch {
      errors += 1;
    } finally {
      releaseTickLock(dir, process.pid);
    }
    ticking = false;
    if (!stopped) schedule();
  }

  return {
    start(): void {
      stopped = false;
      schedule();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    tick,
    pause(): void {
      setPaused(true, dir);
    },
    resume(): void {
      setPaused(false, dir);
    },
    isPaused(): boolean {
      return isPaused(dir);
    },
    consecutiveErrors(): number {
      return errors;
    },
    nextDelayMs,
  };
}
