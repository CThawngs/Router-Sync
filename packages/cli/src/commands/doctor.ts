/**
 * packages/cli/src/commands/doctor.ts
 *
 * Implements `routersync doctor`.
 * Inspects harness configs (all 9 harnesses), 4-Tier schedule ladder, stale-tick age (`> 2x`),
 * and managed routers to detect:
 *  - Circular dependencies (agent harness upstream pointed at managed router)
 *  - Self-interruption risk
 *  - Stale recurring tick (`lastTickAgeMs > 2 * configuredIntervalMs`)
 *  - Verifies that rollback is runnable without AI/harness assistance
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import {
  isProcessAlive,
  listHarnessCapabilities,
  locateRouterDb,
  openBetterSqlite3,
  parseTickLockPayload,
  readRouterModelState,
  resolveRouterKey,
} from '@routersync/core';
import { loadConfigFile, getDefaultConfigPath, resolveRouterDbPath } from '../config/loader.js';
import {
  describePublicRegistry,
  type PublicRegistryStatus,
} from '../sync/provider-registry.js';
import type { RouterConfig, RouterSyncConfig } from '../config/schema.js';
import { isLowResource, lowResourceReason } from '../low-resource.js';
import { LINUX_CRON_MARKER, WINDOWS_TASK_NAME } from './schedule.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ActiveScheduleTier = 'harness-native' | 'os-scheduler' | 'tick-if-due' | 'daemon' | 'none';

export interface DoctorCommandOptions {
  configPath?: string | undefined;
  hermesConfigPath?: string | undefined;
  dshConfigPath?: string | undefined;
  homeDir?: string | undefined;
  tickStateDir?: string | undefined;
  nowMs?: number | undefined;
  silent?: boolean | undefined;
  probeOsScheduleFn?: (() => { installed: boolean; detail: string }) | undefined;
  json?: boolean | undefined;
  out?: string | undefined;
}

export interface CircularDependencyWarning {
  harness: 'hermes' | 'dsh';
  harnessConfigPath: string;
  routerId: string;
  routerUrl: string;
  severity: 'WARNING';
  message: string;
}

export interface ValidationWarning {
  routerId: string;
  adapter: string;
  severity: 'WARNING';
  message: string;
}

export interface RouterKeyDiagnostic {
  routerId: string;
  adapter: string;
  keyName?: string | undefined;
  keyScope?: 'client' | 'elevated' | undefined;
}

export interface RouterDiagnostic {
  routerId: string;
  adapter: string;
  dbPath: string | null;
  found: boolean;
  readable: boolean;
  tiers?: {
    A: number;
    B: number;
    C: number;
    total: number;
  } | undefined;
  /** Nguồn của con số tiers.A: số model được combo tham chiếu, không phải số model đang bật. */
  basis?: 'combo-members' | undefined;
  /** Số model đang bật theo readRouterModelState; chuỗi khi reader chưa hỗ trợ. */
  available?: number | string | undefined;
}

export interface AppDiagnostic {
  name: string;
  configPath: string | null;
  detected: boolean;
}

export interface ScheduleDiagnostic {
  installed: boolean;
  detail: string;
  activeTier: ActiveScheduleTier;
  configuredIntervalMinutes: number;
  lastTickAt: string | null;
  lastTickAgeMinutes: number | null;
  staleTickWarning: boolean;
  staleThresholdMinutes: number;
}

export type DoctorScheduleCheck = ScheduleDiagnostic;

export interface HarnessScheduleStatus {
  harnessId: string;
  displayName: string;
  detected: boolean;
  zeroTokenNativeCapable: boolean;
  recommendedTier: 'harness-native' | 'os-scheduler';
  activeTier: ActiveScheduleTier;
  detail: string;
}

export interface RankingPolicyDiagnostic {
  present: boolean;
  path: string | null;
}

export interface DoctorReport {
  ok: boolean;
  ready: boolean;
  configError?: string | null;
  os: string;
  arch: string;
  node: string;
  pnpm: string | null;
  build: boolean;
  stateDir: string;
  tickStateDir: string;
  syncStateDir: string;
  configPath: string | null;
  /** C52-R1: public registry availability; REGISTRY_MISSING when unavailable. */
  registry: PublicRegistryStatus;
  rankingPolicy: RankingPolicyDiagnostic;
  routers: RouterDiagnostic[];
  apps: AppDiagnostic[];
  schedule: ScheduleDiagnostic;
  harnessSchedules: HarnessScheduleStatus[];
  nextSteps: string[];
  circularWarnings: CircularDependencyWarning[];
  validationWarnings?: ValidationWarning[];
  authKeys?: RouterKeyDiagnostic[];
  recommendations: string[];
  timestamp: string;
  /** C14 (e): low-resource status and the reason it was activated. */
  lowResource: boolean;
  lowResourceReason: string | null;
}

