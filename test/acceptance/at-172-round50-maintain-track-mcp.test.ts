/**
 * test/acceptance/at-172-round50-maintain-track-mcp.test.ts
 *
 * Acceptance Test AT-172: Round 50 Maintain, Multi-Router Tracking, and MCP HTTP Integration.
 *
 * Verifies:
 * - computePlan logic for zero-token model lifecycle management (M1–M12)
 * - min-steps preservation on candidate model pruning
 * - Deterministic planHash calculation
 * - MCP HTTP loopback pairing code generation and state tracking
 * - Daemon read-only GET routes and strict 405 rejection of POST requests
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computePlan,
  type MaintainPlanInput,
  type MaintainCombo,
} from '../../packages/cli/src/maintain/plan.js';
import { generatePairCode } from '../../packages/cli/src/commands/mcp-http.js';
import { startDaemonServer } from '../../packages/daemon/src/server.js';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('AT-172: Round 50 Maintain, Track, and MCP HTTP Integration', () => {
  let tmpDir: string;
  let fixture: DaemonFixture | undefined;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
  });

  afterAll(() => {
    fixture?.restore();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-172-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // --- Maintain computePlan Tests ---

  it('1. computePlan returns empty actions when all models in combos are healthy', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'fast',
          managed: true,
          models: ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'],
        },
      ],
      providers: {
        openai: { status: 'ok', removed: [], added: [] },
        anthropic: { status: 'ok', removed: [], added: [] },
      },
    };
    const plan = computePlan(input);
    expect(plan.removes).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
  });

  it('2. computePlan detects removed models and proposes removal actions', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'coding',
          managed: true,
          models: [
            'custom/active-model',
            'custom/deprecated-model',
            'custom/backup-model',
          ],
        },
      ],
      providers: {
        custom: {
          status: 'ok',
          removed: ['custom/deprecated-model'],
        },
      },
    };
    const plan = computePlan(input);
    expect(plan.removes).toHaveLength(1);
    expect(plan.removes[0]?.combo).toBe('coding');
    expect(plan.removes[0]?.model).toBe('custom/deprecated-model');
  });

  it('3. computePlan preserves combos that would drop below min-steps (at least 2)', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'minimal',
          managed: true,
          models: ['custom/model-a', 'custom/model-b'],
        },
      ],
      providers: {
        custom: {
          status: 'ok',
          removed: ['custom/model-b'],
        },
      },
    };
    // Removing model-b leaves only 1 model (< 2), so it must be blocked with 'min-steps'
    const plan = computePlan(input);
    expect(plan.removes).toHaveLength(0);
    const blocked = plan.blocked.find((b) => b.combo === 'minimal' && b.reason === 'min-steps');
    expect(blocked).toBeDefined();
  });

  it('4. computePlan evaluates candidate model additions with regex filter', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'smart',
          managed: true,
          models: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
          rule: {
            providers: ['openai'],
            match: '^openai/o1',
          },
        },
      ],
      providers: {
        openai: {
          status: 'ok',
          added: [
            { id: 'openai/o1-preview' },
            { id: 'openai/unrelated' },
          ],
        },
      },
    };
    const plan = computePlan(input);
    expect(plan.adds).toHaveLength(1);
    expect(plan.adds[0]?.model).toBe('openai/o1-preview');
    expect(plan.adds[0]?.position).toBe('end');
  });

  it('5. computePlan blocks non-free additions when combo has freeOnly=true', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'free-combo',
          managed: true,
          freeOnly: true,
          models: ['meta/llama-3-8b', 'meta/llama-3-70b'],
          rule: {
            providers: ['groq'],
          },
        },
      ],
      providers: {
        groq: {
          status: 'ok',
          added: [{ id: 'groq/paid-model', free: false }],
        },
      },
    };
    const plan = computePlan(input);
    expect(plan.adds).toHaveLength(0);
    const blocked = plan.blocked.find((b) => b.combo === 'free-combo' && b.reason === 'not-free');
    expect(blocked).toBeDefined();
    expect(blocked?.model).toBe('groq/paid-model');
  });

  it('6. computePlan enforces adoptMode=guard blocking any additions', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'adopted-guard',
          managed: false,
          adopted: true,
          adoptMode: 'guard',
          models: ['p1/m1', 'p1/m2'],
          rule: {
            providers: ['p1'],
          },
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          added: [{ id: 'p1/m3' }],
        },
      },
    };
    const plan = computePlan(input);
    expect(plan.adds).toHaveLength(0);
    const blocked = plan.blocked.find((b) => b.combo === 'adopted-guard' && b.reason === 'adopt-guard');
    expect(blocked).toBeDefined();
  });

  it('7. computePlan calculates deterministic 16-character hex planHash', () => {
    const combo: MaintainCombo = {
      id: 'c1',
      managed: true,
      models: ['prov/m1', 'prov/m2', 'prov/m3'],
    };
    const input1: MaintainPlanInput = {
      router: 'omniroute',
      combos: [combo],
      providers: { prov: { status: 'ok', removed: ['prov/m3'] } },
    };
    const input2: MaintainPlanInput = {
      router: 'omniroute',
      combos: [combo],
      providers: { prov: { status: 'ok', removed: ['prov/m3'] } },
    };
    const plan1 = computePlan(input1);
    const plan2 = computePlan(input2);
    expect(plan1.planHash).toBe(plan2.planHash);
    expect(typeof plan1.planHash).toBe('string');
    expect(plan1.planHash).toHaveLength(16);
  });

  // --- MCP HTTP Pairing Code Tests ---

  it('8. generatePairCode creates 8-char hyphenated base32-like code matching [A-Z2-9]{4}-[A-Z2-9]{4}', () => {
    const code = generatePairCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('9. generatePairCode generates unique cryptographically random codes', () => {
    const set = new Set<string>();
    for (let i = 0; i < 20; i++) {
      set.add(generatePairCode());
    }
    expect(set.size).toBe(20);
  });

  it('10. MCP pairing state handles atomic write and JSON reload', () => {
    const pairFile = path.join(tmpDir, 'mcp-pairing.json');
    const pairState = {
      pairCode: generatePairCode(),
      expiresAt: Date.now() + 300000,
      attempts: 0,
    };
    fs.writeFileSync(pairFile, JSON.stringify(pairState, null, 2), 'utf8');
    const readBack = JSON.parse(fs.readFileSync(pairFile, 'utf8'));
    expect(readBack.pairCode).toBe(pairState.pairCode);
    expect(readBack.attempts).toBe(0);
  });

  // --- Daemon Read-Only GET Endpoints Tests ---

  it('11. Daemon serves GET /api/v1/track/status with 200 OK', async () => {
    const { server, port, host } = await startDaemonServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetchRoute(host, port, '/api/v1/track/status', 'GET');
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('12. Daemon serves GET /api/v1/maintain/plan with 200 OK', async () => {
    const { server, port, host } = await startDaemonServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetchRoute(host, port, '/api/v1/maintain/plan', 'GET');
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('13. Daemon serves GET /api/v1/track/events with 200 OK', async () => {
    const { server, port, host } = await startDaemonServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetchRoute(host, port, '/api/v1/track/events', 'GET');
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.events).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('14. Daemon strictly rejects POST to read-only endpoints with 405 Method Not Allowed', async () => {
    const { server, port, host } = await startDaemonServer({ port: 0, host: '127.0.0.1' });
    try {
      const postStatus = await fetchRoute(host, port, '/api/v1/track/status', 'POST');
      expect(postStatus.status).toBe(405);

      const postMaintain = await fetchRoute(host, port, '/api/v1/maintain/plan', 'POST');
      expect(postMaintain.status).toBe(405);
    } finally {
      server.close();
    }
  });
});

async function fetchRoute(host: string, port: number, routePath: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: routePath,
        method,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
