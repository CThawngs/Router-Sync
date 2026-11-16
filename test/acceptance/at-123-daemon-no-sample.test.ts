import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDaemonServer, clearProbeCache, getDaemonVersion, resetDaemonVersionCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-123: Zero Sample / Mock Telemetry Guarantee in S1 Daemon', () => {
  let server: http.Server;
  let port: number;
  let fixture: DaemonFixture | undefined;

  beforeAll(async () => {
    // R11-0: hermetic fixture — tmp SQLite DBs (1 combo `routersync-fast`, model
    // `m1`), explicit env overrides for config/DB paths/probe URLs/state dir.
    // Without these overrides the daemon resolved the owner's REAL databases
    // and probed REAL ports 20128/30128 (r10-at123-red discrepancy).
    fixture = await setupDaemonFixture();
    clearProbeCache();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture?.restore();
  });

  const ENDPOINTS = [
    '/api/v1/health',
    '/api/v1/overview',
    '/api/v1/targets',
    '/api/v1/combos',
    '/api/v1/doctor',
    '/api/v1/settings',
  ];

  const FORBIDDEN_SAMPLE_TOKENS = [
    'claude-3-5-sonnet',
    'gpt-4o-mini',
    'Primary reasoning',
    '#a41f',
    'a41f',
    'opencode',
  ];

  const VIETNAMESE_ACCENTED_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const FORBIDDEN_KEYS = ['breakerState', 'actualVsDesired', 'isFreeOnly', 'timeAgo', 'activeProviders'];

  function findForbiddenKeys(obj: unknown, path = ''): string[] {
    const found: string[] = [];
    if (!obj || typeof obj !== 'object') return found;
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        found.push(...findForbiddenKeys(item, `${path}[${idx}]`));
      });
      return found;
    }
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.includes(key)) {
        found.push(currentPath);
      }
      found.push(...findForbiddenKeys(val, currentPath));
    }
    return found;
  }

  function findFreeFormEnglishSentences(obj: unknown, path = ''): Array<{ path: string; val: string }> {
    const found: Array<{ path: string; val: string }> = [];
    if (!obj || typeof obj !== 'object') return found;
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        found.push(...findFreeFormEnglishSentences(item, `${path}[${idx}]`));
      });
      return found;
    }
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${key}` : key;
      if (typeof val === 'string') {
        // Skip keys that are URLs, timestamps, reasons, or single tokens
        if (key === 'url' || key === 'generatedAt' || key === 'lastChecked' || key === 'id' || key === 'name' || key === 'strategy' || key === 'modelId') {
          continue;
        }
        // Free-form sentence heuristic: has >= 3 space-separated words with letters
        const words = val.trim().split(/\s+/);
        if (words.length >= 3 && /[a-zA-Z]{3,}/.test(val)) {
          found.push({ path: currentPath, val });
        }
      } else {
        found.push(...findFreeFormEnglishSentences(val, currentPath));
      }
    }
    return found;
  }

  for (const ep of ENDPOINTS) {
    it(`asserts no forbidden sample tokens appear in ${ep} response`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${ep}`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const rawText = await res.text();
      for (const token of FORBIDDEN_SAMPLE_TOKENS) {
        expect(
          rawText.toLowerCase().includes(token.toLowerCase()),
          `Endpoint ${ep} contained forbidden sample token: "${token}"`
        ).toBe(false);
      }
    });

    it(`asserts no Vietnamese accented characters in ${ep} response (D1)`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${ep}`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);
      const rawText = await res.text();
      expect(
        VIETNAMESE_ACCENTED_REGEX.test(rawText),
        `Endpoint ${ep} contained Vietnamese accented text violating D1: "${rawText.slice(0, 100)}..."`
      ).toBe(false);
    });

    it(`asserts no forbidden constant/synthetic keys in ${ep} response`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${ep}`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      const forbiddenFound = findForbiddenKeys(data);
      expect(
        forbiddenFound,
        `Endpoint ${ep} contained forbidden keys: ${forbiddenFound.join(', ')}`
      ).toHaveLength(0);
    });

    it(`asserts no free-form English sentences in ${ep} data fields`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${ep}`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      const sentences = findFreeFormEnglishSentences(data);
      expect(
        sentences,
        `Endpoint ${ep} contained free-form English sentences: ${JSON.stringify(sentences)}`
      ).toHaveLength(0);
    });
  }

  it('asserts uptime is dynamic and increments between requests spaced >= 1.1s (timeout: 15s)', async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const health1 = (await res1.json()) as { uptime: number };
    expect(typeof health1.uptime).toBe('number');

    // Wait 1200ms
    await new Promise((r) => setTimeout(r, 1200));

    const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const health2 = (await res2.json()) as { uptime: number };
    expect(health2.uptime).toBeGreaterThanOrEqual(health1.uptime + 1);
  }, 15000);

  it('asserts health.version matches packages/daemon/package.json dynamically (R12-3b)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const health = (await res.json()) as { version: string };
    const daemonPkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'packages/daemon/package.json'), 'utf8')
    ) as { version: string };
    expect(health.version).toBe(daemonPkg.version);
  });

  it('omits health.version when package.json reading fails (zero hardcoded fallback) (R13-2)', () => {
    resetDaemonVersionCache();
    const ver = getDaemonVersion(path.resolve(process.cwd(), 'non-existent-package.json'));
    expect(ver).toBeUndefined();
  });

  describe('GET /api/v1/doctor honest state classification', () => {
    it('returns pass/fail for c1..c6 and not_checked (needs_p3a) for c7..c9', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/doctor`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const report = (await res.json()) as {
        meta: { source: string };
        overallStatus: 'healthy' | 'warning' | 'error';
        conditions: Array<{
          id: string;
          condKey: string;
          state: 'pass' | 'fail' | 'not_checked';
          reason?: string;
          code?: string;
          params?: Record<string, string | number>;
          resultText?: string;
        }>;
      };

      expect(report.conditions).toHaveLength(9);

      // c1..c6: must be 'pass' or 'fail', NEVER undefined, NEVER 'warn'
      // R14-4.1 exception: c5 may also be 'not_checked' when the snapshot
      // directory does not exist yet (daemon S1 is zero-write, so it never
      // creates that directory on a machine that never applied a plan).
      const checkedConditions = report.conditions.filter((c) =>
        ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].includes(c.id)
      );
      expect(checkedConditions).toHaveLength(6);
      for (const cond of checkedConditions) {
        const allowedStates =
          cond.id === 'c5' ? ['pass', 'fail', 'not_checked'] : ['pass', 'fail'];
        expect(allowedStates).toContain(cond.state);
        expect(cond.code).toBeDefined();
        expect(typeof cond.code).toBe('string');
        expect(cond.resultText).toBeUndefined();
      }

      // c5 with 'not_checked' must carry a machine-readable reason
      const c5 = report.conditions.find((c) => c.id === 'c5');
      if (c5?.state === 'not_checked') {
        expect(c5.reason).toBeDefined();
      }

      // c7..c9: must be 'not_checked' with reason 'needs_p3a'
      const p3aConditions = report.conditions.filter((c) =>
        ['c7', 'c8', 'c9'].includes(c.id)
      );
      expect(p3aConditions).toHaveLength(3);
      for (const cond of p3aConditions) {
        expect(cond.state).toBe('not_checked');
        expect(cond.reason).toBe('needs_p3a');
      }
    });
  });

  describe('GET /api/v1/combos zero-mock guarantee', () => {
    it('returns empty array or real records without injecting sample combos', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/combos`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      // R18-1: the route answers the collection envelope on every 200, so the
      // "zero mocked data" check reads the list out of `combos`.
      const body = (await res.json()) as { meta?: { source?: string }; combos?: any[] };
      expect(body.meta?.source).toBeDefined();
      expect(Array.isArray(body.combos)).toBe(true);
      const combos = body.combos as any[];

      // If any combos returned, verify none contain mock models
      for (const combo of combos) {
        for (const step of combo.steps || []) {
          expect(step.modelId).not.toBe('claude-3-5-sonnet');
          expect(step.modelId).not.toBe('gpt-4o-mini');
        }
      }
    });
  });

  describe('GET /api/v1/settings unmeasured fields omission', () => {
    it('omits unmeasured scanSchedule, maxDailyRequests, and mcpClients', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/settings`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const settings = (await res.json()) as any;
      expect(settings.meta).toBeDefined();
      expect(settings.policyMode).toBeDefined();
      expect(settings.scanSchedule).toBeUndefined();
      expect(settings.maxDailyRequests).toBeUndefined();
      expect(settings.mcpClients).toBeUndefined();
    });
  });

  describe('R11-0: fixture-metric asserts (test would go RED if real router data leaked in)', () => {
    it('returns exactly the fixture combo set from /api/v1/combos (combos.length === 1)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/combos`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      // R18-1: the list travels under `combos` inside the envelope.
      const body = (await res.json()) as {
        combos: Array<{ id: string; steps: Array<{ modelId: string }> }>;
      };
      const combos = body.combos;
      // Fixture: 1 combo `routersync-fast` on BOTH routers (same id -> deduped to 1).
      // If the daemon read real router DBs, this count would be far from 1 (r10-at123-red).
      expect(combos.length).toBe(1);
      expect(combos[0]?.id).toBe('routersync-fast');
      expect(combos[0]?.steps.map((s) => s.modelId)).toEqual(['m1']);
    });

    it('returns exactly the fixture model count from /api/v1/overview (trackedModels.count === 1)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const overview = (await res.json()) as { trackedModels: { count: number } };
      // Fixture contains exactly one model id (`m1`).
      expect(overview.trackedModels.count).toBe(1);
    });

    it('reports fixture combo counts per router in /api/v1/targets (db.combosManaged === 1)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const targets = (await res.json()) as Array<{
        id: string;
        db?: { combosManaged: number };
      }>;
      const omni = targets.find((t) => t.id === 'omniroute');
      const nine = targets.find((t) => t.id === '9router');
      expect(omni?.db?.combosManaged).toBe(1);
      expect(nine?.db?.combosManaged).toBe(1);
    });
  });
});
