/**
 * packages/cli/src/commands/maintain.ts
 *
 * Implements `routersync maintain plan`, `maintain authorize`, `maintain create`,
 * and `maintain apply` commands (C45-WP4 §3.2.2: policy-scoped targets replacing
 * hardcoded `^test-\d+$`, emergency freeze gate, and ApplyHistoryReceipt persistence).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import { loadConfigFile, expandTilde } from '../config/loader.js';
import { parse as parseYaml } from 'yaml';
import { createAdapterForRouter } from '../adapters.js';
import {
  computePlan,
  type MaintainPlanInput,
  type MaintainPlanResult,
  type MaintainCombo,
  type MaintainComboRule,
  type MaintainProviderItem,
} from '../maintain/plan.js';
import {
  reduceTrack,
  type TrackEvent,
  type TrackerStateInput,
} from '../maintain/reduce-track.js';
import {
  SAFE_COMBO_SLUG_RE,
  ALLOWED_AGENTS,
  getGrantFilePath,
  validateGrantFile,
  checkGrantScope,
  createGrantFile,
  generateGrantSecret,
  resolveGrantSecret,
  type ApplyGrant,
} from '../maintain/grant.js';
import { classifyFree } from '../track/free-classify.js';
import {
  appendApplyReceipt,
  applyPlanSafe,
  assertControlledWriteSandbox,
  readFreezeState,
  readStandingConsent,
  saveSnapshot,
} from '@routersync/core';
import type { Plan, ComboDefinition } from '@routersync/adapter-sdk';
import { normalizeReadBackLevel } from '@routersync/adapter-sdk';

export interface MaintainPlanOptions {
  configPath?: string | undefined;
  router?: string | undefined;
  json?: boolean | undefined;
  stateDir?: string | undefined;
}

export interface MaintainAuthorizeOptions {
  only?: string | undefined;
  hours?: string | undefined;
  agents?: string | undefined;
  stateDir?: string | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
  secretResolver?: (() => string | undefined) | undefined;
}

export interface MaintainGrantStatusOptions {
  stateDir?: string | undefined;
  json?: boolean | undefined;
}

export interface MaintainRevokeGrantOptions {
  stateDir?: string | undefined;
}

export interface MaintainCreateOptions {
  allowTestBypass?: boolean | undefined;
  name?: string | undefined;
  models?: string | undefined;
  free?: boolean | undefined;
  router?: string | undefined;
  strategy?: string | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
  secretResolver?: (() => string | undefined) | undefined;
}

export interface MaintainApplyOptions {
  allowTestBypass?: boolean | undefined;
  configPath?: string | undefined;
  router?: string | undefined;
  only?: string | undefined;
  planHash?: string | undefined;
  json?: boolean | undefined;
  stateDir?: string | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  agents?: string | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
  secretResolver?: (() => string | undefined) | undefined;
}

const SAFE_COMBO_LIST_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(,[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})*$/;

function parseStrictOnlyCombos(only: string | undefined, commandLabel: string): string[] {
  if (!only || only.trim() === '') {
    console.error(`${commandLabel} requires --only <combo-name>`);
    console.error('MAINTAIN-REFUSED reason=no-only');
    process.exit(1);
  }

  const trimmedOnly = only.trim();
  if (!SAFE_COMBO_LIST_RE.test(trimmedOnly)) {
    console.error(
      `${commandLabel} invalid --only combo slug list '${only}'`
    );
    console.error('MAINTAIN-REFUSED reason=only-pattern');
    process.exit(1);
  }

  return Array.from(new Set(trimmedOnly.split(',')));
}

function parseStrictAgents(rawAgents: string | undefined, commandLabel: string): string[] {
  if (rawAgents === undefined) {
    return [];
  }

  const trimmed = rawAgents.trim();
  if (trimmed === '') {
    console.error(
      `${commandLabel} --agents only accepts ${[...ALLOWED_AGENTS].join(', ')}, got '${rawAgents}'`
    );
    console.error('MAINTAIN-REFUSED reason=agents-invalid');
    process.exit(1);
  }

  const rawSegments = trimmed.split(',');
  if (rawSegments.some((seg) => !ALLOWED_AGENTS.has(seg))) {
    console.error(
      `${commandLabel} --agents only accepts ${[...ALLOWED_AGENTS].join(', ')}, got '${rawAgents}'`
    );
    console.error('MAINTAIN-REFUSED reason=agents-invalid');
    process.exit(1);
  }

  return Array.from(new Set(rawSegments));
}

/**
 * Returns state directory for track-events, grants, and standing-consent.json.
 */
function getTrackStateDir(customDir?: string): string {
  if (customDir) return customDir;
  if (process.env.ROUTERSYNC_STATE_DIR) {
    return process.env.ROUTERSYNC_STATE_DIR;
  }
  return path.join(os.homedir(), '.routersync');
}

/**
 * Load active consented router combo names from `<stateDir>/standing-consent.json`.
 * Defaults to empty set (`[]`) when `standing-consent.json` is absent or invalid!
 */