function parseExplicitIntervalMinutesFromConfig(
  loadedConfig: RouterSyncConfig | null,
  configPath: string | null
): number {
  if (loadedConfig?.schedule?.intervalMinutes) {
    return loadedConfig.schedule.intervalMinutes;
  }
  if (configPath && fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const intervalMatch = raw.match(/\bintervalMinutes\s*:\s*(\d+)/);
      if (intervalMatch?.[1]) {
        const parsed = Number(intervalMatch[1]);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440) return parsed;
      }
      const syncMatch = raw.match(
        /\bsync\s*:\s*['"]?every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i
      );
      if (syncMatch?.[1] && syncMatch[2]) {
        const val = Number(syncMatch[1]);
        const unit = syncMatch[2].toLowerCase();
        if (Number.isFinite(val) && val >= 1) {
          if (unit.startsWith('d')) return val * 1440;
          if (unit.startsWith('h')) return val * 60;
          return val;
        }
      }
    } catch {
      // ignore unreadable file
    }
  }
  return 15;
}

export async function runDoctorCommand(options: DoctorCommandOptions = {}): Promise<DoctorReport> {
  const nowMs = options.nowMs ?? Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const homeDir = options.homeDir ?? os.homedir();
  const circularWarnings: CircularDependencyWarning[] = [];
  const validationWarnings: ValidationWarning[] = [];
  const recommendations: string[] = [];

  function resolveConfigPath(): string | null {
    if (options.configPath && options.configPath.trim().length > 0) {
      return path.resolve(options.configPath.trim());
    }
    if (process.env['ROUTERSYNC_CONFIG']) {
      return path.resolve(process.env['ROUTERSYNC_CONFIG']);
    }
    const localYaml = path.resolve('routersync.yaml');
    if (fs.existsSync(localYaml)) return localYaml;
    const localConfigYaml = path.resolve('config.yaml');
    if (fs.existsSync(localConfigYaml)) return localConfigYaml;
    return getDefaultConfigPath();
  }

  const configPath = resolveConfigPath();
  const configExists = configPath ? fs.existsSync(configPath) : false;

  // 1. Load active router configurations & check validation status
  let rawRouters: Array<{ id: string; adapter: string; validated?: boolean; url: string }> = [
    { id: 'omni', adapter: 'omniroute', validated: false, url: 'http://localhost:30128' },
    { id: 'nine', adapter: '9router', validated: false, url: 'http://localhost:20128' },
  ];
  let configError: string | null = null;
  let loadedConfig: RouterSyncConfig | null = null;

  if (options.configPath || configExists) {
    try {
      const { config } = loadConfigFile(options.configPath);
      loadedConfig = config;
      rawRouters = config.routers.map((r) => ({
        id: r.id,
        adapter: r.adapter,
        validated: Boolean(r.validated),
        url: r.baseUrl ?? (r.adapter === 'omniroute' ? 'http://localhost:30128' : 'http://localhost:20128'),
      }));
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
      // Fall back to defaults
    }
  }

  // Bằng chứng sao lưu gần nhất: sync-last.json trong thư mục state, đủ cả 2 router
  let backupEvidence: string | null = null;
  try {
    const syncStateDir = getSyncStateDir();
    const syncLastPath = path.join(syncStateDir, 'sync-last.json');
    if (fs.existsSync(syncLastPath)) {
      const raw = JSON.parse(fs.readFileSync(syncLastPath, 'utf8')) as {
        at?: string;
        routers?: Record<string, { backup?: string; changed?: string[] }>;
        planHash?: string;
      };
      const syncRouters = raw.routers ?? {};
      const hasBoth = Boolean(syncRouters['9router']?.backup && syncRouters['omniroute']?.backup);
      const backupsExist =
        hasBoth &&
        fs.existsSync(String(syncRouters['9router']?.backup)) &&
        fs.existsSync(String(syncRouters['omniroute']?.backup));
      if (hasBoth && backupsExist && raw.at) {
        backupEvidence = `Đã có bằng chứng sao lưu gần nhất (${raw.at})`;
      }
    }
  } catch {
    backupEvidence = null;
  }

  for (const r of rawRouters) {
    if (!r.validated) {
      if (backupEvidence) {
        recommendations.push(`Router '${r.id}' (${r.adapter}): ${backupEvidence}.`);
        (r as { validated?: boolean }).validated = true;
      } else {
        validationWarnings.push({
          routerId: r.id,
          adapter: r.adapter,
          severity: 'WARNING',
          message: `Chưa có bằng chứng ghi thật cho adapter '${r.adapter}'; giữ chế độ chỉ đọc cho tới khi bạn tự kiểm tra.`,
        });
      }
    }
  }

  const configuredRouters = rawRouters.map((r) => ({ id: r.id, url: r.url }));

  // 2. Check Hermes harness configuration
  const hermesPath = options.hermesConfigPath ?? path.join(homeDir, '.hermes', 'config.json');
  if (fs.existsSync(hermesPath)) {
    try {
      const hermesRaw = fs.readFileSync(hermesPath, 'utf8');
      for (const router of configuredRouters) {
        if (hermesRaw.includes(router.url) || hermesRaw.includes(String(new URL(router.url).port))) {
          circularWarnings.push({
            harness: 'hermes',
            harnessConfigPath: hermesPath,
            routerId: router.id,
            routerUrl: router.url,
            severity: 'WARNING',
            message: `Circular dependency detected: Harness 'hermes' is configured to use router '${router.id}' (${router.url}) as upstream provider. Modifying this router may self-interrupt agent execution.`,
          });
        }
      }
    } catch {
      // Ignored
    }
  }

  // 3. Check DSH harness configuration
  const dshPath = options.dshConfigPath ?? path.join(homeDir, '.dsh', 'config.yml');
  if (fs.existsSync(dshPath)) {
    try {
      const dshRaw = fs.readFileSync(dshPath, 'utf8');
      for (const router of configuredRouters) {
        if (dshRaw.includes(router.url) || dshRaw.includes(String(new URL(router.url).port))) {
          circularWarnings.push({
            harness: 'dsh',
            harnessConfigPath: dshPath,
            routerId: router.id,
            routerUrl: router.url,
            severity: 'WARNING',
            message: `Circular dependency detected: Harness 'dsh' is configured to use router '${router.id}' (${router.url}) as upstream provider. Modifying this router may self-interrupt agent execution.`,
          });
        }
      }
    } catch {
      // Ignored
    }
  }

  if (circularWarnings.length > 0) {
    recommendations.push(
      'Use a direct provider API key or non-managed fallback endpoint for the agent harness itself.',
      'Remember: `routersync rollback` can always be executed independently via CLI without AI assistance.'
    );
  }

  const unvalidatedAdapters = rawRouters.filter((r) => !r.validated);
  if (unvalidatedAdapters.length > 0) {
    recommendations.push(
      'Chưa có bằng chứng ghi thật cho một số adapter. Giữ policy.mode ở "manual" hoặc "shadow" cho tới khi bạn tự kiểm tra.'
    );
  }

  // comboTimeoutMs advice: >120000ms hides per-attempt timeout
  try {
    for (const r of rawRouters) {
      const routerName = r.adapter === '9router' ? '9router' : r.adapter === 'omniroute' ? 'omniroute' : null;
      if (!routerName) continue;
      const db = openBetterSqlite3(locateRouterDb(routerName), { readOnly: true, busyTimeoutMs: 5000 });
      try {
        const cols = db.prepare('PRAGMA table_info(combos)').all() as Array<{ name: string }>;
        const names = cols.map((c) => c.name);
        const payloadCol = names.includes('data') ? 'data' : names.includes('models') ? 'models' : null;
        if (!payloadCol) continue;
        const rows = db.prepare(`SELECT name, ${payloadCol} AS p FROM combos`).all() as Array<{ name: string; p: string }>;
        for (const row of rows) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(row.p ?? '{}') as Record<string, unknown>;
          } catch {
            // ignore
          }
          const cfgSub = parsed['config'] as Record<string, unknown> | undefined;
          const t =
            parsed['timeoutMs'] ??
            parsed['comboTimeoutMs'] ??
            parsed['timeout'] ??
            cfgSub?.['timeoutMs'] ??
            cfgSub?.['comboTimeoutMs'] ??
            cfgSub?.['timeout'];
          if (typeof t === 'number' && t > 120000) {
            recommendations.push(
              `Combo '${row.name}' (${r.id}): timeout=${t}ms > 120000ms — gợi ý đặt per-attempt timeout <= 120000ms để tránh treo tiến trình (đây là gợi ý cấu hình, không phải lỗi).`
            );
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    /* DB unavailable: read-only diag, skip */
  }

  const authKeys: RouterKeyDiagnostic[] = [];
  for (const r of rawRouters) {
    const key = resolveRouterKey(r.adapter, process.env);
    authKeys.push({
      routerId: r.id,
      adapter: r.adapter,
      keyName: key?.name,
      keyScope: key?.scope,
    });
    if (key?.scope === 'elevated') {
      recommendations.push(
        `Router '${r.id}' (${r.adapter}) is using elevated key ${key.name}. Consider setting a client-scoped key (${r.adapter === '9router' ? 'NINEROUTER_CLIENT_KEY' : 'OMNIROUTE_CLIENT_KEY'}) for read-back per least privilege.`
      );
    }
  }

  // ---- K8: machine-readable environment diagnostics ----
  function detectPnpm(): string | null {
    try {
      const out = execSync('pnpm --version', { encoding: 'utf8', timeout: 5000 }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  function detectBuild(): boolean {
    const candidates = [
      path.join(process.cwd(), 'packages', 'cli', 'dist', 'index.js'),
      path.join(__dirname, '..', 'index.js'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function getTickStateDir(): string {
    if (options.tickStateDir && options.tickStateDir.trim().length > 0) {
      return path.resolve(options.tickStateDir.trim());
    }
    return process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(homeDir, '.routersync');
  }

  function getSyncStateDir(): string {
    const override = process.env['ROUTERSYNC_SYNC_STATE_DIR'];
    if (override && override.trim().length > 0) {
      return path.resolve(override.trim());
    }
    if (process.platform === 'win32') {
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? homeDir, 'AppData', 'Local'),
        'routersync'
      );
    }
    return path.join(
      process.env['XDG_STATE_HOME'] ?? path.join(process.env['HOME'] ?? homeDir, '.local', 'state'),
      'routersync'
    );
  }

  function detectRankingPolicy(): RankingPolicyDiagnostic {
    let candidate: string;
    if (process.platform === 'win32') {
      candidate = path.join(
        process.env['APPDATA'] ?? path.join(homeDir, 'AppData', 'Roaming'),
        'routersync',
        'ranking.yaml'
      );
    } else {
      candidate = path.join(
        process.env['XDG_CONFIG_HOME'] ?? path.join(homeDir, '.config'),
        'routersync',
        'ranking.yaml'
      );
    }
    let present = false;
    try {
      present = fs.existsSync(candidate);
    } catch {
      present = false;
    }
    return { present, path: candidate };
  }

  function detectRouters(config: RouterSyncConfig | null): RouterDiagnostic[] {
    const routers: RouterConfig[] = config
      ? config.routers
      : [
          { id: 'omni', adapter: 'omniroute' } as RouterConfig,
          { id: 'nine', adapter: '9router' } as RouterConfig,
        ];
    return routers.map((r) => {
      let dbPath: string | null = null;
      let found = false;
      let readable = false;
      try {
        dbPath = resolveRouterDbPath(r);
        found = fs.existsSync(dbPath);
        if (found) {
          const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 2000 });
          let tiers: { A: number; B: number; C: number; total: number } | undefined;
          try {
            db.prepare('SELECT 1').get();
            readable = true;
            let tierA = 0;
            let tierB = 0;
            try {
              const combos = db.prepare('SELECT * FROM combos').all() as Array<Record<string, unknown>>;
              const comboModels = new Set<string>();
              for (const c of combos) {
                try {
                  const raw = (c['models'] ?? c['data']) as string | undefined;
                  const parsed = JSON.parse(raw || '[]');
                  const list = Array.isArray(parsed)
                    ? parsed
                    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown[] }).models)
                      ? (parsed as { models: unknown[] }).models
                      : [];
                  for (const m of list) {
                    if (typeof m === 'string') comboModels.add(m);
                    else if (m && typeof (m as { model?: string }).model === 'string') {
                      comboModels.add((m as { model: string }).model);
                    } else if (m && typeof (m as { id?: string }).id === 'string') {
                      comboModels.add((m as { id: string }).id);
                    }
                  }
                } catch {
                  // ignore malformed combo JSON
                }
              }
              tierA = comboModels.size;
              if (r.adapter === '9router') {
                try {
                  const disabled = db
                    .prepare("SELECT value FROM kv WHERE scope = 'disabledModels'")
                    .all() as Array<{ value: string }>;
                  for (const d of disabled) {
                    try {
                      const parsed = JSON.parse(d.value);
                      if (Array.isArray(parsed)) tierB += parsed.length;
                    } catch {
                      // ignore
                    }
                  }
                } catch {
                  // Bảng kv không có trong bản sao tối giản: vẫn giữ tiers.A từ combos.
                }
              } else {
                tierB = 0;
              }
              tiers = { A: tierA, B: tierB, C: 0, total: tierA + tierB };
            } catch {
              // ignore
            }
          } catch {
            readable = false;
          } finally {
            db.close();
          }
          const basis = tiers ? ('combo-members' as const) : undefined;
          let available: number | string | undefined;
          if (tiers) {
            if (r.adapter === '9router') {
              try {
                available = readRouterModelState(r.adapter).availableModels.size;
              } catch {
                available = 'UNKNOWN';
              }
            } else {
              available = 'UNKNOWN (reader not implemented)';
            }
          }
          return {
            routerId: r.id,
            adapter: r.adapter,
            dbPath,
            found,
            readable,
            ...(tiers ? { tiers, basis, available } : {}),
          };
        }
      } catch {
        dbPath = null;
      }
      return { routerId: r.id, adapter: r.adapter, dbPath, found, readable };
    });
  }

  function detectApps(): AppDiagnostic[] {
    const probes: Array<{ name: string; paths: string[] }> = [
      { name: 'Hermes Agent', paths: [path.join(homeDir, '.hermes', 'config.json')] },
      { name: 'DSH Desktop', paths: [path.join(homeDir, '.dsh', 'config.yml')] },
      {
        name: 'Claude Code',
        paths: [path.join(homeDir, '.claude.json'), path.join(homeDir, '.config', 'claude-code', 'config.json')],
      },
      { name: 'OpenCode', paths: [path.join(homeDir, '.config', 'opencode', 'opencode.json')] },
      { name: 'Codex', paths: [path.join(homeDir, '.codex', 'config.toml')] },
      { name: 'Antigravity', paths: [path.join(homeDir, '.gemini', 'antigravity')] },
    ];
    return probes.map((a) => {
      let detected = false;
      let configPathFound: string | null = null;
      for (const p of a.paths) {
        try {
          if (fs.existsSync(p)) {
            detected = true;
            configPathFound = p;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      return { name: a.name, configPath: configPathFound, detected };
    });
  }

  const pnpmVersion = detectPnpm();
  const isBuilt = detectBuild();
  const tickStateDir = getTickStateDir();
  const syncStateDir = getSyncStateDir();
  const stateDir = syncStateDir;
  const rankingPolicy = detectRankingPolicy();
  const config = loadedConfig;
  const routers = detectRouters(config);
  const apps = detectApps();

  // ---- C45-WP7: Read-only 4-Tier Schedule & Stale-Tick (> 2x) Diagnostics ----
  function detectScheduleAndHarnesses(): {
    schedule: ScheduleDiagnostic;
    harnessSchedules: HarnessScheduleStatus[];
  } {
    const configuredIntervalMinutes = parseExplicitIntervalMinutesFromConfig(config, configPath);
    const configuredIntervalMs = configuredIntervalMinutes * 60_000;
    const staleThresholdMinutes = 2 * configuredIntervalMinutes;

    // 1. Check Tier 1 (Harness-Native Zero-Token)
    const hermesSh = path.join(homeDir, '.hermes', 'scripts', 'routersync-tick.sh');
    const hermesPs1 = path.join(homeDir, '.hermes', 'scripts', 'routersync-tick.ps1');
    const hermesJobs = path.join(homeDir, '.hermes', 'cron', 'jobs.json');
    let hermesNativeInstalled = fs.existsSync(hermesSh) || fs.existsSync(hermesPs1);
    if (!hermesNativeInstalled && fs.existsSync(hermesJobs)) {
      try {
        const rawJobs = fs.readFileSync(hermesJobs, 'utf8');
        if (rawJobs.includes('routersync-tick') && rawJobs.includes('no_agent')) {
          hermesNativeInstalled = true;
        }
      } catch {
        // ignore
      }
    }

    const agySidecar = path.join(homeDir, '.gemini', 'config', 'sidecars', 'routersync-tick', 'sidecar.json');
    const agySnippet = path.join(tickStateDir, 'schedules', 'antigravity', 'antigravity-sidecar.snippet.json');
    const agyNativeInstalled = fs.existsSync(agySidecar) || fs.existsSync(agySnippet);

    // 2. Check Tier 2 (OS Scheduler)
    let osInstalled = false;
    let osDetail = '';
    const systemdTimerCandidates = [
      path.join(homeDir, '.config', 'systemd', 'user', 'routersync-daemon.timer'),
      path.join(homeDir, '.config', 'systemd', 'user', 'routersync-tick.timer'),
    ];
    const launchdCandidates = [
      path.join(homeDir, 'Library', 'LaunchAgents', 'com.routersync.daemon.plist'),
      path.join(homeDir, 'Library', 'LaunchAgents', 'com.routersync.tick.plist'),
    ];
    const winTaskXml = path.join(tickStateDir, 'routersync-task.xml');

    for (const candidate of [...systemdTimerCandidates, ...launchdCandidates]) {
      if (fs.existsSync(candidate)) {
        osInstalled = true;
        osDetail = `OS scheduler unit present (${candidate})`;
        break;
      }
    }
    if (!osInstalled && fs.existsSync(winTaskXml)) {
      osInstalled = true;
      osDetail = `Windows Task XML present (${winTaskXml})`;
    }
    if (!osInstalled) {
      if (options.probeOsScheduleFn) {
        const probed = options.probeOsScheduleFn();
        osInstalled = probed.installed;
        osDetail = probed.detail;
      } else if (!options.homeDir && !options.tickStateDir) {
        if (process.platform === 'win32') {
          try {
            const res = spawnSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], {
              encoding: 'utf8',
              timeout: 3000,
            });
            if (res.status === 0) {
              osInstalled = true;
              osDetail = `Windows Task Scheduler (${WINDOWS_TASK_NAME})`;
            }
          } catch {
            // ignore
          }
        } else if (process.platform === 'linux') {
          try {
            const res = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 3000 });
            if (res.status === 0 && (res.stdout ?? '').includes(LINUX_CRON_MARKER)) {
              osInstalled = true;
              osDetail = 'Linux crontab (# routersync-tick)';
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // 3. Check Tier 4 (Daemon live lock)
    let daemonActive = false;
    let daemonPid = 0;
    const daemonLockFile = path.join(tickStateDir, 'daemon.lock');
    if (fs.existsSync(daemonLockFile)) {
      try {
        const parsedLock = parseTickLockPayload(fs.readFileSync(daemonLockFile, 'utf8'));
        if (parsedLock && isProcessAlive(parsedLock.pid)) {
          daemonActive = true;
          daemonPid = parsedLock.pid;
        }
      } catch {
        // ignore
      }
    }

    // 4. Check Tier 3 (MCP tick_if_due startup opt-in)
    const tickIfDueStartupEnabled = Boolean(
      config?.schedule?.tickOnMcpStartup || process.env['ROUTERSYNC_MCP_STARTUP_TICK'] === '1'
    );

    let activeTier: ActiveScheduleTier = 'none';
    let detail =
      'No routersync tick schedule detected. Run `routersync schedule install --dry-run` or `routersync schedule install`.';

    if (hermesNativeInstalled || agyNativeInstalled) {
      activeTier = 'harness-native';
      detail = hermesNativeInstalled
        ? 'Tier 1 harness-native zero-token cron active (Hermes script cron)'
        : 'Tier 1 harness-native zero-token sidecar active (Antigravity schedule)';
    } else if (osInstalled) {
      activeTier = 'os-scheduler';
      detail = osDetail || 'Tier 2 OS scheduler active';
    } else if (daemonActive) {
      activeTier = 'daemon';
      detail = `Tier 4 routersync daemon active (pid ${daemonPid})`;
    } else if (tickIfDueStartupEnabled) {
      activeTier = 'tick-if-due';
      detail = 'Tier 3 MCP tick_if_due startup gate enabled';
    }

    const installed = activeTier !== 'none';

    // 5. Evaluate status.json last tick age & > 2x stale warning (kills M3)
    let lastTickAt: string | null = null;
    let lastTickAgeMinutes: number | null = null;
    let staleTickWarning = false;

    const statusPath = path.join(tickStateDir, 'status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const rawStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        const tsCandidate = rawStatus['timestamp'] ?? rawStatus['generatedAt'];
        if (typeof tsCandidate === 'string' && tsCandidate.trim().length > 0) {
          const parsedMs = Date.parse(tsCandidate);
          if (Number.isFinite(parsedMs)) {
            lastTickAt = tsCandidate;
            const ageMs = Math.max(0, nowMs - parsedMs);
            lastTickAgeMinutes = Math.floor(ageMs / 60_000);
            if (ageMs > 2 * configuredIntervalMs) {
              staleTickWarning = true;
              recommendations.push(
                `Last tick is ${lastTickAgeMinutes}m old, exceeding 2x threshold (${staleThresholdMinutes}m for ${configuredIntervalMinutes}m interval). Run \`routersync tick\` or repair your schedule via \`routersync schedule install\`.`
              );
            }
          }
        }
      } catch {
        // ignore unreadable status.json
      }
    }

    // 6. Build 9 canonical harness schedule entries
    const harnessDetectionProbes: Record<string, string[]> = {
      hermes: [path.join(homeDir, '.hermes', 'config.json'), path.join(homeDir, '.hermes')],
      'claude-code': [path.join(homeDir, '.claude.json'), path.join(homeDir, '.claude', 'settings.json')],
      codex: [path.join(homeDir, '.codex', 'config.toml')],
      antigravity: [
        path.join(homeDir, '.gemini', 'antigravity'),
        path.join(homeDir, '.gemini', 'config', 'config.json'),
      ],
      opencode: [path.join(homeDir, '.config', 'opencode', 'opencode.json')],
      cursor: [path.join(homeDir, '.cursor', 'mcp.json')],
      'grok-bot': [path.join(homeDir, '.grok', 'user-settings.json')],
      openmausbot: [path.join(homeDir, '.openmausbot', 'settings.json')],
      dsh: [path.join(homeDir, '.dsh', 'config.yml')],
    };

    const harnessSchedules: HarnessScheduleStatus[] = listHarnessCapabilities().map((cap) => {
      const probePaths = harnessDetectionProbes[cap.id] ?? [];
      const detected = probePaths.some((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      const zeroTokenNativeCapable = cap.scheduler.zeroTokenScriptCapable;
      const recommendedTier: 'harness-native' | 'os-scheduler' = zeroTokenNativeCapable
        ? 'harness-native'
        : 'os-scheduler';

      let harnessActiveTier: ActiveScheduleTier = 'none';
      if (cap.id === 'hermes' && hermesNativeInstalled) {
        harnessActiveTier = 'harness-native';
      } else if (cap.id === 'antigravity' && agyNativeInstalled) {
        harnessActiveTier = 'harness-native';
      } else if (osInstalled) {
        harnessActiveTier = 'os-scheduler';
      } else if (daemonActive) {
        harnessActiveTier = 'daemon';
      } else if (tickIfDueStartupEnabled) {
        harnessActiveTier = 'tick-if-due';
      }

      return {
        harnessId: cap.id,
        displayName: cap.displayName,
        detected,
        zeroTokenNativeCapable,
        recommendedTier,
        activeTier: harnessActiveTier,
        detail: zeroTokenNativeCapable
          ? `Supports Tier 1 zero-token native schedule (${cap.scheduler.schedulerType})`
          : `Uses Tier 2 OS scheduler + Tier 3 MCP tick_if_due (${cap.scheduler.schedulerType})`,
      };
    });

    return {
      schedule: {
        installed,
        detail,
        activeTier,
        configuredIntervalMinutes,
        lastTickAt,
        lastTickAgeMinutes,
        staleTickWarning,
        staleThresholdMinutes,
      },
      harnessSchedules,
    };
  }

  const { schedule, harnessSchedules } = detectScheduleAndHarnesses();

  const nextSteps: string[] = [];
  if (configError) {
    nextSteps.push(`Sửa lỗi tệp cấu hình (${configPath ?? options.configPath ?? 'config.yaml'}): ${configError}`);
  }
  if (!isBuilt) nextSteps.push('Run `pnpm build` to compile the CLI before using routersync.');
  if (!configPath || !fs.existsSync(configPath)) {
    nextSteps.push('Run `routersync init` to create a default config.yaml configuration file.');
  }
  if (!rankingPolicy.present) {
    nextSteps.push('Copy `ranking.example.yaml` to the ranking policy path (' + rankingPolicy.path + ') before any write path.');
  }
  for (const r of routers) {
    if (!r.found) {
      nextSteps.push(
        `Configure the router database for '${r.routerId}' (${r.adapter}) — set routers[].db.path or ROUTERSYNC_${r.adapter.toUpperCase()}_DB.`
      );
    } else if (!r.readable) {
      nextSteps.push(`Router '${r.routerId}' database exists at ${r.dbPath} but could not be opened read-only.`);
    }
  }
  if (!schedule.installed) {
    nextSteps.push('Set up a scheduled `routersync tick` run (`routersync schedule install`) for zero-token catalogue watches.');
  }
  if (schedule.staleTickWarning) {
    nextSteps.push(
      `Recurring tick is overdue (${schedule.lastTickAgeMinutes}m > ${schedule.staleThresholdMinutes}m). Run \`routersync tick\` or check \`routersync schedule status\`.`
    );
  }
  if (circularWarnings.length > 0) {
    nextSteps.push('Break circular dependencies: point the agent harness at a direct provider API key or non-managed fallback endpoint.');
  }
  if (validationWarnings.length > 0) {
    nextSteps.push('Giữ policy.mode ở "manual" hoặc "shadow" cho tới khi bạn tự kiểm tra bằng chứng ghi thật trên adapter.');
  }
  if (nextSteps.length === 0) {
    nextSteps.push('Environment looks ready. Run `routersync scan` as the first read-only command.');
  }

  const isReady =
    isBuilt &&
    !configError &&
    Boolean(configPath && fs.existsSync(configPath)) &&
    routers.some((r) => r.found && r.readable) &&
    circularWarnings.length === 0;

  const report: DoctorReport = {
    ok: circularWarnings.length === 0 && !configError,
    ready: isReady,
    configError: configError ?? null,
    os: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm: pnpmVersion,
    build: isBuilt,
    stateDir,
    tickStateDir,
    syncStateDir,
    configPath: configPath ? configPath : null,
    registry: describePublicRegistry(),
    rankingPolicy,
    routers,
    apps,
    schedule,
    harnessSchedules,
    nextSteps,
    circularWarnings,
    validationWarnings,
    authKeys,
    recommendations,
    timestamp,
    lowResource: isLowResource(),
    lowResourceReason: lowResourceReason() ?? null,
  };

  if (options.silent) {
    return report;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const outLines: string[] = [];
    outLines.push(`\n======================================================`);
    outLines.push(`[routersync doctor] Chẩn đoán sức khỏe hệ thống`);
    outLines.push(`Thời gian: ${timestamp}`);
    outLines.push(`======================================================`);
    if (configError) {
      outLines.push(`[!] LỖI CẤU HÌNH (configError): ${configError}`);
    }
    outLines.push(`Khóa xác thực router đã cấu hình:`);
    for (const k of authKeys) {
      if (k.keyName) {
        outLines.push(`  - [${k.routerId}] (${k.adapter}): ${k.keyName} (phạm vi: ${k.keyScope})`);
      } else {
        outLines.push(`  - [${k.routerId}] (${k.adapter}): chưa cấu hình (chế độ giảm cấp chỉ-db)`);
      }
    }
    outLines.push(`------------------------------------------------------`);
    outLines.push(
      `Lịch định kỳ (Schedule): tier=${schedule.activeTier} installed=${schedule.installed ? 'yes' : 'no'} interval=${schedule.configuredIntervalMinutes}m lastTickAge=${schedule.lastTickAgeMinutes !== null ? `${schedule.lastTickAgeMinutes}m` : 'n/a'}${schedule.staleTickWarning ? ' [STALE > 2x]' : ''}`
    );
    outLines.push(`------------------------------------------------------`);
    outLines.push(`Tầng model theo router (chỉ đọc):`);
    for (const r of routers) {
      if (!r.tiers) {
        outLines.push(`  - [${r.routerId}] (${r.adapter}): không đọc được tiers`);
        continue;
      }
      const label = `A (models referenced by combos)=${r.tiers.A}`;
      const available =
        typeof r.available === 'number' ? `${r.available} (available in router)` : String(r.available);
      outLines.push(`  - [${r.routerId}] (${r.adapter}): ${label}; basis=${r.basis}; available=${available}`);
    }
    outLines.push(`------------------------------------------------------`);
    if (circularWarnings.length === 0 && validationWarnings.length === 0) {
      outLines.push(`✓ Không phát hiện phụ thuộc vòng giữa harness và router.`);
      if (backupEvidence) {
        outLines.push(`✓ Đã có bằng chứng sao lưu; cờ \`validated\` trong cấu hình chưa đổi.`);
      } else {
        outLines.push(`✓ Mọi adapter router đã được xác minh.`);
      }
    } else {
      if (circularWarnings.length > 0) {
        outLines.push(`! Phát hiện ${circularWarnings.length} cảnh báo phụ thuộc vòng:`);
        for (const w of circularWarnings) {
          outLines.push(`  - [${w.harness.toUpperCase()}] ${w.message}`);
        }
      }
      if (validationWarnings.length > 0) {
        outLines.push(`! Cảnh báo xác minh adapter:`);
        for (const v of validationWarnings) {
          outLines.push(`  - [${v.adapter.toUpperCase()}] ${v.message}`);
        }
      }
    }
    if (recommendations.length > 0) {
      outLines.push(`\nKhuyến nghị:`);
      for (const rec of recommendations) {
        outLines.push(`  * ${rec}`);
      }
    }
    outLines.push(`======================================================\n`);
    const text = outLines.join('\n') + '\n';
    if (options.out) fs.writeFileSync(options.out, text, 'utf8');
    console.log(text);
  }

  return report;
}
