/**
 * packages/mcp-server/test/strategy-interview.test.ts
 *
 * C45 WP5 + WP6 Red-First MCP Test Suite — `list_strategies` Capability Matrix,
 * Read-Only `profile_interview` Adaptive Session (0 disk writes), and
 * `routersync_adaptive_interview` MCP Prompt Registration (Phục vụ: S4, S5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRouterSyncMcpServer, ALL_MCP_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../src/index.js';

describe('C45 WP5 + WP6 MCP — list_strategies, profile_interview & adaptive prompt', () => {
  let tmpDir: string;
  let stateDir: string;
  let configDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp56-mcp-'));
    stateDir = path.join(tmpDir, 'state');
    configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = configDir;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function connectClient() {
    const server = createRouterSyncMcpServer({
      mockCombos: [
        {
          id: 'routersync-coding',
          name: 'routersync-coding',
          strategy: 'fallback',
          models: ['gemini/gemini-2.5-flash', 'groq/llama-3.3-70b-versatile'],
          managed: true,
          minSteps: 2,
        },
      ],
      mockCatalog: [
        { id: 'gemini/gemini-2.5-flash', provider: 'gemini', status: 'active' },
        { id: 'groq/llama-3.3-70b-versatile', provider: 'groq', status: 'active' },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wp56-test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      async call(name: string, args: Record<string, unknown> = {}) {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
        return JSON.parse(text) as Record<string, unknown>;
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  it('keeps READ_ONLY_TOOL_NAMES=25 and ALL_MCP_TOOL_NAMES=27 while upgrading list_strategies with 9router, omniroute, and litellm capabilities', async () => {
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(25);
    expect(ALL_MCP_TOOL_NAMES).toHaveLength(27);

    const conn = await connectClient();
    try {
      const all = await conn.call('list_strategies', {});
      expect(Array.isArray(all['strategies'])).toBe(true);
      const caps = all['routerCapabilities'] as Array<{ routerKind: string }>;
      expect(caps.map((c) => c.routerKind)).toEqual(['9router', 'omniroute', 'litellm']);
      const guidelines = all['selectionGuidelines'] as {
        stepCeiling: { focusedDefault: number; freeOnlyDefault: number; minSteps: number; hardMax: number };
        excludedReliabilityLabels: string[];
      };
      expect(guidelines.stepCeiling).toEqual({
        focusedDefault: 12,
        freeOnlyDefault: 15,
        minSteps: 2,
        hardMax: 15,
      });
      expect(guidelines.excludedReliabilityLabels).toEqual(['HANG', 'DEAD']);

      const filtered = await conn.call('list_strategies', { routerKind: 'litellm' });
      const litellmCaps = filtered['routerCapabilities'] as Array<{ routerKind: string }>;
      expect(litellmCaps).toHaveLength(1);
      expect(litellmCaps[0]?.routerKind).toBe('litellm');
    } finally {
      await conn.close();
    }
  });

  it('keeps profile_interview 100% read-only (0 disk writes) for both {} and { answers } and registers routersync_adaptive_interview prompt', async () => {
    const conn = await connectClient();
    try {
      const beforeState = fs.readdirSync(stateDir);
      const beforeConfig = fs.readdirSync(configDir);

      const qRes = await conn.call('profile_interview', {});
      expect(qRes['maxQuestions']).toBe(12);
      expect(Array.isArray(qRes['adaptiveQuestions'])).toBe(true);
      expect(Array.isArray(qRes['legacyQuestions'])).toBe(true);

      const evalRes = await conn.call('profile_interview', {
        answers: {
          purpose: 'everyday coding',
          harnesses: 'not sure',
          routers: 'LiteLLM',
          keyedProviders: 'not sure',
          budget: 'idk',
          priority: 'speed, long-context',
          automationLevel: 'auto-safe',
          scanCycle: 'daily',
        },
      });
      expect(evalRes['valid']).toBe(true);
      expect(Number(evalRes['questionCountAsked'])).toBeLessThanOrEqual(12);
      expect(typeof evalRes['profileYaml']).toBe('string');
      expect(String(evalRes['c45ConsentNote'])).toMatch(/propose.*verified read-back/i);
      const profileObj = evalRes['profile'] as { harnesses: string[]; routers: string[]; keyedProviders: string[] };
      expect(profileObj.harnesses).toEqual([]);
      expect(profileObj.routers).toEqual(['litellm']);
      expect(profileObj.keyedProviders).toEqual([]);

      // Zero files created on disk!
      expect(fs.readdirSync(stateDir)).toEqual(beforeState);
      expect(fs.readdirSync(configDir)).toEqual(beforeConfig);

      // Verify MCP prompt routersync_adaptive_interview is registered and callable
      const prompts = await conn.client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toContain('routersync_adaptive_interview');
      const promptResult = await conn.client.getPrompt({
        name: 'routersync_adaptive_interview',
        arguments: { harness: 'openmausbot' },
      });
      expect(promptResult.messages.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });
});
