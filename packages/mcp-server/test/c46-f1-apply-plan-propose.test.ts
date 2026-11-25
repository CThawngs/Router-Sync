/**
 * packages/mcp-server/test/c46-f1-apply-plan-propose.test.ts
 *
 * Ticket C46-F1 Red-First MCP `apply_plan` Suite (Ph?c v?: S3, S4, S9):
 * Enforces single-use `approvalToken` when target consent level is `propose`
 * (`APPROVAL_TOKEN_REQUIRED`), permits tokenless execution ONLY for verified `auto-safe`,
 * and rejects forged `standing-consent` receipts in `auto-safe` re-verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  openBetterSqlite3,
  appendApplyReceipt,
  canonicalJsonStringify,
  computeHmacSha256Hex,
  ensureConsentSigningKey,
  readApplyHistory,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { createApprovalToken, resetTokenRegistry } from '@routersync/daemon';
import { createRouterSyncMcpServer } from '../src/index.js';
import { computeCanonicalTickPlanHash } from '../src/apply-plan.js';

const ORIGINAL_ENV = { ...process.env };

describe('C46-F1 MCP apply_plan Propose Token Gate & Auto-Safe Verification', () => {
  let tmpRoot: string;
  let stateDir: string;
  let configDir: string;
  let plansDir: string;
  let nineDbPath: string;
  let opencodePath: string;
  let configPath: string;

  const INITIAL_ROUTER_MODELS = [
    'openai/gpt-4o-old',
    'openai/gpt-4.1',
    'anthropic/claude-sonnet-4',
  ];

  function seedNineRouterSandboxDb(models: string[] = INITIAL_ROUTER_MODELS): void {
    const db = openBetterSqlite3(nineDbPath);
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
    const now = '2026-11-25T00:00:00.000Z';
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('coding-main', 'coding-main', null, JSON.stringify(models), now, now);
    db.close();
  }

  function readNineComboModels(): string[] {
    const db = openBetterSqlite3(nineDbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get('coding-main', 'coding-main') as { models: string } | undefined;
      return row ? (JSON.parse(row.models) as string[]) : [];
    } finally {
      db.close();
    }
  }

  function seedOpencodeConfig(): string {
    const content = [
      '{',
      '  // Preserve user header comment byte-for-byte',
      '  "model": "openai/gpt-4.1",',
      '  "provider": {',
      '    "openai": {',
      '      "options": {',
      '        "apiKey": "dummy-openai-sandbox-key",',
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
    ].join('\n');
    fs.writeFileSync(opencodePath, content, 'utf8');
    return content;
  }

  function writeTickPlan(modelToAdd = 'gpt-5-mini'): { planPath: string; planHash: string } {
    const now = '2026-11-25T01:00:00.000Z';
    const routerActions = [
      {
        targetType: 'router',
        router: '9router',
        comboName: 'coding-main',
        provider: 'openai',
        modelId: modelToAdd,
        fullStep: `openai/${modelToAdd}`,
        action: 'ADD_MODEL',
        reason: 'Discovered in L1 scan',
        sourcePublishedAt: now,
        sourceFirstChangedAt: now,
        planCreatedAt: now,
        detectionLatencyMs: 0,
      },
    ];
    const harnessActions = [
      {
        targetType: 'harness',
        harnessId: 'opencode',
        configPath: opencodePath,
        providerId: 'openai',
        modelId: modelToAdd,
        action: 'ADD_MODEL',
        reason: 'Discovered in L1 scan',
        sourcePublishedAt: now,
        sourceFirstChangedAt: now,
        planCreatedAt: now,
        detectionLatencyMs: 0,
      },
    ];
    const planHash =
      computeCanonicalTickPlanHash({
        routerActions: routerActions as any,
        harnessActions: harnessActions as any,
      }) ?? '';
    const planPath = path.join(plansDir, 'tick-plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: now,
          mode: 'propose',
          planHash,
          routerActions,
          harnessActions,
        },
        null,
        2
      ),
      'utf8'
    );
    return { planPath, planHash };
  }

  async function connectClient(): Promise<{
    call: (
      name: string,
      args?: Record<string, unknown>
    ) => Promise<{ isError: boolean; body: Record<string, any> }>;
    close: () => Promise<void>;
  }> {
    const server = createRouterSyncMcpServer({ configPath });
    const client = new Client({ name: 'c46-f1-mcp-test', version: '1.0.0' });
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

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f1-mcp-'));
    stateDir = path.join(tmpRoot, 'state');
    configDir = path.join(tmpRoot, 'home', 'config');
    plansDir = path.join(stateDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    nineDbPath = path.join(tmpRoot, 'nine-sandbox.sqlite');
    seedNineRouterSandboxDb();

    opencodePath = path.join(tmpRoot, 'opencode.jsonc');
    seedOpencodeConfig();

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
        '',
      ].join('\n'),
      'utf8'
    );

    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = path.join(tmpRoot, 'home');
    process.env['LOCALAPPDATA'] = path.join(tmpRoot, 'local');
    process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] = '1';
    resetTokenRegistry();
  });

  afterEach(() => {
    resetTokenRegistry();
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('1. REJECTS apply_plan without approvalToken when target consent is propose (APPROVAL_TOKEN_REQUIRED, 0 DB/harness writes, 0 receipts ? kills M4)', async () => {
    const preOpencode = fs.readFileSync(opencodePath, 'utf8');
    const { planHash } = writeTickPlan('gpt-5-mini');

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
      const routerNoTok = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
      });
      expect(routerNoTok.isError).toBe(true);
      expect(routerNoTok.body['applied']).toBe(false);
      expect(routerNoTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');
      expect(routerNoTok.body['target']).toBe('router:nine/coding-main');
      expect(readNineComboModels()).toEqual(INITIAL_ROUTER_MODELS);
      expect(readApplyHistory(stateDir).receipts).toHaveLength(0);

      const harnessNoTok = await mcp.call('apply_plan', {
        planHash,
        targets: ['harness:opencode'],
      });
      expect(harnessNoTok.isError).toBe(true);
      expect(harnessNoTok.body['applied']).toBe(false);
      expect(harnessNoTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');
      expect(harnessNoTok.body['target']).toBe('harness:opencode');
      expect(fs.readFileSync(opencodePath, 'utf8')).toBe(preOpencode);
      expect(readApplyHistory(stateDir).receipts).toHaveLength(0);

      const blankTok = await mcp.call('apply_plan', {
        planHash,
        targets: ['router:nine/coding-main'],
        approvalToken: '   ',
      });
      expect(blankTok.isError).toBe(true);
      expect(blankTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');
    } finally {
      await mcp.close();
    }
  });

  it('2. SUCCEEDS at propose WITH single-use approvalToken (records approval-token + propose), STILL requires token before promotion, and SUCCEEDS WITHOUT token at auto-safe (records standing-consent + auto-safe)', async () => {
    const { planHash: hash1 } = writeTickPlan('gpt-5-mini');
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-main',
      level: 'propose',
    });
    upsertStandingConsentTarget(stateDir, {
      target: 'harness:opencode',
      level: 'propose',
    });

    const tok1 = createApprovalToken(hash1);
    const mcp = await connectClient();
    try {
      const proposeOk = await mcp.call('apply_plan', {
        planHash: hash1,
        targets: ['router:nine/coding-main', 'harness:opencode'],
        approvalToken: tok1.token,
      });
      expect(proposeOk.isError).toBe(false);
      expect(proposeOk.body['applied']).toBe(true);
      expect(
        (proposeOk.body['targets'] as Array<Record<string, unknown>>).every(
          (t) => t['appliedAtLevel'] === 'propose'
        )
      ).toBe(true);

      const histAfterPropose = readApplyHistory(stateDir);
      expect(histAfterPropose.receipts).toHaveLength(2);
      for (const r of histAfterPropose.receipts) {
        expect(r.authorizedVia).toBe('approval-token');
        expect(r.appliedAtLevel).toBe('propose');
      }

      // While targets are STILL at level: 'propose' (even with verified propose receipts!),
      // calling apply_plan without approvalToken MUST STILL fail with APPROVAL_TOKEN_REQUIRED! (kills M4)
      const { planHash: hash2 } = writeTickPlan('gpt-5-nano');
      const stillProposeNoTok = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main'],
      });
      expect(stillProposeNoTok.isError).toBe(true);
      expect(stillProposeNoTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');

      // Promote ONLY router:nine/coding-main to auto-safe; keep harness:opencode at propose.
      // Mixed batch without approvalToken must reject harness:opencode at Gate 3 with 0 writes!
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'auto-safe',
      });
      const mixedNoTok = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main', 'harness:opencode'],
      });
      expect(mixedNoTok.isError).toBe(true);
      expect(mixedNoTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');
      expect(mixedNoTok.body['target']).toBe('harness:opencode');
      expect(readNineComboModels()).not.toContain('openai/gpt-5-nano');

      // Now promote harness:opencode to auto-safe too -> apply_plan succeeds WITHOUT approvalToken!
      upsertStandingConsentTarget(stateDir, {
        target: 'harness:opencode',
        level: 'auto-safe',
      });
      const autoSafeOk = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main', 'harness:opencode'],
      });
      expect(autoSafeOk.isError).toBe(false);
      expect(autoSafeOk.body['applied']).toBe(true);
      expect(
        (autoSafeOk.body['targets'] as Array<Record<string, unknown>>).every(
          (t) => t['appliedAtLevel'] === 'auto-safe'
        )
      ).toBe(true);
      expect(readNineComboModels()).toContain('openai/gpt-5-nano');

      const histAfterAutoSafe = readApplyHistory(stateDir);
      expect(histAfterAutoSafe.receipts).toHaveLength(4);
      for (const r of histAfterAutoSafe.receipts.slice(2)) {
        expect(r.authorizedVia).toBe('standing-consent');
        expect(r.appliedAtLevel).toBe('auto-safe');
      }
    } finally {
      await mcp.close();
    }
  });

  it('3. REJECTS auto-safe apply_plan without approvalToken when apply-history.json is missing, tampered, or only has a standing-consent receipt (AUTO_SAFE_RECEIPT_MISSING ? kills M5)', async () => {
    const { planHash: hash1 } = writeTickPlan('gpt-5-mini');
    const tok1 = createApprovalToken(hash1);
    const mcp = await connectClient();
    try {
      const initOk = await mcp.call('apply_plan', {
        planHash: hash1,
        targets: ['router:nine/coding-main'],
        approvalToken: tok1.token,
      });
      expect(initOk.isError).toBe(false);

      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'auto-safe',
      });

      const { planHash: hash2 } = writeTickPlan('gpt-5-nano');
      const historyFile = path.join(stateDir, 'apply-history.json');

      // (a) Missing apply-history.json -> AUTO_SAFE_RECEIPT_MISSING
      fs.unlinkSync(historyFile);
      const missingRes = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main'],
      });
      expect(missingRes.isError).toBe(true);
      expect(missingRes.body['errorCode']).toBe('AUTO_SAFE_RECEIPT_MISSING');

      // (b) Forged/signed receipt with authorizedVia: 'standing-consent' & appliedAtLevel: 'propose' -> AUTO_SAFE_RECEIPT_MISSING (kills M5)
      appendApplyReceipt(stateDir, {
        target: 'router:nine/coding-main',
        planHash: hash1,
        appliedAt: '2026-11-25T02:00:00.000Z',
        appliedAtLevel: 'propose',
        authorizedVia: 'standing-consent',
        success: true,
        readBackVerified: true,
        readBackLevel: 'db-only',
        rolledBack: false,
        snapshotOrBackupRef: 'snap-forged',
      });
      const standingReceiptRes = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main'],
      });
      expect(standingReceiptRes.isError).toBe(true);
      expect(standingReceiptRes.body['errorCode']).toBe('AUTO_SAFE_RECEIPT_MISSING');

      // (c) Tampered HMAC on apply-history.json -> AUTO_SAFE_RECEIPT_MISSING
      const signingKey = ensureConsentSigningKey(stateDir);
      const tampered = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as Record<string, any>;
      tampered['receipts'][0]['authorizedVia'] = 'approval-token';
      // Deliberately keep old hmacSha256 so HMAC verification fails
      expect(signingKey.length).toBeGreaterThan(0);
      expect(typeof canonicalJsonStringify).toBe('function');
      expect(typeof computeHmacSha256Hex).toBe('function');
      fs.writeFileSync(historyFile, JSON.stringify(tampered, null, 2), 'utf8');

      const tamperedRes = await mcp.call('apply_plan', {
        planHash: hash2,
        targets: ['router:nine/coding-main'],
      });
      expect(tamperedRes.isError).toBe(true);
      expect(tamperedRes.body['errorCode']).toBe('AUTO_SAFE_RECEIPT_MISSING');
      expect(readNineComboModels()).not.toContain('openai/gpt-5-nano');
    } finally {
      await mcp.close();
    }
  });
});
