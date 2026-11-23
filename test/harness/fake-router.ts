/**
 * test/harness/fake-router.ts
 * 
 * In-memory / Ephemeral FakeRouter Test Harness for automated acceptance testing.
 * Simulates real router behavior, latency, cache staleness, and rollback.
 */

import type {
  ApplyResult,
  ComboDefinition,
  HealthStatus,
  ModelInfo,
  Plan,
  RouterAdapter,
  Snapshot,
} from '@routersync/adapter-sdk';
import { createSnapshotEntity } from '@routersync/core';
import * as http from 'node:http';

export interface FakeRouterOptions {
  name?: string;
  initialCombos?: ComboDefinition[];
  catalog?: ModelInfo[];
  staleCache?: boolean;
  /** Number of endpoint polls for which the pre-apply snapshot is still served. */
  reflectAfterPolls?: number | undefined;
  /** Always serve the pre-apply snapshot over HTTP (200 but stale). */
  staleServingPath?: boolean;
  /** Force a non-200 status on the serving-path endpoints (e.g. 503). */
  servingStatusOverride?: number | undefined;
  /** Simulate a dashboard-less API-key session: /api/combos requires a cookie. */
  requireAuthForCombos?: boolean;
}

export class FakeRouter implements RouterAdapter {
  readonly name: string;
  readonly tier = 'T3' as const;

  public combos: ComboDefinition[];
  public catalog: ModelInfo[];
  public staleCache: boolean;
  public snapshots: Snapshot[] = [];
  public rollbackCount = 0;
  public writeCount = 0;

  public reflectAfterPolls?: number | undefined;
  public staleServingPath: boolean;
  public servingStatusOverride?: number | undefined;
  public requireAuthForCombos: boolean;

  public healthRequests = 0;
  public modelsRequests = 0;
  public combosRequests = 0;

  private preApplySnapshot: ComboDefinition[];
  private reflectedCombos: ComboDefinition[] | undefined;
  private servedCombos: ComboDefinition[];
  private server?: http.Server;
  private serverPort?: number;

  constructor(options: FakeRouterOptions = {}) {
    this.name = options.name ?? 'fake-router';
    this.combos = options.initialCombos ? JSON.parse(JSON.stringify(options.initialCombos)) : [];
    this.catalog = options.catalog ? JSON.parse(JSON.stringify(options.catalog)) : [];
    this.staleCache = options.staleCache ?? false;
    this.reflectAfterPolls = options.reflectAfterPolls;
    this.staleServingPath = options.staleServingPath ?? false;
    this.servingStatusOverride = options.servingStatusOverride;
    this.requireAuthForCombos = options.requireAuthForCombos ?? false;
    this.preApplySnapshot = JSON.parse(JSON.stringify(this.combos));
    this.servedCombos = JSON.parse(JSON.stringify(this.combos));
  }

  async checkHealth(): Promise<HealthStatus> {
    return {
      ok: true,
      status: 'ok',
      latencyMs: 1,
      timestamp: new Date().toISOString(),
    };
  }

  async readCatalog(): Promise<ModelInfo[]> {
    return JSON.parse(JSON.stringify(this.catalog));
  }

  async readCombos(): Promise<ComboDefinition[]> {
    if (this.staleCache) {
      // Simulate gateway serving stale cached combo state
      const initial = this.snapshots[0]?.combos ?? [];
      return JSON.parse(JSON.stringify(initial));
    }
    return JSON.parse(JSON.stringify(this.combos));
  }

  /** Reset all per-endpoint request counters. */
  resetCounters(): void {
    this.healthRequests = 0;
    this.modelsRequests = 0;
    this.combosRequests = 0;
  }

  /** Replace the in-memory combos (and, unless reflection is pending, the served combos). */
  setCombos(combos: ComboDefinition[]): void {
    this.combos = JSON.parse(JSON.stringify(combos));
    this.servedCombos = JSON.parse(JSON.stringify(combos));
  }

  /** Snapshot the combos served while reflection has not happened yet. */
  setPreApplySnapshot(combos: ComboDefinition[]): void {
    this.preApplySnapshot = JSON.parse(JSON.stringify(combos));
    this.servedCombos = JSON.parse(JSON.stringify(combos));
  }

