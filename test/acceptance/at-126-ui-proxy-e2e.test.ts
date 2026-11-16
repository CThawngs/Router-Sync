/**
 * test/acceptance/at-126-ui-proxy-e2e.test.ts
 *
 * Acceptance Test AT-126: UI -> Vite Proxy -> Daemon E2E Verification
 *
 * Verifies that the Vite development server proxy forwards API requests cleanly
 * to the daemon server (changeOrigin: true), and that direct access with foreign
 * Host or Origin headers is rejected with HTTP 403.
 *
 * Runs strictly against in-process ephemeral test servers on loopback ports.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDaemonServer } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-126: UI -> Vite Proxy -> Daemon E2E', () => {
  let daemonServer: http.Server;
  let daemonPort: number;
  let viteServer: any;
  let vitePort: number;
  let fixture: DaemonFixture | undefined;

  beforeAll(async () => {
    // R11-0: hermetic fixture — env overrides point config/DBs/probe URLs at tmp state.
    fixture = await setupDaemonFixture();
    // 1. Start daemon on dynamic ephemeral port
    daemonServer = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      daemonServer.listen(0, '127.0.0.1', () => {
        daemonPort = (daemonServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 2. Start Vite server using createServer API pointing proxy to daemonPort
    const { createServer: createViteServer } = await import(
      '../../packages/ui/node_modules/vite/dist/node/index.js'
    );

    viteServer = await createViteServer({
      root: path.resolve(process.cwd(), 'packages/ui'),
      configFile: path.resolve(process.cwd(), 'packages/ui/vite.config.ts'),
      server: {
        port: 0,
        proxy: {
          '/api': {
            target: `http://127.0.0.1:${daemonPort}`,
            changeOrigin: true,
          },
        },
      },
      logLevel: 'silent',
    });
    await viteServer.listen();
    vitePort = (viteServer.httpServer?.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (viteServer) {
      await viteServer.close();
    }
    if (daemonServer) {
      await new Promise<void>((resolve) => daemonServer.close(() => resolve()));
    }
    fixture?.restore();
  });

  it('proxies GET /api/v1/health cleanly through Vite to daemon', async () => {
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/v1/health`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      daemon?: string;
      readOnly?: boolean;
      status?: string;
      meta?: unknown;
    };
    expect(data.daemon).toBe('ok');
    expect(data.readOnly).toBe(true);
    expect(['ok', 'healthy', 'routers_down']).toContain(data.status);
    expect(data.meta).toBeDefined();
  });

  it('rejects direct request with foreign Host evil.example with HTTP 403', async () => {
    const res = await new Promise<{ status: number; body: { error?: string } }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: daemonPort,
          path: '/api/v1/health',
          method: 'GET',
          headers: { Host: `evil.example:${daemonPort}` },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: response.statusCode ?? 0, body: {} });
            }
          });
        }
      );
      req.on('error', () => resolve({ status: 500, body: {} }));
      req.end();
    });

    expect(res.status).toBe(403);
    expect(['invalid_host', 'forbidden_host']).toContain(res.body.error);
  });

  it('rejects direct request with foreign Origin http://evil.example with HTTP 403', async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/health`, {
      headers: {
        Origin: 'http://evil.example',
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(['invalid_origin', 'forbidden_origin']).toContain(body.error);
  });
});
