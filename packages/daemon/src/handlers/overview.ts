/**
 * packages/daemon/src/handlers/overview.ts
 *
 * Handler for GET /api/v1/overview (Structured i18n D1, Honest status D7 / R9-1).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeRouter } from '../probe/reachability.js';
import { readRouterCombos } from '../db/reader.js';
import { sendJson } from '../security/network.js';
import type { SystemOverview } from '../types.js';

export async function handleOverview(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [omniProbe, nineProbe] = await Promise.all([
    probeRouter('omniroute'),
    probeRouter('9router'),
  ]);

  const omniDb = readRouterCombos('omniroute');
  const nineDb = readRouterCombos('9router');
  const nowIso = new Date().toISOString();

  const isOmniUp = omniProbe.reachability === 'up';
  const isNineUp = nineProbe.reachability === 'up';
  const anyRouterUp = isOmniUp || isNineUp;

  // Extract unique models across real combos in DB
  const uniqueModels = new Set<string>();
  if (omniDb.data) {
    for (const c of omniDb.data) for (const m of c.models) uniqueModels.add(m);
  }
  if (nineDb.data) {
    for (const c of nineDb.data) for (const m of c.models) uniqueModels.add(m);
  }

  const probes = [omniProbe, nineProbe];
  const upCount = probes.filter((p) => p.reachability === 'up').length;
  const probedCount = probes.length;

  const overview: SystemOverview = {
    meta: {
      source: anyRouterUp ? 'live' : 'unavailable',
      reason: anyRouterUp ? undefined : 'all_routers_down',
      generatedAt: nowIso,
    },
    routers: {
      upCount,
      probedCount,
    },
    trackedModels: {
      count: uniqueModels.size,
    },
    billableRequestsToday: {
      code: 'by_design_zero_inference',
    },
    lastCheck: {
      code: anyRouterUp ? 'daemon_running' : 'router_disconnected',
      lastCheckAt: nowIso,
    },
  };

  sendJson(res, 200, overview);
}
