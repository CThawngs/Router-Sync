/**
 * packages/cli/src/apps/drift.ts
 *
 * `routersync apps drift` — đối chiếu model trong app agent với trạng thái router
 * (chỉ đọc, không ghi).
 *
 * Mỗi model của app được đối chiếu với ĐÚNG MỘT router, quyết định theo provider
 * (id provider hoặc host:cổng của baseURL đã ánh xạ). Provider không ánh xạ được
 * tới router nào ⇒ NOT-ROUTED.
 *
 * Phân loại theo trạng thái router (đọc chỉ đọc qua readRouterModelState + readCombos):
 *   9Router:
 *     OK       : model có trong availableModels (tầng A — active) hoặc comboModels (combo)
 *     DISABLED : model có trong disabledModels (bị tắt)
 *     MISSING  : model không có trong bất kỳ tập nào
 *     UNKNOWN  : versionMismatch hoặc không đọc được router
 *   OmniRoute:
 *     OK       : model có trong availableModels (synced, custom, alias, hoặc combo active) hoặc comboModels
 *     DISABLED : model có trong disabledModels (bị tắt qua radar_local_model_state hoặc customModels ẩn)
 *     MISSING  : model không có trong disabledModels, availableModels hay comboModels
 *     UNKNOWN  : không đọc được router
 *   NOT-ROUTED : provider trực tiếp, không qua router
 *
 * ID chuẩn hóa: bỏ tiền tố provider khi so với router catalog
 *   (ví dụ `9router/test-3` → `test-3`).
 *
 * availableModels và comboModels trong router state dùng định dạng alias/modelId
 * (ví dụ `ag/gemini-4-carbon-high`, `oc/claude-sonnet-5-5`), không phải
 * provider/modelId. Code trích xuất model ID gốc và so sánh với phần sau dấu `/`.
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentAppInspection,
  AgentAppProvider,
  AgentAppRouterRef,
} from '@routersync/adapter-sdk';
import {
  readRouterModelState,
  type RouterModelState,
  getProviderAliases,
} from '@routersync/core';
import { AGENT_APP_ADAPTERS, getAgentAppAdapter, type AgentAppId } from './inspect.js';
import { detectRouter } from './inspect.js';

export type DriftStatus = 'OK' | 'DISABLED' | 'MISSING' | 'UNKNOWN' | 'NOT-ROUTED';

export const DRIFT_STATUSES: DriftStatus[] = ['OK', 'DISABLED', 'MISSING', 'UNKNOWN', 'NOT-ROUTED'];

export interface DriftEntry {
  app: string;
  router: string;
  /** Tên hiển thị (đã redact nếu cần): provider/id hoặc chỉ id tùy router. */
  name: string;
  /** Id thuần của model (đã bỏ tiền tố provider, dùng để tính UNUSED). */
  modelId: string;
  /** Tên provider đã redact. */
  provider: string;
  kind: 'combo' | 'alias' | 'model' | 'NOT-ROUTED';
  status: DriftStatus;
  reason: string;
  /** inCombo: model có nằm trong một combo không. Dùng cho UNUSED. */
  inCombo: boolean;
}

export interface RouterDriftView {
  router: string;
  /** Trạng thái model từ readRouterModelState. */
  state: RouterModelState | undefined;
  /** Lỗi khi đọc router (nếu có). */
  error: string | undefined;
  /** Tên combo (readCombos[].id / [].name). */
  comboNames: Set<string>;
  /** Tên alias. */
  aliasNames: Set<string>;
  /** Tất cả model ID có sẵn (bare name và alias/modelId). */
  availableIds: Set<string>;
  /** Tất cả model ID bị tắt (bare name và alias/modelId). */
  disabledIds: Set<string>;
  /** Tất cả model ID trong combo (bare name và alias/modelId). */
  comboIds: Set<string>;
}

export interface DriftResult {
  app: string;
  router: string;
  entries: DriftEntry[];
  totals: Record<DriftStatus, number>;
}

export interface DriftReport {
  results: DriftResult[];
  unused: Array<{
    router: string;
    name: string;
    kind: 'combo' | 'alias' | 'model';
    provider: string;
    inCombo: boolean;
  }>;
  totals: Record<DriftStatus, number>;
  idFormatMismatchSuspected: boolean;
  mismatchExamples: Array<{ appId: string; routerId: string }>;
}

