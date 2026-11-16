/**
 * packages/daemon/src/server.ts
 *
 * Core HTTP Server for the RouterSync S1 Read-Only Daemon (T3-DAEMON-SEC).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  validateHost,
  validateOrigin,
  sendError,
} from './security/network.js';
import { setConfiguredRouterDbPaths } from '@routersync/core/readonly';
import { readDaemonConfig } from './config/reader.js';
import { handleHealth } from './handlers/health.js';
import { handleOverview } from './handlers/overview.js';
import { handleTargets } from './handlers/targets.js';
import { handleCombos } from './handlers/combos.js';
import { handleDoctor } from './handlers/doctor.js';
import { handleSettings } from './handlers/settings.js';
import { handleProviders } from './handlers/providers.js';
import { handleModels } from './handlers/models.js';
import { handleApprove } from './handlers/approval.js';
import { handlePendingChanges, handleHistoryChanges } from './handlers/changes.js';
import { handleUnsupportedSlice } from './handlers/unsupported.js';
import { handleTrackStatus, handleTrackEvents, handleMcpClients } from './handlers/track.js';
import { handleMaintainPlan } from './handlers/maintain.js';

export interface ServerOptions {
  port?: number;
  host?: '127.0.0.1';
  /** Bearer token required on every request. Falls back to ROUTERSYNC_DAEMON_TOKEN env, then token file. */
  token?: string | undefined;
  /** Path to token file (default: ROUTERSYNC_DAEMON_TOKEN_FILE or <stateDir>/daemon.token). */
  tokenFile?: string | undefined;
}

export function defaultTokenFile(): string {
  const stateDir = process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
  return process.env['ROUTERSYNC_DAEMON_TOKEN_FILE'] ?? path.join(stateDir, 'daemon.token');
}

/**
 * Load daemon bearer token: explicit > env > token file.
 * Token file perms guidance: POSIX 0600, Windows restrict NTFS ACL to owner
 * (icacls /inheritance:r /grant:r "%USERNAME%:(R,W)").
 */
export function loadDaemonToken(options?: { token?: string | undefined; tokenFile?: string | undefined }): string | undefined {
  if (options?.token) return options.token;
  if (process.env['ROUTERSYNC_DAEMON_TOKEN']) return process.env['ROUTERSYNC_DAEMON_TOKEN'];
  const file = options?.tokenFile ?? defaultTokenFile();
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time compare of "Bearer <token>" header vs expected token. */
export function checkBearerToken(authHeader: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!authHeader) return false;
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function tokenFileGuidance(): string {
  return 'POSIX: chmod 600 ~/.routersync/daemon.token; Windows: icacls "%USERPROFILE%\\.routersync\\daemon.token" /inheritance:r /grant:r "%USERNAME%:(R,W)"';
}

export function redactToken(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

export function createDaemonServer(options?: ServerOptions): http.Server {
  // C4o/O2: install configured router DB paths at daemon startup
  try {
    const cfg = readDaemonConfig();
    const paths: Partial<Record<'9router' | 'omniroute', string>> = {};
    if (cfg.omniDbPath) paths['omniroute'] = cfg.omniDbPath;
    if (cfg.nineDbPath) paths['9router'] = cfg.nineDbPath;
    if (Object.keys(paths).length > 0) setConfiguredRouterDbPaths(paths, { source: 'daemon' });
  } catch {
    // ignore
  }

  const host = options?.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error(`Refusing to bind daemon to non-loopback address: "${host}". Only 127.0.0.1 is permitted.`);
  }

  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      const expectedToken = loadDaemonToken({ token: options?.token, tokenFile: options?.tokenFile });
      const parsedEarly = new URL(req.url ?? '/', 'http://127.0.0.1');
      void parsedEarly;

      // 1. Host header validation (DNS rebinding / Host header injection mitigation)
      if (!validateHost(req.headers.host)) {
        sendError(res, 403, 'invalid_host', 'Host must be 127.0.0.1 or localhost');
        return;
      }

      // 2. Origin validation — foreign Origin => 403, never echo CORS headers.
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : options?.port;
      if (!validateOrigin(req.headers.origin, boundPort)) {
        sendError(res, 403, 'invalid_origin', 'Cross-origin requests from third-party domains forbidden');
        return;
      }

      // OPTIONS: answer without any CORS headers (no ACAO anywhere).
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      // Bearer auth: missing/invalid => 401 (only enforced when a token is configured).
      if (expectedToken && !checkBearerToken(req.headers.authorization, expectedToken)) {
        sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
        return;
      }

      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = parsed.pathname;

      // 3. Strict Method Guard (Phase 3b: POST permitted exclusively for /api/v1/changes/approve)
      if (req.method !== 'GET') {
        if (req.method === 'POST' && pathname === '/api/v1/changes/approve') {
          await handleApprove(req, res);
          return;
        }
        sendError(
          res,
          405,
          'read_only_slice',
          'S1 daemon is strictly read-only. Fast-loop and writes arrive in P3b/P4.',
          { Allow: 'GET' }
        );
        return;
      }

      // 4. API Endpoints
      switch (pathname) {
        case '/api/v1/health':
          await handleHealth(req, res);
          break;
        case '/api/v1/overview':
          await handleOverview(req, res);
          break;
        case '/api/v1/targets':
          await handleTargets(req, res);
          break;
        case '/api/v1/combos':
          await handleCombos(req, res);
          break;
        case '/api/v1/doctor':
          await handleDoctor(req, res);
          break;
        case '/api/v1/settings':
          await handleSettings(req, res);
          break;
        case '/api/v1/setup-preview':
          // R17-2: the setup-wizard preview is not measured in the S1 slice.
          handleUnsupportedSlice(req, res, 'SetupPreview');
          break;
        case '/api/v1/heartbeat':
          handleUnsupportedSlice(req, res, 'Heartbeat');
          break;
        case '/api/v1/providers':
          await handleProviders(req, res);
          break;
        case '/api/v1/models':
          await handleModels(req, res);
          break;
        case '/api/v1/changes/pending':
          await handlePendingChanges(req, res);
          break;
        case '/api/v1/changes/history':
          await handleHistoryChanges(req, res);
          break;
        case '/api/v1/changes':
          handleUnsupportedSlice(req, res, 'Changes');
          break;
        case '/api/v1/track/status':
          await handleTrackStatus(req, res);
          break;
        case '/api/v1/track/events':
          await handleTrackEvents(req, res);
          break;
        case '/api/v1/mcp/clients':
          await handleMcpClients(req, res);
          break;
        case '/api/v1/maintain/plan':
          await handleMaintainPlan(req, res);
          break;
        default:
          sendError(res, 404, 'not_found', `Route ${pathname} not found`);
          break;
      }
    } catch (err: unknown) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}

export function startDaemonServer(options?: ServerOptions): Promise<{ server: http.Server; port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const port = options?.port ?? 3128;
    const host = options?.host ?? '127.0.0.1';

    try {
      const server = createDaemonServer({ port, host, token: options?.token, tokenFile: options?.tokenFile });
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ server, port: actualPort, host });
      });
      server.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}
