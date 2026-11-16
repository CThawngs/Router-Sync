/**
 * packages/daemon/src/handlers/track.ts
 *
 * Handlers for GET /api/v1/track/status, GET /api/v1/track/events, GET /api/v1/mcp/clients (R48 read-only).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendJson, sendError } from '../security/network.js';

function getStateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
}

export async function handleTrackStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method Not Allowed');
    return;
  }
  const stateFile = path.join(getStateDir(), 'tracker-state.json');
  if (!fs.existsSync(stateFile)) {
    sendJson(res, 200, { run: 0, providers: {} });
    return;
  }
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    sendJson(res, 200, parsed);
  } catch {
    sendJson(res, 200, { run: 0, providers: {} });
  }
}

export async function handleTrackEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method Not Allowed');
    return;
  }
  const eventsFile = path.join(getStateDir(), 'track-events.jsonl');
  if (!fs.existsSync(eventsFile)) {
    sendJson(res, 200, { events: [] });
    return;
  }
  try {
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const events = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    sendJson(res, 200, { events });
  } catch {
    sendJson(res, 200, { events: [] });
  }
}

export async function handleMcpClients(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method Not Allowed');
    return;
  }
  const clientsFile = path.join(getStateDir(), 'mcp-clients.json');
  if (!fs.existsSync(clientsFile)) {
    sendJson(res, 200, { clients: [] });
    return;
  }
  try {
    const raw = fs.readFileSync(clientsFile, 'utf8');
    const parsed = JSON.parse(raw);
    const clients = Array.isArray(parsed) ? parsed : (parsed?.clients ?? []);
    sendJson(res, 200, { clients });
  } catch {
    sendJson(res, 200, { clients: [] });
  }
}
