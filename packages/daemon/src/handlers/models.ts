/**
 * packages/daemon/src/handlers/models.ts
 *
 * Handler for GET /api/v1/models (Phase 3a / P1-DEBT-01 / SPEC §23.2).
 * Returns real models from the persistent Catalog SQLite Store via @routersync/core/readonly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readCatalogModels } from '../db/reader.js';
import { sendJson } from '../security/network.js';

export async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const modRes = readCatalogModels();
  const nowIso = new Date().toISOString();

  if (!modRes.ok) {
    sendJson(res, 200, {
      meta: {
        source: 'unavailable',
        reason: modRes.meta.reason ?? 'catalog_unreadable',
        generatedAt: nowIso,
      },
      data: [],
    });
    return;
  }

  const models = modRes.data ?? [];

  if (models.length === 0) {
    sendJson(res, 200, {
      meta: {
        source: 'unavailable',
        reason: 'catalog_empty',
        generatedAt: nowIso,
      },
      data: [],
    });
    return;
  }

  const payload = models.map((m) => {
    let status: 'healthy' | 'new' | 'due_removal' | 'paused' | 'degraded' = 'healthy';
    if (m.status === 'grace_period') {
      status = 'due_removal';
    } else if (m.status === 'absent') {
      status = 'degraded';
    }

    return {
      id: `${m.providerId}/${m.id}`,
      canonicalId: m.id,
      provider: m.providerId,
      priceKind: 'unknown',
      priceText: 'N/A',
      context: m.contextWindow ? `${m.contextWindow}k` : 'unknown',
      score: 85,
      status,
      hasVision: 'unknown',
      aliases: [m.rawId],
      whereUsed: [],
      scoreExplanation: 'Discovered from provider models endpoint',
    };
  });

  sendJson(res, 200, {
    meta: {
      source: 'live',
      generatedAt: nowIso,
    },
    data: payload,
  });
}
