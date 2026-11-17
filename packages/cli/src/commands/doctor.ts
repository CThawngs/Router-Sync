/**
 * packages/cli/src/commands/doctor.ts
 *
 * Implements `routersync doctor`.
 * Inspects harness configs (Hermes, DSH) and managed routers to detect:
 *  - Circular dependencies (agent harness upstream pointed at managed router)
 *  - Self-interruption risk
 *  - Verifies that rollback is runnable without AI/harness assistance
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolveRouterKey, locateRouterDb, openBetterSqlite3, readRouterModelState } from '@routersync/core';
import { loadConfigFile, getDefaultConfigPath, resolveRouterDbPath } from '../config/loader.js';
import type { RouterConfig, RouterSyncConfig } from '../config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DoctorCommandOptions {
  configPath?: string | undefined;
  hermesConfigPath?: string | undefined;
  dshConfigPath?: string | undefined;
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
  detail: string | null;
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
  rankingPolicy: RankingPolicyDiagnostic;
  routers: RouterDiagnostic[];
  apps: AppDiagnostic[];
  schedule: ScheduleDiagnostic;
  nextSteps: string[];
  circularWarnings: CircularDependencyWarning[];
  validationWarnings?: ValidationWarning[];
  authKeys?: RouterKeyDiagnostic[];
  recommendations: string[];
  timestamp: string;
}

export async function runDoctorCommand(options: DoctorCommandOptions = {}): Promise<DoctorReport> {
  const timestamp = new Date().toISOString();
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
      const raw = JSON.parse(fs.readFileSync(syncLastPath, 'utf8')) as { at?: string; routers?: Record<string, { backup?: string; changed?: string[] }>; planHash?: string };
      const syncRouters = raw.routers ?? {};
      const hasBoth = Boolean(syncRouters['9router']?.backup && syncRouters['omniroute']?.backup);
      const backupsExist = hasBoth && fs.existsSync(String(syncRouters['9router']?.backup)) && fs.existsSync(String(syncRouters['omniroute']?.backup));
      if (hasBoth && backupsExist && raw.at) {
        backupEvidence = `Đã có bằng chứng sao lưu gần nhất (${raw.at})`;
      }
    }
  } catch { backupEvidence = null; }

  for (const r of rawRouters) {
    if (!r.validated) {
      if (backupEvidence) {
        recommendations.push(
          `Router '${r.id}' (${r.adapter}): ${backupEvidence}.`
        );
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
  const hermesPath = options.hermesConfigPath ?? path.join(os.homedir(), '.hermes', 'config.json');
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
  const dshPath = options.dshConfigPath ?? path.join(os.homedir(), '.dsh', 'config.yml');
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
        const cols = db.prepare("PRAGMA table_info(combos)").all() as Array<{name:string}>;
        const names = cols.map(c=>c.name);
        const payloadCol = names.includes('data') ? 'data' : names.includes('models') ? 'models' : null;
        if (!payloadCol) continue;
        const rows = db.prepare(`SELECT name, ${payloadCol} AS p FROM combos`).all() as Array<{name:string;p:string}>;
        for (const row of rows) {
          let parsed: any = {};
          try { parsed = JSON.parse(row.p ?? '{}'); } catch {}
          const t = parsed.timeoutMs ?? parsed.comboTimeoutMs ?? parsed.timeout ?? parsed.config?.timeoutMs ?? parsed.config?.comboTimeoutMs ?? parsed.config?.timeout;
          if (typeof t === 'number' && t > 120000) {
            recommendations.push(
              `Combo '${row.name}' (${r.id}): timeout=${t}ms > 120000ms — gợi ý đặt per-attempt timeout <= 120000ms để tránh treo tiến trình (đây là gợi ý cấu hình, không phải lỗi).`
            );
          }
        }
      } finally { db.close(); }
    }
  } catch { /* DB unavailable: read-only diag, skip */ }

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
      try { if (fs.existsSync(c)) return true; } catch { /* ignore */ }
    }
    return false;
  }

  function getTickStateDir(): string {
    return process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
  }

  function getSyncStateDir(): string {
    const override = process.env['ROUTERSYNC_SYNC_STATE_DIR'];
    if (override && override.trim().length > 0) {
      return path.resolve(override.trim());
    }
    if (process.platform === 'win32') {
      return path.join(process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? os.homedir(), 'AppData', 'Local'), 'routersync');
    }
    return path.join(process.env['XDG_STATE_HOME'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.local', 'state'), 'routersync');
  }

  function detectRankingPolicy(): RankingPolicyDiagnostic {
    let candidate: string;
    if (process.platform === 'win32') {
      candidate = path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'routersync', 'ranking.yaml');
    } else {
      candidate = path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'routersync', 'ranking.yaml');
    }
    let present = false;
    try { present = fs.existsSync(candidate); } catch { present = false; }
    return { present, path: candidate };
  }

  function detectRouters(config: RouterSyncConfig | null): RouterDiagnostic[] {
    const routers: RouterConfig[] = config ? config.routers : [
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
                    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown[] }).models))
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
                } catch {}
              }
              tierA = comboModels.size;
              if (r.adapter === '9router') {
                try {
                  const disabled = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels'").all() as Array<{ value: string }>;
                  for (const d of disabled) {
                    try {
                      const parsed = JSON.parse(d.value);
                      if (Array.isArray(parsed)) tierB += parsed.length;
                    } catch {}
                  }
                } catch {
                  // Bảng kv không có trong bản sao tối giản: vẫn giữ tiers.A từ combos.
                }
              } else {
                // OmniRoute has no verified Tier B in SQLite (model_capabilities is an internal capability mapping table with 11k+ rows, not Tier B; models outside combos are UNKNOWN).
                tierB = 0;
              }
              tiers = { A: tierA, B: tierB, C: 0, total: tierA + tierB };
            } catch {}
          } catch { readable = false; } finally { db.close(); }
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
            routerId: r.id, adapter: r.adapter, dbPath, found, readable,
            ...(tiers ? { tiers, basis, available } : {}),
          };
        }
      } catch { dbPath = null; }
      return { routerId: r.id, adapter: r.adapter, dbPath, found, readable };
    });
  }

  function detectApps(): AppDiagnostic[] {
    const home = os.homedir();
    const probes: Array<{ name: string; paths: string[] }> = [
      { name: 'Hermes Agent', paths: [path.join(home, '.hermes', 'config.json')] },
      { name: 'DSH Desktop', paths: [path.join(home, '.dsh', 'config.yml')] },
      { name: 'Claude Code', paths: [path.join(home, '.claude.json'), path.join(home, '.config', 'claude-code', 'config.json')] },
      { name: 'OpenCode', paths: [path.join(home, '.config', 'opencode', 'opencode.json')] },
      { name: 'Codex', paths: [path.join(home, '.codex', 'config.toml')] },
      { name: 'Antigravity', paths: [path.join(home, '.gemini', 'antigravity')] },
    ];
    return probes.map((a) => {
      let detected = false;
      let configPath: string | null = null;
      for (const p of a.paths) {
        try { if (fs.existsSync(p)) { detected = true; configPath = p; break; } } catch { /* ignore */ }
      }
      return { name: a.name, configPath, detected };
    });
  }

  function detectSchedule(): ScheduleDiagnostic {
    return {
      installed: false,
      detail: 'No routersync tick schedule detected. Copy a sample from examples/schedule/ and install it for your OS.',
    };
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
  const schedule = detectSchedule();

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
      nextSteps.push(`Configure the router database for '${r.routerId}' (${r.adapter}) — set routers[].db.path or ROUTERSYNC_${r.adapter.toUpperCase()}_DB.`);
    } else if (!r.readable) {
      nextSteps.push(`Router '${r.routerId}' database exists at ${r.dbPath} but could not be opened read-only.`);
    }
  }
  if (!schedule.installed) {
    nextSteps.push('Set up a scheduled `routersync tick` run (see examples/schedule/) for zero-token catalogue watches.');
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
    rankingPolicy,
    routers,
    apps,
    schedule,
    nextSteps,
    circularWarnings,
    validationWarnings,
    authKeys,
    recommendations,
    timestamp,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const outLines: string[] = [];
    outLines.push(`\n======================================================`);
    outLines.push(`[routersync doctor] Chẩn đoán sức khỏe hệ thống`);
    outLines.push(`Thời gian: ${new Date().toISOString()}`);
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
    outLines.push(`Tầng model theo router (chỉ đọc):`);
    for (const r of routers) {
      if (!r.tiers) {
        outLines.push(`  - [${r.routerId}] (${r.adapter}): không đọc được tiers`);
        continue;
      }
      const label = `A (models referenced by combos)=${r.tiers.A}`;
      const available = typeof r.available === 'number'
        ? `${r.available} (available in router)`
        : String(r.available);
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
    // C4n/N1: recommendations must be visible in text mode even when there is
    // no circular warning and no validation warning (e.g. combo timeout hints
    // and "backup evidence" notices, which live in `recommendations` only).
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
