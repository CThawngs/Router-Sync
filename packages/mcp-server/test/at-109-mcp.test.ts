/**
 * MCP portion of Acceptance Test AT-109 (Spec §33.3, Gate L, 2026-10-15):
 *  - MCP `status` tool reports applyStates + pendingReloadRouters.
 *  - MCP `inbox_list` emits a system-sourced pending-reload item
 *    (proposed_by.kind = 'system').
 * Lives in the mcp-server package so the MCP SDK resolves (strict pnpm layout).
 *
 * R19-2 (DECISIONS 2026-10-18-01): an apply state describes a WRITE, so the
 * status tool may only publish 'written-pending-reload' when there is EVIDENCE
 * of that write. The state directory of the test is a throwaway directory:
 * with a snapshot of the 9Router target the old value comes back, without one
 * the state is 'unwritten'. The real state directory of this machine is never
 * read and never written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRouterSyncMcpServer } from '../src/index.js';
import { saveSnapshot } from '@routersync/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ORIGINAL_ENV = { ...process.env };

describe('AT-109 (MCP portion): written-pending-reload in status + inbox', () => {
  let tmpStateDir: string;

  beforeEach(() => {
    tmpStateDir = path.join(
      os.tmpdir(),
      `at109_mcp_state_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(tmpStateDir, { recursive: true });
    process.env['ROUTERSYNC_STATE_DIR'] = tmpStateDir;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  it('status tool reports 9router written-pending-reload; inbox emits system event', async () => {
    // The evidence of a write: a snapshot of the 9Router target.
    saveSnapshot({
      id: 'snap_at109_mcp_nine',
      target: '9router',
      timestamp: new Date().toISOString(),
      combos: [],
    });

    const server = createRouterSyncMcpServer({ mockCombos: [], mockCatalog: [] });
    const client = new Client({ name: 'at109-mcp-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const statusRes = await client.callTool({ name: 'status', arguments: {} });
      const statusContent = statusRes.content as Array<{ type: string; text: string }>;
      const statusText = statusContent[0]?.text ?? '';
      const status = JSON.parse(statusText) as {
        applyStates: Record<string, string>;
        pendingReloadRouters: string[];
      };
      expect(status.applyStates['9router']).toBe('written-pending-reload');
      expect(status.pendingReloadRouters).toContain('9router');

      const inboxRes = await client.callTool({ name: 'inbox_list', arguments: {} });
      const inboxContent = inboxRes.content as Array<{ type: string; text: string }>;
      const inboxText = inboxContent[0]?.text ?? '';
      const inbox = JSON.parse(inboxText) as {
        items: Array<{ title?: string; proposed_by?: { kind?: string } }>;
      };
      const sysItem = inbox.items.find((i) => i.proposed_by?.kind === 'system');
      expect(sysItem).toBeDefined();
      expect(sysItem?.title).toContain('written-pending-reload');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('status tool reports "unwritten" when there is no evidence of a write (R19-2)', async () => {
    // The state directory is empty: nothing was ever written, so nothing may
    // claim that a write is pending a reload.
    const server = createRouterSyncMcpServer({ mockCombos: [], mockCatalog: [] });
    const client = new Client({ name: 'at109-mcp-client-unwritten', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const statusRes = await client.callTool({ name: 'status', arguments: {} });
      const statusContent = statusRes.content as Array<{ type: string; text: string }>;
      const status = JSON.parse(statusContent[0]?.text ?? '') as {
        applyStates: Record<string, string>;
        pendingReloadRouters: string[];
      };
      expect(status.applyStates['9router']).toBe('unwritten');
      expect(status.applyStates['omniroute']).toBe('unwritten');
      expect(status.pendingReloadRouters).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
