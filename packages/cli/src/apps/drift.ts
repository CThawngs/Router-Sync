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
 * Phân loại theo RouterModelState từ core (tầng A/B/C/UNKNOWN):
 *   OK         : tier A — model đang active trong router
 *   DISABLED   : tier B do bị tắt
 *   MISSING    : tier C — router không biết model này
 *   UNKNOWN    : tier UNKNOWN — không xác định được (ví dụ versionMismatch)
 *   NOT-ROUTED : provider trực tiếp, không qua router
 *
 * ID chuẩn hóa: bỏ tiền tố provider khi so với router catalog
 *   (ví dụ `9router/test-3` → `test-3`).
 *
 * Khóa so sánh từng router:
 *   9Router: Available Models (availableModels) + combo/alias
 *   OmniRoute: combos.data.models (trường m.model ?? m.id)
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
  type ModelTierClassification,
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
  }>;
  totals: Record<DriftStatus, number>;
  idFormatMismatchSuspected: boolean;
  mismatchExamples: Array<{ appId: string; routerId: string }>;
}

export function zeroTotals(): Record<DriftStatus, number> {
  return { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
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

/** Phân loại một model đơn lẻ đối với một router view. */
export function classifyModelDrift(
  modelId: string,
  provider: string,
  view: RouterDriftView
): { entry: Omit<DriftEntry, 'app'>; matchedRouter: boolean } {
  const strippedId = stripProviderPrefix(modelId);
  const kind = driftKindOf(strippedId, view.comboNames, view.aliasNames);
  const state = view.state;

  if (!state) {
    return {
      entry: {
        router: view.router,
        name: modelId,
        modelId: strippedId,
        provider,
        kind,
        status: 'UNKNOWN',
        reason: 'không đọc được router',
      },
      matchedRouter: false,
    };
  }

  const classification = state.classify(provider, strippedId);
  const status = tierToStatus(classification.tier, classification.reason);

  return {
    entry: {
      router: view.router,
      name: modelId,
      modelId: strippedId,
      provider,
      kind,
      status,
      reason: classification.reason ?? '',
    },
    matchedRouter: status !== 'NOT-ROUTED',
  };
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

  return { router, state, error, comboNames, aliasNames };
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
      // Parse đơn giản: các dòng tên provider (mỗi dòng 1 tên, bỏ qua comment và trống).
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

/** Danh sách provider công khai (từ 9Router provider aliases). */
export function getPublicProviderRegistry(): Set<string> {
  // Import động để tránh cyclic dependency; dùng danh sách tĩnh từ 9router-provider-models.
  // Các key này là tên provider đầy đủ (antigravity, kilocode, kiro, opencode, ...).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@routersync/core');
    // NINE_ROUTER_PROVIDER_ALIASES không được export trực tiếp từ core index,
    // nên dùng danh sách provider đã biết từ inspect fixtures + tên router chuẩn.
  } catch {
    // ignore
  }
  const known = new Set<string>([
    '9router',
    'omniroute',
    'hugging-face',
    'deepseek',
    'kilocode',
    'kiro',
    'opencode',
    'cursor',
    'claude',
    'gemini',
    'github',
    'perplexity',
    'anthropic',
    'openai',
    'cohere',
    'mistral',
    'meta',
    'google',
    'xai',
    'nvidia',
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

/** Quyết định xem tên provider có bị redact không. */
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

/** Kiểm tra id-format-mismatch: router có catalog > 0 nhưng 0 model của app khớp. */
export function checkIdFormatMismatch(
  results: DriftResult[],
  views: RouterDriftView[]
): { suspected: boolean; examples: Array<{ appId: string; routerId: string }> } {
  const examples: Array<{ appId: string; routerId: string }> = [];
  let suspected = false;

  for (const v of views) {
    if (!v.state || v.state.catalogModels.size === 0) continue;
    // Kiểm tra xem có app nào có model khớp với router này không.
    let anyMatch = false;
    for (const r of results) {
      if (r.router !== v.router) continue;
      for (const e of r.entries) {
        if (e.kind === 'NOT-ROUTED') continue;
        if (v.state.catalogModels.has(e.modelId) || v.comboNames.has(e.modelId)) {
          anyMatch = true;
          break;
        }
      }
      if (anyMatch) break;
    }
    if (!anyMatch) {
      suspected = true;
      // Lấy 3 ví dụ cặp (id của app, id của router) đã redact.
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

export function zeroTotalsFull(): Record<DriftStatus, number> {
  return { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
}

/** Gộp nhiều kết quả thành báo cáo, tính UNUSED và tổng hợp. */
export function buildDriftReport(
  results: DriftResult[],
  views: RouterDriftView[],
  redactor: ProviderRedactor,
  publicRegistry: Set<string>,
  localAllowlist: Set<string>
): DriftReport {
  const used = new Set<string>();
  for (const r of results) {
    for (const e of r.entries) {
      if (e.kind !== 'NOT-ROUTED') used.add(`${r.router}|${e.modelId}`);
    }
  }

  const unused: Array<{
    router: string;
    name: string;
    kind: 'combo' | 'alias' | 'model';
    provider: string;
  }> = [];
  for (const v of views) {
    if (!v.state) continue;
    for (const id of v.state.catalogModels) {
      if (used.has(`${v.router}|${id}`)) continue;
      const provider = extractProvider(id);
      unused.push({
        router: v.router,
        name: id,
        kind: driftKindOf(id, v.comboNames, v.aliasNames),
        provider: shouldRedactProvider(provider, publicRegistry, localAllowlist)
          ? redactor.redact(provider)
          : provider,
      });
    }
  }
  unused.sort((a, b) => a.router.localeCompare(b.router) || a.name.localeCompare(b.name));

  const totals = zeroTotalsFull();
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
    lines.push('CẢNH BÁO: id-format-mismatch-suspected — router có catalog nhưng 0 model của app khớp.');
    lines.push('Có thể do định dạng model id khác nhau (có/không tiền tố provider).');
    for (const ex of report.mismatchExamples) {
      lines.push(`  ví dụ: appId=${ex.appId} routerId=${ex.routerId}`);
    }
  }
  if (report.unused.length > 0) {
    lines.push('');
    lines.push('UNUSED (20 đầu):');
    for (const u of report.unused.slice(0, 20)) {
      lines.push(`  ${u.router}  ${u.kind}  ${u.provider}/${u.name}`);
    }
  }
  return lines.join('\n');
}
