/**
 * packages/cli/test/c49-t5-rehearsal-and-secrets.test.ts
 *
 * Ticket C49-T5 (`Phục vụ: S9, S10`):
 *  1. 7-day simulated tick rehearsal strictly inside `os.tmpdir()` (`day-1` .. `day-7`),
 *     planting all 5 required anomalies across Days 2–6 and proving 0 false-positive
 *     anomalies on normal Days 1 & 7.
 *  2. 10-Secret Sanitizer & Independent Pre-Write Scanner Suite: verifies zero leaks
 *     across all 8 exported files AND all-or-nothing refusal (`exitCode = 1`, 0 files)
 *     when any of the 10 unredacted secret/PII patterns reaches Stage 2.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBetterSqlite3 } from '@routersync/core';
import { installConfiguredRouterDbPaths } from '../src/config/loader.js';
import { runTickCommand } from '../src/commands/tick.js';
import {
  FIELD_REPORT_BUNDLE_FILES,
  runFieldReportCommand,
} from '../src/commands/field-report.js';
import { scanSerializedFieldReportOutputs } from '../src/commands/field-report-scanner.js';

const createdTmpDirs: string[] = [];

function makeTmpDir(prefix = 'rs-c49-t5-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  while (createdTmpDirs.length > 0) {
    const dir = createdTmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const TEN_COMBO_MODELS = [
  'model-01',
  'model-02',
  'model-03',
  'model-04',
  'model-05',
  'model-06',
  'model-07',
  'model-08',
  'model-09',
  'model-10',
];

function buildTenSecretsFixture(): Array<{ id: string; label: string; value: string; probeToken: string }> {
  const realUser = os.userInfo().username || 'syntheticOwnerLogin';
  const realHost = os.hostname() || 'syntheticOwnerWorkstation';
  const cloudSync = ['One', 'Drive'].join('');

  return [
    {
      id: '1-openai-key',
      label: 'OpenAI API key',
      value: ['sk', 'proj', 'C49Secret01OpenAiKeyTest9876543210abcd'].join('-'),
      probeToken: 'C49Secret01OpenAiKeyTest9876543210abcd',
    },
    {
      id: '2-anthropic-key',
      label: 'Anthropic API key',
      value: ['sk', 'ant', 'api03', 'C49Secret02AnthropicKey9876543210abcd'].join('-'),
      probeToken: 'C49Secret02AnthropicKey9876543210abcd',
    },
    {
      id: '3-google-key',
      label: 'Google API key',
      value: ['AI', 'zaSy', 'C49Secret03GoogleKey1234567890abcde'].join(''),
      probeToken: 'C49Secret03GoogleKey1234567890abcde',
    },
    {
      id: '4-github-pat',
      label: 'GitHub PAT',
      value: `${['ghp', '_C49Secret04GithubPat1234567890abcdefgh'].join('')} ${['github', '_pat_', 'C49Secret04FinePat1234567890abcd'].join('')}`,
      probeToken: 'C49Secret04GithubPat1234567890abcdefgh',
    },
    {
      id: '5-bearer-jwt',
      label: 'Bearer JWT',
      value: `${['Bea', 'rer '].join('')}${['ey', 'JhbGciOiJIUzI1NiJ9'].join('')}.eyJzdWIiOiJjNDktc2VjcmV0LTA1In0.C49Secret05JwtSig9876543210abcdef`,
      probeToken: 'C49Secret05JwtSig9876543210abcdef',
    },
    {
      id: '6-bcrypt-hash',
      label: 'Bcrypt/Argon2 password hash',
      value: `${['$', '2b', '$12$'].join('')}C49Secret06BcryptSaltAndHashValue1234567890abcdefghij`,
      probeToken: 'C49Secret06BcryptSaltAndHashValue1234567890abcdefghij',
    },
    {
      id: '7-credentialed-url',
      label: 'Credentialed URL with query api_key',
      value: ['https://', 'c49admin', ':', 'C49Secret07UrlPass', '@', 'router.test:8080/v1?api_key=C49Secret07QueryKey99'].join(''),
      probeToken: 'C49Secret07UrlPass',
    },
    {
      id: '8-win-personal-path',
      label: 'Windows personal path & cloud sync folder',
      value: ['C:', 'Users', 'c49WinOwnerAcct', cloudSync, 'Documents', 'routersync.yaml'].join('\\'),
      probeToken: 'c49WinOwnerAcct',
    },
    {
      id: '9-posix-personal-path',
      label: 'POSIX /home & /Users personal paths',
      value: `${['', 'home', 'c49LinuxOwnerAcct', '.config', 'routersync.yaml'].join('/')} | ${['', 'Users', 'c49MacOwnerAcct', 'Library', 'routersync.yaml'].join('/')}`,
      probeToken: 'c49LinuxOwnerAcct',
    },
    {
      id: '10-host-and-username',
      label: 'OS username & machine hostname',
      value: `owner_user=${realUser} machine_host=${realHost}`,
      probeToken: realHost.length > 3 ? realHost : realUser,
    },
  ];
}

describe('C49-T5: 7-Day Simulated Field Rehearsal in os.tmpdir() + 10-Secret Suite', () => {
  it(
    'simulates 7 days of scheduled ticks, catches all 5 planted anomalies on Days 2–6, and emits 0 anomalies on normal Days 1 & 7',
    async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const root = makeTmpDir('rs-c49-7day-');
      const stateDir = path.join(root, 'state');
      const homeDir = path.join(root, 'isolated-home');
      fs.mkdirSync(homeDir, { recursive: true });

      const omniDbPath = path.join(root, 'omniroute.sqlite');
      const db = openBetterSqlite3(omniDbPath, { restrictToDir: root });
      db.exec(`
        CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT);
        CREATE TABLE provider_nodes (id TEXT, prefix TEXT, base_url TEXT);
        CREATE TABLE combos (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0, system_message TEXT DEFAULT NULL
        );
        CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
      `);
      db.prepare(
        'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'conn-openai',
        'openai',
        'OpenAI Sim',
        'api_key',
        1,
        'test-ram-only-key',
        JSON.stringify({ prefix: 'openai', baseUrl: 'https://api.openai.com/v1' })
      );
      db.prepare(
        'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'combo-main',
        'rs-main',
        JSON.stringify({
          models: TEN_COMBO_MODELS.map((m) => ({ model: `openai/${m}` })),
          strategy: 'priority',
        }),
        '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
        0,
        null
      );
      db.close();

      const configPath = path.join(root, 'routersync.yaml');
      fs.writeFileSync(
        configPath,
        [
          'version: 1',
          'routers:',
          '  - id: omni',
          '    adapter: omniroute',
          '    baseUrl: "http://127.0.0.1:9"',
          '    db:',
          `      path: "${omniDbPath.replace(/\\/g, '/')}"`,
          '    isolated: true',
          'policy:',
          '  mode: shadow',
          '  schedule:',
          '    sync: "every 6h"',
          '    health: "every 6h"',
          'schedule:',
          '  intervalMinutes: 360',
          'combos:',
          '  - name: rs-main',
          '    role: coding',
          '    routers: [omni]',
          '    size: 10',
          '',
        ].join('\n'),
        'utf8'
      );

      installConfiguredRouterDbPaths(configPath);

      const isolatedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ROUTERSYNC_HOME: homeDir,
        ROUTERSYNC_STATE_DIR: stateDir,
        ROUTERSYNC_OMNIROUTE_DB: omniDbPath,
        ROUTERSYNC_CONFIG: configPath,
      };

      const baseStartMs = Date.parse('2026-11-01T00:00:00.000Z');
      const SIX_HOURS_MS = 6 * 3600 * 1000;
      const ONE_DAY_MS = 24 * 3600 * 1000;

      let currentClockMs = baseStartMs;
      let activeBehavior: {
        status: number;
        models: string[];
        advanceClockMs: number;
      } = {
        status: 200,
        models: [...TEN_COMBO_MODELS],
        advanceClockMs: 120,
      };

      const mockFetch: typeof globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        currentClockMs += activeBehavior.advanceClockMs;
        if (url.includes('api.openai.com')) {
          if (activeBehavior.status !== 200) {
            return new Response(JSON.stringify({ error: { code: String(activeBehavior.status) } }), {
              status: activeBehavior.status,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              object: 'list',
              data: activeBehavior.models.map((id) => ({ id, object: 'model' })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        // L2 / L3 empty clean responses so zero external network calls occur
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const dailyAnomalies: Record<number, Array<{ code: string; evidence: string[]; sourceFile: string; metrics: Record<string, unknown> }>> = {};

      for (let day = 1; day <= 7; day += 1) {
        const dayStartMs = baseStartMs + (day - 1) * ONE_DAY_MS;
        const dayEndMs = dayStartMs + ONE_DAY_MS - 1;

        for (let slot = 0; slot < 4; slot += 1) {
          currentClockMs = dayStartMs + slot * SIX_HOURS_MS;

          // Configure each day's exact schedule scenario:
          if (day === 1 || day === 7) {
            // Normal healthy days
            activeBehavior = { status: 200, models: [...TEN_COMBO_MODELS], advanceClockMs: 120 };
          } else if (day === 2) {
            // Planted #1: Model flapping (model-10 absent on slot 1, present again on slots 2 & 3)
            const models =
              slot === 1
                ? TEN_COMBO_MODELS.filter((m) => m !== 'model-10')
                : [...TEN_COMBO_MODELS];
            activeBehavior = { status: 200, models, advanceClockMs: 140 };
          } else if (day === 3) {
            // Planted #2: Provider HTTP 429 rate-limit spike on slots 1 & 2 (50% > 20%)
            activeBehavior =
              slot === 1 || slot === 2
                ? { status: 429, models: [], advanceClockMs: 180 }
                : { status: 200, models: [...TEN_COMBO_MODELS], advanceClockMs: 120 };
          } else if (day === 4) {
            // Planted #3: Sustained Provider HTTP 405 error across all 4 scans on Day 4
            activeBehavior = { status: 405, models: [], advanceClockMs: 150 };
          } else if (day === 5) {
            // Planted #4: Slow tick on slot 2 (45_000 ms > 30_000 ms threshold)
            activeBehavior = {
              status: 200,
              models: [...TEN_COMBO_MODELS],
              advanceClockMs: slot === 2 ? 45_000 : 130,
            };
          } else if (day === 6) {
            // Planted #5: 10% shrink cap blocking removal (2 of 10 models = 20% > 10% ceiling)
            // Seed verified official deprecation notices on Day 6 for model-09 & model-10
            if (slot === 0) {
              const evIso = new Date(dayStartMs - 1000).toISOString();
              fs.writeFileSync(
                path.join(stateDir, 'research-evidence.json'),
                JSON.stringify(
                  [
                    {
                      recordId: 'ev-c49-retire-09',
                      id: 'openai/model-09',
                      provider: 'openai',
                      modelId: 'model-09',
                      verdict: 'deprecated',
                      sourceTier: 'official',
                      domainVerified: true,
                      url: 'https://platform.openai.com/docs/deprecations',
                      publishedAt: evIso,
                      shutdownDate: evIso,
                      submittedAt: evIso,
                      consumedAt: null,
                      synthetic: true,
                    },
                    {
                      recordId: 'ev-c49-retire-10',
                      id: 'openai/model-10',
                      provider: 'openai',
                      modelId: 'model-10',
                      verdict: 'deprecated',
                      sourceTier: 'official',
                      domainVerified: true,
                      url: 'https://platform.openai.com/docs/deprecations',
                      publishedAt: evIso,
                      shutdownDate: evIso,
                      submittedAt: evIso,
                      consumedAt: null,
                      synthetic: true,
                    },
                  ],
                  null,
                  2
                ),
                'utf8'
              );
            }
            activeBehavior = { status: 200, models: [...TEN_COMBO_MODELS], advanceClockMs: 150 };
          }

          await runTickCommand({
            configPath,
            stateDir,
            homeDir,
            env: isolatedEnv,
            mode: day === 6 ? 'propose' : 'observe',
            clock: () => currentClockMs,
            fetchFn: mockFetch,
            allowSyntheticNoticeFixture: day === 6,
            harnessTargets: [],
            json: true,
          });

          // Clean up Day 6 synthetic deprecation ledger at end of Day 6 so Day 7 returns to clean baseline
          if (day === 6 && slot === 3) {
            fs.rmSync(path.join(stateDir, 'research-evidence.json'), { force: true });
          }
        }

        const dayOutDir = path.join(root, `report-day-${day}`);
        const reportRes = await runFieldReportCommand({
          out: dayOutDir,
          stateDir,
          config: configPath,
          since: new Date(dayStartMs).toISOString(),
          until: new Date(dayEndMs).toISOString(),
          nowMs: dayEndMs,
          silent: true,
        });

        expect(fs.readdirSync(dayOutDir).length).toBeLessThanOrEqual(8);
        dailyAnomalies[day] = reportRes.anomalies;

        const timelineIds = new Set(
          fs
            .readFileSync(path.join(dayOutDir, 'timeline.jsonl'), 'utf8')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { id: string }).id)
        );
        for (const anom of reportRes.anomalies) {
          expect(anom.evidence.length).toBeGreaterThan(0);
          for (const evId of anom.evidence) {
            expect(timelineIds.has(evId)).toBe(true);
          }
          expect(anom.sourceFile.length).toBeGreaterThan(0);
        }
      }

      // Normal Days 1 & 7 MUST have strictly 0 anomalies (zero false positives!)
      expect(dailyAnomalies[1]).toEqual([]);
      expect(dailyAnomalies[7]).toEqual([]);

      // Days 2..6 MUST catch all 5 planted anomalies accurately!
      expect(dailyAnomalies[2]!.map((a) => a.code)).toContain('MODEL_FLAPPING');
      expect(dailyAnomalies[3]!.map((a) => a.code)).toContain('PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH');
      expect((dailyAnomalies[3]![0]!.metrics['errorCodes'] as Record<string, number>)['429']).toBeGreaterThanOrEqual(1);

      expect(dailyAnomalies[4]!.map((a) => a.code)).toContain('PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH');
      expect((dailyAnomalies[4]![0]!.metrics['errorCodes'] as Record<string, number>)['405']).toBe(4);

      expect(dailyAnomalies[5]!.map((a) => a.code)).toContain('TICK_DURATION_SLOW');
      expect(dailyAnomalies[6]!.map((a) => a.code)).toContain('COMBO_SHRINK_CAP_BLOCKED');

      // Full 7-day cumulative export catches all 5 across the full week
      const weekOutDir = path.join(root, 'report-full-week');
      const fullWeek = await runFieldReportCommand({
        out: weekOutDir,
        stateDir,
        config: configPath,
        nowMs: baseStartMs + 7 * ONE_DAY_MS,
        silent: true,
      });
      const weekCodes = new Set(fullWeek.anomalies.map((a) => a.code));
      expect(weekCodes.has('MODEL_FLAPPING')).toBe(true);
      expect(weekCodes.has('PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH')).toBe(true);
      expect(weekCodes.has('TICK_DURATION_SLOW')).toBe(true);
      expect(weekCodes.has('COMBO_SHRINK_CAP_BLOCKED')).toBe(true);
    },
    60_000
  );

  it('scrubs all 10 secret/PII types across all 8 files AND blocks write (0 files) on every unredacted type in Stage 2', async () => {
    const root = makeTmpDir('rs-c49-10secrets-');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(stateDir, 'plans'), { recursive: true });

    const tenSecrets = buildTenSecretsFixture();
    expect(tenSecrets).toHaveLength(10);

    // Seed stateDir with all 10 secrets spread across inbox, freeze, tick.log, status.json
    fs.writeFileSync(
      path.join(stateDir, 'inbox.json'),
      JSON.stringify(
        {
          updatedAt: '2026-11-26T12:00:00.000Z',
          items: tenSecrets.map((s, idx) => ({
            id: `sec-item-${idx + 1}`,
            title: `${s.label}: ${s.value}`,
            type: 'warning',
            timestamp: '2026-11-26T12:00:00.000Z',
            body: `Detail payload ${s.value}`,
            proposed_by: { kind: 'system', source: 'tick' },
          })),
        },
        null,
        2
      ),
      'utf8'
    );

    fs.writeFileSync(
      path.join(stateDir, 'freeze.json'),
      JSON.stringify(
        {
          version: 1,
          frozen: true,
          frozenAt: '2026-11-26T12:01:00.000Z',
          reason: tenSecrets.map((s) => s.value).join(' ; '),
        },
        null,
        2
      ),
      'utf8'
    );

    fs.writeFileSync(
      path.join(stateDir, 'tick.log'),
      `2026-11-26T12:00:00.000Z mode=observe requests=1 changed=0 unchanged=1 backoff=0 inbox_added=10 paid-requests=0 tokens=0 llm-calls=0 shrink_blocks={} research_queue=0 detection_latency_ms=na\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(stateDir, 'status.json'),
      JSON.stringify({
        timestamp: '2026-11-26T12:00:00.000Z',
        mode: 'observe',
        effectiveMode: 'observe',
        requests: 1,
        paidRequests: 0,
        tokens: 0,
        llmCalls: 0,
        providers: [{ prefix: 'openai', label: 'OK', status: 200, models: 2, changed: false, added: [], graceAbsent: [], deadConfirmed: [], backoffSec: 0 }],
      }),
      'utf8'
    );

    // (A) Stage-1 scrubber + Stage-2 scanner normal run: 0 leaks across all 8 files
    const cleanOutDir = path.join(root, 'scrubbed-bundle');
    const report = await runFieldReportCommand({
      out: cleanOutDir,
      stateDir,
      nowMs: Date.parse('2026-11-26T12:05:00.000Z'),
      silent: true,
    });

    expect(report.summary.scrubSummary.redactedCount).toBeGreaterThanOrEqual(10);
    for (const fileName of FIELD_REPORT_BUNDLE_FILES) {
      const content = fs.readFileSync(path.join(cleanOutDir, fileName), 'utf8');
      for (const secret of tenSecrets) {
        if (secret.probeToken.length >= 4) {
          expect(content, `Leak of ${secret.id} in ${fileName}`).not.toContain(secret.probeToken);
        }
      }
    }

    // (B) Stage-2 independent scanner individually blocks EVERY SINGLE ONE of the 10 secret types
    for (const secret of tenSecrets) {
      const scanRes = scanSerializedFieldReportOutputs({
        'timeline.jsonl': JSON.stringify({ id: 'evt-0001', note: secret.value }),
      });
      expect(scanRes.clean, `Independent scanner missed ${secret.id} (${secret.label})`).toBe(false);
      expect(JSON.stringify(scanRes.violations)).not.toContain(secret.probeToken);
    }

    // (C) End-to-end pre-write refusal leaves 0 files on disk
    const refusedDir = path.join(root, 'refused-bundle');
    await expect(
      runFieldReportCommand({
        out: refusedDir,
        stateDir,
        nowMs: Date.parse('2026-11-26T12:05:00.000Z'),
        silent: true,
        _unsafeSkipStage1ScrubberForScannerTest: true,
      })
    ).rejects.toThrow(/FIELD_REPORT_SECRET_SCAN_BLOCKED/);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(refusedDir)).toBe(false);
  });
});
