#!/usr/bin/env node
/**
 * packages/mcp-server/src/index.ts
 *
 * Entrypoint for RouterSync MCP Server (Condition C1, C45-WP3 & C45-WP4).
 * Exposes the 25 strictly read-only tools in READ_ONLY_TOOL_NAMES, the
 * isolated evidence ledger tool in LEDGER_APPEND_TOOL_NAMES, and the
 * consent/token-gated `apply_plan` tool in CONTROLLED_WRITE_TOOL_NAMES.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createRouterSyncMcpServer,
  READ_ONLY_TOOL_NAMES,
  LEDGER_APPEND_TOOL_NAMES,
  CONTROLLED_WRITE_TOOL_NAMES,
  ALL_MCP_TOOL_NAMES,
} from './server.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

export {
  createRouterSyncMcpServer,
  READ_ONLY_TOOL_NAMES,
  LEDGER_APPEND_TOOL_NAMES,
  CONTROLLED_WRITE_TOOL_NAMES,
  ALL_MCP_TOOL_NAMES,
  StreamableHTTPServerTransport,
};
export * from './pagination.js';
export * from './sanitize.js';

export interface McpClientRecord {
  name: string;
  version: string;
  lastSeenAt: string;
}

export function recordConnectedClient(name: string, version: string): void {
  try {
    const stateDir = process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const filePath = path.join(stateDir, 'mcp-clients.json');
    let clients: McpClientRecord[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          clients = parsed;
        } else if (Array.isArray(parsed?.clients)) {
          clients = parsed.clients;
        }
      } catch {
        clients = [];
      }
    }
    const cleanName = String(name).slice(0, 64);
    const cleanVersion = String(version || 'unknown').slice(0, 32);
    const now = new Date().toISOString();

    const idx = clients.findIndex((c) => c.name === cleanName);
    if (idx >= 0) {
      clients[idx] = { name: cleanName, version: cleanVersion, lastSeenAt: now };
    } else {
      clients.push({ name: cleanName, version: cleanVersion, lastSeenAt: now });
    }
    fs.writeFileSync(filePath, JSON.stringify(clients, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

export async function runServer(): Promise<void> {
  const server = createRouterSyncMcpServer();
  const transport = new StdioServerTransport();

  let innerOnMessage: ((message: unknown) => void) | undefined = undefined;
  Object.defineProperty(transport, 'onmessage', {
    get() {
      return innerOnMessage;
    },
    set(fn: (message: unknown) => void) {
      innerOnMessage = (msg: unknown) => {
        try {
          if (msg && typeof msg === 'object') {
            const m = msg as Record<string, unknown>;
            if (m['method'] === 'initialize' && m['params'] && typeof m['params'] === 'object') {
              const params = m['params'] as Record<string, unknown>;
              const clientInfo = params['clientInfo'] as { name?: string; version?: string } | undefined;
              if (clientInfo?.name) {
                recordConnectedClient(clientInfo.name, clientInfo.version ?? 'unknown');
              }
            }
          }
        } catch {
          // ignore error
        }
        return fn(msg);
      };
    },
    configurable: true,
    enumerable: true,
  });

  await server.connect(transport);
  process.stderr.write(
    `[routersync-mcp] Server running on stdio (${READ_ONLY_TOOL_NAMES.length} read-only + ${LEDGER_APPEND_TOOL_NAMES.length} ledger-append + ${CONTROLLED_WRITE_TOOL_NAMES.length} controlled-write tools active)\n`
  );
}

// Start the server when this file IS the entry point. Comparing the resolved
// paths works for the source tree and for an installed package alike.
function checkIsMain(): boolean {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  if (path.resolve(process.argv[1]) === selfPath) return true;
  const normalized = process.argv[1].replace(/\\/g, '/');
  if (normalized.endsWith('/routersync-mcp') || normalized === 'routersync-mcp') return true;
  try {
    return fs.realpathSync(process.argv[1]) === selfPath;
  } catch {
    return false;
  }
}
const isMain = checkIsMain();
if (isMain) {
  runServer().catch((err) => {
    process.stderr.write(`[routersync-mcp] Fatal server error: ${err}\n`);
    process.exit(1);
  });
}