export function zeroTotals(): Record<DriftStatus, number> {
  return { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
}

/** Tính tổng các trạng thái từ danh sách entries (chỉ dùng để kiểm tra mutation). */
export function computeTotalsFromEntries(entries: DriftEntry[]): Record<DriftStatus, number> {
  const totals: Record<DriftStatus, number> = zeroTotals();
  for (const e of entries) {
    totals[e.status] = (totals[e.status] || 0) + 1;
  }
  return totals;
}

/** Ánh xạ provider của app sang router. Mỗi provider chỉ thuộc TỐI ĐA 1 router. */
export function providerToRouter(
  providerId: string,
  baseUrl?: string | undefined
): AgentAppRouterRef {
  // 1. Phát hiện trực tiếp từ tên provider hoặc baseURL.
  const direct = detectRouter(providerId);
  if (direct !== 'UNKNOWN') return direct;
  if (baseUrl) {
    const urlDirect = detectRouter(baseUrl);
    if (urlDirect !== 'UNKNOWN') return urlDirect;
  }
  // 2. DSH dùng provider id 'nine-router' / 'nine-router-vision' rõ ràng là 9Router.
  const lower = providerId.toLowerCase();
  if (lower.includes('nine-router')) return '9router';
  if (lower.includes('omniroute')) return 'omniroute';
  return 'UNKNOWN';
}

/** Loại bỏ tiền tố provider khỏi model id: '9router/test-3' → 'test-3'. */
export function stripProviderPrefix(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash === -1) return modelId;
  return modelId.slice(slash + 1);
}

/** Lấy phần provider từ 'provider/id'. */
export function extractProvider(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash === -1) return modelId;
  return modelId.slice(0, slash);
}

/** Kiểm tra model id có dạng 'provider/id' không. */
function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes('/') && modelId.indexOf('/') > 0;
}

/** Drift kind từ model id (đã strip prefix) so với combo/alias names. */
export function driftKindOf(
  modelId: string,
  comboNames: Set<string>,
  aliasNames: Set<string>
): 'combo' | 'alias' | 'model' {
  if (comboNames.has(modelId)) return 'combo';
  if (aliasNames.has(modelId)) return 'alias';
  return 'model';
}

/** Tier classification → DriftStatus. */
export function tierToStatus(tier: 'A' | 'B' | 'C' | 'UNKNOWN', reason?: string): DriftStatus {
  if (tier === 'A') return 'OK';
  if (tier === 'B') return 'DISABLED';
  if (tier === 'C') return 'MISSING';
  return 'UNKNOWN';
}

/**
 * Trích xuất tất cả model ID từ một Set các id có dạng 'alias/modelId' hoặc bare name.
 * Trả về Set chứa cả dạng đầy đủ và dạng bare name (phần sau '/').
 */
export function extractAllIds(ids: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    const slash = id.indexOf('/');
    if (slash !== -1) {
      out.add(id.slice(slash + 1));
    }
  }
  return out;
}

/** Xây dựng view chỉ đọc của một router từ readRouterModelState + combos. */
export async function buildRouterView(
  router: string,
  combos: Array<{ id: string; name?: string; models?: string[] }>
): Promise<RouterDriftView> {
  let state: RouterModelState | undefined;
  let error: string | undefined;
  try {
    state = await readRouterModelState(router);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }

  const comboNames = new Set<string>();
  for (const c of combos) {
    if (c.id) comboNames.add(c.id);
    if (c.name) comboNames.add(c.name);
  }
  const aliasNames = new Set<string>();

  let availableIds: Set<string> = new Set();
  let disabledIds: Set<string> = new Set();
  let comboIds: Set<string> = new Set();

  if (state) {
    availableIds = extractAllIds(state.availableModels);
    disabledIds = extractAllIds(state.disabledModels);
    comboIds = extractAllIds(state.comboModels);
  }

  return { router, state, error, comboNames, aliasNames, availableIds, disabledIds, comboIds };
}

/** Tải danh sách provider public từ registry cục bộ (nếu có). */
export function loadLocalProviderAllowlist(): Set<string> {
  const allowlist = new Set<string>();
  const candidates = [
    path.join(process.env.APPDATA || '', 'routersync', 'providers.local.yaml'),
    path.join(os.homedir(), '.config', 'routersync', 'providers.local.yaml'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        allowlist.add(trimmed);
      }
    } catch {
      // Bỏ qua file lỗi.
    }
  }
  return allowlist;
}

