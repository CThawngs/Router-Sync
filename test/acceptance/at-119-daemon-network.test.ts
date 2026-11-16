import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createDaemonServer } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-119: Daemon Network Hardening & Host/Origin Guards (T3-DAEMON-SEC)', () => {
  let server: http.Server;
  let port: number;
  let fixture: DaemonFixture | undefined;

  beforeAll(async () => {
    // R11-0: hermetic fixture — env overrides point config/DBs/probe URLs at tmp state.
    fixture = await setupDaemonFixture();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture?.restore();
  });

  it('strictly rejects binding to non-loopback addresses', () => {
    expect(() => {
      createDaemonServer({ host: '0.0.0.0' as any });
    }).toThrow(/Refusing to bind daemon to non-loopback address/);

    expect(() => {
      createDaemonServer({ host: '192.168.1.1' as any });
    }).toThrow(/Refusing to bind daemon to non-loopback address/);
  });

  it('accepts loopback Host headers (127.0.0.1 and localhost)', async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `localhost:${port}` },
    });
    expect(res2.status).toBe(200);
  });

  it('rejects foreign or spoofed Host headers with HTTP 403 invalid_host', async () => {
    const res = await new Promise<{ status: number; body: { error: string } }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/health',
          method: 'GET',
          headers: { Host: `evil-attacker.io:${port}` },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) });
          });
        }
      );
      req.end();
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_host');
  });

  it('allows requests with missing Origin (CLI / curl / internal scripts)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
  });

  it('allows allowlisted UI and daemon loopback Origin headers', async () => {
    // 3100 unified Vite UI port
    const res1 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://localhost:3100',
      },
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://127.0.0.1:3100',
      },
    });
    expect(res2.status).toBe(200);

    // Daemon's own origin
    const res3 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    expect(res3.status).toBe(200);
  });

  it('allows custom loopback origin via ROUTERSYNC_UI_ORIGIN env var', async () => {
    process.env['ROUTERSYNC_UI_ORIGIN'] = 'http://127.0.0.1:4173';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: 'http://127.0.0.1:4173',
        },
      });
      expect(res.status).toBe(200);
    } finally {
      delete process.env['ROUTERSYNC_UI_ORIGIN'];
    }
  });

  it('rejects foreign or non-allowlisted Origin headers with HTTP 403 invalid_origin', async () => {
    // Non-allowlisted loopback port
    const res1 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://localhost:9999',
      },
    });
    expect(res1.status).toBe(403);
    const body1 = (await res1.json()) as { error?: string };
    expect(body1.error).toBe('invalid_origin');

    // Foreign third-party domain
    const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://evil.com',
      },
    });
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as { error?: string };
    expect(body2.error).toBe('invalid_origin');
  });

  it('never emits open CORS wildcard Access-Control-Allow-Origin: *', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('enforces maxHeaderSize (8192 bytes)', async () => {
    const largeHeader = 'X-Padding: ' + 'A'.repeat(9000);
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/health',
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${port}`,
        'X-Large-Payload': largeHeader,
      },
    };

    const statusOrErr = await new Promise<number | string>((resolve) => {
      const req = http.request(options, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (err) => {
        resolve(err.message);
      });
      req.end();
    });

    // Node http parser returns 431 Request Header Fields Too Large or closes connection on oversized header
    if (typeof statusOrErr === 'number') {
      expect([431, 400]).toContain(statusOrErr);
    } else {
      expect(statusOrErr).toMatch(/(HPE_HEADER_OVERFLOW|ECONNRESET|socket hang up)/);
    }
  });
});
