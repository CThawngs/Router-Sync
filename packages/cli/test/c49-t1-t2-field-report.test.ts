/**
 * packages/cli/test/c49-t1-t2-field-report.test.ts
 *
 * Tickets C49-T1 & C49-T2 (`Phục vụ: S9, S10`):
 *  - T1: Strictly read-only `routersync field-report` CLI command, path safety guards,
 *        <= 8 output bundle contract, Stage-1 Scrubber + Stage-2 Independent Pre-Write Scanner.
 *  - T2: Purely data-measured `anomalies.json` detector covering all 8 required anomaly codes
 *        with `timeline.jsonl` evidence IDs and `sourceFile` provenance.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateFreeze,
  appendApplyReceipt,
  deactivateFreeze,
  markApplyReceiptRolledBack,
  openBetterSqlite3,
} from '@routersync/core';
import { COMMAND_CLASSES } from '../src/command-classification.js';
import { createCliProgram } from '../src/index.js';
import {
  FIELD_REPORT_BUNDLE_FILES,
  assertFieldReportOutDir,
  runFieldReportCommand,
} from '../src/commands/field-report.js';
import { detectFieldAnomalies } from '../src/commands/field-report-anomalies.js';
import { scanSerializedFieldReportOutputs } from '../src/commands/field-report-scanner.js';
import { scrubFieldReportValue } from '../src/commands/field-report-scrubber.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const createdTmpDirs: string[] = [];

function makeTmpDir(prefix = 'rs-c49-t1-'): string {
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

interface FileSnapshot {
  relPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

function snapshotTree(rootDir: string): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  function walk(cur: string): void {
    const entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
      const st = fs.statSync(abs);
      if (ent.isDirectory()) {
        out.push({ relPath: `${rel}/`, sha256: 'DIR', size: 0, mtimeMs: st.mtimeMs });
        walk(abs);
      } else {
        const buf = fs.readFileSync(abs);
        out.push({
          relPath: rel,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return out;
}

function buildRuntimeOpenAiSecret(): string {
  return ['sk', 'proj', 'C49UnitSecret9876543210abcdefghij'].join('-');
}

function buildRuntimeCredUrl(): string {
  return ['https://', 'opsadmin', ':', 'Sup3rS3cretPw', '@', 'router.test:8443/v1?api_key=tok_998877665544'].join('');
}

function seedRichFieldState(root: string): {
  stateDir: string;
  configPath: string;
  dbPath: string;
} {
  const stateDir = path.join(root, 'state');
  const plansDir = path.join(stateDir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const dbPath = path.join(root, 'omni.sqlite');
  const db = openBetterSqlite3(dbPath, { restrictToDir: root });
  db.exec(`
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT);
    CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
  `);
  db.prepare(
    'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'conn-1',
    'openai',
    'OpenAI Main',
    'api_key',
    1,
    buildRuntimeOpenAiSecret(),
    JSON.stringify({ prefix: 'openai', baseUrl: 'http://127.0.0.1:9/v1' })
  );
  db.prepare('INSERT INTO combos (id, name, data) VALUES (?, ?, ?)').run(
    'c-main',
    'rs-main',
    JSON.stringify({
      models: [{ model: 'openai/gpt-4o' }, { model: 'openai/gpt-4o-mini' }],
      strategy: 'priority',
    })
  );
  db.prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)').run(
    'syncedAvailableModels',
    'openai:conn-1',
    JSON.stringify([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])
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
      `    baseUrl: "${buildRuntimeCredUrl()}"`,
      `    db:`,
      `      path: "${dbPath.replace(/\\/g, '/')}"`,
      '    isolated: true',
      'policy:',
      '  mode: shadow',
      '  schedule:',
      '    sync: "every 15m"',
      '    health: "every 5m"',
      'schedule:',
      '  intervalMinutes: 15',
      'combos:',
      '  - name: rs-main',
      '    role: coding',
      '    routers: [omni]',
      '    size: 2',
      '    pin: ["openai/gpt-4o"]',
      'webhook:',
      '  enabled: true',
      `  url: "${buildRuntimeCredUrl()}"`,
      '',
    ].join('\n'),
    'utf8'
  );

  // Seed apply + rollback + freeze + unfreeze lifecycle in stateDir
  const r1 = appendApplyReceipt(stateDir, {
    target: 'router:omni/rs-main',
    planHash: 'aabbccddeeff0011',
    appliedAt: '2026-11-26T10:05:00.000Z',
    appliedAtLevel: 'propose',
    authorizedVia: 'interactive-tty',
    success: true,
    readBackVerified: true,
    readBackLevel: 'db-only',
    rolledBack: false,
    snapshotOrBackupRef: 'snap-001',
  });
  markApplyReceiptRolledBack(stateDir, {
    target: 'router:omni/rs-main',
    snapshotOrBackupRef: r1.snapshotOrBackupRef,
  });
  activateFreeze(stateDir, 'drill-freeze-check', Date.parse('2026-11-26T10:10:00.000Z'));
  deactivateFreeze(stateDir, Date.parse('2026-11-26T10:12:00.000Z'));

  const tick1Tele = {
    startedAt: '2026-11-26T10:00:00.000Z',
    endedAt: '2026-11-26T10:00:00.250Z',
    durationMs: 250,
    resources: {
      rssBytes: 64 * 1024 * 1024,
      heapUsedBytes: 28 * 1024 * 1024,
      cpuUserMs: 42,
      cpuSystemMs: 11,
    },
    providers: [
      {
        providerId: 'openai',
        router: 'omniroute',
        scanned: true,
        ok: true,
        status: 200,
        label: 'OK',
        errorCode: null,
        latencyMs: 85,
        unverifiable: false,
        scannedModels: ['gpt-4o', 'gpt-4o-mini'],
        routerModels: ['gpt-4o', 'gpt-4o-mini'],
      },
    ],
    combos: [{ router: 'omni', name: 'rs-main', models: ['openai/gpt-4o', 'openai/gpt-4o-mini'] }],
    blockedRemovals: [],
  };
  const tick2Tele = {
    startedAt: '2026-11-26T10:15:00.000Z',
    endedAt: '2026-11-26T10:15:00.310Z',
    durationMs: 310,
    resources: {
      rssBytes: 66 * 1024 * 1024,
      heapUsedBytes: 30 * 1024 * 1024,
      cpuUserMs: 48,
      cpuSystemMs: 14,
    },
    providers: [
      {
        providerId: 'openai',
        router: 'omniroute',
        scanned: true,
        ok: true,
        status: 200,
        label: 'UNCHANGED',
        errorCode: null,
        latencyMs: 95,
        unverifiable: false,
        scannedModels: ['gpt-4o', 'gpt-4o-mini'],
        routerModels: ['gpt-4o', 'gpt-4o-mini'],
      },
    ],
    combos: [{ router: 'omni', name: 'rs-main', models: ['openai/gpt-4o', 'openai/gpt-4o-mini'] }],
    blockedRemovals: [],
  };

  fs.writeFileSync(
    path.join(stateDir, 'tick.log'),
    [
      `2026-11-26T10:00:00.000Z mode=observe requests=1 changed=1 unchanged=0 backoff=0 inbox_added=0 paid-requests=0 tokens=0 llm-calls=0 shrink_blocks={} research_queue=0 detection_latency_ms=na field_telemetry=${JSON.stringify(tick1Tele)}`,
      `2026-11-26T10:15:00.000Z mode=observe requests=1 changed=0 unchanged=1 backoff=0 inbox_added=0 paid-requests=0 tokens=0 llm-calls=0 shrink_blocks={} research_queue=0 detection_latency_ms=na field_telemetry=${JSON.stringify(tick2Tele)}`,
      '',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'status.json'),
    JSON.stringify(
      {
        timestamp: '2026-11-26T10:15:00.000Z',
        startedAt: '2026-11-26T10:15:00.000Z',
        endedAt: '2026-11-26T10:15:00.310Z',
        durationMs: 310,
        mode: 'observe',
        effectiveMode: 'observe',
        requests: 1,
        paidRequests: 0,
        tokens: 0,
        llmCalls: 0,
        changedProviders: 0,
        unchangedProviders: 1,
        backoffSkipped: 0,
        inboxAdded: 0,
        providers: [
          {
            prefix: 'openai',
            label: 'UNCHANGED',
            status: 200,
            models: 2,
            changed: false,
            added: [],
            graceAbsent: [],
            deadConfirmed: [],
            backoffSec: 0,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'tick-catalog.json'),
    JSON.stringify(
      {
        version: 1,
        updatedAt: '2026-11-26T10:15:00.000Z',
        providers: {
          openai: {
            prefix: 'openai',
            router: 'omniroute',
            hash: '1234567890abcdef',
            ids: ['gpt-4o', 'gpt-4o-mini'],
            absenceCounts: {},
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'UNCHANGED',
            updatedAt: '2026-11-26T10:15:00.000Z',
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(plansDir, 'tick-plan.json'),
    JSON.stringify(
      {
        version: 1,
        mode: 'observe',
        planCreatedAt: '2026-11-26T10:15:00.100Z',
        planHash: '0123456789abcdef',
        accounting: { requests: 1, paidRequests: 0, tokens: 0, llmCalls: 0 },
        routerActions: [],
        harnessActions: [],
        blockedRemovals: [],
        detectionLatency: { measuredCount: 0, minMs: null, p50Ms: null, maxMs: null },
      },
      null,
      2
    ),
    'utf8'
  );

  return { stateDir, configPath, dbPath };
}

describe('C49-T1: routersync field-report Read-Only Exporter, Path Guard & Two-Stage Scanner', () => {
  it('registers field-report lazily in index.ts and classifies it as short', () => {
    expect(COMMAND_CLASSES['field-report']).toBe('short');

    const program = createCliProgram();
    const cmd = program.commands.find((c) => c.name() === 'field-report');
    expect(cmd).toBeDefined();

    const longFlags = cmd!.options.map((o) => o.long);
    expect(longFlags).toEqual(
      expect.arrayContaining([
        '--out',
        '--state-dir',
        '--config',
        '--error-rate-threshold',
        '--expected-interval-ms',
        '--slow-tick-ms',
        '--json',
      ])
    );

    const indexSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts'),
      'utf8'
    );
    expect(indexSrc).not.toMatch(/import\s+[^;]*from\s+['"]\.\/commands\/field-report\.js['"]/);
    expect(indexSrc).toMatch(/import\(['"]\.\/commands\/field-report\.js['"]\)/);
  });

  it('exports <= 8 files with zero network calls and preserves <stateDir> + config byte & mtime identity', async () => {
    const root = makeTmpDir('rs-c49-t1-readonly-');
    const { stateDir, configPath, dbPath } = seedRichFieldState(root);
    const outDir = path.join(root, 'exported-bundle');

    const beforeState = snapshotTree(stateDir);
    const beforeCfgStat = fs.statSync(configPath);
    const beforeCfgHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(configPath))
      .digest('hex');
    const beforeDbHash = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('NETWORK_FORBIDDEN_IN_FIELD_REPORT');
    }) as typeof globalThis.fetch;

    try {
      const res = await runFieldReportCommand({
        out: outDir,
        stateDir,
        config: configPath,
        nowMs: Date.parse('2026-11-26T10:20:00.000Z'),
        silent: true,
      });

      expect(process.exitCode ?? 0).toBe(0);
      expect(res.writtenFiles.length).toBeLessThanOrEqual(8);
      expect(res.writtenFiles.sort()).toEqual([...FIELD_REPORT_BUNDLE_FILES].sort());

      const diskFiles = fs.readdirSync(outDir).sort();
      expect(diskFiles.length).toBe(8);
      expect(diskFiles).toEqual([...FIELD_REPORT_BUNDLE_FILES].sort());

      // Strict zero-mutation check on <stateDir>, config, and DB
      expect(snapshotTree(stateDir)).toEqual(beforeState);
      expect(fs.statSync(configPath).mtimeMs).toBe(beforeCfgStat.mtimeMs);
      expect(
        crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')
      ).toBe(beforeCfgHash);
      expect(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(
        beforeDbHash
      );

      // Verify all 8 files content contracts
      const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
      expect(summary.counts.ticks).toBe(2);
      expect(summary.counts.applies).toBe(1);
      expect(summary.counts.rollbacks).toBe(1);
      expect(summary.counts.freezes).toBe(1);
      expect(summary.counts.unfreezes).toBe(1);
      expect(summary.anomalyCount).toBe(0);

      const timelineLines = fs
        .readFileSync(path.join(outDir, 'timeline.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(timelineLines.map((e) => e.kind)).toEqual(
        expect.arrayContaining(['tick', 'apply', 'rollback', 'freeze', 'unfreeze'])
      );
      for (const evt of timelineLines) {
        expect(evt.id).toMatch(/^evt-\d{4,}$/);
        expect(typeof evt.startedAt).toBe('string');
        expect(typeof evt.endedAt).toBe('string');
        expect(typeof evt.sourceFile).toBe('string');
      }

      const providers = JSON.parse(fs.readFileSync(path.join(outDir, 'providers.json'), 'utf8'));
      expect(providers.providers).toHaveLength(1);
      expect(providers.providers[0]).toMatchObject({
        providerId: 'openai',
        scanCount: 2,
        okCount: 2,
        errorCount: 0,
        unverifiableCount: 0,
      });

      const models = JSON.parse(fs.readFileSync(path.join(outDir, 'models.json'), 'utf8'));
      expect(models.models.length).toBe(2);

      const resources = JSON.parse(fs.readFileSync(path.join(outDir, 'resources.json'), 'utf8'));
      expect(resources.samples).toHaveLength(2);
      expect(resources.aggregate.durationMs.max).toBe(310);
      expect(resources.aggregate.rssBytes.max).toBe(66 * 1024 * 1024);

      const configShape = JSON.parse(
        fs.readFileSync(path.join(outDir, 'config-shape.json'), 'utf8')
      );
      expect(configShape.routers[0]).toMatchObject({
        id: 'omni',
        adapter: 'omniroute',
        hasBaseUrl: true,
        hasDbPath: true,
      });
      const rawAllFiles = diskFiles
        .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'))
        .join('\n');
      expect(rawAllFiles).not.toContain('Sup3rS3cretPw');
      expect(rawAllFiles).not.toContain('tok_998877665544');
      expect(rawAllFiles).not.toContain(buildRuntimeOpenAiSecret());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects --out inside <stateDir> (lexical & symlink/junction), bots.json, routines.json, or existing file', async () => {
    const root = makeTmpDir('rs-c49-t1-pathguard-');
    const { stateDir } = seedRichFieldState(root);

    // 1. Exact stateDir & child of stateDir
    expect(() => assertFieldReportOutDir(stateDir, stateDir)).toThrow(
      /FIELD_REPORT_OUT_INSIDE_STATE_DIR/
    );
    expect(() => assertFieldReportOutDir(path.join(stateDir, 'nested-out'), stateDir)).toThrow(
      /FIELD_REPORT_OUT_INSIDE_STATE_DIR/
    );

    // 2. Forbidden OpenMausBot runtime files
    expect(() => assertFieldReportOutDir(path.join(root, 'bots.json'), stateDir)).toThrow(
      /FORBIDDEN_RUNTIME_FILE/
    );
    expect(() => assertFieldReportOutDir(path.join(root, 'routines.json'), stateDir)).toThrow(
      /FORBIDDEN_RUNTIME_FILE/
    );

    // 3. Symlink / junction escape into <stateDir>
    const subInsideState = path.join(stateDir, 'plans');
    const linkOut = path.join(root, 'escape-link');
    fs.symlinkSync(
      subInsideState,
      linkOut,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(() => assertFieldReportOutDir(path.join(linkOut, 'bundle'), stateDir)).toThrow(
      /FIELD_REPORT_OUT_INSIDE_STATE_DIR/
    );

    // 4. Existing regular file passed as --out directory
    const existingFile = path.join(root, 'already-a-file.txt');
    fs.writeFileSync(existingFile, 'hello', 'utf8');
    expect(() => assertFieldReportOutDir(existingFile, stateDir)).toThrow(/INVALID_ARGUMENT/);
  });

  it('enforces Stage-2 independent pre-write scanner all-or-nothing refusal (0 files written on leak)', async () => {
    const root = makeTmpDir('rs-c49-t1-scanner-block-');
    const { stateDir, configPath } = seedRichFieldState(root);

    // Inject raw secret into inbox.json
    const secretKey = buildRuntimeOpenAiSecret();
    fs.writeFileSync(
      path.join(stateDir, 'inbox.json'),
      JSON.stringify({
        updatedAt: '2026-11-26T10:15:00.000Z',
        items: [
          {
            id: 'leak-probe',
            title: `Probe ${secretKey}`,
            type: 'warning',
            timestamp: '2026-11-26T10:15:00.000Z',
            body: `Auth header leaked ${secretKey}`,
            proposed_by: { kind: 'system', source: 'tick' },
          },
        ],
      }),
      'utf8'
    );

    // Direct Stage-2 scanner unit check
    const directScan = scanSerializedFieldReportOutputs({
      'summary.json': JSON.stringify({ note: secretKey }),
    });
    expect(directScan.clean).toBe(false);
    expect(JSON.stringify(directScan.violations)).not.toContain(secretKey);

    // End-to-end refusal when Stage 1 is bypassed: 0 files created in blockedOutDir!
    const blockedOutDir = path.join(root, 'blocked-out');
    let caughtError: Error | null = null;
    try {
      await runFieldReportCommand({
        out: blockedOutDir,
        stateDir,
        config: configPath,
        nowMs: Date.parse('2026-11-26T10:20:00.000Z'),
        silent: true,
        _unsafeSkipStage1ScrubberForScannerTest: true,
      });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain('FIELD_REPORT_SECRET_SCAN_BLOCKED');
    expect(caughtError!.message).not.toContain(secretKey);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(blockedOutDir)).toBe(false);

    // With Stage 1 scrubber active (normal execution), secret is redacted and Stage 2 passes
    process.exitCode = 0;
    const cleanOutDir = path.join(root, 'clean-out');
    const okRes = await runFieldReportCommand({
      out: cleanOutDir,
      stateDir,
      config: configPath,
      nowMs: Date.parse('2026-11-26T10:20:00.000Z'),
      silent: true,
    });
    expect(okRes.summary.scrubSummary.redactedCount).toBeGreaterThan(0);
    expect(scrubFieldReportValue(secretKey).value).toBe('[REDACTED_SECRET]');
  });
});

describe('C49-T2: Measured Anomaly Detector (All 8 Canonical Anomaly Codes)', () => {
  it('detects VACUOUS_DETECTION when zero ticks / zero scans exist in window', () => {
    const anomalies = detectFieldAnomalies({
      timeline: [],
      providers: [],
      models: [],
      combos: [],
      providerCatalogIds: {},
      routerModelIds: {},
      shrinkBlocks: [],
      thresholds: {
        errorRateThreshold: 0.2,
        expectedIntervalMs: null,
        intervalDriftToleranceRatio: 0.5,
        slowTickMs: 30_000,
        shrinkCapRatio: 0.1,
      },
      windowBounds: { startMs: null, endMs: null },
    });

    expect(anomalies.map((a) => a.code)).toContain('VACUOUS_DETECTION');
    const vac = anomalies.find((a) => a.code === 'VACUOUS_DETECTION')!;
    expect(vac.evidence.length).toBeGreaterThan(0);
    expect(vac.sourceFile).toBe('status.json');
  });

  it('detects all remaining 7 anomaly codes purely from measured observations with valid timeline evidence', () => {
    const timeline = [
      {
        id: 'evt-0001',
        line: 1,
        kind: 'tick' as const,
        startedAt: '2026-11-26T00:00:00.000Z',
        endedAt: '2026-11-26T00:00:01.000Z',
        durationMs: 1000,
        mode: 'observe',
        outcome: 'ok',
        sourceFile: 'tick.log',
        metadata: {},
      },
      {
        id: 'evt-0002',
        line: 2,
        kind: 'tick' as const,
        startedAt: '2026-11-26T03:00:00.000Z',
        endedAt: '2026-11-26T03:00:42.000Z',
        durationMs: 42_000,
        mode: 'propose',
        outcome: 'degraded',
        sourceFile: 'tick.log',
        metadata: {},
      },
      {
        id: 'evt-0003',
        line: 3,
        kind: 'tick' as const,
        startedAt: '2026-11-26T06:00:00.000Z',
        endedAt: '2026-11-26T06:00:01.200Z',
        durationMs: 1200,
        mode: 'propose',
        outcome: 'ok',
        sourceFile: 'tick.log',
        metadata: {},
      },
    ];

    const anomalies = detectFieldAnomalies({
      timeline,
      providers: [
        {
          providerId: 'openai',
          scanCount: 3,
          okCount: 1,
          errorCount: 2,
          errorCodes: { '429': 1, '405': 1 },
          latencyMs: { min: 100, p50: 200, p95: 500, max: 500 },
          unverifiableCount: 2,
          unverifiableRate: 2 / 3,
          errorRate: 2 / 3,
          errorEvidenceIds: ['evt-0002', 'evt-0003'],
          sourceFile: 'tick.log',
        },
      ],
      models: [
        {
          modelId: 'gpt-flap',
          providerId: 'openai',
          fullStep: 'openai/gpt-flap',
          observations: [
            { timestamp: '2026-11-26T00:00:00.000Z', status: 'present', timelineId: 'evt-0001' },
            { timestamp: '2026-11-26T03:00:00.000Z', status: 'absent', timelineId: 'evt-0002' },
            { timestamp: '2026-11-26T06:00:00.000Z', status: 'present', timelineId: 'evt-0003' },
          ],
          presentCount: 2,
          absentCount: 1,
          unverifiableCount: 0,
          transitions: 2,
          inCombos: ['omni/rs-main'],
        },
      ],
      combos: [
        {
          router: 'omni',
          name: 'rs-main',
          models: ['openai/gpt-flap', 'openai/ghost-never-existed'],
          sourceFile: 'tick-catalog.json',
        },
      ],
      providerCatalogIds: {
        openai: { ids: ['gpt-flap', 'gpt-new-upstream'], verified: true, sourceFile: 'tick-catalog.json' },
      },
      routerModelIds: {
        openai: { ids: ['gpt-flap', 'gpt-stale-router-only'], sourceFile: 'tick.log' },
      },
      shrinkBlocks: [
        {
          targetId: 'omni/rs-main',
          blockedModels: ['openai/gpt-retire-1', 'openai/gpt-retire-2'],
          timelineId: 'evt-0002',
          sourceFile: 'plans/tick-plan.json',
        },
      ],
      thresholds: {
        errorRateThreshold: 0.2,
        expectedIntervalMs: 15 * 60 * 1000, // 15m over 6h expects ~24 ticks, actual is 3 -> drift!
        intervalDriftToleranceRatio: 0.5,
        slowTickMs: 30_000,
        shrinkCapRatio: 0.1,
      },
      windowBounds: {
        startMs: Date.parse('2026-11-26T00:00:00.000Z'),
        endMs: Date.parse('2026-11-26T06:00:00.000Z'),
      },
    });

    const codes = new Set(anomalies.map((a) => a.code));
    expect(codes).toEqual(
      new Set([
        'MODEL_FLAPPING',
        'PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH',
        'SCAN_COUNT_INTERVAL_DRIFT',
        'TICK_DURATION_SLOW',
        'COMBO_SHRINK_CAP_BLOCKED',
        'PROVIDER_ROUTER_LIST_MISMATCH',
        'COMBO_MODEL_MISSING_FROM_CATALOGS',
      ])
    );

    const validTimelineIds = new Set(timeline.map((t) => t.id));
    for (const anomaly of anomalies) {
      expect(anomaly.evidence.length).toBeGreaterThan(0);
      for (const evId of anomaly.evidence) {
        expect(validTimelineIds.has(evId)).toBe(true);
      }
      expect(anomaly.sourceFile.length).toBeGreaterThan(0);
      expect(typeof anomaly.metrics).toBe('object');
    }
  });
});