/**
 * Phân loại một model đơn lẻ đối với một router view.
 * Sử dụng availableIds/disabledIds/comboIds (đã trích xuất bare name) thay vì
 * state.classify() để tránh vấn đề định dạng id giữa alias/modelId và provider/id.
 */
export function classifyModelDrift(
  modelId: string,
  provider: string,
  view: RouterDriftView
): { entry: Omit<DriftEntry, 'app'>; matchedRouter: boolean } {
  const strippedId = stripProviderPrefix(modelId);
  const kind = driftKindOf(strippedId, view.comboNames, view.aliasNames);
  const router = view.router;

  if (!view.state || !view.availableIds || !view.disabledIds || !view.comboIds) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'UNKNOWN',
        reason: 'không đọc được router',
        inCombo: false,
      },
      matchedRouter: false,
    };
  }

  const is9Router = router === '9router';
  const isOmniRoute = router === 'omniroute';

  // Tính inCombo: model có nằm trong một combo không?
  let inCombo = view.comboIds.has(strippedId);

  // 9Router: versionMismatch ⇒ UNKNOWN
  if (is9Router && view.state.versionMismatch) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'UNKNOWN',
        reason: 'snapshot-version-mismatch',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // 9Router: kiểm tra disabled
  if (is9Router && view.disabledIds.has(strippedId)) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'DISABLED',
        reason: inCombo
          ? 'Inconsistent: disabled in router kv but configured in active combo'
          : 'Disabled in router kv',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // 9Router: kiểm tra availableModels (tầng A — model đang bật)
  if (is9Router && view.availableIds.has(strippedId)) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'OK',
        reason: inCombo
          ? 'Available in router UI and configured in active combo'
          : 'Available in router UI (provider registry, custom model, or alias)',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // OmniRoute: kiểm tra disabled trước availableIds / comboIds
  if (isOmniRoute && view.disabledIds.has(strippedId)) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'DISABLED',
        reason: inCombo
          ? 'Inconsistent: disabled in router state but configured in active combo'
          : 'Disabled in router state',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // OmniRoute: OK nếu có trong availableIds hoặc comboIds
  if (isOmniRoute && (view.availableIds.has(strippedId) || view.comboIds.has(strippedId))) {
    const inAvailable = view.availableIds.has(strippedId);
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'OK',
        reason:
          inAvailable && inCombo
            ? 'Available in OmniRoute state and configured in active combo'
            : inCombo
              ? 'Active in OmniRoute combo'
              : 'Available in OmniRoute state (synced, custom, or alias)',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // 9Router: kiểm tra customModels (dùng state.customModels trực tiếp vì đã extractAllIds)
  // customModels cũng đã được extract vào availableIds? Không — availableIds chỉ từ availableModels.
  // Kiểm tra riêng customModels từ state.
  if (is9Router && view.state.customModels.has(strippedId)) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'OK',
        reason: 'Available in router UI (custom model or alias)',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // OmniRoute: không có trong disabledIds, availableIds hay comboIds ⇒ MISSING
  // UNKNOWN chỉ dùng khi không đọc được router (xử lý ở trên)
  if (isOmniRoute) {
    return {
      entry: {
        router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'MISSING',
        reason: 'Unconfigured in router',
        inCombo,
      },
      matchedRouter: true,
    };
  }

  // Không tìm thấy trong bất kỳ tập nào ⇒ MISSING
  return {
    entry: {
      router,
      name: modelId,
      modelId: strippedId,
      provider,
      kind,
      status: 'MISSING',
      reason: 'Unconfigured in router',
      inCombo,
    },
    matchedRouter: true,
  };
}

/**
 * Xây dựng tập tên provider công khai (không bị redact).
 * Bao gồm: tên router, tên provider từ NINE_ROUTER_PROVIDER_ALIASES keys,
 * và các provider công khai phổ biến (302ai, huggingface, nvidia, ...).
 */
