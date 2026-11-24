/**
 * packages/mcp-server/test/submit-research.test.ts
 *
 * C45-WP3 Red-First MCP E2E Suite over InMemoryTransport (Serves: S1, S3, S7):
 *  - Verifies submit_research writes ONLY <stateDir>/research-evidence.json
 *    and performs ZERO writes to configDir, inbox.json, verify-status.json,
 *    plansDir, router DBs, or harness config files.
 *  - Verifies official vs secondary sourceTier classification & SPOOFED_OFFICIAL_DOMAIN error.
 *  - Verifies research_evidence surfaces submittedEvidence and research_queue
 *    excludes items resolved by fresh official evidence (but NOT secondary evidence).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createRouterSyncMcpServer,
  READ_ONLY_TOOL_NAMES,
  LEDGER_APPEND_TOOL_NAMES,
  CONTROLLED_WRITE_TOOL_NAMES,
  ALL_MCP_TOOL_NAMES,
} from '../src/index.js';

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('C45-WP3 Part 2: MCP submit_research, research_queue & research_evidence', () => {
  let rootDir = '';
  let stateDir = '';
  let configDir = '';
  let localAppData = '';
  let fakeRouterDb = '';
  let fakeHarnessCfg = '';
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp3-mcp-'));
    stateDir = path.join(rootDir, 'state');
    configDir = path.join(rootDir, 'config');
    localAppData = path.join(rootDir, 'localappdata');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(localAppData, { recursive: true });

    fakeRouterDb = path.join(rootDir, 'fake-router.sqlite');
    fakeHarnessCfg = path.join(rootDir, 'opencode.json');
    fs.writeFileSync(fakeRouterDb, 'SQLite-placeholder-bytes', 'utf8');
    fs.writeFileSync(fakeHarnessCfg, JSON.stringify({ provider: { openai: { models: {} } } }), 'utf8');

    for (const key of [
      'ROUTERSYNC_STATE_DIR',
      'ROUTERSYNC_HOME',
      'ROUTERSYNC_CONFIG_DIR',
      'LOCALAPPDATA',
      'ROUTERSYNC_9ROUTER_DB',
      'ROUTERSYNC_OMNIROUTE_DB',
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = configDir;
    process.env['ROUTERSYNC_CONFIG_DIR'] = configDir;
    process.env['LOCALAPPDATA'] = localAppData;
    process.env['ROUTERSYNC_9ROUTER_DB'] = fakeRouterDb;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = fakeRouterDb;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function connectMcp() {
    const server = createRouterSyncMcpServer({ mockCombos: [], mockCatalog: [] });
    const client = new Client({ name: 'wp3-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      async call(name: string, args: Record<string, unknown> = {}) {
        const res = await client.callTool({ name, arguments: args });
        const content = res.content as Array<{ type: string; text: string }>;
        return {
          isError: Boolean(res.isError),
          body: JSON.parse(content[0]!.text) as Record<string, unknown>,
        };
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  it('exports separated READ_ONLY_TOOL_NAMES (26), LEDGER_APPEND_TOOL_NAMES (2), CONTROLLED_WRITE_TOOL_NAMES (1), and ALL_MCP_TOOL_NAMES (29)', () => {
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(26);
    expect(LEDGER_APPEND_TOOL_NAMES).toEqual(['submit_research', 'tick_if_due']);
    expect(CONTROLLED_WRITE_TOOL_NAMES).toEqual(['apply_plan']);
    expect(ALL_MCP_TOOL_NAMES).toHaveLength(29);
  });

  it('accepts official URL, writes ONLY research-evidence.json, and touches zero router/harness/inbox/verify files', async () => {
    const routerShaBefore = sha256File(fakeRouterDb);
    const harnessShaBefore = sha256File(fakeHarnessCfg);

    const mcp = await connectMcp();
    try {
      const res = await mcp.call('submit_research', {
        provider: 'openai',
        modelId: 'gpt-4.5-preview',
        verdict: 'deprecated',
        url: 'https://platform.openai.com/docs/deprecations',
        quote: 'gpt-4.5-preview was shut down on 2026-07-14; migrate to gpt-4.1.',
        publishedAt: '2026-04-14T00:00:00.000Z',
        shutdownDate: '2026-07-14',
        replacementModelId: 'gpt-4.1',
        claimedSourceTier: 'official',
      });

      expect(res.isError).toBe(false);
      expect(res.body['accepted']).toBe(true);
      expect(res.body['routerWrites']).toBe(0);
      expect(res.body['harnessWrites']).toBe(0);

      const record = res.body['record'] as Record<string, unknown>;
      expect(record['sourceTier']).toBe('official');
      expect(record['domainVerified']).toBe(true);
      expect(record['matchedOfficialDomain']).toBe('openai.com');
      expect(record['untrusted']).toBe(true);

      // Strictly ONLY ledger files (cost-ledger.json + research-evidence.json) exist inside stateDir
      expect(fs.readdirSync(stateDir).sort()).toEqual([
        'cost-ledger.json',
        'research-evidence.json',
      ]);
      expect(fs.readdirSync(configDir)).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, 'inbox.json'))).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'verify-status.json'))).toBe(false);
      expect(sha256File(fakeRouterDb)).toBe(routerShaBefore);
      expect(sha256File(fakeHarnessCfg)).toBe(harnessShaBefore);
    } finally {
      await mcp.close();
    }
  });

  it('labels non-official blog URL as secondary and rejects claimedSourceTier="official" with SPOOFED_OFFICIAL_DOMAIN and zero writes', async () => {
    const mcp = await connectMcp();
    try {
      // 1. Spoofed official claim -> hard error & ZERO files created
      const spoofRes = await mcp.call('submit_research', {
        provider: 'openai',
        modelId: 'gpt-4.5-preview',
        verdict: 'deprecated',
        url: 'https://openai.com.attacker.io/doc',
        quote: 'Fake retirement notice',
        claimedSourceTier: 'official',
      });

      expect(spoofRes.isError).toBe(true);
      expect(spoofRes.body['accepted']).toBe(false);
      expect(spoofRes.body['errorCode']).toBe('SPOOFED_OFFICIAL_DOMAIN');
      expect(fs.readdirSync(stateDir)).toEqual([]);

      // 2. Omitted claimedSourceTier on blog URL -> accepted as secondary
      const secRes = await mcp.call('submit_research', {
        provider: 'openai',
        modelId: 'gpt-4.5-preview',
        verdict: 'deprecated',
        url: 'https://blog.example.org/gpt-retired',
        quote: 'Community rumor about retirement',
      });

      expect(secRes.isError).toBe(false);
      expect(secRes.body['accepted']).toBe(true);
      const record = secRes.body['record'] as Record<string, unknown>;
      expect(record['sourceTier']).toBe('secondary');
      expect(record['domainVerified']).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  it('surfaces submittedEvidence in research_evidence and resolves research_queue items ONLY when official evidence arrives', async () => {
    const queuedAt = '2026-11-24T00:00:00.000Z';
    fs.writeFileSync(
      path.join(stateDir, 'research-queue.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: queuedAt,
          items: [
            {
              queueId: 'anthropic/claude-3-sonnet-20240229',
              id: 'anthropic/claude-3-sonnet-20240229',
              prefix: 'anthropic',
              modelId: 'claude-3-sonnet-20240229',
              label: 'SẮP-NGỪNG',
              reasons: ['AMBIGUOUS_DEPRECATION'],
              missing: ['AMBIGUOUS_DEPRECATION', 'L3_NOTICE'],
              targetsAffected: ['router:9router/coding-combo', 'harness:opencode'],
              firstQueuedAt: queuedAt,
              updatedAt: queuedAt,
              verifiedAt: queuedAt,
            },
            {
              queueId: 'openai/gpt-mystery-free',
              id: 'openai/gpt-mystery-free',
              prefix: 'openai',
              modelId: 'gpt-mystery-free',
              label: 'ĐÃ-XÁC-NHẬN-CÒN',
              reasons: ['UNKNOWN_PRICING_TIER'],
              missing: ['UNKNOWN_PRICING_TIER'],
              targetsAffected: ['router:9router/free-combo'],
              firstQueuedAt: queuedAt,
              updatedAt: queuedAt,
              verifiedAt: queuedAt,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const mcp = await connectMcp();
    try {
      // Filter by reason works
      const filtered = await mcp.call('research_queue', { reason: 'UNKNOWN_PRICING_TIER' });
      expect(filtered.body['total']).toBe(1);

      // Submitting secondary evidence does NOT resolve AMBIGUOUS_DEPRECATION
      await mcp.call('submit_research', {
        provider: 'anthropic',
        modelId: 'claude-3-sonnet-20240229',
        verdict: 'deprecated',
        url: 'https://news.example.com/claude-retired',
        quote: 'Secondary blog post says retired',
      });

      const afterSecondary = await mcp.call('research_queue', { reason: 'AMBIGUOUS_DEPRECATION' });
      expect(afterSecondary.body['total']).toBe(1);

      // Submitting official evidence DOES resolve AMBIGUOUS_DEPRECATION
      await mcp.call('submit_research', {
        provider: 'anthropic',
        modelId: 'claude-3-sonnet-20240229',
        verdict: 'deprecated',
        url: 'https://docs.anthropic.com/en/docs/resources/model-deprecations',
        quote: 'claude-3-sonnet-20240229 retired July 21, 2026',
        shutdownDate: '2026-07-21',
      });

      const afterOfficial = await mcp.call('research_queue', { reason: 'AMBIGUOUS_DEPRECATION' });
      expect(afterOfficial.body['total']).toBe(0);

      // research_evidence returns submittedEvidence even when verify-status.json is absent
      const ev = await mcp.call('research_evidence', { model: 'anthropic/claude-3-sonnet-20240229' });
      expect(ev.body['available']).toBe(true);
      expect(ev.body['found']).toBe(true);
      expect(ev.body['record']).toBeNull();
      const submitted = ev.body['submittedEvidence'] as Array<Record<string, unknown>>;
      expect(submitted.length).toBe(2);
      expect(submitted.some((r) => r['sourceTier'] === 'official')).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
