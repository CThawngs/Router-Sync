import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createDaemonServer } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-118: Daemon Read-Only Isolation & Applier Exclusion (B-4 / S1 / R9-8)', () => {
  const daemonDir = path.resolve(__dirname, '../../packages/daemon');
  const daemonSrcDir = path.join(daemonDir, 'src');

  it('verifies packages/daemon has 0 external npm dependencies declared (workspace:@routersync/core allowed)', () => {
    const pkgJsonPath = path.join(daemonDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const externalDeps = Object.keys(pkg.dependencies || {}).filter(
      (dep) => !dep.startsWith('@routersync/')
    );
    expect(externalDeps).toEqual([]);
  });

  it('asserts packages/daemon only imports from @routersync/core/readonly and forbids root @routersync/core or other packages', () => {
    const filesToScan: string[] = [];

    function collect(dir: string) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collect(full);
        } else if (ent.name.endsWith('.ts')) {
          filesToScan.push(full);
        }
      }
    }

    collect(daemonSrcDir);
    expect(filesToScan.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(daemonDir, file).replace(/\\/g, '/');

      // Check imports starting with @routersync/
      const importMatches = content.match(/from\s+['"]@routersync\/[^'"]+['"]/g) || [];
      for (const imp of importMatches) {
        if (!imp.includes('@routersync/core/readonly')) {
          violations.push(`${relPath} imports forbidden package entry: "${imp}"`);
        }
      }

      // Check bare import from @routersync/core
      const rootImportMatches = content.match(/from\s+['"]@routersync\/core['"]/g) || [];
      for (const imp of rootImportMatches) {
        violations.push(`${relPath} imports root @routersync/core: "${imp}" (must use @routersync/core/readonly)`);
      }

      // Forbid node:sqlite
      if (content.includes('node:sqlite')) {
        violations.push(`${relPath} contains forbidden import: "node:sqlite"`);
      }
    }

    expect(
      violations,
      `R9-8 Isolation failure: Daemon contains invalid or non-readonly imports:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('asserts allowLiveDbWrite and applier entry points DO NOT exist in packages/daemon source files (B-4)', () => {
    const filesToScan: string[] = [];

    function collect(dir: string) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collect(full);
        } else if (ent.name.endsWith('.ts')) {
          filesToScan.push(full);
        }
      }
    }

    collect(daemonSrcDir);
    expect(filesToScan.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const FORBIDDEN_TOKENS = [
      'allowLiveDbWrite',
      'planCombos',
      'applyMultiRouterSafe',
      'applyPlan',
      '/applier',
      'core/applier',
    ];

    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(daemonDir, file).replace(/\\/g, '/');

      for (const token of FORBIDDEN_TOKENS) {
        if (content.includes(token)) {
          violations.push(`${relPath} contains forbidden token: "${token}"`);
        }
      }
    }

    expect(
      violations,
      `B-4 Isolation failure: Daemon contains applier/write primitives:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('asserts SQLite reader uses @routersync/core/readonly with permanent readonly: true', () => {
    const coreReadonlyCode = fs.readFileSync(
      path.resolve(__dirname, '../../packages/core/src/readonly.ts'),
      'utf8'
    );
    expect(coreReadonlyCode).toContain('readonly: true');
    expect(coreReadonlyCode).not.toContain('readonly: false');
    expect(coreReadonlyCode).not.toContain('allowLiveDbWrite');

    const daemonDbReader = fs.readFileSync(path.join(daemonSrcDir, 'db/reader.ts'), 'utf8');
    expect(daemonDbReader).toContain('@routersync/core/readonly');
    expect(daemonDbReader).not.toContain('allowLiveDbWrite');
  });

  describe('HTTP Server Method Guard', () => {
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

    it.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
      'rejects %s on any endpoint with HTTP 405 read_only_slice and Allow: GET',
      async (method) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
          method,
          headers: { Host: `127.0.0.1:${port}` },
        });

        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET');

        const body = await res.json();
        expect(body).toEqual({
          error: 'read_only_slice',
          message: 'S1 daemon is strictly read-only. Fast-loop and writes arrive in P3b/P4.',
        });
      }
    );
  });
});