export function getPublicProviderRegistry(): Set<string> {
  const known = new Set<string>([
    // Tên router
    '9router',
    'omniroute',
    'nine-router',
    // Provider có alias trong 9Router registry (các key của NINE_ROUTER_PROVIDER_ALIASES)
    'antigravity',
    'api-airforce',
    'aws-polly',
    'baidu',
    'bedrock',
    'bedrock-xai',
    'blackbox',
    'bluesminds',
    'byteplus',
    'claude',
    'cline',
    'cloudflare-ai',
    'codebuddy-cn',
    'codebuddy-intl',
    'codex',
    'commandcode',
    'cursor',
    'deepseek',
    'featherless',
    'fish-audio',
    'gemini-cli',
    'github',
    'grok-cli',
    'grok-web',
    'hyperbolic',
    'iflow',
    'jina-ai',
    'kilo-gateway',
    'kilocode',
    'kiro',
    'mimo-free',
    'minimax-code',
    'minimax-code-global',
    'opencode',
    'opencode-go',
    'opencode-zen',
    'perplexity',
    'perplexity-agent',
    'perplexity-web',
    'poolside',
    'qoder',
    'qoder-cn',
    'runcrate',
    'sambanova',
    'synthetic',
    'tencent',
    'vertex',
    'vertex-partner',
    'volcengine-ark',
    'xiaomi-mimo',
    'xiaomi-tokenplan',
    // Provider công khai phổ biến khác
    '302ai',
    'hugging-face',
    'huggingface',
    'nvidia',
    'openai',
    'anthropic',
    'cohere',
    'mistral',
    'meta',
    'google',
    'xai',
    'minimax',
    'poolside',
    'sambanova',
    'groq',
    'fireworks',
    'together',
    'vertex',
    'bedrock',
    'sagemaker',
  ]);
  return known;
}

/**
 * Quyết định xem tên provider có bị redact không.
 * Chỉ che id có trong providers.local.yaml hoặc không tìm thấy trong registry công
 * khai lẫn danh sách router. Provider công khai giữ nguyên tên.
 */
export function shouldRedactProvider(
  provider: string,
  publicRegistry: Set<string>,
  localAllowlist: Set<string>
): boolean {
  if (publicRegistry.has(provider)) return false;
  if (localAllowlist.has(provider)) return false;
  return true;
}

/** Redact tên provider thành <private-provider-N>. */
export class ProviderRedactor {
  private map = new Map<string, string>();
  private counter = 0;

  redact(provider: string): string {
    if (this.map.has(provider)) return this.map.get(provider)!;
    this.counter++;
    const redacted = `<private-provider-${this.counter}>`;
    this.map.set(provider, redacted);
    return redacted;
  }
}

/**
 * Kiểm tra id-format-mismatch: router có availableModels > 0 nhưng 0 tham chiếu của
 * app khớp. Xuất hiện trong bảng và --json.
 */
export function checkIdFormatMismatch(
  results: DriftResult[],
  views: RouterDriftView[]
): { suspected: boolean; examples: Array<{ appId: string; routerId: string }> } {
  const examples: Array<{ appId: string; routerId: string }> = [];
  let suspected = false;

  for (const v of views) {
    if (!v.state || v.state.availableModels.size === 0) continue;
    // Kiểm tra xem có app nào có model khớp với router này không.
    let anyMatch = false;
    for (const r of results) {
      if (r.router !== v.router) continue;
      for (const e of r.entries) {
        // Chỉ kiểm tra các model qua router (không phải NOT-ROUTED)
        if (e.kind === 'NOT-ROUTED') continue;
        if (v.availableIds.has(e.modelId) || v.comboIds.has(e.modelId)) {
          anyMatch = true;
          break;
        }
      }
      if (anyMatch) break;
    }
    if (!anyMatch) {
      suspected = true;
      // Lấy 3 ví dụ cặp (id của app, id của router).
      const appIds: string[] = [];
      const routerIds: string[] = [];
      for (const r of results) {
        if (r.router !== v.router) continue;
        for (const e of r.entries) {
          if (e.kind === 'NOT-ROUTED') continue;
          appIds.push(e.modelId);
          routerIds.push(e.modelId);
          if (appIds.length >= 3) break;
        }
        if (appIds.length >= 3) break;
      }
      for (let i = 0; i < Math.min(3, appIds.length); i++) {
        const appId = appIds[i];
        const routerId = routerIds[i];
        if (appId !== undefined && routerId !== undefined) {
          examples.push({ appId, routerId });
        }
      }
    }
  }

  return { suspected, examples };
}

