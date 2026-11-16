/**
 * packages/daemon/src/security/network.ts
 *
 * Network boundary enforcement and HTTP hardening for the RouterSync Daemon (T3-DAEMON-SEC).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeObject } from './sanitize.js';

export function validateHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strictly allow 127.0.0.1[:port] or localhost[:port]
  return /^127\.0\.0\.1(:\d+)?$/.test(hostHeader) || /^localhost(:\d+)?$/.test(hostHeader);
}

export function validateOrigin(originHeader: string | undefined, daemonPort?: number): boolean {
  if (!originHeader) {
    // Non-browser clients (curl, local CLI, server-to-server) do not send Origin
    return true;
  }
  const allowed = new Set([
    'http://localhost:3100',
    'http://127.0.0.1:3100',
  ]);
  if (daemonPort) {
    allowed.add(`http://localhost:${daemonPort}`);
    allowed.add(`http://127.0.0.1:${daemonPort}`);
  }
  const customOrigin = process.env['ROUTERSYNC_UI_ORIGIN'];
  if (customOrigin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(customOrigin)) {
    allowed.add(customOrigin);
  }
  return allowed.has(originHeader);
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const sanitized = sanitizeObject(data);
  const body = JSON.stringify(sanitized);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  error: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify({ error, message });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
