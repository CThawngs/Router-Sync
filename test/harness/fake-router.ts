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

  private server?: http.Server;
  private serverPort?: number;

  constructor(options: FakeRouterOptions = {}) {
    this.name = options.name ?? 'fake-router';
    this.combos = options.initialCombos ? JSON.parse(JSON.stringify(options.initialCombos)) : [];
    this.catalog = options.catalog ? JSON.parse(JSON.stringify(options.catalog)) : [];
    this.staleCache = options.staleCache ?? false;
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

  async createSnapshot(): Promise<Snapshot> {
    const snap = createSnapshotEntity(this.name, this.combos);
    this.snapshots.push(snap);
    return snap;
  }

  async applyPlan(plan: Plan): Promise<ApplyResult> {
    this.writeCount++;
    const appliedAt = new Date().toISOString();

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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
          return;
        }

        if (req.url === '/v1/models' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: this.catalog.map((m) => ({ id: m.id, object: 'model' })),
            })
          );
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
}
