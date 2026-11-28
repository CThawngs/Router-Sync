/**
 * packages/cli/test/c50-k1-k3-rehearsal.test.ts
 *
 * Tickets C50-K1 & C50-K3 (`Phục vụ: S9, S10, key không rời RAM`):
 *  - Isolated `os.tmpdir()` rehearsal seeding 28 provider/env/config secrets across ALL 4
 *    free-text sources (`inbox.json` body, `tick.log` line/note -> `timeline.jsonl`,
 *    `freeze.json` reason, `routersync.yaml` -> `config-shape.json`).
 *  - Run A: Normal 2-stage export (`writtenFiles === 8`, `redactedCount`, 0 external byte leaks,
 *    negative hashes & long model IDs preserved intact, honest `README.md`).
 *  - Run B: Stage-2 refusal (`_unsafeSkipStage1ScrubberForScannerTest: true` -> `exitCode === 1`,
 *    `0` files written, violations recorded across all 4 sources with 0 secret echo).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendApplyReceipt } from '@routersync/core';
import {
  FIELD_REPORT_BUNDLE_FILES,
  runFieldReportCommand,
} from '../src/commands/field-report.js';
import {
  C50_CFG_SECRET_RAW,
  C50_ENV_SECRET_ENCODED,
  C50_ENV_SECRET_RAW,
  buildC50SecretFormatsFixture,
} from './helpers/c50-secret-fixtures.js';

const createdTmpDirs: string[] = [];

function makeRehearsalTmpDir(prefix = 'rs-c50-rehearsal-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.exitCode = 0;
  while (createdTmpDirs.length > 0) {
    const dir = createdTmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('C50-K1 & K3: 28 Secrets × 4 Free-Text Sources Rehearsal in os.tmpdir()', () => {
  it('passes Run A (8 files, 0 byte leaks across 28×4 matrix, negatives intact) and refuses Run B (0 files, exitCode=1)', async () => {
    const root = makeRehearsalTmpDir();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(stateDir, 'plans'), { recursive: true });

    const secrets = buildC50SecretFormatsFixture();
    expect(secrets).toHaveLength(28);

    const longModels = [
      'openrouter/anthropic/claude-3.7-sonnet-20250219:thinking',
      'togethercomputer/Meta-Llama-3.1-405B-Instruct-Turbo',
      'accounts/fireworks/models/deepseek-r1-distill-llama-70b',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    ];
    const safePlanHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const safeUuid = '550e8400-e29b-41d4-a716-446655440000';

    // Source 1: inbox.json body (all 28 items > old 25 cap!)
    fs.writeFileSync(
      path.join(stateDir, 'inbox.json'),
      JSON.stringify(
        {
          updatedAt: '2026-11-28T00:05:00.000Z',
          items: secrets.map((s, idx) => ({
            id: `inbox-${String(idx + 1).padStart(2, '0')}-${safeUuid}`,
            title: `Alert ${idx + 1}`,
            type: 'warning',
            timestamp: '2026-11-28T00:05:00.000Z',
            body: `Inbox leak ${s.id}: ${s.value} on ${longModels[idx % longModels.length]}`,
          })),
        },
        null,
        2
      ),
      'utf8'
    );

    // Source 2: tick.log free-text notes (both KV note=... and JSON field_telemetry.note)
    const tickLines: string[] = [];
    secrets.forEach((s, idx) => {
      const ts = new Date(Date.parse('2026-11-28T00:00:00.000Z') + idx * 1000).toISOString();
      if (idx % 2 === 0) {
        tickLines.push(
          `${ts} mode=observe requests=1 changed=0 unchanged=1 backoff=0 inbox_added=1 shrink_blocks={} note="TickKV ${s.value} sha256:${safePlanHash}"`
        );
      } else {
        const tele = {
          startedAt: ts,
          endedAt: ts,
          durationMs: 95,
          note: `TickJson ${s.value} model=${longModels[idx % longModels.length]}`,
          providers: [
            {
              providerId: 'openrouter',
              router: 'omni',
              scanned: true,
              ok: true,
              status: 200,
              label: 'OK',
              errorCode: null,
              latencyMs: 40,
              unverifiable: false,
              scannedModels: longModels,
              routerModels: longModels,
            },
          ],
          combos: [{ router: 'omni', name: 'rs-main', models: longModels }],
          blockedRemovals: [],
        };
        tickLines.push(
          `${ts} mode=observe requests=1 changed=0 unchanged=1 backoff=0 inbox_added=1 shrink_blocks={} field_telemetry=${JSON.stringify(tele)}`
        );
      }
    });
    fs.writeFileSync(path.join(stateDir, 'tick.log'), `${tickLines.join('\n')}\n`, 'utf8');

    // Source 3: freeze.json reason (all 28 secrets)
    fs.writeFileSync(
      path.join(stateDir, 'freeze.json'),
      JSON.stringify(
        {
          version: 1,
          frozen: true,
          frozenAt: '2026-11-28T00:10:00.000Z',
          reason: `Emergency freeze (${secrets.map((s) => s.value).join(' | ')})`,
        },
        null,
        2
      ),
      'utf8'
    );

    // Valid apply receipt to verify negative hashes survive intact
    appendApplyReceipt(stateDir, {
      target: 'router:omni/rs-main',
      planHash: safePlanHash,
      appliedAt: '2026-11-28T00:08:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: `snap-${safePlanHash}`,
    });

    // Source 4: routersync.yaml -> config-shape.json (combos[].role + apiKeyEnv + extraSecretPrefixes)
    const configPath = path.join(root, 'routersync.yaml');
    const yamlCombos = secrets
      .map(
        (s, idx) =>
          `  - name: "combo-${String(idx + 1).padStart(2, '0')}"\n    role: ${JSON.stringify(`role-${s.value}`)}\n    routers: [omni]\n    size: 2`
      )
      .join('\n');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: omni',
        '    adapter: omniroute',
        '    isolated: true',
        '    auth:',
        '      apiKeyEnv: MY_CUSTOM_ROUTER_CRED',
        'fieldReport:',
        '  extraSecretPrefixes:',
        '    - "mycorp_"',
        'combos:',
        yamlCombos,
        '',
      ].join('\n'),
      'utf8'
    );

    const rehearsalEnv: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      C50_PROVIDER_SECRET: C50_ENV_SECRET_RAW,
      MY_CUSTOM_ROUTER_CRED: C50_CFG_SECRET_RAW,
    };

    // --- RUN A: Normal 2-Stage Export ---
    const outDirA = path.join(root, 'out-clean');
    const resA = await runFieldReportCommand({
      out: outDirA,
      stateDir,
      config: configPath,
      env: rehearsalEnv,
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
      silent: true,
    });

    expect(process.exitCode ?? 0).toBe(0);
    expect(resA.writtenFiles).toHaveLength(8);
    expect([...resA.writtenFiles].sort()).toEqual([...FIELD_REPORT_BUNDLE_FILES].sort());
    expect(resA.summary.inboxSummary.recentItems).toHaveLength(28);
    expect(resA.summary.scrubSummary.redactedCount).toBeGreaterThanOrEqual(28 * 4);

    // Verify tick.log notes were preserved into timeline.jsonl and scrubbed
    const timelineRows = fs
      .readFileSync(path.join(outDirA, 'timeline.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l) as { kind: string; metadata: Record<string, unknown> });
    const tickRows = timelineRows.filter((r) => r.kind === 'tick');
    expect(tickRows).toHaveLength(28);
    for (const row of tickRows) {
      expect(typeof row.metadata['note']).toBe('string');
      expect(String(row.metadata['note'])).toContain('[REDACTED');
    }

    // Independent external byte-level leak scan across ALL 8 exported files
    const combinedOutput = FIELD_REPORT_BUNDLE_FILES.map((f) =>
      fs.readFileSync(path.join(outDirA, f), 'utf8')
    ).join('\n');

    for (const s of secrets) {
      expect(combinedOutput, `Raw secret leaked for ${s.id}`).not.toContain(s.value);
      expect(combinedOutput, `Probe token leaked for ${s.id}`).not.toContain(s.probeToken);
    }
    expect(combinedOutput).not.toContain(C50_ENV_SECRET_RAW);
    expect(combinedOutput).not.toContain(C50_ENV_SECRET_ENCODED);
    expect(combinedOutput).not.toContain(C50_CFG_SECRET_RAW);

    // Negative preservation check in Run A output
    expect(combinedOutput).toContain(safePlanHash);
    expect(combinedOutput).toContain(safeUuid);
    for (const m of longModels) {
      expect(combinedOutput).toContain(m);
    }

    const readmeVi = fs.readFileSync(path.join(outDirA, 'README.md'), 'utf8');
    expect(readmeVi).not.toMatch(/`0`\s*lộ\s*khóa/i);
    expect(readmeVi).toMatch(/lần xuất đầu tiên|kiểm tra.*bằng mắt/i);

    // --- RUN B: Stage-2 All-or-Nothing Refusal (Stage 1 bypassed) ---
    const outDirB = path.join(root, 'out-refused');
    let blockedErr: (Error & { violations?: Array<{ file: string; line: number; ruleCode: string }> }) | null = null;
    try {
      await runFieldReportCommand({
        out: outDirB,
        stateDir,
        config: configPath,
        env: rehearsalEnv,
        nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
        silent: true,
        _unsafeSkipStage1ScrubberForScannerTest: true,
      });
    } catch (err) {
      blockedErr = err as Error & { violations?: Array<{ file: string; line: number; ruleCode: string }> };
    }

    expect(blockedErr).not.toBeNull();
    expect(blockedErr!.message).toContain('FIELD_REPORT_SECRET_SCAN_BLOCKED');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(outDirB)).toBe(false);
    expect(Array.isArray(blockedErr!.violations)).toBe(true);
    expect(blockedErr!.violations!.length).toBeGreaterThanOrEqual(28);

    const flaggedFiles = new Set(blockedErr!.violations!.map((v) => v.file));
    expect(flaggedFiles.has('summary.json')).toBe(true);
    expect(flaggedFiles.has('timeline.jsonl')).toBe(true);
    expect(flaggedFiles.has('config-shape.json')).toBe(true);

    const errDump = `${blockedErr!.message} ${JSON.stringify(blockedErr!.violations)}`;
    for (const s of secrets) {
      expect(errDump).not.toContain(s.probeToken);
    }
  });

  it('extracts ${VAR} YAML interpolations and fieldReport.extraSecretEnvVars for both stages (kills M2)', async () => {
    const root = makeRehearsalTmpDir('rs-c50-envinterp-');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const interpVal = 'Interp99!@#$';
    const extraEnvVal = 'ExtraEnv88%&';
    fs.writeFileSync(
      path.join(stateDir, 'tick.log'),
      `${JSON.stringify({
        timestamp: '2026-11-28T01:00:00.000Z',
        mode: 'observe',
        note: `Raw=${interpVal} Encoded=${encodeURIComponent(interpVal)} Extra=${extraEnvVal}`,
      })}\n`,
      'utf8'
    );

    const configPath = path.join(root, 'routersync.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: omni',
        '    adapter: omniroute',
        '    isolated: true',
        '    baseUrl: "http://127.0.0.1:8080/${CUSTOM_INTERP_CRED}"',
        'fieldReport:',
        '  extraSecretEnvVars:',
        '    - CUSTOM_DECLARED_VAR',
        '',
      ].join('\n'),
      'utf8'
    );

    const env: NodeJS.ProcessEnv = {
      CUSTOM_INTERP_CRED: interpVal,
      CUSTOM_DECLARED_VAR: extraEnvVal,
    };

    const outClean = path.join(root, 'clean');
    const res = await runFieldReportCommand({
      out: outClean,
      stateDir,
      config: configPath,
      env,
      silent: true,
    });
    expect(res.summary.scrubSummary.redactedCount).toBeGreaterThanOrEqual(3);
    const timelineText = fs.readFileSync(path.join(outClean, 'timeline.jsonl'), 'utf8');
    expect(timelineText).not.toContain(interpVal);
    expect(timelineText).not.toContain(encodeURIComponent(interpVal));
    expect(timelineText).not.toContain(extraEnvVal);
  });
});
