/**
 * test/acceptance/at-150-doctor-c2.test.ts
 *
 * Acceptance Test AT-150: doctor c2 config-file semantics (R16-4).
 *
 * DECISIONS 2026-10-20-01 (safety-first): a machine that was NEVER
 * configured has no `routersync.yaml`. That is a NORMAL S1 state, not a
 * failure, so c2 reports `not_checked` with reason `using_defaults`. Only a
 * config file that EXISTS but cannot be read, or is broken, stays a `fail`.
 *
 * The table below is the whole truth table of c2:
 *
 * | config file          | state       | code               | reason         | overallStatus |
 * |----------------------|-------------|--------------------|----------------|---------------|
 * | missing (ENOENT)     | not_checked | config_missing     | using_defaults | warning       |
 * | present + valid      | pass        | config_readable   | (none)         | warning       |
 * | present + empty      | fail        | config_invalid    | not_a_mapping  | error         |
 * | present + bad YAML   | fail        | config_invalid    | (lint token)   | error         |
 * | present + unreadable | fail        | config_unreadable | (errno)        | error         |
 *
 * `overallStatus` keeps the daemon rule: any `fail` -> 'error', else any
 * `not_checked` -> 'warning', else 'healthy'. With a missing config file and
 * nothing else failing the report is a 'warning', NOT an 'error'.
 *
 * Hermetic: every file lives in a throwaway tmp dir, the router SQLite DBs
 * come from the shared daemon fixture, and the probe URLs point at mock
 * loopback servers owned by THIS test — never the real router ports
 * 20128/30128 (DECISIONS 2026-10-14-04).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import {
  setupDaemonFixture,
  assertDaemonEnvIsHermetic,
  type DaemonFixture,
} from '../harness/daemon-fixture.js';

interface DoctorConditionView {
  id: string;
  condKey: string;
  state: string;
  reason?: string | undefined;
  code?: string | undefined;
  params?: Record<string, string | number> | undefined;
}

interface DoctorBody {
  overallStatus: string;
  conditions: DoctorConditionView[];
}

interface SettingsBody {
  meta: { source: string; generatedAt: string };
  policyMode?: string;
  policyModeSource?: string;
}

describe('Acceptance Test AT-150: doctor c2 config-file semantics (R16-4)', () => {
  let mockOmni: http.Server;
  let mockNine: http.Server;
  let fixture: DaemonFixture;
  let daemon: http.Server;
  let daemonPort: number;
  let caseDir: string;

  beforeAll(async () => {
    // Mock loopback routers so c6 ('routers_reachable') passes: the table
    // below then isolates c2 as the ONLY condition under test.
    mockOmni = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    mockNine = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise<void>((r) => mockOmni.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => mockNine.listen(0, '127.0.0.1', () => r()));

    fixture = await setupDaemonFixture({
      probePorts: {
        omni: (mockOmni.address() as AddressInfo).port,
        nine: (mockNine.address() as AddressInfo).port,
      },
    });
    caseDir = path.join(fixture.tmpDir, 'c2-cases');
    fs.mkdirSync(caseDir, { recursive: true });

    clearProbeCache();
    daemon = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      daemon.listen(0, '127.0.0.1', () => resolve());
    });
    daemonPort = (daemon.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    mockOmni.close();
    mockNine.close();
    fixture.restore();
  });

  /** The config path every case lives under — never the owner's real config. */
  function casePath(name: string): string {
    return path.join(caseDir, name);
  }

  function assertUnderFixtureTmp(p: string): void {
    const rel = path.relative(fixture.tmpDir, path.resolve(p));
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    expect(inside, `${p} must stay inside the throwaway fixture dir`).toBe(true);
  }

  async function getDoctor(): Promise<DoctorBody> {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/doctor`, {
      headers: { Host: `127.0.0.1:${daemonPort}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DoctorBody;
  }

  async function getSettings(): Promise<SettingsBody> {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/settings`, {
      headers: { Host: `127.0.0.1:${daemonPort}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as SettingsBody;
  }

  function c2Of(body: DoctorBody): DoctorConditionView {
    const c2 = body.conditions.find((c) => c.id === 'c2');
    expect(c2, 'doctor report must contain condition c2').toBeDefined();
    return c2 as DoctorConditionView;
  }

  interface C2Case {
    name: string;
    /** Writes/creates the config artefact and returns the path to point at. */
    prepare: () => string;
    expectedState: string;
    expectedCode: string;
    expectedReason?: string | undefined;
    /** Optional pattern the `reason` token must match (errno codes vary per OS). */
    expectedReasonPattern?: RegExp | undefined;
    expectedOverall: 'warning' | 'error';
  }

  const CASES: C2Case[] = [
    {
      name: 'c2 case 1: config file missing (never-configured machine) -> not_checked / config_missing / using_defaults',
      prepare: () => {
        const p = casePath('routersync.yaml');
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        return p;
      },
      expectedState: 'not_checked',
      expectedCode: 'config_missing',
      expectedReason: 'using_defaults',
      expectedOverall: 'warning',
    },
    {
      name: 'c2 case 2: config file present and valid -> pass / config_readable',
      prepare: () => fixture.configPath,
      expectedState: 'pass',
      expectedCode: 'config_readable',
      expectedReason: undefined,
      expectedOverall: 'warning',
    },
    {
      name: 'c2 case 3: config file present but EMPTY -> fail / config_invalid (an empty file is not a config object)',
      prepare: () => {
        const p = casePath('empty.yaml');
        fs.writeFileSync(p, '', 'utf8');
        return p;
      },
      expectedState: 'fail',
      expectedCode: 'config_invalid',
      expectedReason: 'not_a_mapping',
      expectedOverall: 'error',
    },
    {
      name: 'c2 case 4: config file present with MALFORMED YAML (tab indentation) -> fail / config_invalid',
      prepare: () => {
        const p = casePath('malformed-tab.yaml');
        fs.writeFileSync(
          p,
          'policy:\n  mode: manual\nrouters:\n  - id: omniroute\n\tbaseUrl: http://127.0.0.1:1\n',
          'utf8'
        );
        return p;
      },
      expectedState: 'fail',
      expectedCode: 'config_invalid',
      expectedReason: 'tab_indentation',
      expectedOverall: 'error',
    },
    {
      name: 'c2 case 5: config file present with MALFORMED YAML (unclosed flow collection) -> fail / config_invalid',
      prepare: () => {
        const p = casePath('malformed-flow.yaml');
        fs.writeFileSync(p, 'policy: [manual\n', 'utf8');
        return p;
      },
      expectedState: 'fail',
      expectedCode: 'config_invalid',
      expectedReason: 'unclosed_flow',
      expectedOverall: 'error',
    },
    {
      name: 'c2 case 6: config path present but NOT READABLE (directory in place of the file) -> fail / config_unreadable',
      prepare: () => {
        const p = casePath('unreadable.yaml');
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        fs.mkdirSync(p, { recursive: true });
        return p;
      },
      expectedState: 'fail',
      expectedCode: 'config_unreadable',
      expectedReason: undefined,
      expectedReasonPattern: /EISDIR|EACCES|EPERM/,
      expectedOverall: 'error',
    },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      const configPath = c.prepare();
      assertUnderFixtureTmp(configPath);
      process.env['ROUTERSYNC_CONFIG'] = configPath;

      if (fs.existsSync(configPath)) {
        // The shared hermetic guard (AT-127) proves the daemon cannot read
        // outside the throwaway fixture.
        assertDaemonEnvIsHermetic();
      }

      const body = await getDoctor();
      const c2 = c2Of(body);

      expect(c2.state).toBe(c.expectedState);
      expect(c2.code).toBe(c.expectedCode);
      if (c.expectedReason !== undefined) {
        expect(c2.reason).toBe(c.expectedReason);
      }
      if (c.expectedReasonPattern !== undefined) {
        expect(String(c2.reason)).toMatch(c.expectedReasonPattern);
      }
      expect(body.overallStatus).toBe(c.expectedOverall);

      if (c.expectedState === 'fail') {
        // A real failure must be reported as an error, never hidden.
        expect(body.overallStatus).toBe('error');
        // The rest of the report stays untouched (c1..c9 always present).
        expect(body.conditions.map((x) => x.id)).toEqual(
          expect.arrayContaining(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'])
        );
      } else {
        // A missing config must NOT turn the whole report into an error.
        expect(body.overallStatus).not.toBe('error');
      }
    });
  }

  it('c2 case 2b: valid config file keeps params.file (the file name the operator configured)', async () => {
    process.env['ROUTERSYNC_CONFIG'] = fixture.configPath;
    assertDaemonEnvIsHermetic();
    const body = await getDoctor();
    const c2 = c2Of(body);
    expect(c2.state).toBe('pass');
    expect(c2.code).toBe('config_readable');
    expect(c2.params?.file).toBe(path.basename(fixture.configPath));
  });

  it('c2 case 7: /settings reports policyModeSource = "config" when a config file was read', async () => {
    process.env['ROUTERSYNC_CONFIG'] = fixture.configPath;
    assertDaemonEnvIsHermetic();
    const settings = await getSettings();
    expect(settings.policyModeSource).toBe('config');
    expect(settings.policyMode).toBe('manual');
    expect(settings.meta.source).toBe('live');
  });

  it('c2 case 8: /settings reports policyModeSource = "default" and policyMode "manual" when there is no config file', async () => {
    const p = casePath('absent.yaml');
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    process.env['ROUTERSYNC_CONFIG'] = p;
    assertUnderFixtureTmp(p);

    const settings = await getSettings();
    expect(settings.policyModeSource).toBe('default');
    expect(settings.policyMode).toBe('manual');
    expect(settings.meta.source).toBe('live');
  });

  it('c2 case 9: a missing config file leaves the doctor report free of failures other than the deferred ones', async () => {
    const p = casePath('absent.yaml');
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    process.env['ROUTERSYNC_CONFIG'] = p;

    const body = await getDoctor();
    const failing = body.conditions.filter((c) => c.state === 'fail');
    expect(failing.map((c) => c.id)).toEqual([]);
    expect(body.overallStatus).toBe('warning');
  });
});
