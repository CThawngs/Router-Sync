/**
 * packages/mcp-server/test/apply-plan.test.ts
 *
 * C45-WP4 Red-First MCP `apply_plan` Suite (Phục vụ: S3, S4, S9):
 *  - 3-tier MCP tool split (25 read-only + 1 ledger-append + 1 controlled-write = 27)
 *  - 8-gate fail-closed pipeline (freeze, planHash recomputation, consent/token,
 *    sandbox tmpdir guard, I1..I8 invariants, backup/atomic-write/read-back/I4/auto-rollback,
 *    HMAC apply-history receipt, inbox + webhook notifications)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  openBetterSqlite3,
  upsertStandingConsentTarget,
  activateFreeze,
  readApplyHistory,
  assertEligibleForAutoSafe,
  ConsentValidationError,
} from '@routersync/core';
import { createApprovalToken, resetTokenRegistry } from '@routersync/daemon';
import {
  createRouterSyncMcpServer,
  READ_ONLY_TOOL_NAMES,
  LEDGER_APPEND_TOOL_NAMES,
  CONTROLLED_WRITE_TOOL_NAMES,
  ALL_MCP_TOOL_NAMES,
} from '../src/index.js';

const ORIGINAL_ENV = { ...process.env };

function computeTickPlanHash(plan: {
  routerActions: Array<{
    router: string;
    comboName: string;
    provider: string;
    modelId: string;
    action: string;
  }>;
  harnessActions: Array<{
    harnessId: string;
    providerId: string;
    modelId: string;
    action: string;
  }>;
}): string {
  const payload = JSON.stringify({
    routerActions: plan.routerActions.map((a) => ({
      router: a.router,
      comboName: a.comboName,
      provider: a.provider,
      modelId: a.modelId,
      action: a.action,
    })),
    harnessActions: plan.harnessActions.map((a) => ({
      harnessId: a.harnessId,
      providerId: a.providerId,
      modelId: a.modelId,
      action: a.action,
    })),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

describe('C45-WP4 Controlled MCP `apply_plan` Tool', () => {
  let tmpRoot: string;
  let stateDir: string;
  let configDir: string;
  let plansDir: string;
  let nineDbPath: string;
  let opencodePath: string;
  let configPath: string;
  let webhookServer: http.Server | null = null;
  let webhookPayloads: Array<Record<string, unknown>> = [];

  function seedNineRouterSandboxDb(
    dbFile: string,
    combos: Array<{ id: string; name: string; models: string[]; freeOnly?: boolean }>
  ): void {
    const db = openBetterSqlite3(dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      DELETE FROM combos;
      DELETE FROM settings;
      INSERT INTO settings (id, data) VALUES (1, '{}');
    `);
    const now = '2026-11-24T00:00:00.000Z';
    const stmt = db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const c of combos) {
      stmt.run(c.id, c.name, c.freeOnly ? 'free' : null, JSON.stringify(c.models), now, now);
    }
    db.close();
  }

  function readNineComboModels(dbFile: string, comboName: string): string[] {
    const db = openBetterSqlite3(dbFile, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get(comboName, comboName) as { models: string } | undefined;
      return row ? (JSON.parse(row.models) as string[]) : [];
    } finally {
      db.close();
    }
  }

  async function connectClient(): Promise<{
    call: (
      name: string,
      args?: Record<string, unknown>
    ) => Promise<{ isError: boolean; body: Record<string, any> }>;
    close: () => Promise<void>;
  }> {
    const server = createRouterSyncMcpServer({ configPath });
    const client = new Client({ name: 'wp4-apply-plan-test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return {
      async call(name, args = {}) {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
        return {
          isError: Boolean(res.isError),
          body: JSON.parse(text) as Record<string, any>,
        };
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp4-mcp-'));
    stateDir = path.join(tmpRoot, 'state');
    configDir = path.join(tmpRoot, 'home', 'config');
    plansDir = path.join(stateDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    nineDbPath = path.join(tmpRoot, 'nine-sandbox.sqlite');
    seedNineRouterSandboxDb(nineDbPath, [
      {
        id: 'coding-main',
        name: 'coding-main',
        models: ['openai/gpt-4o-old', 'openai/gpt-4.1', 'anthropic/claude-sonnet-4'],
      },
    ]);

    opencodePath = path.join(tmpRoot, 'opencode.jsonc');
    fs.writeFileSync(
      opencodePath,
      [
        '{',
        '  // Preserve user header comment byte-for-byte',
        '  "model": "openai/gpt-4.1",',
        '  "provider": {',
        '    "openai": {',
        '      "options": {',
        `        "apiKey": "${['sk', 'sandboxtestkey123456'].join('-')}",`,
        '        "baseURL": "https://api.openai.com/v1"',
        '      },',
        '      "models": {',
        '        "gpt-4o-old": { "name": "GPT-4o Old" },',
        '        "gpt-4.1": { "name": "GPT-4.1" }',
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    webhookPayloads = [];
    webhookServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        try {
          webhookPayloads.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // ignore
        }
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => webhookServer!.listen(0, '127.0.0.1', () => resolve()));
    const whPort = (webhookServer.address() as AddressInfo).port;

    configPath = path.join(configDir, 'routersync.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    db:',
        `      path: ${nineDbPath}`,
        'combos:',
        '  - id: coding-main',
        '    name: coding-main',
        '    freeOnly: false',
        '    minSteps: 2',
        '    models:',
        '      - openai/gpt-4.1',
        '      - anthropic/claude-sonnet-4',
        'webhook:',
        '  enabled: true',
        `  url: http://127.0.0.1:${whPort}/hook`,
        '',
      ].join('\n'),
      'utf8'
    );

    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = path.join(tmpRoot, 'home');
    process.env['LOCALAPPDATA'] = path.join(tmpRoot, 'local');
    resetTokenRegistry();
  });

  afterEach(async () => {
    resetTokenRegistry();
    if (webhookServer) {
      await new Promise<void>((resolve) => webhookServer!.close(() => resolve()));
      webhookServer = null;
    }
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeTickPlan(custom?: {
    routerActions?: Array<Record<string, unknown>>;
    harnessActions?: Array<Record<string, unknown>>;
    overrideHash?: string;
  }): { planPath: string; planHash: string } {
    const now = '2026-11-24T12:00:00.000Z';
    const routerActions =
      custom?.routerActions ??
      [
        {
          targetType: 'router',
          router: '9router',
          comboName: 'coding-main',
          provider: 'openai',
          modelId: 'gpt-4o-old',
          fullStep: 'openai/gpt-4o-old',
          action: 'REMOVE_MODEL',
          reason: 'OFFICIAL_DEPRECATION',
          sourcePublishedAt: now,
          sourceFirstChangedAt: now,
          planCreatedAt: now,
          detectionLatencyMs: 0,
        },
        {
          targetType: 'router',
          router: '9router',
          comboName: 'coding-main',
          provider: 'openai',
          modelId: 'gpt-5-mini',
          fullStep: 'openai/gpt-5-mini',
          action: 'ADD_MODEL',
          reason: 'Discovered in L1 scan',
          sourcePublishedAt: now,
          sourceFirstChangedAt: now,
          planCreatedAt: now,
          detectionLatencyMs: 0,
        },
      ];
    const harnessActions =
      custom?.harnessActions ??
      [
        {
          targetType: 'harness',
          harnessId: 'opencode',
          configPath: opencodePath,
          providerId: 'openai',
          modelId: 'gpt-4o-old',
          action: 'REMOVE_MODEL',
          reason: 'OFFICIAL_DEPRECATION',
          sourcePublishedAt: now,
          sourceFirstChangedAt: now,
          planCreatedAt: now,
          detectionLatencyMs: 0,
        },
        {
          targetType: 'harness',
          harnessId: 'opencode',
          configPath: opencodePath,
          providerId: 'openai',
          modelId: 'gpt-5-mini',
          action: 'ADD_MODEL',
          reason: 'Discovered in L1 scan',
          sourcePublishedAt: now,
          sourceFirstChangedAt: now,
          planCreatedAt: now,
          detectionLatencyMs: 0,
        },
      ];
    const computed = computeTickPlanHash({
      routerActions: routerActions as any,
      harnessActions: harnessActions as any,
    });
    const planHash = custom?.overrideHash ?? computed;
    const planPath = path.join(plansDir, 'tick-plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          version: 1,
          mode: 'propose',
          planCreatedAt: now,
          planHash,
          accounting: { requests: 2, paidRequests: 0, tokens: 0, llmCalls: 0 },
          routerActions,
          harnessActions,
          blockedRemovals: [],
          detectionLatency: { measuredCount: 4, minMs: 0, maxMs: 0, p50Ms: 0 },
        },
        null,
        2
      ),
      'utf8'
    );
    return { planPath, planHash };
  }

  it('exports exact 3-tier tool split (25 + 1 + 1 = 27) with zero delete/approve/grant tools', () => {
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(25);
    expect(LEDGER_APPEND_TOOL_NAMES).toEqual(['submit_research']);
    expect(CONTROLLED_WRITE_TOOL_NAMES).toEqual(['apply_plan']);
    expect(ALL_MCP_TOOL_NAMES).toHaveLength(27);

    for (const name of ALL_MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/delete|approve|grant/i);
    }
  });

  it('rejects apply_plan without consent/token, on planHash mismatch or tampered plan actions (M3), on freeze (M2), on off target, and on expired/tampered consent (M4)', async () => {
    const { planPath, planHash } = writeTickPlan();
    const mcp = await connectClient();
    try {
      // (a) No consent and no token -> UNAUTHORIZED_TARGET, zero mutations
      const unauth = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
      });
      expect(unauth.isError).toBe(true);
      expect(unauth.body['errorCode']).toBe('UNAUTHORIZED_TARGET');
      expect(readNineComboModels(nineDbPath, 'coding-main')).toEqual([
        'openai/gpt-4o-old',
        'openai/gpt-4.1',
        'anthropic/claude-sonnet-4',
      ]);

      // Grant propose consent
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'propose',
      });

      // (b1) Wrong planHash argument -> PLAN_HASH_MISMATCH (kills M3)
      const badArgHash = await mcp.call('apply_plan', {
        planHash: 'deadbeefdeadbeef',
        targets: ['router:nine/coding-main'],
      });
      expect(badArgHash.isError).toBe(true);
      expect(badArgHash.body['errorCode']).toBe('PLAN_HASH_MISMATCH');

      // (b2) Tamper actions inside tick-plan.json while keeping old planHash field -> PLAN_HASH_MISMATCH (kills M3)
      const origPlanRaw = fs.readFileSync(planPath, 'utf8');
      const tamperedPlan = JSON.parse(origPlanRaw) as Record<string, any>;
      tamperedPlan['routerActions'][1]['modelId'] = 'gpt-99-injected';
      fs.writeFileSync(planPath, JSON.stringify(tamperedPlan, null, 2), 'utf8');
      const tamperedHashRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
      });
      expect(tamperedHashRes.isError).toBe(true);
      expect(tamperedHashRes.body['errorCode']).toBe('PLAN_HASH_MISMATCH');
      fs.writeFileSync(planPath, origPlanRaw, 'utf8');

      // (c) Freeze blocks apply_plan EVEN WITH valid consent AND valid daemon approvalToken (kills M2)
      activateFreeze(stateDir, 'security-drill');
      const tokDuringFreeze = createApprovalToken(planHash);
      const frozenRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
        approvalToken: tokDuringFreeze.token,
      });
      expect(frozenRes.isError).toBe(true);
      expect(frozenRes.body['errorCode']).toBe('WRITE_FROZEN');
      fs.unlinkSync(path.join(stateDir, 'freeze.json'));

      // (d) Explicit level === 'off' blocks BOTH standing consent and approvalToken
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'off',
      });
      const offRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
        approvalToken: tokDuringFreeze.token,
      });
      expect(offRes.isError).toBe(true);
      expect(offRes.body['errorCode']).toBe('TARGET_CONSENT_OFF');

      // (e) Tampered standing-consent.json HMAC rejected (kills M4)
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'propose',
      });
      const consentFile = path.join(stateDir, 'standing-consent.json');
      const parsedConsent = JSON.parse(fs.readFileSync(consentFile, 'utf8')) as Record<string, any>;
      parsedConsent['targets'][0]['expiresAt'] = '2099-01-01T00:00:00.000Z';
      fs.writeFileSync(consentFile, JSON.stringify(parsedConsent, null, 2), 'utf8');

      const hmacBadRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
      });
      expect(hmacBadRes.isError).toBe(true);
      expect(hmacBadRes.body['errorCode']).toBe('CONSENT_HMAC_INVALID');
    } finally {
      await mcp.close();
    }
  });

  it('rejects invariant violations I3 (< 2 models) and I6 (paid model in freeOnly combo) with zero writes (M6)', async () => {
    // Seed combo with only 2 models; plan tries to remove 1 leaving 1 (< minSteps 2 -> I3 violation!)
    seedNineRouterSandboxDb(nineDbPath, [
      {
        id: 'coding-main',
        name: 'coding-main',
        models: ['openai/gpt-4o-old', 'openai/gpt-4.1'],
      },
    ]);
    const { planHash: i3Hash } = writeTickPlan({
      routerActions: [
        {
          targetType: 'router',
          router: '9router',
          comboName: 'coding-main',
          provider: 'openai',
          modelId: 'gpt-4o-old',
          fullStep: 'openai/gpt-4o-old',
          action: 'REMOVE_MODEL',
          reason: 'OFFICIAL_DEPRECATION',
          sourcePublishedAt: null,
          sourceFirstChangedAt: null,
          planCreatedAt: '2026-11-24T12:00:00.000Z',
          detectionLatencyMs: null,
        },
      ],
      harnessActions: [],
    });

    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-main',
      level: 'propose',
    });

    const mcp = await connectClient();
    try {
      const i3Res = await mcp.call('apply_plan', {
        planHash: i3Hash,
        targets: ['router:nine/coding-main'],
      });
      expect(i3Res.isError).toBe(true);
      expect(i3Res.body['errorCode']).toBe('INVARIANT_VIOLATION');
      expect(JSON.stringify(i3Res.body)).toContain('I3');
      expect(readNineComboModels(nineDbPath, 'coding-main')).toEqual([
        'openai/gpt-4o-old',
        'openai/gpt-4.1',
      ]);

      // Now configure coding-main as freeOnly: true and attempt adding a confirmed paid model -> I6 violation!
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, 'utf8').replace('freeOnly: false', 'freeOnly: true'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'l2-cache.json'),
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-24T12:00:00.000Z',
          models: {
            'openai/gpt-4o-old': { price: 0, source: 'both' },
            'openai/gpt-4.1': { price: 0, source: 'both' },
            'openai/gpt-5-pro-paid': { price: 15, source: 'both' },
          },
        }),
        'utf8'
      );
      const { planHash: i6Hash } = writeTickPlan({
        routerActions: [
          {
            targetType: 'router',
            router: '9router',
            comboName: 'coding-main',
            provider: 'openai',
            modelId: 'gpt-5-pro-paid',
            fullStep: 'openai/gpt-5-pro-paid',
            action: 'ADD_MODEL',
            reason: 'Discovered in L1 scan',
            sourcePublishedAt: null,
            sourceFirstChangedAt: null,
            planCreatedAt: '2026-11-24T12:00:00.000Z',
            detectionLatencyMs: null,
          },
        ],
        harnessActions: [],
      });

      const mcpFree = await connectClient();
      try {
        const i6Res = await mcpFree.call('apply_plan', {
          planHash: i6Hash,
          targets: ['router:nine/coding-main'],
        });
        expect(i6Res.isError).toBe(true);
        expect(i6Res.body['errorCode']).toBe('INVARIANT_VIOLATION');
        expect(JSON.stringify(i6Res.body)).toContain('I6');
      } finally {
        await mcpFree.close();
      }
    } finally {
      await mcp.close();
    }
  });

  it('applies router + lossless harness plan via standing consent OR single-use daemon approvalToken, verifies read-back + I4, writes apply-history + inbox + sanitized webhook', async () => {
    const { planHash } = writeTickPlan();

    // Use daemon-issued persistent approvalToken for router + harness targets without standing consent!
    const daemonToken = createApprovalToken(planHash);

    const mcp = await connectClient();
    try {
      const okRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main', 'harness:opencode'],
        approvalToken: daemonToken.token,
      });
      expect(okRes.isError).toBe(false);
      expect(okRes.body['applied']).toBe(true);

      // Router DB updated & verified
      expect(readNineComboModels(nineDbPath, 'coding-main')).toEqual([
        'openai/gpt-4.1',
        'anthropic/claude-sonnet-4',
        'openai/gpt-5-mini',
      ]);

      // OpenCode JSONC updated losslessly (preserving // comment, default model, apiKey, baseURL)
      const postOpencode = fs.readFileSync(opencodePath, 'utf8');
      expect(postOpencode).toContain('// Preserve user header comment byte-for-byte');
      expect(postOpencode).toContain('"model": "openai/gpt-4.1"');
      expect(postOpencode).toContain('"gpt-5-mini"');
      expect(postOpencode).not.toContain('"gpt-4o-old"');
      expect(fs.existsSync(`${opencodePath}.routersync.bak`)).toBe(true);

      // Replay of same approvalToken MUST fail with INVALID_APPROVAL_TOKEN (token_already_consumed)
      const replayRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
        approvalToken: daemonToken.token,
      });
      expect(replayRes.isError).toBe(true);
      expect(replayRes.body['errorCode']).toBe('INVALID_APPROVAL_TOKEN');
      expect(replayRes.body['reason']).toBe('token_already_consumed');

      // Apply history recorded 2 verified propose receipts -> both targets are now eligible for auto-safe!
      const hist = readApplyHistory(stateDir);
      expect(hist.valid).toBe(true);
      expect(hist.receipts).toHaveLength(2);
      expect(assertEligibleForAutoSafe(stateDir, 'router:nine/coding-main').readBackVerified).toBe(true);
      expect(assertEligibleForAutoSafe(stateDir, 'harness:opencode').readBackVerified).toBe(true);

      // Inbox & webhook notified with zero secrets/user paths
      const inboxRaw = fs.readFileSync(path.join(stateDir, 'inbox.json'), 'utf8');
      expect(inboxRaw).toContain('[PLAN-APPLIED]');
      expect(inboxRaw).not.toContain(['sk', 'sandboxtestkey123456'].join('-'));

      expect(webhookPayloads.length).toBeGreaterThanOrEqual(1);
      const rawWebhook = JSON.stringify(webhookPayloads);
      expect(rawWebhook).toContain('mcp.apply_plan');
      expect(rawWebhook).not.toContain(['sk', 'sandboxtestkey123456'].join('-'));
    } finally {
      await mcp.close();
    }
  });

  it('automatically rolls back BOTH router SQLite DB and harness config byte-for-byte on post-write read-back fault (M5) and denies auto-safe eligibility', async () => {
    const preOpencodeBytes = fs.readFileSync(opencodePath);
    const { planHash } = writeTickPlan();

    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-main',
      level: 'propose',
    });
    upsertStandingConsentTarget(stateDir, {
      target: 'harness:opencode',
      level: 'propose',
    });

    const mcp = await connectClient();
    try {
      const faultRes = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main', 'harness:opencode'],
        injectReadBackFault: true,
      });
      expect(faultRes.isError).toBe(true);
      expect(faultRes.body['rolledBack']).toBe(true);

      // Router DB restored to exact pre-apply models
      expect(readNineComboModels(nineDbPath, 'coding-main')).toEqual([
        'openai/gpt-4o-old',
        'openai/gpt-4.1',
        'anthropic/claude-sonnet-4',
      ]);

      // Harness config restored byte-for-byte
      expect(Buffer.compare(fs.readFileSync(opencodePath), preOpencodeBytes)).toBe(0);

      // Rolled-back apply MUST NOT unlock auto-safe promotion!
      expect(() =>
        assertEligibleForAutoSafe(stateDir, 'router:nine/coding-main')
      ).toThrowError(ConsentValidationError);
      expect(() =>
        assertEligibleForAutoSafe(stateDir, 'harness:opencode')
      ).toThrowError(ConsentValidationError);
    } finally {
      await mcp.close();
    }
  });
});
