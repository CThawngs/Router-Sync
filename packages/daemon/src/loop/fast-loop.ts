/**
 * packages/daemon/src/loop/fast-loop.ts
 *
 * Fast Loop Router Health & Drift Monitor (Phase 3b / SPEC §31.9 ④).
 *
 * Periodically monitors router reachability and database combo definitions
 * using strictly read-only primitives (@routersync/core/readonly).
 * Detects external drift without modifying router state and emits deduplicated
 * actionable webhook alerts on drift transitions (M2-02).
 */

import {
  sendActionableWebhook,
  type ActionableWebhookAlert,
  type WebhookDeliveryResult,
} from '@routersync/core/readonly';
import { probeRouter } from '../probe/reachability.js';
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
  driftCount?: number | undefined;
  lastDriftAt?: string | undefined;
  webhookDelivery?: WebhookDeliveryResult | undefined;
}

export interface FastLoopOptions {
  intervalMs?: number | undefined;
  webhookUrl?: string | undefined;
  webhookTimeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

interface RouterBaselineSnapshot {
  reachability: FastLoopRouterState['reachability'];
  combosFingerprint: string;
  combosCount: number;
  modelsCount: number;
}

function serializeRouterCombos(combos: readonly ParsedComboRecord[]): string {
  return [...combos]
    .map((combo) => `${combo.id}:${combo.name}:[${combo.models.join(',')}]`)
    .sort()
    .join(';');
}

export class FastLoop {
  private readonly intervalMs: number;
  private readonly webhookUrl?: string | undefined;
  private readonly webhookTimeoutMs?: number | undefined;
  private readonly env?: NodeJS.ProcessEnv | undefined;
  private readonly fetchFn?: typeof globalThis.fetch | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentState: FastLoopState | null = null;
  private baseline: {
    omniroute: RouterBaselineSnapshot;
    '9router': RouterBaselineSnapshot;
  } | null = null;
  private lastDriftFingerprint: string | null = null;
  private listeners: Set<(state: FastLoopState) => void> = new Set();
  private lastDriftAt?: string | undefined;

  constructor(options?: FastLoopOptions) {
    this.intervalMs = options?.intervalMs ?? 30_000; // default 30s
    this.webhookUrl = options?.webhookUrl;
    this.webhookTimeoutMs = options?.webhookTimeoutMs;
    this.env = options?.env;
    this.fetchFn = options?.fetchFn;
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

  private resolveWebhookUrl(): string | undefined {
    if (this.webhookUrl !== undefined && this.webhookUrl.trim() !== '') {
      return this.webhookUrl;
    }
    const envSource = this.env ?? process.env;
    return envSource['ROUTERSYNC_WEBHOOK_URL'];
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

    const omniCombosFp = serializeRouterCombos(omniCombos);
    const nineCombosFp = serializeRouterCombos(nineCombos);

    const driftAlerts: ActionableWebhookAlert[] = [];
    const driftFingerprintParts: string[] = [];
    const driftedRouters = new Set<string>();

    if (!this.baseline) {
      this.baseline = {
        omniroute: {
          reachability: omniState.reachability,
          combosFingerprint: omniCombosFp,
          combosCount: omniState.combosCount,
          modelsCount: omniState.modelsCount,
        },
        '9router': {
          reachability: nineState.reachability,
          combosFingerprint: nineCombosFp,
          combosCount: nineState.combosCount,
          modelsCount: nineState.modelsCount,
        },
      };
    } else {
      const checkRouterDrift = (
        routerId: 'omniroute' | '9router',
        state: FastLoopRouterState,
        combosFp: string,
        base: RouterBaselineSnapshot
      ) => {
        if (combosFp !== base.combosFingerprint) {
          driftedRouters.add(routerId);
          driftFingerprintParts.push(`${routerId}:combos:${combosFp}`);
          driftAlerts.push({
            kind: 'router_drift',
            providerOrRouter: routerId,
            code: 'COMBO_DRIFT',
            message: `Router ${routerId} combo state drifted from baseline (${base.combosCount} combos / ${base.modelsCount} models -> ${state.combosCount} combos / ${state.modelsCount} models).`,
          });
        }
        if (state.reachability !== base.reachability) {
          driftedRouters.add(routerId);
          driftFingerprintParts.push(`${routerId}:reachability:${state.reachability}`);
          driftAlerts.push({
            kind: state.reachability === 'down' ? 'degraded_target' : 'router_drift',
            providerOrRouter: routerId,
            code: 'REACHABILITY_DRIFT',
            message: `Router ${routerId} reachability changed (${base.reachability} -> ${state.reachability}).`,
          });
        }
      };

      checkRouterDrift('omniroute', omniState, omniCombosFp, this.baseline.omniroute);
      checkRouterDrift('9router', nineState, nineCombosFp, this.baseline['9router']);
    }

    const driftCount = driftAlerts.length;
    const driftDetected = driftCount > 0;
    let webhookDelivery: WebhookDeliveryResult;

    if (driftCount === 0) {
      this.lastDriftFingerprint = null;
      webhookDelivery = await sendActionableWebhook({
        url: this.resolveWebhookUrl(),
        source: 'daemon.fast_loop',
        timestamp: nowIso,
        driftCount: 0,
        changedProviders: [],
        alerts: [],
        timeoutMs: this.webhookTimeoutMs,
        fetchImpl: this.fetchFn,
      });
    } else {
      this.lastDriftAt = nowIso;
      const sortedFingerprint = [...driftFingerprintParts].sort().join('|');
      if (sortedFingerprint !== this.lastDriftFingerprint) {
        this.lastDriftFingerprint = sortedFingerprint;
        webhookDelivery = await sendActionableWebhook({
          url: this.resolveWebhookUrl(),
          source: 'daemon.fast_loop',
          timestamp: nowIso,
          driftCount,
          changedProviders: [...driftedRouters],
          alerts: driftAlerts,
          timeoutMs: this.webhookTimeoutMs,
          fetchImpl: this.fetchFn,
        });
      } else {
        webhookDelivery = {
          status: 'skipped',
          ok: true,
          reason: 'duplicate_drift_suppressed',
          durationMs: 0,
        };
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
      driftCount,
      lastDriftAt: this.lastDriftAt,
      webhookDelivery,
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
