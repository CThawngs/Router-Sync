/**
 * packages/cli/src/apps/write-adapter.ts
 *
 * C45-WP2 Direction A Lossless Harness Write Adapters (`Phục vụ: S3`):
 *  - 4 Tier-A `write-adapter` harnesses:
 *      1. `hermes` (YAML with `#` comments + sibling `.env` key check)
 *      2. `openmausbot` (JSON `instances.<id>.config.managedModels`; refuses `bots.json`/`routines.json`)
 *      3. `opencode` (JSON/JSONC `provider.<id>.models.<modelId>` with `//` & `/* * /` comments)
 *      4. `dsh` (YAML Cordis patch `llm-pi-ai.config.providers.<id>.models[]` with `#` comments)
 *  - 5 `report-only` harnesses:
 *      `claude-code`, `codex`, `antigravity`, `cursor`, `grok-bot`
 *
 * Non-negotiable invariants enforced here:
 *  - M1: Only keyed providers (or verified local router ports 20128/30128) are modified.
 *  - M2: Default model slots, API keys, and base URLs are NEVER mutated (deprecated defaults emit warnings only).
 *  - M3: Lossless AST span replacement preserves comments, CRLF/LF, BOM, and sibling sections byte-for-byte.
 *  - M4: Backup -> Atomic Write -> Read-back (models + defaults + providerMeta endpoints/keys) -> Automatic Rollback to exact preSha256 on mismatch.
 *  - M5: Deterministic refusal on `report-only` harnesses and direct/symlink/junction `os.homedir()` paths outside `os.tmpdir()`.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  assertControlledWriteSandbox,
  expandHarnessPathPattern,
  getHarnessCapability,
  listHarnessCapabilities,
  type HarnessCapability,
} from '@routersync/core';
import type {
  HarnessApplyOptions,
  HarnessApplyResult,
  HarnessCatalogInput,
  HarnessDefaultSlotWarning,
  HarnessModelAddition,
  HarnessModelPlan,
  HarnessModelRemoval,
  HarnessPlanOptions,
  HarnessRollbackOptions,
  HarnessRollbackResult,
  HarnessWriteAdapter,
} from '@routersync/adapter-sdk';
import {
  applySpanReplacements,
  buildJsoncModelsMapReplacement,
  buildJsoncStringArrayReplacement,
  buildYamlModelsSeqEdit,
  detectNewline,
  findJsoncProperty,
  formatYamlScalar,
  jsoncNodeToValue,
  parseJsoncObject,
  type JsoncObjectNode,
  type SpanEdit,
} from './lossless-edit.js';

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function computePlanHash(payload: {
  app: string;
  directionAMode: string;
  editable: boolean;
  targetProviders: string[];
  additions: HarnessModelAddition[];
  removals: HarnessModelRemoval[];
  defaultSlotWarnings: HarnessDefaultSlotWarning[];
}): string {
  return sha256(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Canonical Symlink / Junction-Safe Path Guards (Shared across WP1 & WP2)
// ---------------------------------------------------------------------------

/**
 * Resolves `targetPath` to its deepest canonical real path on disk by walking
 * upward through non-existent trailing path segments until finding the nearest
 * existing ancestor (or dangling symlink), resolving via `fs.realpathSync.native`
 * (or `fs.readlinkSync`), and re-appending the remaining relative segments.
 */
export function resolveDeepRealPath(targetPath: string, depth = 0): string {
  if (depth > 40) {
    throw new Error(`Too many symbolic link levels while resolving path: ${targetPath}`);
  }
  const abs = path.resolve(targetPath);
  const tailSegments: string[] = [];
  let cur = abs;

  while (true) {
    try {
      const realAncestor = fs.realpathSync.native(cur);
      return tailSegments.length > 0
        ? path.join(realAncestor, ...tailSegments.reverse())
        : realAncestor;
    } catch {
      const lstat = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (lstat?.isSymbolicLink()) {
        const rawLink = fs.readlinkSync(cur);
        const linkedTarget = path.resolve(path.dirname(cur), rawLink);
        const resolvedLink = resolveDeepRealPath(linkedTarget, depth + 1);
        return tailSegments.length > 0
          ? path.join(resolvedLink, ...tailSegments.reverse())
          : resolvedLink;
      }
      const parent = path.dirname(cur);
      if (parent === cur) {
        return tailSegments.length > 0 ? path.join(cur, ...tailSegments.reverse()) : cur;
      }
      tailSegments.push(path.basename(cur));
      cur = parent;
    }
  }
}

function normalizeForPlatformComparison(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSubPathOrEqual(parentDir: string, candidate: string): boolean {
  const normParent = normalizeForPlatformComparison(parentDir);
  const normCandidate = normalizeForPlatformComparison(candidate);
  const rel = path.relative(normParent, normCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns `true` when `targetPath` (after full symlink / Windows junction
 * resolution) lands inside the real `os.homedir()` and NOT genuinely inside
 * a distinct `os.tmpdir()` sandbox directory.
 */
export function isInsideRealHomeOutsideSandbox(targetPath: string): boolean {
  const realTarget = resolveDeepRealPath(targetPath);
  const realHome = resolveDeepRealPath(os.homedir());
  const realTmp = resolveDeepRealPath(os.tmpdir());

  const sameTmpAndHome =
    normalizeForPlatformComparison(realTmp) === normalizeForPlatformComparison(realHome);
  if (!sameTmpAndHome && !isSubPathOrEqual(realTmp, realHome) && isSubPathOrEqual(realTmp, realTarget)) {
    return false;
  }
  return isSubPathOrEqual(realHome, realTarget);
}

/**
 * Guard against writing to real user home directories outside `os.tmpdir()`
 * unless an explicit live owner gate (`ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`) is set.
 */
export function assertHarnessWriteSandboxAllowed(configPath: string): void {
  assertControlledWriteSandbox(configPath, 'harness-config');
}

/**
 * Blocks any read/write against OpenMausBot's app-owned `bots.json` or `routines.json`
 * (checking both lexical basename and symlink-resolved basename).
 */
export function assertOpenMausBotSafeFile(configPath: string): void {
  const lexicalBase = path.basename(configPath).toLowerCase();
  const realBase = path.basename(resolveDeepRealPath(configPath)).toLowerCase();
  for (const base of [lexicalBase, realBase]) {
    if (base === 'bots.json' || base === 'routines.json') {
      throw new Error(
        `OpenMausBot safety guard: refusing to access or modify ${base}; only config.json may be inspected/edited while ${base} belongs to the running app.`
      );
    }
  }
}

/**
 * Resolves the effective `homeDir` for `apps plan` / `apps apply`:
 *  - If `--home` was explicitly provided, use it symmetrically.
 *  - If `--config` points to a sandbox path outside real `os.homedir()`, return `undefined`
 *    so host `~/.hermes/.env` and `~/.local/share/opencode/auth.json` never leak into sandbox runs.
 *  - Otherwise (no `--config`, or `--config` is inside real `os.homedir()`), return `os.homedir()`.
 */
export function resolveEffectiveHarnessHomeDir(
  configPath: string | undefined,
  explicitHome: string | undefined
): string | undefined {
  if (explicitHome !== undefined) {
    return explicitHome;
  }
  if (!configPath) {
    return os.homedir();
  }
  return isInsideRealHomeOutsideSandbox(configPath) ? os.homedir() : undefined;
}

let cachedOsProcs: { at: number; list: string[] } | undefined;

function defaultProcessListRunner(): string[] {
  const now = Date.now();
  if (cachedOsProcs && now - cachedOsProcs.at < 2_000) {
    return cachedOsProcs.list;
  }
  const out: string[] = [];
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        timeout: 1_500,
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)"/);
          if (m?.[1]) out.push(m[1]);
        }
      }
    } else {
      const res = spawnSync('ps', ['-A', '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 1_500,
      });
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) out.push(path.basename(trimmed));
        }
      }
    }
  } catch {
    // Ignore process listing failures in restricted sandboxes
  }
  cachedOsProcs = { at: now, list: out };
  return out;
}