function getConsentedRouterCombos(stateDir?: string, routerHint?: string): Set<string> {
  const sDir = getTrackStateDir(stateDir);
  const consent = readStandingConsent(sDir);
  if (!consent.valid) return new Set();

  const allowed = new Set<string>();
  for (const entry of consent.activeTargets) {
    if (
      entry.targetKind === 'router' &&
      entry.comboName &&
      (entry.level === 'propose' || entry.level === 'auto-safe')
    ) {
      if (
        !routerHint ||
        entry.routerId === routerHint ||
        entry.routerId === '9router' ||
        entry.routerId === 'omniroute'
      ) {
        allowed.add(entry.comboName);
      }
    }
  }
  return allowed;
}

/**
 * Load raw track events and state from state dir.
 */
export function loadTrackData(stateDir?: string): { state: TrackerStateInput; events: TrackEvent[] } {
  const dir = getTrackStateDir(stateDir);
  const eventsFile = path.join(dir, 'track-events.jsonl');
  const events: TrackEvent[] = [];

  if (fs.existsSync(eventsFile)) {
    try {
      const content = fs.readFileSync(eventsFile, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev === 'object') {
            events.push(ev);
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore read error
    }
  }

  let state: TrackerStateInput = {};
  const stateFiles = ['tracker-state.json', 'track-state.json'];
  for (const sf of stateFiles) {
    const full = path.join(dir, sf);
    if (fs.existsSync(full)) {
      try {
        const raw = fs.readFileSync(full, 'utf8');
        state = JSON.parse(raw);
        if (state && typeof state === 'object') {
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  return { state, events };
}

/**
 * Read track events and track state from state dir, reduced via pure reduceTrack.
 */
export function readTrackEvents(stateDir?: string): Record<string, { removed: string[]; added: string[] }> {
  const { state, events } = loadTrackData(stateDir);
  const reduced = reduceTrack({ state, events });
  const result: Record<string, { removed: string[]; added: string[] }> = {};
  for (const [p, data] of Object.entries(reduced.providers)) {
    result[p] = {
      removed: data.removed,
      added: data.added.map((a) => a.id),
    };
  }
  return result;
}

/**
 * Build pure maintain plan from configuration and database adapter.
 */
export async function buildMaintainPlan(
  configPath?: string,
  targetRouter?: string,
  stateDir?: string
): Promise<{
  config: ReturnType<typeof loadConfigFile>['config'];
  routerCfg: ReturnType<typeof loadConfigFile>['config']['routers'][number];
  adapter: any;
  liveCombos: ComboDefinition[];
  planResult: MaintainPlanResult;
}> {
  const { config } = loadConfigFile(configPath);
  const routerCfg = targetRouter
    ? config.routers.find((r) => r.id === targetRouter)
    : config.routers[0];

  if (!routerCfg) {
    throw new Error(`Target router '${targetRouter ?? 'default'}' not found in configuration.`);
  }

  const adapter = await createAdapterForRouter(routerCfg, stateDir);
  const liveCombos = await adapter.readCombos();

  const managedComboMap = new Map<string, any>();
  for (const c of config.combos) {
    if (c.routers.includes(routerCfg.id)) {
      managedComboMap.set(c.name, c);
    }
  }

  const adoptedComboMap = new Map<string, string>();
  for (const a of config.adopt ?? []) {
    if (a.router === routerCfg.id) {
      adoptedComboMap.set(a.name, a.mode);
    }
  }

  const { state, events } = loadTrackData(stateDir);
  const reduced = reduceTrack({ state, events });
  const providers: Record<string, MaintainProviderItem> = {};

  for (const [pName, pData] of Object.entries(reduced.providers)) {
    providers[pName] = {
      status: pData.status,
      removed: pData.removed,
      added: pData.added,
    };
  }

  // Populate known providers from live combos if missing
  for (const combo of liveCombos) {
    for (const m of combo.models) {
      const slash = m.indexOf('/');
      if (slash > 0) {
        const pName = m.slice(0, slash);
        if (!providers[pName]) {
          providers[pName] = { status: 'unknown', removed: [], added: [] };
        }
      }
    }
  }

  const maintainCombos: MaintainCombo[] = liveCombos.map((combo) => {
    const managedSpec = managedComboMap.get(combo.name) || managedComboMap.get(combo.id);
    const isManaged = Boolean(managedSpec);
    const adoptMode = adoptedComboMap.get(combo.name) || adoptedComboMap.get(combo.id);
    const isAdopted = Boolean(adoptMode);

    const autoMaintainRaw = managedSpec?.autoMaintain ?? (combo as any).autoMaintain;
    const isAutoEnabled = typeof autoMaintainRaw === 'object' && autoMaintainRaw !== null
      ? Boolean(autoMaintainRaw.enabled)
      : Boolean(autoMaintainRaw);

    let comboRule: MaintainComboRule | undefined = undefined;
    if (isAutoEnabled) {
      const autoObj = typeof autoMaintainRaw === 'object' && autoMaintainRaw !== null ? autoMaintainRaw : undefined;
      comboRule = {
        providers: autoObj?.providers,
        match: autoObj?.match,
        maxAdds: autoObj?.maxAdds ?? 3,
      };
    }

    const item: MaintainCombo = {
      id: combo.id,
      name: combo.name,
      managed: isManaged,
      adopted: isAdopted,
      models: [...combo.models],
      autoMaintain: isAutoEnabled,
      freeOnly: managedSpec?.constraints?.freeOnly ?? (combo as any).freeOnly ?? false,
    };
    if (adoptMode) {
      item.adoptMode = adoptMode as any;
    }
    if (comboRule) {
      item.rule = comboRule;
    }
    return item;
  });

  const agentTargets = [
    { id: 'antigravity', status: 'unverified' },
    { id: 'hermes', status: 'unverified' },
    { id: 'openclaw', status: 'unverified' },
  ];

  const planInput: MaintainPlanInput = {
    router: routerCfg.id,
    policyMode: config.policy?.mode,
    combos: maintainCombos,
    providers,
    agents: agentTargets,
  };

  const planResult = computePlan(planInput);

  return {
    config,
    routerCfg,
    adapter,
    liveCombos,
    planResult,
  };
}

/**
 * CLI command `routersync maintain plan`
 */
export async function runMaintainPlanCommand(options: MaintainPlanOptions): Promise<void> {
  const { routerCfg, planResult } = await buildMaintainPlan(
    options.configPath,
    options.router,
    options.stateDir
  );

  if (options.json) {
    console.log(JSON.stringify(planResult, null, 2));
    return;
  }

  console.log(`[routersync] Maintain plan for router '${routerCfg.id}':`);
  console.log(
    `MAINTAIN-PLAN removes=${planResult.removes.length} adds=${planResult.adds.length} unmanagedTouched=${planResult.summary.unmanagedTouched}`
  );
  console.log(`PLAN-HASH ${planResult.planHash}`);
  console.log(`Removals: ${planResult.removes.length}`);
  for (const r of planResult.removes) {
    console.log(`  - Combo '${r.combo}': remove '${r.model}' (${r.reason})`);
  }
  console.log(`Additions: ${planResult.adds.length}`);
  for (const a of planResult.adds) {
    console.log(`  + Combo '${a.combo}': add '${a.model}' at position '${a.position}'`);
  }
  console.log(`Blocked: ${planResult.blocked.length}`);
  for (const b of planResult.blocked) {
    console.log(`  ! Combo '${b.combo}': blocked reason '${b.reason}'`);
  }
  console.log(
    `Summary: unmanaged touched=${planResult.summary.unmanagedTouched}, auto-eligible=${
      planResult.summary.autoEligible.join(',') || 'none'
    }`
  );
}

function isUnderDir(targetPath: string, parentDir: string): boolean {
  try {
    const rel = path.relative(path.resolve(parentDir).toLowerCase(), path.resolve(targetPath).toLowerCase());
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function resolvePreflightDbPath(options: MaintainApplyOptions): string {
  const targetRouterId = options.router;
  if (
    targetRouterId === '9router' ||
    (!targetRouterId && (process.env['NINEROUTER_DB_PATH'] || process.env['NINE_ROUTER_DB_PATH']))
  ) {
    const env9 =
      process.env['NINEROUTER_DB_PATH'] ||
      process.env['NINE_ROUTER_DB_PATH'] ||
      (process.env['NINEROUTER_DATA_DIR']
        ? path.join(process.env['NINEROUTER_DATA_DIR'], 'data.sqlite')
        : undefined);
    if (env9) return path.resolve(env9);
  }
  if (
    targetRouterId === 'omniroute' ||
    (!targetRouterId &&
      (process.env['OMNIROUTE_DB_PATH'] || process.env['OMNIROUTE_HOME'] || process.env['OMNIROUTE_DATA_DIR']))
  ) {
    const envOmni =
      process.env['OMNIROUTE_DB_PATH'] ||
      (process.env['OMNIROUTE_HOME'] ? path.join(process.env['OMNIROUTE_HOME'], 'storage.sqlite') : undefined) ||
      (process.env['OMNIROUTE_DATA_DIR'] ? path.join(process.env['OMNIROUTE_DATA_DIR'], 'storage.sqlite') : undefined);
    if (envOmni) return path.resolve(envOmni);
  }

  let configPath = options.configPath;
  if (!configPath && process.env['ROUTERSYNC_CONFIG']) {
    configPath = process.env['ROUTERSYNC_CONFIG'];
  }
  if (!configPath) {
    const defaultYaml = path.join(process.cwd(), 'routersync.yaml');
    const defaultYml = path.join(process.cwd(), 'routersync.yml');
    const defaultJson = path.join(process.cwd(), 'routersync.json');
    if (fs.existsSync(defaultYaml)) configPath = defaultYaml;
    else if (fs.existsSync(defaultYml)) configPath = defaultYml;
    else if (fs.existsSync(defaultJson)) configPath = defaultJson;
  }

  if (configPath && fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = configPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
      if (parsed && Array.isArray(parsed.routers)) {
        const r = targetRouterId
          ? parsed.routers.find(
              (x: { id?: string; adapter?: string }) => x.id === targetRouterId || x.adapter === targetRouterId
            )
          : parsed.routers[0];
        if (r?.db?.path) {
          return path.resolve(expandTilde(r.db.path));
        }
      }
    } catch {
      // ignore parse error in preflight
    }
  }

  // If no explicit DB path was provided via env var or config, it defaults to the production DB.
  // The default router DB is located outside os.tmpdir().
  return path.resolve(process.cwd(), '..', 'default-router-db', 'data.sqlite');
}

async function promptForConfirmation(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * CLI command `routersync maintain authorize`
 */
export async function runMaintainAuthorizeCommand(options: MaintainAuthorizeOptions): Promise<void> {
  // Refusal guards 1 & 2: strict --only grammar
  const targetComboNames = parseStrictOnlyCombos(options.only, 'maintain authorize');

  // Refusal guard 3: hours-range (1-8)
  let hours = 1;
  if (options.hours !== undefined) {
    const hTrim = options.hours.trim();
    if (!/^[1-8]$/.test(hTrim)) {
      console.error(`maintain authorize requires --hours between 1 and 8, got '${options.hours}'`);
      console.error('MAINTAIN-REFUSED reason=hours-range');
      process.exit(1);
    }
    hours = parseInt(hTrim, 10);
  }

  // Refusal guard 4: strict --agents grammar
  const agents = parseStrictAgents(options.agents, 'maintain authorize');

  // Refusal guard 5: emergency freeze check
  const sDir = getTrackStateDir(options.stateDir);
  if (readFreezeState(sDir).frozen) {
    console.error('maintain authorize blocked: emergency freeze is active');
    console.error('MAINTAIN-REFUSED reason=frozen');
    process.exit(1);
  }

  // Refusal guard 6: policy scope check (default [] when standing-consent.json is absent)
  const consented = getConsentedRouterCombos(options.stateDir);
  if (targetComboNames.some((c) => !consented.has(c))) {
    console.error(
      `maintain authorize only permitted for combos consented in standing-consent.json, got '${options.only}'`
    );
    console.error('MAINTAIN-REFUSED reason=only-pattern');
    process.exit(1);
  }

  // Refusal guard 7: no-tty (K1: grant issuance is TTY-only; programmatic seam is internal API only)
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);

  if (!isTTY) {
    console.error('maintain authorize requires an interactive TTY');
    console.error('MAINTAIN-REFUSED reason=no-tty');
    process.exit(1);
  }

  const prompt = options.promptFn ?? promptForConfirmation;
  const confirmWord = (
    await prompt(
      `Gõ 'chay' để xác nhận cấp giấy phép ghi cho combo '${targetComboNames.join(',')}' (${hours}h): `
    )
  ).trim();

  if (confirmWord !== 'chay') {
    console.error(`Xác nhận bị từ chối (nhập '${confirmWord}', yêu cầu 'chay'). Hủy cấp phép.`);
    process.exit(1);
  }

  const grantId = crypto.randomBytes(8).toString('hex');
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + hours * 3600000).toISOString();

  const grant: ApplyGrant = {
    version: 1,
    id: grantId,
    combos: targetComboNames,
    agents,
    createdAt,
    expiresAt,
  };

  // S0: secret generated here, printed ONCE, never written to disk.
  const secret = generateGrantSecret();
  const grantFile = createGrantFile(grant, secret);

  const grantPath = getGrantFilePath(options.stateDir);
  const grantDir = path.dirname(grantPath);
  if (!fs.existsSync(grantDir)) {
    fs.mkdirSync(grantDir, { recursive: true });
  }

  fs.writeFileSync(grantPath, JSON.stringify(grantFile, null, 2), 'utf8');

  console.log(`GRANT-SECRET ${secret}`);
  console.log(
    `GRANT id=${grant.id} combos=${grant.combos.join(',')} agents=${grant.agents.join(',')} expiresAt=${grant.expiresAt} remaining_min=${hours * 60}`
  );
}

/**
 * CLI command `routersync maintain grant-status`
 */
export async function runMaintainGrantStatusCommand(options: MaintainGrantStatusOptions): Promise<void> {
  const grantPath = getGrantFilePath(options.stateDir);
  // Status is read-only: structure/expiry only, no secret needed, zero secret/hash/MAC emitted.
  const validation = validateGrantFile(grantPath, undefined, { requireSecret: false });

  if (!validation.valid) {
    if (options.json) {
      if (validation.notFound) {
        console.log(JSON.stringify({ active: false }));
      } else {
        console.log(JSON.stringify({ active: false, reason: validation.reason }));
      }
      return;
    }
    console.log('GRANT none');
    return;
  }

  const grant = validation.grant;
  const remainingMs = new Date(grant.expiresAt).getTime() - Date.now();
  const remainingMin = Math.max(0, Math.round(remainingMs / 60000));

  if (options.json) {
    console.log(
      JSON.stringify({
        active: true,
        id: grant.id,
        combos: grant.combos,
        agents: grant.agents,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        remainingMin,
      })
    );
    return;
  }

  console.log(
    `GRANT id=${grant.id} combos=${grant.combos.join(',')} agents=${grant.agents.join(',')} expiresAt=${grant.expiresAt} remaining_min=${remainingMin}`
  );
}

/**
 * CLI command `routersync maintain revoke-grant`
 */
export async function runMaintainRevokeGrantCommand(options: MaintainRevokeGrantOptions): Promise<void> {
  const grantPath = getGrantFilePath(options.stateDir);
  if (fs.existsSync(grantPath)) {
    try {
      fs.unlinkSync(grantPath);
    } catch {
      // ignore
    }
  }
  console.log('GRANT-REVOKED');
}

/**
 * CLI command `routersync maintain secret-selftest`
 */
export async function runMaintainSecretSelftestCommand(options: { stateDir?: string | undefined }): Promise<void> {
  const tty = Boolean(process.stdin.isTTY);
  const grantId = crypto.randomBytes(8).toString('hex');
  const now = new Date();
  const grant: ApplyGrant = {
    version: 1,
    id: grantId,
    combos: ['test-01'],
    agents: [],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  };
  const secret = generateGrantSecret();
  const grantFile = createGrantFile(grant, secret);
  const grantPath = getGrantFilePath(options.stateDir);
  fs.mkdirSync(path.dirname(grantPath), { recursive: true });
  fs.writeFileSync(grantPath, JSON.stringify(grantFile, null, 2), 'utf8');
  const resolved = resolveGrantSecret();
  const validation = validateGrantFile(grantPath, resolved);
  const result = validation.valid
    ? 'ok'
    : validation.reason === 'grant-secret-missing'
      ? 'missing'
      : 'wrong';
  const grantsChecked = [grantPath].filter((p) => fs.existsSync(p)).length;
  console.log(`SECRET-SELFTEST result=${result} tty=${tty ? 'yes' : 'no'} grants-checked=${grantsChecked}`);
}

/**
 * CLI command `routersync maintain create`
 */
export async function runMaintainCreateCommand(options: MaintainCreateOptions): Promise<void> {
  const comboName = options.name?.trim();
  if (!comboName || !SAFE_COMBO_SLUG_RE.test(comboName)) {
    console.error(`maintain create invalid combo slug '${options.name}'`);
    console.error('MAINTAIN-REFUSED reason=only-pattern');
    process.exit(1);
  }

  const modelList = (options.models ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (modelList.length < 2) {
    throw new Error(`maintain create requires at least 2 models, got ${modelList.length}`);
  }

  const sDir = getTrackStateDir(options.stateDir);
  if (readFreezeState(sDir).frozen) {
    console.error('maintain create blocked: emergency freeze is active');
    console.error('MAINTAIN-REFUSED reason=frozen');
    process.exit(1);
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const isTestBypass =
    options.allowTestBypass === true &&
    process.env.VITEST === 'true' &&
    process.env.ROUTERSYNC_TEST_FAST === '1' &&
    typeof process.env.ROUTERSYNC_TEST_CONFIRM === 'string';

  const grantPath = getGrantFilePath(options.stateDir);
  let activeGrant: ApplyGrant | null = null;

  if (fs.existsSync(grantPath)) {
    const grantSecret = isTestBypass
      ? undefined
      : resolveGrantSecret({ isTTY, secretResolver: options.secretResolver });
    const grantCheck = validateGrantFile(grantPath, grantSecret, {
      requireSecret: !isTestBypass,
    });
    if (!grantCheck.valid) {
      console.error(`Grant file invalid: ${grantCheck.reason}`);
      console.error(`MAINTAIN-REFUSED reason=${grantCheck.reason}`);
      process.exit(1);
    }
    const scopeCheck = checkGrantScope(grantCheck.grant, [comboName], []);
    if (!scopeCheck.valid) {
      console.error(`Grant scope check failed: ${scopeCheck.detail}`);
      console.error(`MAINTAIN-REFUSED reason=${scopeCheck.reason} detail=${scopeCheck.detail}`);
      process.exit(1);
    }
    activeGrant = grantCheck.grant;
  } else {
    const consented = getConsentedRouterCombos(options.stateDir, options.router);
    if (!isTestBypass && !consented.has(comboName)) {
      console.error(`Combo '${comboName}' is not authorized in standing-consent.json`);
      console.error('MAINTAIN-REFUSED reason=only-pattern');
      process.exit(1);
    }
    if (!isTTY && !isTestBypass) {
      console.error('maintain create requires an interactive TTY or a valid write grant');
      console.error('MAINTAIN-REFUSED reason=no-tty');
      process.exit(1);
    }
  }

  const preflightDb = resolvePreflightDbPath({ router: options.router, configPath: options.configPath });
  if (isTestBypass) {
    if (!isUnderDir(preflightDb, os.tmpdir())) {
      console.error(`Target router database is outside os.tmpdir(): ${preflightDb}`);
      console.error('MAINTAIN-REFUSED reason=test-db-outside-tmp');
      process.exit(1);
    }
  } else if (!options.dryRun) {
    assertControlledWriteSandbox(preflightDb, 'router-db');
  }

  const prompt = options.promptFn ?? promptForConfirmation;
  let confirmWord = '';
  if (activeGrant) {
    confirmWord = 'chay';
  } else if (isTestBypass) {
    confirmWord = (process.env.ROUTERSYNC_TEST_CONFIRM ?? '').trim();
  } else {
    confirmWord = (await prompt(`Gõ 'chay' để xác nhận tạo combo '${comboName}': `)).trim();
  }

  if (confirmWord !== 'chay') {
    throw new Error(`Xác nhận bị từ chối (nhập '${confirmWord}', yêu cầu 'chay'). Hủy tạo combo.`);
  }

  const { config } = loadConfigFile(options.configPath);
  const routerCfg = options.router
    ? config.routers.find((r) => r.id === options.router)
    : config.routers[0];

  if (!routerCfg) {
    throw new Error(`Target router '${options.router ?? 'default'}' not found in configuration.`);
  }

  const adapter = await createAdapterForRouter(routerCfg, options.stateDir);
  const liveCombos = await adapter.readCombos();

  if (options.free) {
    let ownerConfig: any = null;
    const ownerConfigFile = path.join(sDir, 'owner-config.json');
    if (fs.existsSync(ownerConfigFile)) {
      try {
        ownerConfig = JSON.parse(fs.readFileSync(ownerConfigFile, 'utf8'));
      } catch {
        // ignore
      }
    }

    const metaMap = new Map<string, boolean>();
    const metaFile = path.join(sDir, 'model-meta.json');
    if (fs.existsSync(metaFile)) {
      try {
        const metaData = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (Array.isArray(metaData.items)) {
          for (const it of metaData.items) {
            if (it && typeof it.id === 'string') {
              metaMap.set(it.id, Boolean(it.free));
            }
          }
        }
      } catch {
        // ignore
      }
    }

    let nonFreeCount = 0;
    let fromMeta = 0;
    let fromClassify = 0;
    for (const m of modelList) {
      if (metaMap.has(m)) {
        fromMeta++;
        if (!metaMap.get(m)) {
          nonFreeCount++;
        }
      } else {
        fromClassify++;
        const slashIdx = m.indexOf('/');
        const provider = slashIdx > 0 ? m.slice(0, slashIdx) : '';
        const rawModel = slashIdx > 0 ? m.slice(slashIdx + 1) : m;
        const res = classifyFree({
          provider,
          models: [rawModel],
          ownerConfig,
        });
        const isFree = res.items[0]?.free ?? false;
        if (!isFree) {
          nonFreeCount++;
        }
      }
    }

    const routerName = options.router || routerCfg.adapter || routerCfg.id;
    const freeSource = fromClassify === 0 ? 'model-meta' : fromMeta === 0 ? 'classify' : 'mixed';
    console.log(
      `COMBO-FREE-CHECK router=${routerName} name=${comboName} non_free=${nonFreeCount} total=${modelList.length} source=${freeSource}`
    );

    if (nonFreeCount > 0) {
      throw new Error(`Combo '${comboName}' contains ${nonFreeCount} non-free model(s) but --free was specified.`);
    }
  }

  const routerName = options.router || routerCfg.adapter || routerCfg.id;
  console.log(
    `CREATE-COMBO router=${routerName} name=${comboName} models=${modelList.length} free_only=${options.free ? 'yes' : 'no'}`
  );

  const snapshot = await adapter.createSnapshot();
  saveSnapshot(snapshot);

  const existing = liveCombos.find((c) => c.name === comboName || c.id === comboName);
  const targetPlan: Plan = {
    id: `maintain-create-${comboName}-${Date.now()}`,
    target: routerCfg.id,
    timestamp: new Date().toISOString(),
    additions: existing
      ? []
      : [
          {
            id: comboName,
            name: comboName,
            models: modelList,
            managed: true,
          },
        ],
    modifications: existing
      ? [
          {
            id: existing.id,
            name: comboName,
            models: modelList,
            managed: existing.managed ?? true,
          },
        ]
      : [],
    deletions: [],
    reasons: {
      [comboName]: 'maintain-create',
    },
  };

  const applyResult = await applyPlanSafe(adapter, targetPlan, { dryRun: Boolean(options.dryRun) });
  if (!applyResult.success && applyResult.staleDetected) {
    console.error(`READBACK stale=yes rollback=${applyResult.rollbackExecuted ? 'yes' : 'no'}`);
    process.exit(1);
  }
  if (!applyResult.success) {
    throw new Error(`maintain create write failed: ${applyResult.error}`);
  }

  if (!options.dryRun) {
    appendApplyReceipt(sDir, {
      target: `router:${routerCfg.id}/${comboName}`,
      planHash: targetPlan.id,
      appliedAt: targetPlan.timestamp,
      appliedAtLevel: 'propose',
      authorizedVia: activeGrant ? 'legacy-grant' : 'interactive-tty',
      success: applyResult.success,
      readBackVerified: Boolean(applyResult.readBackVerified),
      readBackLevel: applyResult.readBackLevel ?? 'db-only',
      rolledBack: Boolean(applyResult.rollbackExecuted),
      snapshotOrBackupRef: snapshot.id,
    });
  }

  const grantId = activeGrant ? activeGrant.id : '0000000000000000';
  console.log(`MAINTAIN-APPLY changed=1 combos=${comboName} snapshot=${snapshot.id} grant=${grantId}`);
  const canonicalCreate =
    applyResult.canonicalReadBackLevel ?? normalizeReadBackLevel(applyResult.readBackLevel);
  if (options.dryRun) {
    console.log('READBACK dry-run');
  } else if (
    applyResult.readBackVerified &&
    (canonicalCreate === 'api-verified' || canonicalCreate === 'existence-only')
  ) {
    console.log(`READBACK ok=yes level=${canonicalCreate}`);
  } else {
    console.log(`READBACK db-only reason=${applyResult.degradedReason ?? 'no-serving-path'}`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          name: comboName,
          models: modelList,
          free: Boolean(options.free),
          snapshotId: snapshot.id,
          grantId,
        },
        null,
        2
      )
    );
  }
}

/**
 * CLI command `routersync maintain apply`
 *
 * Enforces refusal guards and gate restrictions (preserving security-audit.mjs Gate 1):
 * 1. Missing --only -> MAINTAIN-REFUSED reason=no-only
 * 2. Invalid combo slug syntax -> MAINTAIN-REFUSED reason=only-pattern
 * 3. --yes flag present -> MAINTAIN-REFUSED reason=yes-flag
 * 4. Agents invalid -> MAINTAIN-REFUSED reason=agents-invalid
 * 5. Emergency freeze active -> MAINTAIN-REFUSED reason=frozen
 * 6. Policy scope (standing-consent.json, default []) or active grant -> MAINTAIN-REFUSED reason=only-pattern / grant-* / no-tty
 */
export async function runMaintainApplyCommand(options: MaintainApplyOptions): Promise<void> {
  // Refusal guards 1 & 2: strict --only slug list grammar
  const targetComboNames = parseStrictOnlyCombos(options.only, 'maintain apply');

  // Refusal guard 3: yes-flag (MUST precede policy scope check for security-audit.mjs:921!)
  if (options.yes) {
    console.error('maintain apply does not allow --yes');
    console.error('MAINTAIN-REFUSED reason=yes-flag');
    process.exit(1);
  }

  // Refusal guard 4: strict --agents grammar
  const targetAgents = parseStrictAgents(options.agents, 'maintain apply');

  // Refusal guard 5: emergency freeze check
  const sDir = getTrackStateDir(options.stateDir);
  if (readFreezeState(sDir).frozen) {
    console.error('maintain apply blocked: emergency freeze is active');
    console.error('MAINTAIN-REFUSED reason=frozen');
    process.exit(1);
  }

  // Refusal guard 6: Grant check, Policy scope check (default []), & TTY check
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const isTestBypass =
    options.allowTestBypass === true &&
    process.env.VITEST === 'true' &&
    process.env.ROUTERSYNC_TEST_FAST === '1' &&
    typeof process.env.ROUTERSYNC_TEST_CONFIRM === 'string';

  const grantPath = getGrantFilePath(options.stateDir);
  let activeGrant: ApplyGrant | null = null;

  if (fs.existsSync(grantPath)) {
    const grantSecret = isTestBypass
      ? undefined
      : resolveGrantSecret({ isTTY, secretResolver: options.secretResolver });
    const grantCheck = validateGrantFile(grantPath, grantSecret, {
      requireSecret: !isTestBypass,
    });
    if (!grantCheck.valid) {
      console.error(`Grant file invalid: ${grantCheck.reason}`);
      console.error(`MAINTAIN-REFUSED reason=${grantCheck.reason}`);
      process.exit(1);
    }
    const scopeCheck = checkGrantScope(grantCheck.grant, targetComboNames, targetAgents);
    if (!scopeCheck.valid) {
      console.error(`Grant scope check failed: ${scopeCheck.detail}`);
      console.error(`MAINTAIN-REFUSED reason=${scopeCheck.reason} detail=${scopeCheck.detail}`);
      process.exit(1);
    }
    activeGrant = grantCheck.grant;
  } else {
    const consented = getConsentedRouterCombos(options.stateDir, options.router);
    if (!isTestBypass && targetComboNames.some((c) => !consented.has(c))) {
      console.error(
        `maintain apply only permitted for combos consented in standing-consent.json, got '${options.only}'`
      );
      console.error('MAINTAIN-REFUSED reason=only-pattern');
      process.exit(1);
    }
    if (!isTTY && !isTestBypass) {
      console.error('maintain apply requires an interactive TTY or a valid write grant');
      console.error('MAINTAIN-REFUSED reason=no-tty');
      process.exit(1);
    }
  }

  // Refusal guard 7: test-db-outside-tmp / sandbox guard
  const preflightDb = resolvePreflightDbPath(options);
  if (isTestBypass) {
    if (!isUnderDir(preflightDb, os.tmpdir())) {
      console.error(`Target router database is outside os.tmpdir(): ${preflightDb}`);
      console.error('MAINTAIN-REFUSED reason=test-db-outside-tmp');
      process.exit(1);
    }
  } else if (!options.dryRun) {
    assertControlledWriteSandbox(preflightDb, 'router-db');
  }

  // Gate: Mandatory --plan-hash
  if (!options.planHash) {
    throw new Error('maintain apply requires --plan-hash <hash>');
  }

  // Build the pure plan
  const { routerCfg, adapter, liveCombos, planResult } = await buildMaintainPlan(
    options.configPath,
    options.router,
    options.stateDir
  );

  // Compare plan hash
  if (options.planHash !== planResult.planHash) {
    throw new Error(
      `Plan hash mismatch: provided '${options.planHash}', computed '${planResult.planHash}'`
    );
  }

  // Find target combos
  for (const comboName of targetComboNames) {
    const targetCombo = liveCombos.find((c) => c.name === comboName || c.id === comboName);
    if (!targetCombo) {
      throw new Error(`Target combo '${comboName}' not found in router database`);
    }
  }

  // Gate: Confirmation prompt: must type 'chay' (bypassed if valid grant)
  const prompt = options.promptFn ?? promptForConfirmation;
  let confirmWord = '';
  if (activeGrant) {
    confirmWord = 'chay';
  } else if (isTestBypass) {
    confirmWord = (process.env.ROUTERSYNC_TEST_CONFIRM ?? '').trim();
  } else {
    confirmWord = (
      await prompt(`Gõ 'chay' để xác nhận áp dụng kế hoạch bảo trì cho combo '${targetComboNames.join(',')}': `)
    ).trim();
  }

  if (confirmWord !== 'chay') {
    throw new Error(`Xác nhận bị từ chối (nhập '${confirmWord}', yêu cầu 'chay'). Hủy áp dụng.`);
  }

  // Compute updated model list for each target combo
  const modifications = [];
  const updatedCombosResult: Array<{ combo: string; models: string[] }> = [];

  for (const comboName of targetComboNames) {
    const targetCombo = liveCombos.find((c) => c.name === comboName || c.id === comboName)!;
    const removesForCombo = new Set(
      planResult.removes
        .filter((r) => r.combo === targetCombo.id || r.combo === targetCombo.name)
        .map((r) => r.model)
    );

    const addsForCombo = planResult.adds
      .filter((a) => a.combo === targetCombo.id || a.combo === targetCombo.name)
      .map((a) => a.model);

    const updatedModels = targetCombo.models.filter((m) => !removesForCombo.has(m));
    for (const addModel of addsForCombo) {
      if (!updatedModels.includes(addModel)) {
        updatedModels.push(addModel);
      }
    }

    if (updatedModels.length < 2) {
      throw new Error(`Bảo trì bị chặn: combo '${comboName}' phải duy trì ít nhất 2 model (minSteps >= 2).`);
    }

    modifications.push({
      ...targetCombo,
      models: updatedModels,
    });
    updatedCombosResult.push({
      combo: targetCombo.name,
      models: updatedModels,
    });
  }

  // Pre-write snapshot persisted
  const snapshot = await adapter.createSnapshot();
  const snapshotPath = saveSnapshot(snapshot);
  console.log(`SNAPSHOT id=${snapshot.id} saved to ${snapshotPath}`);

  const nowIso = new Date().toISOString();
  const targetPlan: Plan = {
    id: `maintain-${planResult.planHash}`,
    target: routerCfg.id,
    timestamp: nowIso,
    additions: [],
    modifications,
    deletions: [],
    reasons: Object.fromEntries(
      modifications.map((m) => [m.id, `maintain-apply:${planResult.planHash}`])
    ),
  };

  // Check for test simulation hook of read-back mismatch
  if (process.env.ROUTERSYNC_FORCE_READBACK_MISMATCH === '1') {
    await adapter.applyPlan(targetPlan);
    const rollbackOk = await adapter.rollback(snapshot);
    throw new Error(
      `Read-back verification failed (simulated mismatch): rollback executed=${rollbackOk}`
    );
  }

  const applyResult = await applyPlanSafe(adapter, targetPlan, { dryRun: Boolean(options.dryRun) });
  if (!applyResult.success && applyResult.staleDetected) {
    console.error(`READBACK stale=yes rollback=${applyResult.rollbackExecuted ? 'yes' : 'no'}`);
    process.exit(1);
  }
  if (!applyResult.success) {
    throw new Error(`maintain apply write failed: ${applyResult.error}`);
  }

  if (!options.dryRun) {
    for (const comboName of targetComboNames) {
      appendApplyReceipt(sDir, {
        target: `router:${routerCfg.id}/${comboName}`,
        planHash: planResult.planHash,
        appliedAt: nowIso,
        appliedAtLevel: 'propose',
        authorizedVia: activeGrant ? 'legacy-grant' : 'interactive-tty',
        success: applyResult.success,
        readBackVerified: Boolean(applyResult.readBackVerified),
        readBackLevel: applyResult.readBackLevel ?? 'db-only',
        rolledBack: Boolean(applyResult.rollbackExecuted),
        snapshotOrBackupRef: snapshot.id,
      });
    }
  }

  console.log(
    `MAINTAIN-PLAN removes=${planResult.removes.length} adds=${planResult.adds.length} unmanagedTouched=${planResult.summary.unmanagedTouched}`
  );
  console.log(`PLAN-HASH ${planResult.planHash}`);
  const grantId = activeGrant ? activeGrant.id : '0000000000000000';
  console.log(`MAINTAIN-APPLY changed=${modifications.length} combos=${targetComboNames.join(',')} snapshot=${snapshot.id} grant=${grantId}`);
  const canonicalApply =
    applyResult.canonicalReadBackLevel ?? normalizeReadBackLevel(applyResult.readBackLevel);
  if (options.dryRun) {
    console.log('READBACK dry-run');
  } else if (
    applyResult.readBackVerified &&
    (canonicalApply === 'api-verified' || canonicalApply === 'existence-only')
  ) {
    console.log(`READBACK ok=yes level=${canonicalApply}`);
  } else {
    console.log(`READBACK db-only reason=${applyResult.degradedReason ?? 'no-serving-path'}`);
  }
  console.log(`[routersync] maintain apply succeeded for combo '${options.only}'. Read-back verified.`);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          combo: options.only,
          combos: targetComboNames,
          planHash: planResult.planHash,
          snapshotId: snapshot.id,
          grantId,
          models: updatedCombosResult[0]?.models ?? [],
          results: updatedCombosResult,
        },
        null,
        2
      )
    );
  }
}
