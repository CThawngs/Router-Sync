/**
 * packages/daemon/src/loop/fast-loop.ts
 *
 * Fast Loop Router Health & Drift Monitor (Phase 3b / SPEC §31.9 ④).
 *
 * Periodically monitors router reachability and database combo definitions
 * using strictly read-only primitives (@routersync/core/readonly).
 * Detects external drift without modifying router state.
 */

import { probeRouter } from '../probe/reachability.js';
import type { RouterProbeResult } from '../types.js';
import { readRouterCombos, type ParsedComboRecord } from '../db/reader.js';

export interface FastLoopRouterState {
  reachability: 'up' | 'down' | 'unknown';
  combosCount: number;
  modelsCount: number;
}

export interface FastLoopState {
  timestamp: string;
  routers: {
    omniroute: FastLoopRouterState;
    '9router': FastLoopRouterState;
  };
  totalCombos: number;
  uniqueModels: number;
  anyRouterUp: boolean;
  driftDetected: boolean;
  lastDriftAt?: string | undefined;
}

export interface FastLoopOptions {
  intervalMs?: number | undefined;
}

export class FastLoop {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentState: FastLoopState | null = null;
  private listeners: Set<(state: FastLoopState) => void> = new Set();
  private lastDriftAt?: string | undefined;

  constructor(options?: FastLoopOptions) {
    this.intervalMs = options?.intervalMs ?? 30_000; // default 30s
  }

  isRunning(): boolean {
    return this.running;
  }

  getState(): FastLoopState | null {
    return this.currentState;
  }

  onStateChange(listener: (state: FastLoopState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async checkOnce(): Promise<FastLoopState> {
    const nowIso = new Date().toISOString();

    const [omniProbe, nineProbe] = await Promise.all([
      probeRouter('omniroute'),
      probeRouter('9router'),
    ]);

    const omniDb = readRouterCombos('omniroute');
    const nineDb = readRouterCombos('9router');

    const omniCombos: ParsedComboRecord[] = omniDb.ok && Array.isArray(omniDb.data) ? omniDb.data : [];
    const nineCombos: ParsedComboRecord[] = nineDb.ok && Array.isArray(nineDb.data) ? nineDb.data : [];

    const omniModels = new Set<string>();
    for (const c of omniCombos) for (const m of c.models) omniModels.add(m);

    const nineModels = new Set<string>();
    for (const c of nineCombos) for (const m of c.models) nineModels.add(m);

    const allUniqueModels = new Set<string>([...omniModels, ...nineModels]);
    const totalCombos = omniCombos.length + nineCombos.length;

    const omniState: FastLoopRouterState = {
      reachability: omniProbe.reachability,
      combosCount: omniCombos.length,
      modelsCount: omniModels.size,
    };

    const nineState: FastLoopRouterState = {
      reachability: nineProbe.reachability,
      combosCount: nineCombos.length,
      modelsCount: nineModels.size,
    };

    let driftDetected = false;
    if (this.currentState) {
      if (
        this.currentState.routers.omniroute.reachability !== omniState.reachability ||
        this.currentState.routers['9router'].reachability !== nineState.reachability ||
        this.currentState.totalCombos !== totalCombos ||
        this.currentState.uniqueModels !== allUniqueModels.size
      ) {
        driftDetected = true;
        this.lastDriftAt = nowIso;
      }
    }

    const newState: FastLoopState = {
      timestamp: nowIso,
      routers: {
        omniroute: omniState,
        '9router': nineState,
      },
      totalCombos,
      uniqueModels: allUniqueModels.size,
      anyRouterUp: omniProbe.reachability === 'up' || nineProbe.reachability === 'up',
      driftDetected,
      lastDriftAt: this.lastDriftAt,
    };

    this.currentState = newState;

    if (driftDetected) {
      for (const listener of this.listeners) {
        try {
          listener(newState);
        } catch {}
      }
    }

    return newState;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    void this.checkOnce();

    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);

    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