/**
 * Detects running processes matching the harness capability record in `harness-matrix.json`.
 */
export function detectRunningHarnessProcesses(
  harnessId: string,
  runner?: () => string[]
): string[] {
  const cap = getHarnessCapability(harnessId);
  if (!cap) return [];

  const expectedRaw = [
    ...cap.processNames.win32,
    ...cap.processNames.darwin,
    ...cap.processNames.linux,
  ].filter((name) => {
    const lower = name.toLowerCase();
    // Avoid generic python interpreter false-positives when scanning OS processes
    return lower !== 'python.exe' && lower !== 'python' && lower !== 'python3';
  });

  if (expectedRaw.length === 0) return [];
  const expectedLower = new Set(expectedRaw.map((n) => n.toLowerCase()));

  const running = runner ? runner() : defaultProcessListRunner();
  const matched = new Set<string>();
  for (const proc of running) {
    const base = path.basename(proc.trim());
    if (expectedLower.has(base.toLowerCase())) {
      matched.add(base);
    }
  }
  return [...matched];
}

function resolveDefaultModelsConfigPath(cap: HarnessCapability, homeDir?: string): string {
  if (cap.id === 'hermes') {
    const hermesHome = process.env['HERMES_HOME']?.trim();
    if (hermesHome && (!homeDir || isSubPathOrEqual(homeDir, hermesHome))) {
      const envCandidate = path.join(hermesHome, 'config.yaml');
      if (fs.existsSync(envCandidate)) return envCandidate;
    }
  }
  const platformKey: 'win32' | 'darwin' | 'linux' =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const patterns =
    cap.modelsConfig.paths[platformKey]?.length
      ? cap.modelsConfig.paths[platformKey]
      : cap.mcp.paths[platformKey] ?? [];
  if (patterns.length === 0) return '';

  const customHomeProvided =
    typeof homeDir === 'string' &&
    homeDir.trim().length > 0 &&
    normalizeForPlatformComparison(homeDir) !== normalizeForPlatformComparison(os.homedir());
  const expandEnv = customHomeProvided
    ? {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
        APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
      }
    : process.env;

  const expanded = patterns.map((p) =>
    expandHarnessPathPattern(p, { homeDir, platform: process.platform, env: expandEnv })
  );
  for (const candidate of expanded) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return expanded[0] ?? '';
}

function isLocalRouterPortUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):(?:20128|30128)(?:\/|$)/i.test(rawUrl.trim());
}

function nonEmptyStr(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function atomicWriteBytes(filePath: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof content === 'string') {
    fs.writeFileSync(tmpPath, content, 'utf8');
  } else {
    fs.writeFileSync(tmpPath, content);
  }
  fs.renameSync(tmpPath, filePath);
}

interface ProviderMetaFingerprint {
  endpointFingerprint: string;
  authFingerprint: string;
  nonModelsFingerprint: string;
}

interface ParsedHarnessState {
  /** All providers discovered -> ordered list of model IDs */
  allProviderModels: Map<string, string[]>;
  /** Subset of providers eligible for Direction A updates (keyed) */
  keyedProviders: Set<string>;
  /** Default slot name -> raw string value */
  defaultSlots: Map<string, { rawValue: string; providerHint?: string | undefined }>;
  /** Immutable SHA-256 digests of endpoint URL, auth metadata, and non-model fields per provider */
  providerMeta: Map<string, ProviderMetaFingerprint>;
  /** Computes lossless next text for a given map of provider -> { removeSet, addIds } */
  buildUpdatedText: (
    providerChanges: Map<string, { removeSet: Set<string>; addIds: string[] }>
  ) => string;
}

function omitKeys(obj: Record<string, unknown>, keysToOmit: readonly string[]): Record<string, unknown> {
  const omit = new Set(keysToOmit);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (!omit.has(key)) {
      out[key] = obj[key];
    }
  }
  return out;
}

function checkDefaultSlotWarnings(
  defaultSlots: Map<string, { rawValue: string; providerHint?: string | undefined }>,
  catalog: HarnessCatalogInput
): HarnessDefaultSlotWarning[] {
  const warnings: HarnessDefaultSlotWarning[] = [];

  for (const [slot, info] of defaultSlots.entries()) {
    const raw = info.rawValue;
    if (!raw) continue;

    const slashIdx = raw.indexOf('/');
    const parsedProvider = slashIdx > 0 ? raw.slice(0, slashIdx) : info.providerHint;
    const bareModel = slashIdx > 0 ? raw.slice(slashIdx + 1) : raw;

    const candidateEntries: Array<[string, { liveModels: string[]; deprecatedModels: string[] }]> =
      parsedProvider && catalog[parsedProvider]
        ? [[parsedProvider, catalog[parsedProvider]!]]
        : Object.entries(catalog);

    for (const [provId, cat] of candidateEntries) {
      if (cat.deprecatedModels.includes(bareModel) || cat.deprecatedModels.includes(raw)) {
        const nextLive = cat.liveModels[0];
        const suggestion = nextLive
          ? slashIdx > 0
            ? `${provId}/${nextLive}`
            : nextLive
          : 'chọn model đang hoạt động khác trong danh sách liveModels';
        warnings.push({
          slot,
          currentModel: raw,
          suggestion,
        });
        break;
      }
    }
  }

  return warnings;
}

/**
 * Parses the RHS of a `KEY=VALUE` line in `.env` without returning or logging
 * secrets externally: strips unquoted `# inline comments` and empty quotes `""`/`''`.
 */
function extractDotEnvValue(rawRhs: string): string {
  const s = rawRhs.trim();
  if (!s || s.startsWith('#')) {
    return '';
  }
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0]!;
    for (let i = 1; i < s.length; i += 1) {
      if (quote === '"' && s[i] === '\\') {
        i += 1;
        continue;
      }
      if (s[i] === quote) {
        return s.slice(1, i).trim();
      }
    }
    return s.slice(1).replace(/\s+#.*$/, '').trim();
  }
  const commentMatch = s.match(/\s+#/);
  const unquoted =
    commentMatch && commentMatch.index !== undefined
      ? s.slice(0, commentMatch.index).trim()
      : s;
  if (unquoted === '""' || unquoted === "''") {
    return '';
  }
  return unquoted;
}

function readEnvVariableNamesOnly(envFilePaths: string[]): Set<string> {
  const keys = new Set<string>();
  for (const envPath of envFilePaths) {
    if (!envPath || !fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m?.[1]) continue;
        const val = extractDotEnvValue(m[2] ?? '');
        if (val.length > 0) {
          keys.add(m[1]);
        }
      }
    } catch {
      // Ignore unreadable .env
    }
  }
  return keys;
}

