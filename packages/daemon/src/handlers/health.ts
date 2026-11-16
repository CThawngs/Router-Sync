/**
 * packages/daemon/src/handlers/health.ts
 *
 * Handler for GET /api/v1/health.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeRouter } from '../probe/reachability.js';
import { sendJson } from '../security/network.js';
import type { DaemonHealthResponse } from '../types.js';

let cachedVersion: string | undefined = undefined;
let versionChecked = false;

export function getDaemonVersion(pkgPathOverride?: string): string | undefined {
  if (pkgPathOverride !== undefined) {
    try {
      const content = fs.readFileSync(pkgPathOverride, 'utf8');
      const parsed = JSON.parse(content) as { version?: string };
      return parsed.version;
    } catch {
      return undefined;
    }
  }
  if (versionChecked) return cachedVersion;
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const content = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(content) as { version?: string };
    if (parsed.version) {
      cachedVersion = parsed.version;
    }
  } catch {
    cachedVersion = undefined;
  }
  versionChecked = true;
  return cachedVersion;
}

export function resetDaemonVersionCache(): void {
  cachedVersion = undefined;
  versionChecked = false;
}

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [omniProbe, nineProbe] = await Promise.all([
    probeRouter('omniroute'),
    probeRouter('9router'),
  ]);

  const anyUp = omniProbe.reachability === 'up' || nineProbe.reachability === 'up';
  const ver = getDaemonVersion();

  const response: DaemonHealthResponse = {
    meta: {
      source: 'live',
      generatedAt: new Date().toISOString(),
    },
    daemon: 'ok',
    status: anyUp ? 'healthy' : 'routers_down',
    ...(ver !== undefined ? { version: ver } : {}),
    readOnly: true,
    uptime: Math.floor(process.uptime()),
    routers: {
      omniroute: omniProbe,
      '9router': nineProbe,
    },
  };

  sendJson(res, 200, response);
}
