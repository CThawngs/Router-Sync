/**
 * packages/daemon/src/handlers/settings.ts
 *
 * Handler for GET /api/v1/settings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../security/network.js';
import type { SettingsResponse } from '../types.js';
import { readDaemonConfig } from '../config/reader.js';

export async function handleSettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nowIso = new Date().toISOString();
  const config = readDaemonConfig();

  const settings: SettingsResponse = {
    meta: {
      source: 'live',
      generatedAt: nowIso,
    },
    policyMode: config.policyMode,
    // R16-4: say WHERE policyMode came from. 'config' only when a config
    // file exists and was read successfully; otherwise the daemon falls back
    // to 'manual' and says so.
    policyModeSource: config.configStatus === 'ok' ? 'config' : 'default',
    // Unmeasured fields (scanSchedule, maxDailyRequests, mcpClients) are omitted
    // to strictly prevent mock values from masquerading as live telemetry.
  };

  sendJson(res, 200, settings);
}
