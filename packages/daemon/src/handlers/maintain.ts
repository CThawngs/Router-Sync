/**
 * packages/daemon/src/handlers/maintain.ts
 *
 * Handler for GET /api/v1/maintain/plan (R50 read-only).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendJson, sendError } from '../security/network.js';

function getStateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
}

export async function handleMaintainPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method Not Allowed');
    return;
  }
  const stateFile = path.join(getStateDir(), 'tracker-state.json');
  let state = { run: 0, providers: {} };
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      // fallback empty state
    }
  }
  sendJson(res, 200, {
    status: 'ok',
    actions: [],
    summary: 'No maintenance actions needed',
    state,
  });
}