  /** Snapshot the combos served once reflection has happened. */
  setReflectedCombos(combos: ComboDefinition[]): void {
    this.reflectedCombos = JSON.parse(JSON.stringify(combos));
  }

  /** Directly override the served snapshot (bypasses reflection logic). */
  setServingSnapshot(combos: ComboDefinition[]): void {
    this.servedCombos = JSON.parse(JSON.stringify(combos));
  }

  private servedCombosFor(endpoint: 'models' | 'combos'): ComboDefinition[] {
    if (this.staleServingPath) return JSON.parse(JSON.stringify(this.preApplySnapshot));
    const polls = endpoint === 'models' ? this.modelsRequests : this.combosRequests;
    const reflectAfter = this.reflectAfterPolls;
    if (reflectAfter !== undefined && polls <= reflectAfter) {
      return JSON.parse(JSON.stringify(this.preApplySnapshot));
    }
    const source = this.reflectedCombos ?? this.servedCombos;
    return JSON.parse(JSON.stringify(source));
  }

  async createSnapshot(): Promise<Snapshot> {
    const snap = createSnapshotEntity(this.name, this.combos);
    this.snapshots.push(snap);
    return snap;
  }

  async applyPlan(plan: Plan): Promise<ApplyResult> {
    this.writeCount++;
    const appliedAt = new Date().toISOString();
    this.preApplySnapshot = JSON.parse(JSON.stringify(this.combos));

    const comboMap = new Map<string, ComboDefinition>(this.combos.map((c) => [c.id, c]));

    for (const add of plan.additions) {
      comboMap.set(add.id, JSON.parse(JSON.stringify(add)));
    }
    for (const mod of plan.modifications) {
      comboMap.set(mod.id, JSON.parse(JSON.stringify(mod)));
    }
    for (const delId of plan.deletions) {
      comboMap.delete(delId);
    }

    this.combos = Array.from(comboMap.values());
    if (this.reflectedCombos === undefined) {
      this.reflectedCombos = JSON.parse(JSON.stringify(this.combos));
    }

    return {
      success: true,
      target: this.name,
      appliedAt,
      planId: plan.id,
      readBackVerified: true,
      staleDetected: false,
    };
  }

  async rollback(snapshot: Snapshot): Promise<boolean> {
    this.rollbackCount++;
    this.combos = JSON.parse(JSON.stringify(snapshot.combos));
    return true;
  }

  /**
   * Starts a real HTTP server on ephemeral port for network probes.
   */
  async startServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/api/health' && req.method === 'GET') {
          this.healthRequests++;
          const status = this.servingStatusOverride ?? 200;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'unavailable', timestamp: new Date().toISOString() }));
          return;
        }

        if (req.url === '/v1/models' && req.method === 'GET') {
          this.modelsRequests++;
          const status = this.servingStatusOverride ?? 200;
          if (status !== 200) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'serving-path-unavailable' }));
            return;
          }
          const served = this.servedCombosFor('models');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                ...this.catalog.map((m) => ({ id: m.id, object: 'model' })),
                ...served.map((c) => ({ id: c.id, object: 'model' })),
              ],
            })
          );
          return;
        }

        if (req.url === '/api/combos' && req.method === 'GET') {
          this.combosRequests++;
          const status = this.servingStatusOverride ?? 200;
          if (status !== 200) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'serving-path-unavailable' }));
            return;
          }
          const cookie = String(req.headers['cookie'] ?? '');
          if (this.requireAuthForCombos && !/(?:^|;\s*)session=/.test(cookie)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'dashboard-session-required' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ combos: this.servedCombosFor('combos') }));
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.serverPort = addr.port;
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });
    });
  }

  async stopServer(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }
  }

  get healthUrl(): string {
    return `http://127.0.0.1:${this.serverPort}/api/health`;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  get modelsUrl(): string {
    return `${this.baseUrl}/v1/models`;
  }
}

/** Backwards/forwards-compatible name used by M2-03 integration tests. */
export { FakeRouter as FakeRouterServer };
