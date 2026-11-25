/**
 * packages/cli/test/c46-f5-freeze-and-cli-gates.test.ts
 *
 * Ticket C46-F5 (P5 Security & Gate Negative Proofs -- CLI & Unified Freeze Layer)
 * Serves: S1, S3, S4, S7, S9
 *
 * Isolates:
 *  - F5-3 (CLI): research submit <file> rejects sk-..., ghp_..., AIza..., Bearer ..., api_key=..., and PEM private key
 *    in quote/snippet, conclusion, and replacementModelId with SECRET_DETECTED_IN_EVIDENCE, never echoes secret, and leaves
 *    0 mutations in research-evidence.json, cost-ledger.json, and inbox.json.
 *  - F5-9 (CLI + MCP + Tick): With verified propose receipts + active auto-safe consent + valid unconsumed approvalToken,
 *    runFreezeCommand AND corrupted freeze.json ("{broken") block:
 *      (a) runApplyCommand({ ..., write: true, isTTY: true, promptFn: async () => 'chay' }) -> exitCode=1, 0 DB mutations, 0 new receipts
 *      (b) MCP apply_plan WITH valid token AND WITHOUT token (auto-safe) on router + harness -> isError=true, applied=false, 0 mutations, token NOT consumed
 *      (c) runTickCommand({ ..., mode: 'auto-safe' }) on router + harness -> effectiveMode='FROZEN', 0 router/harness mutations, 0 new receipts
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  NINE_ROUTER_EXPECTED_APP_VERSION,
  appendResearchEvidence,
  issuePersistentApprovalToken,
  openBetterSqlite3,
  readApplyHistory,
  upsertStandingConsentTarget,
  verifyPersistentApprovalToken,
} from '@routersync/core';
import { resetTokenRegistry } from '@routersync/daemon';
import { createRouterSyncMcpServer } from '../../mcp-server/src/index.js';
import { computeCanonicalTickPlanHash } from '../../mcp-server/src/apply-plan.js';
import { runApplyCommand } from '../src/commands/apply.js';
import { runFreezeCommand } from '../src/commands/freeze.js';
import { runResearchCommand } from '../src/commands/research.js';
import { runTickCommand } from '../src/commands/tick.js';

class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`EXIT_${code}`);
    this.code = code;
  }
}

async function captureCli(fn: () => Promise<unknown>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(typeof code === 'number' ? code : Number(code ?? 0));
  }) as never);

  let exitCode = 0;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitSignal) {
      exitCode = e.code;
    } else {
      err.push(e instanceof Error ? e.message : String(e));
      exitCode = process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 1;
    }
  } finally {
    process.exitCode = 0;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildSyntheticSecrets() {
  return {
    openaiSk: ['sk', '-'].join('') + 'proj_CliSecretToken0123456789abcdef',
    githubGhp: ['ghp', '_'].join('') + 'CliGithubPatToken0123456789abcdefXYZ1',
    googleAiKey: ['AI', 'za'].join('') + 'SyCliGoogleApiKey0123456789abcdefghij',
    bearerAuth: ['Bearer', ' '].join('') + 'cli_bearer_secret_token_9876543210ab',
    apiKeyAssign: ['api_key', '='].join('') + 'cli_assigned_secret_12345678',
    pemPrivate: ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
  } as const;
}

const INITIAL_TEN_MODELS = [
  'openai/gpt-4o-legacy',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/o3-mini',
  'openai/o4-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.5',
  'openai/gpt-5-nano',
];

const REORDERED_TEN_MODELS = [
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/o3-mini',
  'openai/o4-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.5',
  'openai/gpt-5-nano',
  'openai/gpt-4o-legacy',
];

function createCliFreezeSandbox() {
  const prevEnv = { ...process.env };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f5-cli-'));
  const stateDir = path.join(tmpRoot, 'state');
  const configDir = path.join(tmpRoot, 'config');
  const plansDir = path.join(stateDir, 'plans');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  const nineDbPath = path.join(tmpRoot, 'sandbox-9router.sqlite');
  const opencodePath = path.join(tmpRoot, 'opencode.jsonc');
  const configPath = path.join(configDir, 'routersync.yaml');

  const seedNineDb = (comboModels: readonly string[] = INITIAL_TEN_MODELS): void => {
    const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
    const now = '2026-11-25T00:00:00.000Z';
    db.exec(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER DEFAULT 1,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providerNodes (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        data TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        isActive INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      DELETE FROM combos;
      DELETE FROM providerConnections;
      DELETE FROM models;
      DELETE FROM settings;
      DELETE FROM _meta;
      INSERT INTO settings (id, data) VALUES (1, '{}');
      INSERT INTO models (id, provider, modelId, isActive) VALUES
        ('openai/gpt-4o-legacy', 'openai', 'gpt-4o-legacy', 1),
        ('openai/gpt-4.1', 'openai', 'gpt-4.1', 1),
        ('openai/gpt-4.1-mini', 'openai', 'gpt-4.1-mini', 1),
        ('openai/gpt-4.1-nano', 'openai', 'gpt-4.1-nano', 1),
        ('openai/o3-mini', 'openai', 'o3-mini', 1),
        ('openai/o4-mini', 'openai', 'o4-mini', 1),
        ('openai/gpt-4o', 'openai', 'gpt-4o', 1),
        ('openai/gpt-4o-mini', 'openai', 'gpt-4o-mini', 1),
        ('openai/gpt-4.5', 'openai', 'gpt-4.5', 1),
        ('openai/gpt-5-nano', 'openai', 'gpt-5-nano', 1);
    `);
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-openai',
      'openai',
      'apikey',
      'OpenAI Sandbox',
      null,
      1,
      1,
      JSON.stringify({
        apiKey: 'dummy-openai-sandbox-key',
        baseUrl: 'https://api.openai.com/v1',
        prefix: 'openai',
      }),
      now,
      now
    );
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('coding-primary', 'coding-primary', null, JSON.stringify(comboModels), now, now);
    db.close();
  };

  const readComboModels = (): string[] => {
    const db = openBetterSqlite3(nineDbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get('coding-primary', 'coding-primary') as { models: string } | undefined;
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
      '        "gpt-4o-legacy": { "name": "GPT-4o Legacy" },',
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

  const writeConfig = (pinnedModels: readonly string[]): void => {
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
        'policy:',
        '  mode: manual',
        'combos:',
        '  - name: coding-primary',
        '    routers:',
        '      - nine',
        '    size: 10',
        '    constraints:',
        '      freeOnly: false',
        '    pin:',
        ...pinnedModels.map((m) => `      - ${m}`),
        '    autoMaintain: true',
        'adopt:',
        '  - router: nine',
        '    name: coding-primary',
        '    mode: full',
        '',
      ].join('\n'),
      'utf8'
    );
  };

  const writeTickPlan = (modelToAdd = 'gpt-5-mini'): { planPath: string; planHash: string } => {
    const now = '2026-11-25T01:00:00.000Z';
    const routerActions = [
      {
        targetType: 'router',
        router: '9router',
        comboName: 'coding-primary',
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

  seedNineDb();
  seedOpencodeConfig();
  writeConfig(REORDERED_TEN_MODELS);

  process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
  process.env['ROUTERSYNC_CONFIG_DIR'] = configDir;
  process.env['ROUTERSYNC_PLANS_DIR'] = plansDir;
  process.env['ROUTERSYNC_CONFIG'] = configPath;
  process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
  process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpRoot, 'nonexistent-omni.sqlite');
  delete process.env['ROUTERSYNC_WEBHOOK_URL'];
  resetTokenRegistry();

  const connectMcp = async () => {
    const server = createRouterSyncMcpServer({ configPath, mockCombos: [], mockCatalog: [] });
    const client = new Client({ name: 'c46-f5-cli-mcp', version: '1.0.0' });
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
    vi.restoreAllMocks();
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
    seedNineDb,
    readComboModels,
    seedOpencodeConfig,
    writeConfig,
    writeTickPlan,
    connectMcp,
    cleanup,
  } as const;
}

describe('C46-F5 CLI Research Secret Gate & Unified Freeze Circuit Breaker', () => {
  it(
    'F5-3 (CLI): research submit <file> rejects sk-..., ghp_..., AIza..., Bearer ..., api_key=..., and PEM private key in quote, conclusion, and replacementModelId with SECRET_DETECTED_IN_EVIDENCE and 0 ledger/inbox mutations',
    async () => {
      const ctx = createCliFreezeSandbox();
      try {
        const submitStateDir = path.join(ctx.tmpRoot, 'cli-submit-state');
        fs.mkdirSync(submitStateDir, { recursive: true });
        const secrets = buildSyntheticSecrets();

        let caseIdx = 0;
        for (const [label, secretValue] of Object.entries(secrets)) {
          const payloadVariants: Array<{
            field: 'quote' | 'conclusion' | 'replacementModelId';
            payload: Record<string, unknown>;
          }> = [
            {
              field: 'quote',
              payload: {
                id: 'openai/gpt-4.5-preview',
                verdict: 'deprecated',
                conclusion: 'Clean summary',
                url: 'https://platform.openai.com/docs/deprecations',
                quote: `Excerpt leaking ${secretValue}`,
                replacementModelId: 'gpt-4.1',
                accessedAt: '2026-11-25',
              },
            },
            {
              field: 'conclusion',
              payload: {
                id: 'openai/gpt-4.5-preview',
                verdict: 'deprecated',
                conclusion: `Summary leaking ${secretValue}`,
                url: 'https://platform.openai.com/docs/deprecations',
                quote: 'Clean official deprecation quote.',
                replacementModelId: 'gpt-4.1',
                accessedAt: '2026-11-25',
              },
            },
            {
              field: 'replacementModelId',
              payload: {
                id: 'openai/gpt-4.5-preview',
                verdict: 'deprecated',
                conclusion: 'Clean summary',
                url: 'https://platform.openai.com/docs/deprecations',
                quote: 'Clean official deprecation quote.',
                replacementModelId: `gpt-${secretValue.slice(0, 100)}`,
                accessedAt: '2026-11-25',
              },
            },
          ];

          for (const variant of payloadVariants) {
            caseIdx++;
            const jsonFile = path.join(ctx.tmpRoot, `bad-submit-${caseIdx}.json`);
            fs.writeFileSync(jsonFile, JSON.stringify(variant.payload, null, 2), 'utf8');

            const res = await captureCli(() =>
              runResearchCommand({
                subcommand: 'submit',
                file: jsonFile,
                stateDir: submitStateDir,
                configPath: ctx.configPath,
                nowMs: Date.parse('2026-11-25T12:00:00.000Z'),
              })
            );

            const tag = `${label} in ${variant.field}`;
            expect(res.exitCode, tag).toBe(1);
            const combinedOut = `${res.stdout}\n${res.stderr}`;
            expect(combinedOut, tag).toContain('SECRET_DETECTED_IN_EVIDENCE');
            const secretProbe =
              variant.field === 'replacementModelId' ? secretValue.slice(0, 100) : secretValue;
            expect(combinedOut, tag).not.toContain(secretProbe);
            expect(fs.readdirSync(submitStateDir), tag).toEqual([]);
          }
        }
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-9 (CLI + MCP + Tick): active runFreezeCommand AND corrupted freeze.json ("{broken") fail closed across runApplyCommand (write+TTY), MCP apply_plan (with token & auto-safe), and runTickCommand (auto-safe) with 0 mutations and unconsumed token (kills M10)',
    async () => {
      const ctx = createCliFreezeSandbox();
      const mcp = await ctx.connectMcp();
      try {
        // 1) Grant initial propose consent and create verified propose receipts on BOTH router & harness
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-primary',
          level: 'propose',
        });
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'harness:opencode',
          level: 'propose',
        });

        const { planHash: initPlanHash } = ctx.writeTickPlan('gpt-5-mini');
        const initTok = issuePersistentApprovalToken(ctx.stateDir, initPlanHash);
        const initMcpOk = await mcp.call('apply_plan', {
          planHash: initPlanHash,
          targets: ['router:nine/coding-primary', 'harness:opencode'],
          approvalToken: initTok.token,
        });
        expect(initMcpOk.isError).toBe(false);
        expect(readApplyHistory(ctx.stateDir).receipts).toHaveLength(2);

        // 2) Promote BOTH router:nine/coding-primary and harness:opencode to auto-safe
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'router:nine/coding-primary',
          level: 'auto-safe',
        });
        upsertStandingConsentTarget(ctx.stateDir, {
          target: 'harness:opencode',
          level: 'auto-safe',
        });

        // Reset router DB & harness config to clean pending state so apply, apply_plan, and tick ALL have live pending diffs!
        ctx.seedNineDb(INITIAL_TEN_MODELS);
        ctx.seedOpencodeConfig();
        ctx.writeConfig(REORDERED_TEN_MODELS);

        // Seed tick-catalog.json + official deprecation evidence so tick --mode auto-safe WOULD remove gpt-4o-legacy & add gpt-5.5-codex if unfrozen!
        const baseMs = Date.parse('2026-11-25T12:00:00.000Z');
        fs.writeFileSync(
          path.join(ctx.stateDir, 'tick-catalog.json'),
          JSON.stringify({
            version: 1,
            updatedAt: '2026-11-25T10:00:00.000Z',
            providers: {
              openai: {
                prefix: 'openai',
                router: '9router',
                contentHash: 'seed-hash',
                hash: 'seed-hash',
                ids: INITIAL_TEN_MODELS.map((m) => m.replace(/^openai\//, '')),
                absenceCounts: {},
                consecutiveFailures: 0,
                backoffUntilMs: 0,
                lastStatus: 200,
                lastLabel: 'OK',
                updatedAt: '2026-11-25T10:00:00.000Z',
              },
            },
          }),
          'utf8'
        );
        appendResearchEvidence(ctx.stateDir, {
          provider: 'openai',
          modelId: 'gpt-4o-legacy',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'gpt-4o-legacy shut down on 2026-11-01.',
          shutdownDate: '2026-11-01',
          publishedAt: '2026-11-01T00:00:00.000Z',
          submittedVia: 'cli',
        });

        const mockFetch: typeof globalThis.fetch = async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.includes('api.openai.com')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: 'gpt-4.1' },
                  { id: 'gpt-4.1-mini' },
                  { id: 'gpt-4.1-nano' },
                  { id: 'o3-mini' },
                  { id: 'o4-mini' },
                  { id: 'gpt-4o' },
                  { id: 'gpt-4o-mini' },
                  { id: 'gpt-4.5' },
                  { id: 'gpt-5-nano' },
                  { id: 'gpt-5.5-codex' },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        };

        // Write dedicated mcp-freeze-plan.json (separate filename so runTickCommand writing tick-plan.json doesn't overwrite it)
        const { planPath: defaultPlanPath, planHash: freezePlanHash } = ctx.writeTickPlan('gpt-5-nano');
        const dedicatedPlanName = 'mcp-freeze-plan.json';
        fs.copyFileSync(defaultPlanPath, path.join(ctx.plansDir, dedicatedPlanName));
        const validApprovalToken = issuePersistentApprovalToken(ctx.stateDir, freezePlanHash);

        const receiptsBeforeFreeze = readApplyHistory(ctx.stateDir).receipts.length;
        const opencodeShaBefore = sha256File(ctx.opencodePath);

        // 3) Activate emergency freeze via CLI runFreezeCommand
        const freezeCmdRes = await captureCli(() =>
          runFreezeCommand({
            stateDir: ctx.stateDir,
            reason: 'c46-f5-emergency-freeze',
            json: true,
          })
        );
        expect(freezeCmdRes.exitCode).toBe(0);

        const assertAllThreeBlocked = async (phaseLabel: string, tickNowMs: number): Promise<void> => {
          // (a) CLI apply --write with interactive TTY confirming 'chay' -> exitCode=1, 0 DB mutations, 0 new receipts
          const applyRes = await captureCli(() =>
            runApplyCommand({
              configPath: ctx.configPath,
              stateDir: ctx.stateDir,
              write: true,
              isTTY: true,
              promptFn: async () => 'chay',
              json: true,
            })
          );
          expect(applyRes.exitCode, `${phaseLabel}: apply exitCode`).toBe(1);
          expect(`${applyRes.stdout}\n${applyRes.stderr}`, `${phaseLabel}: apply output`).toContain(
            'WRITE_FROZEN'
          );
          expect(ctx.readComboModels(), `${phaseLabel}: router after apply`).toEqual(
            INITIAL_TEN_MODELS
          );
          expect(
            readApplyHistory(ctx.stateDir).receipts,
            `${phaseLabel}: receipts after apply`
          ).toHaveLength(receiptsBeforeFreeze);

          // (b1) MCP apply_plan WITH valid approvalToken -> isError=true, applied=false, token NOT consumed
          const mcpWithTok = await mcp.call('apply_plan', {
            planHash: freezePlanHash,
            planFile: dedicatedPlanName,
            targets: ['router:nine/coding-primary', 'harness:opencode'],
            approvalToken: validApprovalToken.token,
          });
          expect(mcpWithTok.isError, `${phaseLabel}: mcp with token`).toBe(true);
          expect(mcpWithTok.body['applied'], `${phaseLabel}: mcp with token applied`).toBe(false);
          expect(mcpWithTok.body['errorCode'], `${phaseLabel}: mcp with token code`).toBe(
            'WRITE_FROZEN'
          );
          expect(
            verifyPersistentApprovalToken(ctx.stateDir, validApprovalToken.token, freezePlanHash)
              .valid,
            `${phaseLabel}: token still unconsumed`
          ).toBe(true);

          // (b2) MCP apply_plan WITHOUT token (auto-safe) -> isError=true, applied=false
          const mcpAutoSafe = await mcp.call('apply_plan', {
            planHash: freezePlanHash,
            planFile: dedicatedPlanName,
            targets: ['router:nine/coding-primary', 'harness:opencode'],
          });
          expect(mcpAutoSafe.isError, `${phaseLabel}: mcp auto-safe`).toBe(true);
          expect(mcpAutoSafe.body['applied'], `${phaseLabel}: mcp auto-safe applied`).toBe(false);
          expect(mcpAutoSafe.body['errorCode'], `${phaseLabel}: mcp auto-safe code`).toBe(
            'WRITE_FROZEN'
          );
          expect(ctx.readComboModels(), `${phaseLabel}: router after mcp`).toEqual(
            INITIAL_TEN_MODELS
          );
          expect(sha256File(ctx.opencodePath), `${phaseLabel}: harness after mcp`).toBe(
            opencodeShaBefore
          );
          expect(
            readApplyHistory(ctx.stateDir).receipts,
            `${phaseLabel}: receipts after mcp`
          ).toHaveLength(receiptsBeforeFreeze);

          // (c) CLI tick in mode: 'auto-safe' across router + harness -> effectiveMode='FROZEN', 0 mutations, 0 new receipts
          const tickRes = await runTickCommand({
            configPath: ctx.configPath,
            stateDir: ctx.stateDir,
            mode: 'auto-safe',
            nowMs: tickNowMs,
            minScanIntervalMs: 0,
            fetchFn: mockFetch,
            harnessTargets: [
              {
                harnessId: 'opencode',
                configPath: ctx.opencodePath,
                defaultModels: ['openai/gpt-4.1'],
                providers: [
                  {
                    providerId: 'openai',
                    models: ['gpt-4o-legacy', 'gpt-4.1'],
                    keyPresent: true,
                  },
                ],
              },
            ],
          });
          expect(tickRes.effectiveMode, `${phaseLabel}: tick effectiveMode`).toBe('FROZEN');
          expect(ctx.readComboModels(), `${phaseLabel}: router after tick`).toEqual(
            INITIAL_TEN_MODELS
          );
          expect(sha256File(ctx.opencodePath), `${phaseLabel}: harness after tick`).toBe(
            opencodeShaBefore
          );
          expect(
            readApplyHistory(ctx.stateDir).receipts,
            `${phaseLabel}: receipts after tick`
          ).toHaveLength(receiptsBeforeFreeze);
        };

        await assertAllThreeBlocked('active-freeze', baseMs);

        // 4) Corrupt freeze.json ("{broken") -> fail-closed across ALL 3 (apply, apply_plan, tick)
        fs.writeFileSync(path.join(ctx.stateDir, 'freeze.json'), '{broken', 'utf8');
        await assertAllThreeBlocked('corrupted-freeze-json', baseMs + 120_000);
      } finally {
        await mcp.close();
        ctx.cleanup();
      }
    },
    60_000
  );
});
