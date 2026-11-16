/**
 * packages/daemon/src/handlers/combos.ts
 *
 * Handler for GET /api/v1/combos (Read-only combos reflection).
 * Returns real combos from SQLite databases via @routersync/core/readonly.
 * Zero sample/mock combos returned when DB has no combos (R9-1).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRouterCombos, type ParsedComboRecord } from '../db/reader.js';
import { sendJson } from '../security/network.js';
import type { ComboViewModel, CombosResponse } from '../types.js';

export async function handleCombos(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const omniDb = readRouterCombos('omniroute');
  const nineDb = readRouterCombos('9router');
  const nowIso = new Date().toISOString();

  // R18-1: per-router readability, reported in the collection envelope.
  const routers: CombosResponse['meta']['routers'] = {
    omniroute: omniDb.ok
      ? { source: 'live' }
      : { source: 'unavailable', ...(omniDb.meta.reason === undefined ? {} : { reason: omniDb.meta.reason }) },
    '9router': nineDb.ok
      ? { source: 'live' }
      : { source: 'unavailable', ...(nineDb.meta.reason === undefined ? {} : { reason: nineDb.meta.reason }) },
  };

  // If both DB reads failed due to busy state or unreadable (B-2)
  if (!omniDb.ok && !nineDb.ok) {
    const reason =
      omniDb.meta.reason === 'db_busy' || nineDb.meta.reason === 'db_busy'
        ? 'db_busy'
        : 'db_unreadable';

    const payload: CombosResponse = {
      meta: { source: 'unavailable', reason, generatedAt: nowIso, routers },
      combos: [],
    };
    sendJson(res, 200, payload);
    return;
  }

  const combos: ComboViewModel[] = [];

  // Process omniroute combos
  if (omniDb.ok && Array.isArray(omniDb.data)) {
    for (const record of omniDb.data as ParsedComboRecord[]) {
      combos.push({
        meta: { source: 'live', generatedAt: nowIso },
        id: record.id,
        name: record.name,
        type: record.managed ? 'managed' : 'adopted',
        badgeKey: record.managed ? 'badge_managed' : 'badge_adopted',
        targets: ['omniroute'],
        ...(record.strategy === undefined ? {} : { strategy: record.strategy }),
        steps: record.models.map((m: string, idx: number) => ({
          position: idx + 1,
          modelId: m,
        })),
      });
    }
  }

  // Process 9router combos
  if (nineDb.ok && Array.isArray(nineDb.data)) {
    for (const record of nineDb.data as ParsedComboRecord[]) {
      const existing = combos.find((c) => c.id === record.id);
      const isIdentical =
        existing !== undefined &&
        existing.strategy === record.strategy &&
        existing.steps.length === record.models.length &&
        existing.steps.every((s, idx) => s.modelId === record.models[idx]);

      if (existing && isIdentical) {
        if (!existing.targets.includes('9router')) {
          existing.targets.push('9router');
        }
      } else {
        combos.push({
          meta: { source: 'live', generatedAt: nowIso },
          id: record.id,
          name: record.name,
          type: record.managed ? 'managed' : 'adopted',
          badgeKey: record.managed ? 'badge_managed' : 'badge_adopted',
          targets: ['9router'],
          ...(record.strategy === undefined ? {} : { strategy: record.strategy }),
          steps: record.models.map((m: string, idx: number) => ({
            position: idx + 1,
            modelId: m,
          })),
        });
      }
    }
  }

  // Note: if neither DB has combos, combos is [] (truthful empty array, zero mock injection)
  // R18-1: the envelope travels on EVERY answer, not only on total failure.
  // A readable database with zero combos is then `{ source: 'live', combos: [] }`,
  // which the screen can tell apart from `{ source: 'unavailable' }`.
  const payload: CombosResponse = {
    meta: { source: 'live', generatedAt: nowIso, routers },
    combos,
  };
  sendJson(res, 200, payload);
}