function extractYamlSeqModelIds(seqNode: YAMLSeq | undefined): string[] {
  if (!seqNode || !isSeq(seqNode)) return [];
  const ids: string[] = [];
  for (const item of seqNode.items) {
    if (isScalar(item)) {
      const id = nonEmptyStr(String(item.value ?? ''));
      if (id) ids.push(id);
    } else if (isMap(item)) {
      const idVal = item.get('id');
      const id = nonEmptyStr(typeof idVal === 'string' ? idVal : idVal != null ? String(idVal) : '');
      if (id) ids.push(id);
    }
  }
  return ids;
}

function getLineIndentBefore(text: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) {
    lineStart -= 1;
  }
  let cursor = lineStart;
  while (cursor < offset && (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9)) {
    cursor += 1;
  }
  return text.slice(lineStart, cursor);
}

function getColumnSpacesBefore(text: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10 && text.charCodeAt(lineStart - 1) !== 13) {
    lineStart -= 1;
  }
  return text.slice(lineStart, offset).replace(/[^\t]/g, ' ');
}

const CANONICAL_JSON_SECRET_KEYS = new Set([
  'apikey',
  'key',
  'token',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'secret',
  'secretkey',
  'clientsecret',
  'credential',
  'credentials',
]);

function isCanonicalSecretFieldName(key: string): boolean {
  return CANONICAL_JSON_SECRET_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

function hasJsonSecretField(rec: Record<string, unknown>): boolean {
  return Object.entries(rec).some(
    ([k, v]) => isCanonicalSecretFieldName(k) && typeof v === 'string' && v.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Parser 1: Hermes (`config.yaml` + sibling `.env`)
// ---------------------------------------------------------------------------

function parseHermesState(text: string, configPath: string, homeDir?: string): ParsedHarnessState {
  const doc = parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error(`Invalid Hermes YAML in ${configPath}: ${doc.errors[0]?.message ?? 'root must be a mapping'}`);
  }
  const root = doc.contents;

  const envPaths = [path.join(path.dirname(configPath), '.env')];
  if (homeDir) {
    envPaths.push(path.join(homeDir, '.hermes', '.env'));
  }
  const envKeys = readEnvVariableNamesOnly(envPaths);

  const allProviderModels = new Map<string, string[]>();
  const keyedProviders = new Set<string>();
  const providerSeqNodes = new Map<string, { mapNode: YAMLMap; seqNode?: YAMLSeq | undefined }>();
  const defaultSlots = new Map<string, { rawValue: string; providerHint?: string | undefined }>();
  const providerMeta = new Map<string, ProviderMetaFingerprint>();

  const modelMap = root.get('model', true);
  let mainProviderHint: string | undefined;
  if (isMap(modelMap)) {
    mainProviderHint = nonEmptyStr(modelMap.get('provider'));
    const defModel = nonEmptyStr(modelMap.get('default'));
    if (defModel) {
      defaultSlots.set('model.default', { rawValue: defModel, providerHint: mainProviderHint });
    }
  }

  const cronMap = root.get('cron', true);
  if (isMap(cronMap)) {
    const cronModel = nonEmptyStr(cronMap.get('model'));
    const cronProv = nonEmptyStr(cronMap.get('model_provider')) ?? mainProviderHint;
    if (cronModel) {
      defaultSlots.set('cron.model', { rawValue: cronModel, providerHint: cronProv });
    }
  }

  const providersNode = root.get('providers', true);
  if (isMap(providersNode)) {
    for (const pair of providersNode.items) {
      if (!isScalar(pair.key) || !isMap(pair.value)) continue;
      const provId = String(pair.key.value ?? '').trim();
      if (!provId) continue;
      const pMap = pair.value;
      const inlineKey =
        nonEmptyStr(pMap.get('api_key')) ??
        nonEmptyStr(pMap.get('apiKey')) ??
        nonEmptyStr(pMap.get('key'));
      const keyEnvName = nonEmptyStr(pMap.get('key_env')) ?? nonEmptyStr(pMap.get('api_key_env'));
      const hasEnvKey = Boolean(keyEnvName && envKeys.has(keyEnvName));
      const baseUrl =
        nonEmptyStr(pMap.get('base_url')) ??
        nonEmptyStr(pMap.get('baseURL')) ??
        nonEmptyStr(pMap.get('url'));
      const isKeyed = Boolean(inlineKey) || hasEnvKey || isLocalRouterPortUrl(baseUrl);

      const modelsRaw = pMap.get('models', true);
      const seqNode = isSeq(modelsRaw) ? modelsRaw : undefined;
      allProviderModels.set(provId, extractYamlSeqModelIds(seqNode));
      providerSeqNodes.set(provId, { mapNode: pMap, seqNode });

      const rawJs = (pMap.toJS(doc) ?? {}) as Record<string, unknown>;
      providerMeta.set(provId, {
        endpointFingerprint: sha256(
          JSON.stringify({
            base_url: rawJs['base_url'] ?? null,
            baseURL: rawJs['baseURL'] ?? null,
            url: rawJs['url'] ?? null,
          })
        ),
        authFingerprint: sha256(
          JSON.stringify({
            api_key: rawJs['api_key'] ?? null,
            apiKey: rawJs['apiKey'] ?? null,
            key: rawJs['key'] ?? null,
            key_env: rawJs['key_env'] ?? null,
            api_key_env: rawJs['api_key_env'] ?? null,
            isKeyed,
          })
        ),
        nonModelsFingerprint: sha256(JSON.stringify(omitKeys(rawJs, ['models']))),
      });

      if (isKeyed) {
        keyedProviders.add(provId);
      }
    }
  }

  const customProvidersNode = root.get('custom_providers', true);
  if (isSeq(customProvidersNode)) {
    customProvidersNode.items.forEach((item, idx) => {
      if (!isMap(item)) return;
      const provId = nonEmptyStr(item.get('name')) ?? nonEmptyStr(item.get('id'));
      if (!provId) return;

      const inlineKey =
        nonEmptyStr(item.get('api_key')) ??
        nonEmptyStr(item.get('apiKey')) ??
        nonEmptyStr(item.get('key'));
      const keyEnvName = nonEmptyStr(item.get('key_env')) ?? nonEmptyStr(item.get('api_key_env'));
      const hasEnvKey = Boolean(keyEnvName && envKeys.has(keyEnvName));
      const baseUrl =
        nonEmptyStr(item.get('base_url')) ??
        nonEmptyStr(item.get('baseURL')) ??
        nonEmptyStr(item.get('url'));
      const isKeyed = Boolean(inlineKey) || hasEnvKey || isLocalRouterPortUrl(baseUrl);

      const slotModel = nonEmptyStr(item.get('model'));
      if (slotModel) {
        defaultSlots.set(`custom_providers[${idx}].model`, {
          rawValue: slotModel,
          providerHint: provId,
        });
      }

      const modelsRaw = item.get('models', true);
      const seqNode = isSeq(modelsRaw) ? modelsRaw : undefined;
      allProviderModels.set(provId, extractYamlSeqModelIds(seqNode));
      providerSeqNodes.set(provId, { mapNode: item, seqNode });

      const rawJs = (item.toJS(doc) ?? {}) as Record<string, unknown>;
      providerMeta.set(provId, {
        endpointFingerprint: sha256(
          JSON.stringify({
            base_url: rawJs['base_url'] ?? null,
            baseURL: rawJs['baseURL'] ?? null,
            url: rawJs['url'] ?? null,
          })
        ),
        authFingerprint: sha256(
          JSON.stringify({
            api_key: rawJs['api_key'] ?? null,
            apiKey: rawJs['apiKey'] ?? null,
            key: rawJs['key'] ?? null,
            key_env: rawJs['key_env'] ?? null,
            api_key_env: rawJs['api_key_env'] ?? null,
            isKeyed,
          })
        ),
        nonModelsFingerprint: sha256(JSON.stringify(omitKeys(rawJs, ['models']))),
      });

      if (isKeyed) {
        keyedProviders.add(provId);
      }
    });
  }

  return {
    allProviderModels,
    keyedProviders,
    defaultSlots,
    providerMeta,
    buildUpdatedText(providerChanges) {
      const edits: SpanEdit[] = [];
      const nl = detectNewline(text);
      for (const [provId, change] of providerChanges.entries()) {
        if (change.removeSet.size === 0 && change.addIds.length === 0) continue;
        const target = providerSeqNodes.get(provId);
        if (!target) continue;
        if (target.seqNode) {
          const edit = buildYamlModelsSeqEdit(text, target.seqNode, change.removeSet, change.addIds);
          if (edit) edits.push(edit);
        } else if (change.addIds.length > 0 && target.mapNode.range) {
          const firstPair = target.mapNode.items[0];
          const keyRange = (firstPair?.key as { range?: [number, number, number] } | undefined)?.range;
          const propIndent = keyRange ? getColumnSpacesBefore(text, keyRange[0]) : '    ';
          const insertPos = target.mapNode.range[1];
          const prefix = insertPos > 0 && text.charCodeAt(insertPos - 1) !== 10 ? nl : '';
          const lines = change.addIds
            .map((id) => `${propIndent}  - id: ${formatYamlScalar(id)}`)
            .join(nl);
          edits.push({
            start: insertPos,
            end: insertPos,
            replacement: `${prefix}${propIndent}models:${nl}${lines}${nl}`,
          });
        }
      }
      const next = applySpanReplacements(text, edits);
      const checkDoc = parseDocument(next, { logLevel: 'silent' });
      if (checkDoc.errors.length > 0) {
        throw new Error(`Hermes YAML validation failed after edit: ${checkDoc.errors[0]?.message}`);
      }
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 2: OpenMausBot (`config.json` -> `instances.<id>.config.managedModels`)
// ---------------------------------------------------------------------------

function parseOpenMausBotState(text: string, configPath: string): ParsedHarnessState {
  assertOpenMausBotSafeFile(configPath);
  const { root, value } = parseJsoncObject(text);

  const allProviderModels = new Map<string, string[]>();
  const keyedProviders = new Set<string>();
  const defaultSlots = new Map<string, { rawValue: string; providerHint?: string | undefined }>();
  const providerMeta = new Map<string, ProviderMetaFingerprint>();
  const configNodes = new Map<string, JsoncObjectNode>();

  const topDef = value['defaultModelSelection'];
  if (typeof topDef === 'string' && topDef.trim()) {
    defaultSlots.set('defaultModelSelection', { rawValue: topDef.trim() });
  } else if (topDef && typeof topDef === 'object' && !Array.isArray(topDef)) {
    const nestedModel = nonEmptyStr((topDef as Record<string, unknown>)['model']);
    if (nestedModel) {
      defaultSlots.set('defaultModelSelection', {
        rawValue: nestedModel,
        providerHint: nonEmptyStr((topDef as Record<string, unknown>)['provider']),
      });
    }
  }

  const autoRecovery = value['automaticRecovery'];
  if (autoRecovery && typeof autoRecovery === 'object' && !Array.isArray(autoRecovery)) {
    const backupRaw = (autoRecovery as Record<string, unknown>)['backup'];
    if (typeof backupRaw === 'string' && backupRaw.trim()) {
      defaultSlots.set('automaticRecovery.backup', { rawValue: backupRaw.trim() });
    } else if (backupRaw && typeof backupRaw === 'object' && !Array.isArray(backupRaw)) {
      const rec = backupRaw as Record<string, unknown>;
      const bm = nonEmptyStr(rec['model']);
      if (bm) {
        defaultSlots.set('automaticRecovery.backup', {
          rawValue: bm,
          providerHint: nonEmptyStr(rec['provider']) ?? nonEmptyStr(rec['instanceId']),
        });
      }
    } else if (Array.isArray(backupRaw)) {
      backupRaw.forEach((entry, idx) => {
        const slotKey = idx === 0 ? 'automaticRecovery.backup' : `automaticRecovery.backup[${idx}]`;
        if (typeof entry === 'string' && entry.trim()) {
          defaultSlots.set(slotKey, { rawValue: entry.trim() });
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const rec = entry as Record<string, unknown>;
          const bm = nonEmptyStr(rec['model']);
          if (bm) {
            defaultSlots.set(slotKey, {
              rawValue: bm,
              providerHint: nonEmptyStr(rec['provider']) ?? nonEmptyStr(rec['instanceId']),
            });
          }
        }
      });
    }
  }

  const decider = value['decider'];
  if (decider && typeof decider === 'object' && !Array.isArray(decider)) {
    const dm = nonEmptyStr((decider as Record<string, unknown>)['openrouterModel']);
    if (dm) defaultSlots.set('decider.openrouterModel', { rawValue: dm });
  }

  const instancesProp = findJsoncProperty(root, 'instances');
  if (instancesProp && instancesProp.value.kind === 'object') {
    for (const instProp of instancesProp.value.properties) {
      const instId = instProp.key;
      if (instProp.value.kind !== 'object') continue;
      const instVal = jsoncNodeToValue(instProp.value) as Record<string, unknown>;
      const driver = nonEmptyStr(instVal['driver']);
      const cfgProp = findJsoncProperty(instProp.value, 'config');
      if (!cfgProp || cfgProp.value.kind !== 'object') continue;

      const cfgNode = cfgProp.value;
      const cfgVal = jsoncNodeToValue(cfgNode) as Record<string, unknown>;
      const managedRaw = Array.isArray(cfgVal['managedModels'])
        ? (cfgVal['managedModels'] as unknown[])
        : [];
      const currentModels = managedRaw
        .map((m) => nonEmptyStr(m))
        .filter((m): m is string => Boolean(m));

      allProviderModels.set(instId, currentModels);
      configNodes.set(instId, cfgNode);

      const instModel = nonEmptyStr(cfgVal['model']);
      if (instModel) {
        defaultSlots.set(`instances.${instId}.config.model`, {
          rawValue: instModel,
          providerHint: instId,
        });
      }

      // Only `openai-compat` instances maintain user-editable `managedModels`
      const isEditableDriver = driver === 'openai-compat';
      const urlVal =
        nonEmptyStr(cfgVal['url']) ??
        nonEmptyStr(cfgVal['baseURL']) ??
        nonEmptyStr(cfgVal['baseUrl']);
      const hasSecret = hasJsonSecretField(cfgVal);
      const isKeyed = isEditableDriver && (hasSecret || isLocalRouterPortUrl(urlVal));

      const secretPairs = Object.entries(cfgVal)
        .filter(([k]) => isCanonicalSecretFieldName(k))
        .sort(([a], [b]) => a.localeCompare(b));

      providerMeta.set(instId, {
        endpointFingerprint: sha256(
          JSON.stringify({
            url: cfgVal['url'] ?? null,
            baseURL: cfgVal['baseURL'] ?? null,
            baseUrl: cfgVal['baseUrl'] ?? null,
          })
        ),
        authFingerprint: sha256(JSON.stringify({ secretPairs, isKeyed })),
        nonModelsFingerprint: sha256(
          JSON.stringify({
            instTop: omitKeys(instVal, ['config']),
            cfgWithoutModels: omitKeys(cfgVal, ['managedModels']),
          })
        ),
      });

      if (isKeyed) {
        keyedProviders.add(instId);
      }
    }
  }

  return {
    allProviderModels,
    keyedProviders,
    defaultSlots,
    providerMeta,
    buildUpdatedText(providerChanges) {
      const edits: SpanEdit[] = [];
      const nl = detectNewline(text);

      for (const [instId, change] of providerChanges.entries()) {
        if (change.removeSet.size === 0 && change.addIds.length === 0) continue;
        const cfgNode = configNodes.get(instId);
        if (!cfgNode) continue;

        const current = allProviderModels.get(instId) ?? [];
        const surviving = current.filter((m) => !change.removeSet.has(m));
        const nextModels = [...surviving, ...change.addIds];

        const managedProp = findJsoncProperty(cfgNode, 'managedModels');
        if (managedProp && managedProp.value.kind === 'array') {
          edits.push({
            start: managedProp.value.start,
            end: managedProp.value.end,
            replacement: buildJsoncStringArrayReplacement(text, managedProp.value, nextModels),
          });
        } else if (change.addIds.length > 0) {
          const closingIndent = getLineIndentBefore(text, cfgNode.end - 1);
          const propIndent = cfgNode.properties[0]
            ? getLineIndentBefore(text, cfgNode.properties[0].keyStart)
            : `${closingIndent}  `;
          const arrLiteral = `[${nl}${nextModels
            .map((m) => `${propIndent}  ${JSON.stringify(m)}`)
            .join(`,${nl}`)}${nl}${propIndent}]`;
          if (cfgNode.properties.length === 0) {
            edits.push({
              start: cfgNode.start,
              end: cfgNode.end,
              replacement: `{${nl}${propIndent}"managedModels": ${arrLiteral}${nl}${closingIndent}}`,
            });
          } else {
            const lastProp = cfgNode.properties[cfgNode.properties.length - 1]!;
            edits.push({
              start: lastProp.end,
              end: lastProp.end,
              replacement: `,${nl}${propIndent}"managedModels": ${arrLiteral}`,
            });
          }
        }
      }

      const next = applySpanReplacements(text, edits);
      JSON.parse(next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 3: OpenCode (`opencode.json` / `opencode.jsonc`)
// ---------------------------------------------------------------------------

function readOpenCodeAuthProviders(homeDir?: string): Set<string> {
  const out = new Set<string>();
  if (!homeDir) return out;
  const authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  if (!fs.existsSync(authPath)) return out;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && (typeof v === 'object' || typeof v === 'string')) {
          out.add(k);
        }
      }
    }
  } catch {
    // Ignore unreadable auth.json
  }
  return out;
}

function extractEnvNameList(raw: unknown): string[] {
  if (typeof raw === 'string') {
    const s = nonEmptyStr(raw);
    return s ? [s] : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => nonEmptyStr(item)).filter((item): item is string => Boolean(item));
  }
  return [];
}

function parseOpenCodeState(text: string, configPath: string, homeDir?: string): ParsedHarnessState {
  const { root, value } = parseJsoncObject(text);
  const authProviders = readOpenCodeAuthProviders(homeDir);

  const envPaths = [path.join(path.dirname(configPath), '.env')];
  if (homeDir) {
    envPaths.push(
      path.join(homeDir, '.config', 'opencode', '.env'),
      path.join(homeDir, '.env')
    );
  }
  const envKeys = readEnvVariableNamesOnly(envPaths);

  const allProviderModels = new Map<string, string[]>();
  const keyedProviders = new Set<string>();
  const defaultSlots = new Map<string, { rawValue: string; providerHint?: string | undefined }>();
  const providerMeta = new Map<string, ProviderMetaFingerprint>();
  const providerNodes = new Map<string, { provNode: JsoncObjectNode; modelsNode?: JsoncObjectNode | undefined }>();

  const topModel = nonEmptyStr(value['model']);
  if (topModel) defaultSlots.set('model', { rawValue: topModel });
  const smallModel = nonEmptyStr(value['small_model']);
  if (smallModel) defaultSlots.set('small_model', { rawValue: smallModel });

  const agentVal = value['agent'];
  if (agentVal && typeof agentVal === 'object' && !Array.isArray(agentVal)) {
    for (const [agentName, rawCfg] of Object.entries(agentVal as Record<string, unknown>)) {
      if (rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg)) {
        const am = nonEmptyStr((rawCfg as Record<string, unknown>)['model']);
        if (am) defaultSlots.set(`agent.${agentName}.model`, { rawValue: am });
      }
    }
  }

  const providerProp = findJsoncProperty(root, 'provider');
  if (providerProp && providerProp.value.kind === 'object') {
    for (const pProp of providerProp.value.properties) {
      const provId = pProp.key;
      if (pProp.value.kind !== 'object') continue;
      const pNode = pProp.value;
      const pVal = jsoncNodeToValue(pNode) as Record<string, unknown>;
      const optsVal =
        pVal['options'] && typeof pVal['options'] === 'object' && !Array.isArray(pVal['options'])
          ? (pVal['options'] as Record<string, unknown>)
          : {};

      const configuredEnvNames = [
        ...extractEnvNameList(pVal['env']),
        ...extractEnvNameList(optsVal['env']),
        ...extractEnvNameList(pVal['apiKeyEnv']),
        ...extractEnvNameList(optsVal['apiKeyEnv']),
      ];
      const hasEnvKey = configuredEnvNames.some((envName) => envKeys.has(envName));
      const baseUrl =
        nonEmptyStr(optsVal['baseURL']) ??
        nonEmptyStr(optsVal['base_url']) ??
        nonEmptyStr(optsVal['url']) ??
        nonEmptyStr(pVal['baseURL']);

      const hasKey =
        hasJsonSecretField(optsVal) ||
        hasJsonSecretField(pVal) ||
        hasEnvKey ||
        authProviders.has(provId) ||
        isLocalRouterPortUrl(baseUrl);

      const modelsProp = findJsoncProperty(pNode, 'models');
      const modelsNode = modelsProp && modelsProp.value.kind === 'object' ? modelsProp.value : undefined;
      const modelIds = modelsNode ? modelsNode.properties.map((m) => m.key) : [];

      allProviderModels.set(provId, modelIds);
      providerNodes.set(provId, { provNode: pNode, modelsNode });

      const optSecrets = Object.entries(optsVal)
        .filter(([k]) => isCanonicalSecretFieldName(k))
        .sort(([a], [b]) => a.localeCompare(b));
      const topSecrets = Object.entries(pVal)
        .filter(([k]) => isCanonicalSecretFieldName(k))
        .sort(([a], [b]) => a.localeCompare(b));

      providerMeta.set(provId, {
        endpointFingerprint: sha256(
          JSON.stringify({
            optsBaseURL: optsVal['baseURL'] ?? null,
            optsBaseUrl: optsVal['base_url'] ?? null,
            optsUrl: optsVal['url'] ?? null,
            topBaseURL: pVal['baseURL'] ?? null,
          })
        ),
        authFingerprint: sha256(
          JSON.stringify({
            optSecrets,
            topSecrets,
            env: pVal['env'] ?? null,
            optsEnv: optsVal['env'] ?? null,
            hasKey,
          })
        ),
        nonModelsFingerprint: sha256(JSON.stringify(omitKeys(pVal, ['models']))),
      });

      if (hasKey) {
        keyedProviders.add(provId);
      }
    }
  }

  return {
    allProviderModels,
    keyedProviders,
    defaultSlots,
    providerMeta,
    buildUpdatedText(providerChanges) {
      const edits: SpanEdit[] = [];
      const nl = detectNewline(text);

      for (const [provId, change] of providerChanges.entries()) {
        if (change.removeSet.size === 0 && change.addIds.length === 0) continue;
        const entry = providerNodes.get(provId);
        if (!entry) continue;

        if (entry.modelsNode) {
          edits.push({
            start: entry.modelsNode.start,
            end: entry.modelsNode.end,
            replacement: buildJsoncModelsMapReplacement(
              text,
              entry.modelsNode,
              change.removeSet,
              change.addIds
            ),
          });
        } else if (change.addIds.length > 0) {
          const closingIndent = getLineIndentBefore(text, entry.provNode.end - 1);
          const propIndent = entry.provNode.properties[0]
            ? getLineIndentBefore(text, entry.provNode.properties[0].keyStart)
            : `${closingIndent}  `;
          const innerEntries = change.addIds
            .map((id) => `${propIndent}  ${JSON.stringify(id)}: { "name": ${JSON.stringify(id)} }`)
            .join(`,${nl}`);
          const modelsBlock = `"models": {${nl}${innerEntries}${nl}${propIndent}}`;
          if (entry.provNode.properties.length === 0) {
            edits.push({
              start: entry.provNode.start,
              end: entry.provNode.end,
              replacement: `{${nl}${propIndent}${modelsBlock}${nl}${closingIndent}}`,
            });
          } else {
            const lastProp = entry.provNode.properties[entry.provNode.properties.length - 1]!;
            edits.push({
              start: lastProp.end,
              end: lastProp.end,
              replacement: `,${nl}${propIndent}${modelsBlock}`,
            });
          }
        }
      }

      const next = applySpanReplacements(text, edits);
      parseJsoncObject(next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 4: DSH (`cordis.patch.yml`)
// ---------------------------------------------------------------------------

function parseDshState(text: string, configPath: string): ParsedHarnessState {
  const doc = parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length > 0 || !isSeq(doc.contents)) {
    throw new Error(`Invalid DSH Cordis YAML in ${configPath}: ${doc.errors[0]?.message ?? 'root must be a sequence'}`);
  }

  const allProviderModels = new Map<string, string[]>();
  const keyedProviders = new Set<string>();
  const defaultSlots = new Map<string, { rawValue: string; providerHint?: string | undefined }>();
  const providerMeta = new Map<string, ProviderMetaFingerprint>();
  const providerSeqNodes = new Map<string, { mapNode: YAMLMap; seqNode?: YAMLSeq | undefined }>();

  const rows: YAMLMap[] = [];
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const insertSeq = item.get('insert', true);
    if (isSeq(insertSeq)) {
      for (const nested of insertSeq.items) {
        if (isMap(nested)) rows.push(nested);
      }
    } else {
      rows.push(item);
    }
  }

  for (const row of rows) {
    const id = nonEmptyStr(row.get('id'));
    const name = nonEmptyStr(row.get('name'));
    const cfg = row.get('config', true);
    if (!isMap(cfg)) continue;

    if (id === 'agent-default-model' || name === '@deepseek-ai/dsh-agent-default-model') {
      const defProv = nonEmptyStr(cfg.get('provider'));
      const defModel = nonEmptyStr(cfg.get('model'));
      if (defModel) {
        defaultSlots.set('agent-default-model.config.model', {
          rawValue: defModel,
          providerHint: defProv,
        });
      }
    }

    if (id === 'llm-pi-ai' || name === '@deepseek-ai/dsh-llm-pi-ai') {
      for (const slotKey of ['selectedDefault', 'default', 'model'] as const) {
        const val = nonEmptyStr(cfg.get(slotKey));
        if (val) {
          defaultSlots.set(`config.${slotKey}`, {
            rawValue: val,
            providerHint: nonEmptyStr(cfg.get('provider')),
          });
        }
      }

      const providersMap = cfg.get('providers', true);
      if (isMap(providersMap)) {
        for (const pair of providersMap.items) {
          if (!isScalar(pair.key) || !isMap(pair.value)) continue;
          const provId = String(pair.key.value ?? '').trim();
          if (!provId) continue;
          const pMap = pair.value;
          const hasKey =
            Boolean(nonEmptyStr(pMap.get('apiKeyEnv'))) ||
            Boolean(nonEmptyStr(pMap.get('apiKey'))) ||
            isLocalRouterPortUrl(nonEmptyStr(pMap.get('baseURL')));

          const modelsRaw = pMap.get('models', true);
          const seqNode = isSeq(modelsRaw) ? modelsRaw : undefined;
          allProviderModels.set(provId, extractYamlSeqModelIds(seqNode));
          providerSeqNodes.set(provId, { mapNode: pMap, seqNode });

          const rawJs = (pMap.toJS(doc) ?? {}) as Record<string, unknown>;
          providerMeta.set(provId, {
            endpointFingerprint: sha256(
              JSON.stringify({
                baseURL: rawJs['baseURL'] ?? null,
                base_url: rawJs['base_url'] ?? null,
                url: rawJs['url'] ?? null,
              })
            ),
            authFingerprint: sha256(
              JSON.stringify({
                apiKey: rawJs['apiKey'] ?? null,
                apiKeyEnv: rawJs['apiKeyEnv'] ?? null,
                hasKey,
              })
            ),
            nonModelsFingerprint: sha256(JSON.stringify(omitKeys(rawJs, ['models']))),
          });

          if (hasKey) {
            keyedProviders.add(provId);
          }
        }
      }
    }
  }

  return {
    allProviderModels,
    keyedProviders,
    defaultSlots,
    providerMeta,
    buildUpdatedText(providerChanges) {
      const edits: SpanEdit[] = [];
      const nl = detectNewline(text);

      for (const [provId, change] of providerChanges.entries()) {
        if (change.removeSet.size === 0 && change.addIds.length === 0) continue;
        const target = providerSeqNodes.get(provId);
        if (!target) continue;

        if (target.seqNode) {
          const edit = buildYamlModelsSeqEdit(text, target.seqNode, change.removeSet, change.addIds);
          if (edit) edits.push(edit);
        } else if (change.addIds.length > 0 && target.mapNode.range) {
          const firstPair = target.mapNode.items[0];
          const keyRange = (firstPair?.key as { range?: [number, number, number] } | undefined)?.range;
          const propIndent = keyRange ? getLineIndentBefore(text, keyRange[0]) : '        ';
          const insertPos = target.mapNode.range[1];
          const prefix = insertPos > 0 && text.charCodeAt(insertPos - 1) !== 10 ? nl : '';
          const lines = change.addIds
            .map((id) => `${propIndent}  - id: ${formatYamlScalar(id)}`)
            .join(nl);
          edits.push({
            start: insertPos,
            end: insertPos,
            replacement: `${prefix}${propIndent}models:${nl}${lines}${nl}`,
          });
        }
      }

      const next = applySpanReplacements(text, edits);
      const checkDoc = parseDocument(next, { logLevel: 'silent' });
      if (checkDoc.errors.length > 0 || !isSeq(checkDoc.contents)) {
        throw new Error(`DSH Cordis YAML validation failed after edit: ${checkDoc.errors[0]?.message ?? 'invalid root'}`);
      }
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Unified Write-Adapter Builder & Registry
// ---------------------------------------------------------------------------

type StateParserFn = (text: string, configPath: string, homeDir?: string) => ParsedHarnessState;

function createTierAWriteAdapter(cap: HarnessCapability, parseState: StateParserFn): HarnessWriteAdapter {
  return {
    app: cap.id,
    directionAMode: 'write-adapter',

    async plan(options: HarnessPlanOptions): Promise<HarnessModelPlan> {
      const configPath = options.configPath ?? resolveDefaultModelsConfigPath(cap, options.homeDir);
      if (cap.id === 'openmausbot') {
        assertOpenMausBotSafeFile(configPath);
      }
      const runningProcesses = detectRunningHarnessProcesses(cap.id, options.processRunner);
      const reloadRequired = cap.reloadRequired.models;

      if (!configPath || !fs.existsSync(configPath)) {
        const emptyPayload = {
          app: cap.id,
          directionAMode: 'write-adapter' as const,
          editable: false,
          targetProviders: [] as string[],
          additions: [] as HarnessModelAddition[],
          removals: [] as HarnessModelRemoval[],
          defaultSlotWarnings: [] as HarnessDefaultSlotWarning[],
        };
        return {
          ...emptyPayload,
          configPath,
          guidance: [`Không tìm thấy tệp cấu hình của ${cap.displayName}.`],
          planHash: computePlanHash(emptyPayload),
          reloadRequired,
          runningProcesses,
        };
      }

      const rawText = fs.readFileSync(configPath, 'utf8');
      const state = parseState(rawText, configPath, options.homeDir);

      const targetProviders: string[] = [];
      const additions: HarnessModelAddition[] = [];
      const removals: HarnessModelRemoval[] = [];

      for (const [provId, currentModels] of state.allProviderModels.entries()) {
        if (!state.keyedProviders.has(provId)) {
          continue;
        }
        const cat = options.catalog[provId];
        if (!cat) {
          continue;
        }
        targetProviders.push(provId);

        const deprecatedSet = new Set(cat.deprecatedModels);
        for (const m of currentModels) {
          if (deprecatedSet.has(m)) {
            removals.push({
              provider: provId,
              model: m,
              reason: 'deprecated-upstream',
            });
          }
        }

        const survivingSet = new Set(currentModels.filter((m) => !deprecatedSet.has(m)));
        const seenAdd = new Set<string>();
        for (const live of cat.liveModels) {
          if (!survivingSet.has(live) && !deprecatedSet.has(live) && !seenAdd.has(live)) {
            seenAdd.add(live);
            additions.push({ provider: provId, model: live });
          }
        }
      }

      const defaultSlotWarnings = checkDefaultSlotWarnings(state.defaultSlots, options.catalog);
      const guidance: string[] = [];
      if (runningProcesses.length > 0) {
        guidance.push(
          `Phát hiện tiến trình đang chạy (${runningProcesses.join(', ')}): ${cap.reloadRequired.mechanism}`
        );
      } else if (reloadRequired) {
        guidance.push(cap.reloadRequired.mechanism);
      }

      const hashInput = {
        app: cap.id,
        directionAMode: 'write-adapter' as const,
        editable: true,
        targetProviders,
        additions,
        removals,
        defaultSlotWarnings,
      };

      return {
        ...hashInput,
        configPath,
        guidance,
        planHash: computePlanHash(hashInput),
        reloadRequired,
        runningProcesses,
      };
    },

    async apply(options: HarnessApplyOptions): Promise<HarnessApplyResult> {
      const configPath = options.configPath ?? resolveDefaultModelsConfigPath(cap, options.homeDir);
      if (!configPath) {
        throw new Error(`[${cap.id}] Missing configPath for apply.`);
      }
      if (cap.id === 'openmausbot') {
        assertOpenMausBotSafeFile(configPath);
      }
      assertHarnessWriteSandboxAllowed(configPath);
      const backupPath = options.backupPath ?? `${configPath}.routersync.bak`;
      assertHarnessWriteSandboxAllowed(backupPath);

      if (!fs.existsSync(configPath)) {
        throw new Error(`[${cap.id}] Config file does not exist: ${configPath}`);
      }

      const preBytes = fs.readFileSync(configPath);
      const preSha256 = sha256(preBytes);
      const rawText = preBytes.toString('utf8');
      const preState = parseState(rawText, configPath, options.homeDir);

      const plan = await this.plan({ ...options, configPath });
      if (options.expectedPlanHash && options.expectedPlanHash !== plan.planHash) {
        throw new Error(
          `[${cap.id}] Plan hash mismatch: expected ${options.expectedPlanHash}, computed ${plan.planHash}`
        );
      }

      const providerChanges = new Map<string, { removeSet: Set<string>; addIds: string[] }>();
      const expectedModelsByProvider = new Map<string, string[]>();

      for (const [provId, currentModels] of preState.allProviderModels.entries()) {
        const provRemovals = new Set(
          plan.removals.filter((r) => r.provider === provId).map((r) => r.model)
        );
        const provAdditions = plan.additions
          .filter((a) => a.provider === provId)
          .map((a) => a.model);

        if (provRemovals.size > 0 || provAdditions.length > 0) {
          providerChanges.set(provId, { removeSet: provRemovals, addIds: provAdditions });
          const surviving = currentModels.filter((m) => !provRemovals.has(m));
          expectedModelsByProvider.set(provId, [...surviving, ...provAdditions]);
        } else {
          expectedModelsByProvider.set(provId, [...currentModels]);
        }
      }

      const nextText =
        providerChanges.size > 0 ? preState.buildUpdatedText(providerChanges) : rawText;

      if (providerChanges.size > 0 || !fs.existsSync(backupPath) || Boolean(options.injectReadBackFault)) {
        atomicWriteBytes(backupPath, preBytes);
      }
      if (providerChanges.size > 0) {
        atomicWriteBytes(configPath, nextText);
      }

      try {
        if (typeof options.injectReadBackFault === 'function') {
          options.injectReadBackFault(nextText);
        } else if (options.injectReadBackFault === true) {
          throw new Error('Injected post-write read-back fault');
        }

        const postDiskText = fs.readFileSync(configPath, 'utf8');
        const postState = parseState(postDiskText, configPath, options.homeDir);

        // 1. Verify exact model sets across EVERY provider (both target and untouched keyless)
        if (postState.allProviderModels.size !== expectedModelsByProvider.size) {
          throw new Error('Provider count changed unexpectedly during read-back');
        }
        for (const [provId, expectedModels] of expectedModelsByProvider.entries()) {
          const actualModels = postState.allProviderModels.get(provId);
          if (
            !actualModels ||
            actualModels.length !== expectedModels.length ||
            actualModels.some((m, i) => m !== expectedModels[i])
          ) {
            throw new Error(
              `Read-back model mismatch on provider "${provId}": expected [${expectedModels.join(', ')}], got [${(actualModels ?? []).join(', ')}]`
            );
          }
        }

        // 2. Verify zero mutation on default model slots (including automaticRecovery.backup)
        if (postState.defaultSlots.size !== preState.defaultSlots.size) {
          throw new Error('Read-back detected default-slot count mutation');
        }
        for (const [slot, preSlot] of preState.defaultSlots.entries()) {
          const postSlot = postState.defaultSlots.get(slot);
          if (!postSlot || postSlot.rawValue !== preSlot.rawValue) {
            throw new Error(`Read-back detected forbidden default-slot mutation on "${slot}"`);
          }
        }

        // 3. Verify zero mutation on provider endpoints (baseURL/base_url/url), keys, and non-model metadata
        if (postState.providerMeta.size !== preState.providerMeta.size) {
          throw new Error('Read-back detected provider metadata count mismatch');
        }
        for (const [provId, preMeta] of preState.providerMeta.entries()) {
          const postMeta = postState.providerMeta.get(provId);
          if (!postMeta) {
            throw new Error(`Read-back missing provider metadata for "${provId}"`);
          }
          if (postMeta.endpointFingerprint !== preMeta.endpointFingerprint) {
            throw new Error(
              `Read-back detected forbidden baseURL/endpoint mutation on provider "${provId}"`
            );
          }
          if (postMeta.authFingerprint !== preMeta.authFingerprint) {
            throw new Error(
              `Read-back detected forbidden API key/credential mutation on provider "${provId}"`
            );
          }
          if (postMeta.nonModelsFingerprint !== preMeta.nonModelsFingerprint) {
            throw new Error(
              `Read-back detected forbidden non-model field mutation on provider "${provId}"`
            );
          }
        }
      } catch (verifyErr) {
        // Automatic rollback to exact pre-apply bytes
        const backupBytes = fs.readFileSync(backupPath);
        atomicWriteBytes(configPath, backupBytes);
        const detail = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        throw new Error(
          `[${cap.id}] Post-write read-back verification failed (${detail}); automatic rollback restored pre-apply file.`
        );
      }

      const postSha256 = sha256(fs.readFileSync(configPath));
      return {
        app: cap.id,
        configPath,
        backupPath,
        applied: true,
        rolledBack: false,
        readBackVerified: true,
        reloadRequired: plan.reloadRequired,
        runningProcesses: plan.runningProcesses,
        planHash: plan.planHash,
        preSha256,
        postSha256,
        message:
          providerChanges.size === 0
            ? `Không có thay đổi model cho ${cap.displayName} (tệp giữ nguyên từng byte).`
            : `Đã cập nhật danh sách model của ${cap.displayName} an toàn (đã sao lưu & kiểm chứng đọc lại).`,
      };
    },

    async rollback(options: HarnessRollbackOptions): Promise<HarnessRollbackResult> {
      if (cap.id === 'openmausbot') {
        assertOpenMausBotSafeFile(options.configPath);
      }
      assertHarnessWriteSandboxAllowed(options.configPath);

      const backupPath = options.backupPath ?? `${options.configPath}.routersync.bak`;
      assertHarnessWriteSandboxAllowed(backupPath);
      if (!fs.existsSync(backupPath)) {
        throw new Error(`[${cap.id}] Backup file not found for rollback: ${backupPath}`);
      }

      const backupBytes = fs.readFileSync(backupPath);
      const backupSha = sha256(backupBytes);
      atomicWriteBytes(options.configPath, backupBytes);

      const postSha256 = sha256(fs.readFileSync(options.configPath));
      const expectedSha = options.expectedPreSha256 ?? backupSha;

      return {
        app: cap.id,
        configPath: options.configPath,
        backupPath,
        restored: true,
        byteIdenticalToPreApply: postSha256 === expectedSha,
        postSha256,
      };
    },
  };
}

function createReportOnlyAdapter(cap: HarnessCapability): HarnessWriteAdapter {
  return {
    app: cap.id,
    directionAMode: 'report-only',

    async plan(options: HarnessPlanOptions): Promise<HarnessModelPlan> {
      const configPath = options.configPath ?? resolveDefaultModelsConfigPath(cap, options.homeDir);
      const runningProcesses = detectRunningHarnessProcesses(cap.id, options.processRunner);
      const guidance = [
        `[${cap.displayName}] Chế độ chỉ báo cáo (report-only): RouterSync không ghi trực tiếp danh sách model trên ổ đĩa cho harness này.`,
        cap.modelsConfig.editSafetyNotes,
      ];

      const hashInput = {
        app: cap.id,
        directionAMode: 'report-only' as const,
        editable: false,
        targetProviders: [] as string[],
        additions: [] as HarnessModelAddition[],
        removals: [] as HarnessModelRemoval[],
        defaultSlotWarnings: [] as HarnessDefaultSlotWarning[],
      };

      return {
        ...hashInput,
        configPath,
        guidance,
        planHash: computePlanHash(hashInput),
        reloadRequired: cap.reloadRequired.models,
        runningProcesses,
      };
    },

    async apply(_options: HarnessApplyOptions): Promise<HarnessApplyResult> {
      throw new Error(
        `[${cap.id}] Chế độ chỉ báo cáo (report-only): từ chối ghi cấu hình model của ${cap.displayName}. ${cap.modelsConfig.editSafetyNotes}`
      );
    },

    async rollback(_options: HarnessRollbackOptions): Promise<HarnessRollbackResult> {
      throw new Error(
        `[${cap.id}] Chế độ chỉ báo cáo (report-only): không có bản ghi model để khôi phục cho ${cap.displayName}.`
      );
    },
  };
}

const STATE_PARSERS: Partial<Record<string, StateParserFn>> = {
  hermes: parseHermesState,
  openmausbot: (text, configPath) => parseOpenMausBotState(text, configPath),
  opencode: parseOpenCodeState,
  dsh: (text, configPath) => parseDshState(text, configPath),
};

export const HARNESS_WRITE_ADAPTERS: HarnessWriteAdapter[] = listHarnessCapabilities().map((cap) => {
  const parser = STATE_PARSERS[cap.id];
  if (cap.directionAMode === 'write-adapter' && parser) {
    return createTierAWriteAdapter(cap, parser);
  }
  return createReportOnlyAdapter(cap);
});

export function listHarnessWriteAdapters(): HarnessWriteAdapter[] {
  return [...HARNESS_WRITE_ADAPTERS];
}

export function getHarnessWriteAdapter(app: string): HarnessWriteAdapter | undefined {
  const normalized = app.trim().toLowerCase();
  return HARNESS_WRITE_ADAPTERS.find((adapter) => adapter.app === normalized);
}

export interface DiscoveredTierAHarnessState {
  harnessId: string;
  configPath: string;
  defaultModels: string[];
  providers: Array<{
    providerId: string;
    models: string[];
    keyPresent: boolean;
    proxyDelegated: boolean;
  }>;
}

export function inspectTierAHarnessForTick(
  harnessId: string,
  homeDir: string
): DiscoveredTierAHarnessState | null {
  const cap = getHarnessCapability(harnessId);
  const parser = STATE_PARSERS[harnessId];
  if (!cap || cap.directionAMode !== 'write-adapter' || !parser) {
    return null;
  }
  const configPath = resolveDefaultModelsConfigPath(cap, homeDir);
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }
  if (cap.id === 'openmausbot') {
    assertOpenMausBotSafeFile(configPath);
  }
  const rawText = fs.readFileSync(configPath, 'utf8');
  const state = parser(rawText, configPath, homeDir);
  const defaultModels = [...state.defaultSlots.values()]
    .map((s) => s.rawValue)
    .filter((v) => v.length > 0);

  const providers: DiscoveredTierAHarnessState['providers'] = [];
  for (const [provId, models] of state.allProviderModels.entries()) {
    const keyPresent = state.keyedProviders.has(provId);
    if (models.length === 0 && !keyPresent) continue;
    const lowerId = provId.toLowerCase();
    const proxyDelegated =
      lowerId.includes('9router') ||
      lowerId.includes('9-router') ||
      lowerId.includes('omniroute');
    providers.push({
      providerId: provId,
      models: [...models],
      keyPresent,
      proxyDelegated,
    });
  }

  return {
    harnessId: cap.id,
    configPath,
    defaultModels,
    providers,
  };
}
