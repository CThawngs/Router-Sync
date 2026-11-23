/**
 * packages/daemon/src/handlers/targets.ts
 *
 * Handler for GET /api/v1/targets (B-1 / D7 live status reflection, R9-1 honest data).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeReadBackLevel, resolveRouterKey } from '@routersync/core/readonly';
import { probeRouter } from '../probe/reachability.js';
import {
  readRouterCombosBreakdown,
  type RouterDbReadResult,
  type CombosBreakdown,
} from '../db/reader.js';
import { sendJson } from '../security/network.js';
import type { TargetViewModel } from '../types.js';

export async function handleTargets(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [omniProbe, nineProbe] = await Promise.all([
    probeRouter('omniroute'),
    probeRouter('9router'),
  ]);

  const omniDb = readRouterCombosBreakdown('omniroute');
  const nineDb = readRouterCombosBreakdown('9router');
  const nowIso = new Date().toISOString();

  const isOmniUp = omniProbe.reachability === 'up';
  const isNineUp = nineProbe.reachability === 'up';

  // Resolve keys via @routersync/core/readonly (S1 read-only daemon still reports db-only readBackLevel).
  void resolveRouterKey('omniroute', process.env);
  void resolveRouterKey('9router', process.env);

  // R11-3: S1 performs NO writes, so the daemon must NEVER emit `applyState`
  // (claiming `verified` without any write + read-back would be untruthful).
  // R12-2: combosManaged and combosAdopted are measured truthfully from DB
  // and kept exclusively inside the db block; omitted on read failure.

  function buildTargetDbBlock(dbResult: RouterDbReadResult<CombosBreakdown>) {
    if (!dbResult.ok || !dbResult.data) {
      return {
        meta: dbResult.meta,
      };
    }
    return {
      meta: dbResult.meta,
      combosManaged: dbResult.data.combosManaged,
      combosAdopted: dbResult.data.combosAdopted,
    };
  }

  const omniReadBackLevel = 'db-only' as const;
  const nineReadBackLevel = 'db-only' as const;

  const targets: TargetViewModel[] = [
    {
      id: 'omniroute',
      name: 'OmniRoute',
      type: 'router',
      addressOrPath: omniProbe.url,
      supportsCombos: true,
      readBackLevel: omniReadBackLevel,
      canonicalReadBackLevel: normalizeReadBackLevel(omniReadBackLevel),
      derivedFrom: 'no_key_in_s1',
      db: buildTargetDbBlock(omniDb),
      probe: {
        meta: {
          source: isOmniUp ? 'live' : 'unavailable',
          reason: isOmniUp ? undefined : 'router_unreachable',
          generatedAt: nowIso,
        },
        reachability: omniProbe.reachability,
        httpStatus: omniProbe.httpStatus,
      },
    },
    {
      id: '9router',
      name: '9Router',
      type: 'router',
      addressOrPath: nineProbe.url,
      supportsCombos: true,
      readBackLevel: nineReadBackLevel,
      canonicalReadBackLevel: normalizeReadBackLevel(nineReadBackLevel),
      derivedFrom: 'no_key_in_s1',
      db: buildTargetDbBlock(nineDb),
      probe: {
        meta: {
          source: isNineUp ? 'live' : 'unavailable',
          reason: isNineUp ? undefined : 'router_unreachable',
          generatedAt: nowIso,
        },
        reachability: nineProbe.reachability,
        httpStatus: nineProbe.httpStatus,
      },
    },
  ];

  sendJson(res, 200, targets);
}
