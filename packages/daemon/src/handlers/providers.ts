/**
 * packages/daemon/src/handlers/providers.ts
 *
 * Handler for GET /api/v1/providers (Phase 3a / P1-DEBT-01 / SPEC §23.2).
 * Returns real providers and model counts from the persistent Catalog SQLite Store via @routersync/core/readonly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readCatalogProviders, readCatalogModels } from '../db/reader.js';
import { sendJson } from '../security/network.js';

export async function handleProviders(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const provRes = readCatalogProviders();
  const modRes = readCatalogModels();
  const nowIso = new Date().toISOString();

  if (!provRes.ok) {
    sendJson(res, 200, {
      meta: {
        source: 'unavailable',
        reason: provRes.meta.reason ?? 'catalog_unreadable',
        generatedAt: nowIso,
      },
      data: [],
    });
    return;
  }

  const providers = provRes.data ?? [];
  const models = modRes.data ?? [];

  if (providers.length === 0) {
    sendJson(res, 200, {
      meta: {
        source: 'unavailable',
        reason: 'no_providers_configured',
        generatedAt: nowIso,
      },
      data: [],
    });
    return;
  }

  const modelCountMap = new Map<string, number>();
  for (const m of models) {
    if (m.status !== 'absent') {
      const count = modelCountMap.get(m.providerId) || 0;
      modelCountMap.set(m.providerId, count + 1);
    }
  }

  const payload = providers.map((p) => {
    const count = modelCountMap.get(p.id) || 0;
    return {
      id: p.id,
      name: p.name,
      status: p.status === 'active' ? 'active' : 'key_error',
      keySource: 'env_var',
      keySourceLabel: 'Environment Variable',
      modelsCount: count,
      freeQuotaToday: 'N/A',
      lastScan: p.lastSyncAt ?? nowIso,
      autoAddNew: true,
      autoRemoveGone: false,
      error: p.error,
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
