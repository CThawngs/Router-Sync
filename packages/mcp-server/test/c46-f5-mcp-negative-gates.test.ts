/**
 * packages/mcp-server/test/c46-f5-mcp-negative-gates.test.ts
 *
 * Ticket C46-F5 (P5 Security & Gate Negative Proofs -- MCP Transport Layer)
 * Serves: S1, S3, S4, S7, S9
 *
 * Isolates MCP submit_research and apply_plan negative/edge gates across:
 *  - F5-1: Spoofed/cross-provider/unlisted official domain & disallowed URL authority
 *  - F5-2: Non-HTTPS schemes (http, ftp)
 *  - F5-3: Secret-like content in quote, conclusion, replacementModelId (SECRET_DETECTED_IN_EVIDENCE)
 *  - F5-4 & F5-5: Weekly cap 5/5, maxWeeklyResearchSessions=0, same-week sessionId reuse, dedup vs consumedAt, W48->W49 replay
 *  - F5-6: apply_plan missing approvalToken, blank token, explicit off veto, unconsented target
 *  - F5-7: apply_plan consumed approvalToken replay after restoring identical pending DB/config
 *  - F5-8: apply_plan wrong planHash, mismatched expectedPlanHash, tampered HMAC, expired TTL
 *  - F5-9: freeze & corrupted freeze.json block apply_plan WITH valid token AND WITHOUT token (auto-safe), token NOT consumed
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  activateFreeze,
  computeWeeklyResearchBudget,
  issuePersistentApprovalToken,
  loadResearchEvidence,
  openBetterSqlite3,
  readApplyHistory,
  readCostLedgerReadOnly,
  saveResearchEvidence,
  upsertStandingConsentTarget,
  verifyPersistentApprovalToken,
} from '@routersync/core';
import { resetTokenRegistry } from '@routersync/daemon';
import { createRouterSyncMcpServer } from '../src/index.js';
import { computeCanonicalTickPlanHash } from '../src/apply-plan.js';

const INITIAL_ROUTER_MODELS = [
  'openai/gpt-4o-old',
  'openai/gpt-4.1',
  'anthropic/claude-sonnet-4',
];

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildSyntheticSecrets() {
  return {
    openaiSk: ['sk', '-'].join('') + 'proj_McpSecretToken0123456789abcdef',
    githubGhp: ['ghp', '_'].join('') + 'McpGithubPatToken0123456789abcdefXYZ1',
    googleAiKey: ['AI', 'za'].join('') + 'SyMcpGoogleApiKey0123456789abcdefghij',
    bearerAuth: ['Bearer', ' '].join('') + 'mcp_bearer_secret_token_9876543210ab',
    apiKeyAssign: ['api_key', '='].join('') + 'mcp_assigned_secret_12345678',
    pemPrivate: ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
  } as const;
}

interface McpSandboxOptions {
  readonly maxWeeklyResearchSessions?: number | undefined;
  readonly nowMsRef?: { value: number } | undefined;
}

function createMcpSandbox(opts: McpSandboxOptions = {}) {
  const prevEnv = { ...process.env };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f5-mcp-'));
  const stateDir = path.join(tmpRoot, 'state');
  const configDir = path.join(tmpRoot, 'config');
  const plansDir = path.join(stateDir, 'plans');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  const nineDbPath = path.join(tmpRoot, 'sandbox-9router.sqlite');
  const opencodePath = path.join(tmpRoot, 'opencode.jsonc');
  const configPath = path.join(configDir, 'routersync.yaml');

  const seedRouterDb = (models: readonly string[] = INITIAL_ROUTER_MODELS): void => {
    const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
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
  };

  const readRouterModels = (): string[] => {
    const db = openBetterSqlite3(nineDbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get('coding-main', 'coding-main') as { models: string } | undefined;
      return row ? (JSON.parse(row.models) as string[]) : [];
    } finally {
      db.close();
    }
  };

  const seedOpencodeConfig = (): string => {
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
  };

  const writeTickPlan = (modelToAdd = 'gpt-5-mini'): { planPath: string; planHash: string } => {
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
        routerActions: routerActions as never,
        harnessActions: harnessActions as never,
      }) ?? '';
    const planPath = path.join(plansDir, 'tick-plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        { version: 1, updatedAt: now, mode: 'propose', planHash, routerActions, harnessActions },
        null,
        2
      ),
      'utf8'
    );
    return { planPath, planHash };
  };

  seedRouterDb();
  const initialOpencodeText = seedOpencodeConfig();
  const researchBlock =
    opts.maxWeeklyResearchSessions !== undefined
      ? ['research:', `  maxWeeklyResearchSessions: ${opts.maxWeeklyResearchSessions}`]
      : [];

  fs.writeFileSync(
    configPath,
    [
      'version: 1',
      'routers:',
      '  - id: nine',
      '    adapter: 9router',
      '    isolated: false',
      '    baseUrl: http://127.0.0.1:9',
      '    db:',
      `      path: "${nineDbPath.replace(/\\/g, '/')}"`,
      '    reload:',
      '      type: none',
      ...researchBlock,
      '',
    ].join('\n'),
    'utf8'
  );

  process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
  process.env['ROUTERSYNC_CONFIG_DIR'] = configDir;
  process.env['ROUTERSYNC_PLANS_DIR'] = plansDir;
  process.env['ROUTERSYNC_CONFIG'] = configPath;
  process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
  process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpRoot, 'nonexistent-omni.sqlite');
  delete process.env['ROUTERSYNC_WEBHOOK_URL'];
  delete process.env['ROUTERSYNC_MAX_WEEKLY_RESEARCH_SESSIONS'];
  resetTokenRegistry();

  const connectMcp = async () => {
    const server = createRouterSyncMcpServer({
      configPath,
      mockCombos: [],
      mockCatalog: [],
      ...(opts.nowMsRef ? { nowMs: () => opts.nowMsRef!.value } : {}),
    });
    const client = new Client({ name: 'c46-f5-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      async call(name: string, args: Record<string, unknown> = {}) {
        const res = await client.callTool({ name, arguments: args });
        const content = res.content as Array<{ type: string; text: string }>;
        const rawText = content[0]?.text ?? '{}';
        return {
          isError: Boolean(res.isError),
          rawText,
          body: JSON.parse(rawText) as Record<string, unknown>,
        };
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  };

  const cleanup = () => {
    resetTokenRegistry();
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return {
    tmpRoot,
    stateDir,
    configDir,
    plansDir,
    nineDbPath,
    opencodePath,
    configPath,
    initialOpencodeText,
    seedRouterDb,
    readRouterModels,
    seedOpencodeConfig,
    writeTickPlan,
    connectMcp,
    cleanup,
  } as const;
}

describe('C46-F5 MCP Security & Gate Negative Proofs', () => {
  it(
    'F5-1 & F5-2: MCP submit_research rejects spoofed/cross-provider/unlisted official domains, disallowed URL authorities, and non-HTTPS schemes with 0 files written in stateDir',
    async () => {
      const ctx = createMcpSandbox();
      const mcp = await ctx.connectMcp();
      try {
        fs.rmSync(ctx.plansDir, { recursive: true, force: true });
        expect(fs.readdirSync(ctx.stateDir)).toEqual([]);

        const spoofedOfficialCases = [
          { provider: 'openai', url: 'https://openai.com.attacker.io/doc' },
          { provider: 'openai', url: 'https://evilopenai.com/doc' },
          { provider: 'openai', url: 'https://docs.anthropic.com/en/docs/models' },
          { provider: 'unknownvendor', url: 'https://docs.unknownvendor.example/models' },
        ];

        for (const tc of spoofedOfficialCases) {
          const res = await mcp.call('submit_research', {
            provider: tc.provider,
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: tc.url,
            quote: 'Official retirement table entry.',
            claimedSourceTier: 'official',
          });
          expect(res.isError, tc.url).toBe(true);
          expect(res.body['accepted'], tc.url).toBe(false);
          expect(res.body['errorCode'], tc.url).toBe('SPOOFED_OFFICIAL_DOMAIN');
          expect(fs.readdirSync(ctx.stateDir), tc.url).toEqual([]);
        }

        const credUrl = ['https://user:pass', 'platform.openai.com/doc'].join('@');
        const disallowedUrls = [
          'https://localhost/doc',
          'https://sub.localhost/doc',
          'https://node.local/doc',
          'https://corp.internal/doc',
          'https://127.0.0.1/doc',
          'https://[::1]/doc',
          'https://0x7f000001/doc',
          'https://platform.openai.com:8443/doc',
          credUrl,
        ];

        for (const badUrl of disallowedUrls) {
          const res = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: badUrl,
            quote: 'Retirement notice.',
          });
          expect(res.isError, badUrl).toBe(true);
          expect(res.body['accepted'], badUrl).toBe(false);
          expect(res.body['errorCode'], badUrl).toBe('DISALLOWED_URL_AUTHORITY');
          expect(fs.readdirSync(ctx.stateDir), badUrl).toEqual([]);
        }

        for (const insecureUrl of [
          'http://platform.openai.com/docs/deprecations',
          'ftp://platform.openai.com/docs/deprecations',
        ]) {
          const res = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: insecureUrl,
            quote: 'Retirement notice.',
          });
          expect(res.isError, insecureUrl).toBe(true);
          expect(res.body['accepted'], insecureUrl).toBe(false);
          expect(res.body['errorCode'], insecureUrl).toBe('INSECURE_URL_SCHEME');
          expect(fs.readdirSync(ctx.stateDir), insecureUrl).toEqual([]);
        }
      } finally {
        await mcp.close();
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-3: MCP submit_research rejects secret-like content separately in quote, conclusion, and replacementModelId with SECRET_DETECTED_IN_EVIDENCE, never echoes secret, and writes 0 evidence/cost-ledger bytes',
    async () => {
      const ctx = createMcpSandbox();
      const mcp = await ctx.connectMcp();
      try {
        fs.rmSync(ctx.plansDir, { recursive: true, force: true });
        const secrets = buildSyntheticSecrets();
        for (const [label, secretValue] of Object.entries(secrets)) {
          const quoteRes = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: 'https://platform.openai.com/docs/deprecations',
            quote: `Notice with ${secretValue} embedded`,
            conclusion: 'Clean summary',
            replacementModelId: 'gpt-4.1',
          });
          expect(quoteRes.isError, `${label} in quote`).toBe(true);
          expect(quoteRes.body['accepted'], `${label} in quote`).toBe(false);
          expect(quoteRes.body['errorCode'], `${label} in quote`).toBe('SECRET_DETECTED_IN_EVIDENCE');
          expect(quoteRes.rawText, `${label} in quote`).not.toContain(secretValue);
          expect(fs.readdirSync(ctx.stateDir), `${label} in quote`).toEqual([]);

          const concRes = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: 'https://platform.openai.com/docs/deprecations',
            quote: 'Clean official deprecation quote.',
            conclusion: `Summary leaking ${secretValue}`,
            replacementModelId: 'gpt-4.1',
          });
          expect(concRes.isError, `${label} in conclusion`).toBe(true);
          expect(concRes.body['accepted'], `${label} in conclusion`).toBe(false);
          expect(concRes.body['errorCode'], `${label} in conclusion`).toBe('SECRET_DETECTED_IN_EVIDENCE');
          expect(concRes.rawText, `${label} in conclusion`).not.toContain(secretValue);
          expect(fs.readdirSync(ctx.stateDir), `${label} in conclusion`).toEqual([]);

          const repSecret = secretValue.slice(0, 120);
          const repRes = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: 'gpt-4.5-preview',
            verdict: 'deprecated',
            url: 'https://platform.openai.com/docs/deprecations',
            quote: 'Clean official deprecation quote.',
            conclusion: 'Clean summary',
            replacementModelId: `gpt-${repSecret}`,
          });
          expect(repRes.isError, `${label} in replacementModelId`).toBe(true);
          expect(repRes.body['accepted'], `${label} in replacementModelId`).toBe(false);
          expect(repRes.body['errorCode'], `${label} in replacementModelId`).toBe(
            'SECRET_DETECTED_IN_EVIDENCE'
          );
          expect(repRes.rawText, `${label} in replacementModelId`).not.toContain(repSecret);
          expect(fs.readdirSync(ctx.stateDir), `${label} in replacementModelId`).toEqual([]);
        }
      } finally {
        await mcp.close();
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-4 & F5-5: MCP submit_research enforces weekly 5-session cap, maxWeeklyResearchSessions=0, same-week sessionId reuse + dedup vs consumedAt, and rejects cross-week W48->W49 sessionId replay',
    async () => {
      const nowMsRef = { value: Date.parse('2026-11-25T12:00:00.000Z') };
      const ctx = createMcpSandbox({ nowMsRef });
      const mcp = await ctx.connectMcp();
      try {
        const s1First = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'gpt-4.5-preview retired.',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          sessionId: 's-1',
        });
        expect(s1First.isError).toBe(false);

        nowMsRef.value += 10_000;
        const s1Second = await mcp.call('submit_research', {
          provider: 'anthropic',
          modelId: 'claude-3-sonnet-20240229',
          verdict: 'deprecated',
          url: 'https://docs.anthropic.com/en/docs/resources/model-deprecations',
          quote: 'claude-3-sonnet retired.',
          shutdownDate: '2026-07-21',
          pricingTier: 'paid',
          sessionId: 's-1',
        });
        expect(s1Second.isError).toBe(false);

        const budgetAfterS1 = computeWeeklyResearchBudget(ctx.stateDir, { nowMs: nowMsRef.value });
        expect(budgetAfterS1.isoWeek).toBe('2026-W48');
        expect(budgetAfterS1.usedSessions).toBe(1);
        const s1Ledger = readCostLedgerReadOnly(ctx.stateDir).researchSessions.find(
          (s) => s.isoWeek === '2026-W48' && s.sessionId === 's-1'
        );
        expect(s1Ledger?.toolCallsCount).toBe(2);
        expect(s1Ledger?.findingsSubmitted).toBe(2);

        nowMsRef.value += 10_000;
        const dupRes = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'gpt-4.5-preview retired (updated excerpt).',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          sessionId: 's-1',
        });
        expect(dupRes.isError).toBe(false);
        expect(loadResearchEvidence(ctx.stateDir)).toHaveLength(2);

        const currentRecs = loadResearchEvidence(ctx.stateDir);
        saveResearchEvidence(
          ctx.stateDir,
          currentRecs.map((r) =>
            r.modelId === 'gpt-4.5-preview'
              ? { ...r, consumedAt: '2026-11-25T12:01:00.000Z' }
              : r
          )
        );
        nowMsRef.value += 10_000;
        const afterConsumedRes = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'gpt-4.5-preview fresh post-consumption submission.',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          sessionId: 's-1',
        });
        expect(afterConsumedRes.isError).toBe(false);
        expect(loadResearchEvidence(ctx.stateDir)).toHaveLength(3);

        for (const sid of ['s-2', 's-3', 's-4', 's-5']) {
          nowMsRef.value += 5_000;
          const okRes = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: `model-${sid}`,
            verdict: 'active',
            url: 'https://platform.openai.com/docs/models',
            quote: `Active model ${sid}`,
            sessionId: sid,
          });
          expect(okRes.isError, sid).toBe(false);
        }

        const evPath = path.join(ctx.stateDir, 'research-evidence.json');
        const costPath = path.join(ctx.stateDir, 'cost-ledger.json');
        const evShaW48 = sha256File(evPath);
        const costShaW48 = sha256File(costPath);

        const s6Res = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'model-s6',
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: 'Blocked 6th session',
          sessionId: 's-6',
        });
        expect(s6Res.isError).toBe(true);
        expect(s6Res.body['accepted']).toBe(false);
        expect(s6Res.body['errorCode']).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
        expect(sha256File(evPath)).toBe(evShaW48);
        expect(sha256File(costPath)).toBe(costShaW48);

        const omittedRes = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'model-omitted',
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: 'Blocked omitted session',
        });
        expect(omittedRes.isError).toBe(true);
        expect(omittedRes.body['accepted']).toBe(false);
        expect(omittedRes.body['errorCode']).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
        expect(sha256File(evPath)).toBe(evShaW48);
        expect(sha256File(costPath)).toBe(costShaW48);

        nowMsRef.value = Date.parse('2026-12-02T12:00:00.000Z');
        for (const sid of ['w49-1', 'w49-2', 'w49-3', 'w49-4', 'w49-5']) {
          nowMsRef.value += 5_000;
          const okW49 = await mcp.call('submit_research', {
            provider: 'openai',
            modelId: `model-${sid}`,
            verdict: 'active',
            url: 'https://platform.openai.com/docs/models',
            quote: `Active W49 ${sid}`,
            sessionId: sid,
          });
          expect(okW49.isError, sid).toBe(false);
        }

        const evShaW49 = sha256File(evPath);
        const costShaW49 = sha256File(costPath);

        const replayS1InW49 = await mcp.call('submit_research', {
          provider: 'openai',
          modelId: 'model-replay-s1',
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: 'Cross-week replay attempt of s-1',
          sessionId: 's-1',
        });
        expect(replayS1InW49.isError).toBe(true);
        expect(replayS1InW49.body['accepted']).toBe(false);
        expect(replayS1InW49.body['errorCode']).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
        expect(sha256File(evPath)).toBe(evShaW49);
        expect(sha256File(costPath)).toBe(costShaW49);
      } finally {
        await mcp.close();
        ctx.cleanup();
      }

      const zeroCtx = createMcpSandbox({ maxWeeklyResearchSessions: 0 });
      const zeroMcp = await zeroCtx.connectMcp();
      try {
        fs.rmSync(zeroCtx.plansDir, { recursive: true, force: true });
        const zeroRes = await zeroMcp.call('submit_research', {
          provider: 'openai',
          modelId: 'gpt-4.1',
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: 'Zero cap check',
          sessionId: 's-zero',
        });
        expect(zeroRes.isError).toBe(true);
        expect(zeroRes.body['errorCode']).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
        expect(fs.readdirSync(zeroCtx.stateDir)).toEqual([]);
      } finally {
        await zeroMcp.close();
        zeroCtx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-6, F5-7 & F5-8: MCP apply_plan enforces missing/off/unconsented token gates, single-use consumed approvalToken replay rejection, and wrong planHash / tampered HMAC / expired TTL rejections with 0 mutations',
    async () => {
      const ctx = createMcpSandbox();
      const mcp = await ctx.connectMcp();
      try {
        const { planHash: planHashA } = ctx.writeTickPlan('gpt-5-mini');

        // Unconsented target without token -> rejected with 0 mutations & 0 receipts
        const unconsentedRes = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['router:nine/coding-main'],
        });
        expect(unconsentedRes.isError).toBe(true);
        expect(unconsentedRes.body['applied']).toBe(false);
        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(0);

        // Explicit 'off' target -> rejected with TARGET_CONSENT_OFF even WITH valid approvalToken
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-main',
          level: 'off',
        });
        const tokOff = issuePersistentApprovalToken(ctx.stateDir, planHashA);
        const offRes = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['router:nine/coding-main'],
          approvalToken: tokOff.token,
        });
        expect(offRes.isError).toBe(true);
        expect(offRes.body['applied']).toBe(false);
        expect(offRes.body['errorCode']).toBe('TARGET_CONSENT_OFF');
        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(0);

        // Targets at 'propose' without approvalToken -> APPROVAL_TOKEN_REQUIRED on router & harness
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-main',
          level: 'propose',
        });
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'harness:opencode',
          level: 'propose',
        });

        const missingRouterTok = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['router:nine/coding-main'],
        });
        expect(missingRouterTok.isError).toBe(true);
        expect(missingRouterTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');

        const blankTok = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['router:nine/coding-main'],
          approvalToken: '   ',
        });
        expect(blankTok.isError).toBe(true);
        expect(blankTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');

        const missingHarnessTok = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['harness:opencode'],
        });
        expect(missingHarnessTok.isError).toBe(true);
        expect(missingHarnessTok.body['errorCode']).toBe('APPROVAL_TOKEN_REQUIRED');
        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(fs.readFileSync(ctx.opencodePath, 'utf8')).toBe(ctx.initialOpencodeText);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(0);

        // F5-8: Wrong planHash, mismatched expectedPlanHash, tampered HMAC, expired TTL -> rejected
        const tokForHashA = issuePersistentApprovalToken(ctx.stateDir, planHashA);
        const { planHash: planHashB } = ctx.writeTickPlan('gpt-5-nano');
        expect(planHashB).not.toBe(planHashA);

        const wrongHashRes = await mcp.call('apply_plan', {
          planHash: planHashB,
          targets: ['router:nine/coding-main'],
          approvalToken: tokForHashA.token,
        });
        expect(wrongHashRes.isError).toBe(true);
        expect(wrongHashRes.body['applied']).toBe(false);
        expect(wrongHashRes.body['errorCode']).toBe('INVALID_APPROVAL_TOKEN');
        expect(wrongHashRes.body['reason']).toBe('plan_hash_mismatch');

        const mismatchedArgHash = await mcp.call('apply_plan', {
          planHash: planHashA,
          targets: ['router:nine/coding-main'],
          approvalToken: tokForHashA.token,
        });
        expect(mismatchedArgHash.isError).toBe(true);
        expect(mismatchedArgHash.body['errorCode']).toBe('PLAN_HASH_MISMATCH');

        const tokForHashB = issuePersistentApprovalToken(ctx.stateDir, planHashB);
        const [bNonce, bSig] = tokForHashB.token.split('.');
        const flippedLast = bSig!.endsWith('0') ? '1' : '0';
        const tamperedToken = `${bNonce}.${bSig!.slice(0, -1)}${flippedLast}`;
        const tamperedRes = await mcp.call('apply_plan', {
          planHash: planHashB,
          targets: ['router:nine/coding-main'],
          approvalToken: tamperedToken,
        });
        expect(tamperedRes.isError).toBe(true);
        expect(tamperedRes.body['errorCode']).toBe('INVALID_APPROVAL_TOKEN');
        expect(tamperedRes.body['reason']).toBe('invalid_signature');

        const expiredTok = issuePersistentApprovalToken(ctx.stateDir, planHashB, -5_000);
        const expiredRes = await mcp.call('apply_plan', {
          planHash: planHashB,
          targets: ['router:nine/coding-main'],
          approvalToken: expiredTok.token,
        });
        expect(expiredRes.isError).toBe(true);
        expect(expiredRes.body['errorCode']).toBe('INVALID_APPROVAL_TOKEN');
        expect(expiredRes.body['reason']).toBe('token_expired');

        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(fs.readFileSync(ctx.opencodePath, 'utf8')).toBe(ctx.initialOpencodeText);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(0);

        // F5-7: Valid token tokForHashB succeeds ONCE -> restore identical pending DB/config -> replay SAME token fails! (kills M8)
        const firstApply = await mcp.call('apply_plan', {
          planHash: planHashB,
          targets: ['router:nine/coding-main', 'harness:opencode'],
          approvalToken: tokForHashB.token,
        });
        expect(firstApply.isError).toBe(false);
        expect(firstApply.body['applied']).toBe(true);
        expect(ctx.readRouterModels()).toContain('openai/gpt-5-nano');

        const histAfterOne = readApplyHistory(ctx.stateDir);
        expect(histAfterOne.receipts).toHaveLength(2);
        for (const r of histAfterOne.receipts) {
          expect(r.authorizedVia).toBe('approval-token');
          expect(r.appliedAtLevel).toBe('propose');
        }

        // Restore identical pending router DB and harness config so planHashB matches again
        ctx.seedRouterDb(INITIAL_ROUTER_MODELS);
        ctx.seedOpencodeConfig();
        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(fs.readFileSync(ctx.opencodePath, 'utf8')).toBe(ctx.initialOpencodeText);

        const replayConsumed = await mcp.call('apply_plan', {
          planHash: planHashB,
          targets: ['router:nine/coding-main', 'harness:opencode'],
          approvalToken: tokForHashB.token,
        });
        expect(replayConsumed.isError).toBe(true);
        expect(replayConsumed.body['applied']).toBe(false);
        expect(replayConsumed.body['errorCode']).toBe('INVALID_APPROVAL_TOKEN');
        expect(replayConsumed.body['reason']).toBe('token_already_consumed');
        expect(ctx.readRouterModels()).toEqual(INITIAL_ROUTER_MODELS);
        expect(fs.readFileSync(ctx.opencodePath, 'utf8')).toBe(ctx.initialOpencodeText);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);
      } finally {
        await mcp.close();
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-9 (MCP): active freeze AND corrupted freeze.json block apply_plan WITH valid token AND WITHOUT token (auto-safe) on router + harness without consuming approvalToken (kills M10)',
    async () => {
      const ctx = createMcpSandbox();
      const mcp = await ctx.connectMcp();
      try {
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-main',
          level: 'propose',
        });
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'harness:opencode',
          level: 'propose',
        });

        const { planHash: initHash } = ctx.writeTickPlan('gpt-5-mini');
        const initTok = issuePersistentApprovalToken(ctx.stateDir, initHash);
        const initOk = await mcp.call('apply_plan', {
          planHash: initHash,
          targets: ['router:nine/coding-main', 'harness:opencode'],
          approvalToken: initTok.token,
        });
        expect(initOk.isError).toBe(false);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);

        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-main',
          level: 'auto-safe',
        });
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'harness:opencode',
          level: 'auto-safe',
        });

        const { planHash: planHash2 } = ctx.writeTickPlan('gpt-5-nano');
        const validFrozenTok = issuePersistentApprovalToken(ctx.stateDir, planHash2);
        const routerModelsSnapshot = ctx.readRouterModels();
        const opencodeShaBefore = sha256File(ctx.opencodePath);

        activateFreeze(ctx.stateDir, 'f5-mcp-freeze-check');

        const frozenWithTok = await mcp.call('apply_plan', {
          planHash: planHash2,
          targets: ['router:nine/coding-main', 'harness:opencode'],
          approvalToken: validFrozenTok.token,
        });
        expect(frozenWithTok.isError).toBe(true);
        expect(frozenWithTok.body['applied']).toBe(false);
        expect(frozenWithTok.body['errorCode']).toBe('WRITE_FROZEN');
        expect(ctx.readRouterModels()).toEqual(routerModelsSnapshot);
        expect(sha256File(ctx.opencodePath)).toBe(opencodeShaBefore);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);
        expect(
          verifyPersistentApprovalToken(ctx.stateDir, validFrozenTok.token, planHash2).valid
        ).toBe(true);

        const frozenAutoSafe = await mcp.call('apply_plan', {
          planHash: planHash2,
          targets: ['router:nine/coding-main', 'harness:opencode'],
        });
        expect(frozenAutoSafe.isError).toBe(true);
        expect(frozenAutoSafe.body['applied']).toBe(false);
        expect(frozenAutoSafe.body['errorCode']).toBe('WRITE_FROZEN');
        expect(ctx.readRouterModels()).toEqual(routerModelsSnapshot);
        expect(sha256File(ctx.opencodePath)).toBe(opencodeShaBefore);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);

        fs.writeFileSync(path.join(ctx.stateDir, 'freeze.json'), '{broken', 'utf8');

        const corruptWithTok = await mcp.call('apply_plan', {
          planHash: planHash2,
          targets: ['router:nine/coding-main', 'harness:opencode'],
          approvalToken: validFrozenTok.token,
        });
        expect(corruptWithTok.isError).toBe(true);
        expect(corruptWithTok.body['errorCode']).toBe('WRITE_FROZEN');
        expect(corruptWithTok.body['reason']).toBe('corrupt-freeze-file-fail-closed');

        const corruptAutoSafe = await mcp.call('apply_plan', {
          planHash: planHash2,
          targets: ['router:nine/coding-main', 'harness:opencode'],
        });
        expect(corruptAutoSafe.isError).toBe(true);
        expect(corruptAutoSafe.body['errorCode']).toBe('WRITE_FROZEN');
        expect(corruptAutoSafe.body['reason']).toBe('corrupt-freeze-file-fail-closed');

        expect(ctx.readRouterModels()).toEqual(routerModelsSnapshot);
        expect(sha256File(ctx.opencodePath)).toBe(opencodeShaBefore);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);
        expect(
          verifyPersistentApprovalToken(ctx.stateDir, validFrozenTok.token, planHash2).valid
        ).toBe(true);
      } finally {
        await mcp.close();
        ctx.cleanup();
      }
    },
    60_000
  );
});