/** Gộp nhiều kết quả thành báo cáo, tính UNUSED và tổng hợp. */
export function buildDriftReport(
  results: DriftResult[],
  views: RouterDriftView[],
  redactor: ProviderRedactor,
  publicRegistry: Set<string>,
  localAllowlist: Set<string>,
  connectedProviders: Set<string>
): DriftReport {
  const used = new Set<string>();
  for (const r of results) {
    for (const e of r.entries) {
      if (e.kind !== 'NOT-ROUTED') used.add(`${r.router}|${e.modelId}`);
    }
  }

  // Xây dựng tập alias của các provider đang kết nối (được app tham chiếu)
  const connectedAliases = new Set<string>();
  for (const prov of connectedProviders) {
    for (const alias of getProviderAliases(prov)) {
      connectedAliases.add(alias);
    }
  }

  const unused: Array<{
    router: string;
    name: string;
    kind: 'combo' | 'alias' | 'model';
    provider: string;
    inCombo: boolean;
  }> = [];
  for (const v of views) {
    if (!v.state || !v.availableIds) continue;
    // UNUSED chỉ tính model/combo đang bật của provider đang kết nối,
    // không dùng catalogModels (registry dựng sẵn có nhiều provider chưa kết nối).
    // Iterate over state.availableModels (alias/modelId format) to preserve provider info.
    for (const fullId of v.state.availableModels) {
      const slash = fullId.indexOf('/');
      if (slash === -1) continue; // bare name, không xác định được provider
      const alias = fullId.slice(0, slash);
      const modelId = fullId.slice(slash + 1);
      // Chỉ include nếu alias thuộc về một provider đang kết nối
      if (!connectedAliases.has(alias)) continue;
      if (used.has(`${v.router}|${modelId}`)) continue;
      // Kiểm tra inCombo
      const inCombo = v.comboIds.has(modelId);
      // Lấy tên provider từ alias (đơn giản hóa: dùng alias làm provider name)
      const providerName = alias;
      unused.push({
        router: v.router,
        name: modelId,
        kind: driftKindOf(modelId, v.comboNames, v.aliasNames),
        provider: shouldRedactProvider(providerName, publicRegistry, localAllowlist)
          ? redactor.redact(providerName)
          : providerName,
        inCombo,
      });
    }
  }
  unused.sort((a, b) => a.router.localeCompare(b.router) || a.name.localeCompare(b.name));

  const totals = zeroTotals();
  for (const r of results) {
    for (const s of DRIFT_STATUSES) totals[s] += r.totals[s];
  }

  const mismatch = checkIdFormatMismatch(results, views);

  return { results, unused, totals, idFormatMismatchSuspected: mismatch.suspected, mismatchExamples: mismatch.examples };
}

export function getDriftAdapter(app: string): AgentAppId | undefined {
  return AGENT_APP_ADAPTERS.find((a) => a.app === app)?.app as AgentAppId | undefined;
}

export async function inspectAppDrift(
  app: AgentAppId,
  homeDir: string,
  config?: string
): Promise<AgentAppInspection> {
  const adapter = getAgentAppAdapter(app);
  if (!adapter) throw new Error(`không hỗ trợ app: ${app}`);
  return adapter.inspect({ ...(config ? { configPath: config } : {}), homeDir });
}

export function renderDriftTable(report: DriftReport): string {
  const pad = (value: string, width: number): string =>
    value.length >= width ? value : value + ' '.repeat(width - value.length);

  const rows: string[][] = [['app', 'router', 'provider', 'tên', 'kind', 'trạng thái', 'lý do']];
  for (const r of report.results) {
    for (const e of r.entries) {
      rows.push([r.app, r.router, e.provider, e.name, e.kind, e.status, e.reason]);
    }
  }

  const widths = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
  }
  const body = rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');

  const lines: string[] = [body, ''];
  const t = report.totals;
  lines.push(
    `TỔNG: OK=${t.OK} DISABLED=${t.DISABLED} MISSING=${t.MISSING} UNKNOWN=${t.UNKNOWN} NOT-ROUTED=${t['NOT-ROUTED']} UNUSED=${report.unused.length}`
  );
  if (report.idFormatMismatchSuspected) {
    lines.push('');
    lines.push('CẢNH BÁO: id-format-mismatch-suspected — router có danh mục (availableModels) > 0 nhưng 0 tham chiếu của app khớp.');
    lines.push('Có thể do định dạng model id khác nhau (có/không tiền tố provider).');
    for (const ex of report.mismatchExamples) {
      lines.push(`  ví dụ: appId=${ex.appId} routerId=${ex.routerId}`);
    }
  }
  if (report.unused.length > 0) {
    lines.push('');
    lines.push('UNUSED (20 đầu):');
    for (const u of report.unused.slice(0, 20)) {
      const comboTag = u.inCombo ? ' (inCombo)' : '';
      lines.push(`  ${u.router}  ${u.kind}  ${u.provider}/${u.name}${comboTag}`);
    }
  }
  return lines.join('\n');
}
