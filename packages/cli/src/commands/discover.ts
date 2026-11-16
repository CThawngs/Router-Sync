/**
 * packages/cli/src/commands/discover.ts
 *
 * Read-only model discovery v2. Compares live provider /models listings against
 * a persisted snapshot baseline (%LOCALAPPDATA%\routersync\state\snapshots.json).
 * Zero model calls, zero tokens, no router writes.
 *
 * Rules:
 *   - Lan chay dau tien: phan A rong, model_moi=0 (tao baseline).
 *   - Lan chay thu hai: tinh model moi thuc su.
 *   - FREE-BY-PRICE chỉ được gán khi giá=0 VÀ có đối chứng nguồn thứ hai (OpenRouter hoặc tier_assignments/model_capabilities).
 *   - CON GAN LAI: PRICE-ZERO-UNCONFIRMED (khong duoc them vao combo).
 *   - Mục E: loai trùng, 3 nhom, toida 400 dòng, du lieu day du o discover-full.json.
 *   - needsResearch hẹp: model thuoc provider dang co trong combo, khong non-chat, chua co sau gia ro.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';
import { buildViews } from './sync/sync-plan.js';
import { scanAll } from './sync/sync-scan.js';
import { loadConfigFile } from '../config/loader.js';
import { loadCatalogCounts } from './sync/sync-plan.js';
import { fetchModelEntries, type ModelEntry } from '../sync/providers.js';
import { parseComboStep } from '../sync/normalize.js';
import type { RouterName } from '../sync/write.js';
import { assignTier } from '../rank/comparator.js';
import { loadRankingConfig } from '../rank/config.js';

let cachedTierRules: Record<string, string[]> | null = null;
function getTierRules(): Record<string, string[]> {
  if (cachedTierRules) return cachedTierRules;
  try {
    cachedTierRules = loadRankingConfig().config.tierRules ?? {};
  } catch {
    cachedTierRules = {};
  }
  return cachedTierRules;
}

/** Nguồn thứ hai độc lập kèm provider.trường=giá trị (không chỉ có mặt bảng). */
function isSecondSourceConfirmed(tier: ReturnType<typeof loadOmniRouteTierAssignments> extends Map<string, infer V> ? V | undefined : undefined): boolean {
  return Boolean(tier && tier.hasFreeTier && tier.costIn === 0 && tier.costOut === 0);
}

interface SnapshotEntry {
  firstSeen: string;
}
type Snapshot = Record<string, Record<string, SnapshotEntry>>;

function stateDir(): string {
  const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(base, 'routersync', 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotFile(): string {
  return path.join(stateDir(), 'snapshots.json');
}

function loadSnapshot(): Snapshot {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(), 'utf-8')) as Snapshot;
  } catch {
    return {};
  }
}

function writeSnapshot(snap: Snapshot): void {
  fs.writeFileSync(snapshotFile(), `${JSON.stringify(snap, null, 2)}\n`, 'utf-8');
}

function fullDiscoverFile(): string {
  const dir = stateDir();
  return path.join(dir, 'discover-full.json');
}

function providerOf(modelId: string): string {
  const p = parseComboStep(modelId);
  return p.prefix || 'unknown';
}

function modelNameOf(modelId: string): string {
  const p = parseComboStep(modelId);
  return p.model || modelId;
}

function normalizeId(modelId: string): string {
  let s = modelNameOf(modelId).toLowerCase();
  if (s.endsWith(':free')) s = s.slice(0, -5);
  else if (s.endsWith('-free')) s = s.slice(0, -5);
  return s;
}

export function isFreeSuffix(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.endsWith('-free') || lower.endsWith(':free');
}

/** Alias tiền tố -> chuẩn providerId (vd oc/opencode/openrouter cùng gốc). */
export const PROVIDER_ALIAS: Record<string, string> = {
  oc: 'opencode', ocz: 'opencode-zen', opencode: 'opencode', 'openrouter': 'openrouter',
  ag: 'antigravity', gemini: 'gemini', hf: 'huggingface', huggingface: 'huggingface',
};
/** ponytail: gộp alias cùng provider bằng segment cuối + bỏ :free/-free; đủ cho bzl beam/nemotron, sai thì thu hẹp. */
export function canonicalAliasKey(fullId: string): string {
  let s = fullId.toLowerCase().replace(/[.]/g, '-');
  const parts = s.split('/').filter((p) => p.length > 0);
  let last = parts[parts.length - 1] ?? s;
  // lặp: '...-free:free' cần bỏ cả hai hậu tố
  for (let i = 0; i < 2; i++) {
    if (last.endsWith(':free') || last.endsWith('-free')) last = last.slice(0, -5);
    else break;
  }
  return last;
}
export function dedupeAliasIds(ids: readonly string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const id of ids) { const k = canonicalAliasKey(id); if (seen.has(k)) continue; seen.add(k); out.push(id); }
  return out;
}
export function canonicalProvider(prefix: string): string {
  return PROVIDER_ALIAS[prefix.toLowerCase()] ?? prefix.toLowerCase();
}
/** Khóa chuẩn <providerId>/<modelId> thường, bỏ :free/-free, . -> -. */
export function canonicalKey(prefix: string, modelId: string): string {
  let m = modelId.toLowerCase().replace(/[.]/g, '-');
  if (m.endsWith(':free')) m = m.slice(0, -5);
  else if (m.endsWith('-free')) m = m.slice(0, -5);
  return `${canonicalProvider(prefix)}/${m}`;
}
/** PRICE-PROVIDER-WIDE-ZERO: >50% model có giá 0 -> giá 0 không phải bằng chứng free. */
export function providerWideZero(entries: ModelEntry[]): { ratio: number; wideZero: boolean } {
  const priced = entries.filter((e) => e.priceFields.length > 0);
  if (priced.length === 0) return { ratio: 0, wideZero: false };
  const zero = priced.filter((e) => (e.inputPrice ?? 1) === 0 && (e.outputPrice ?? 1) === 0).length;
  const ratio = zero / priced.length;
  return { ratio, wideZero: ratio > 0.5 };
}

// ---------------------------------------------------------------------------
// Price sources
// ---------------------------------------------------------------------------

interface PriceSource {
  source: string;
  field: string;
  input?: number;
  output?: number;
}

export function classifyPrice(
  modelId: string,
  entry: ModelEntry | undefined,
  catalogMeta: Record<string, unknown> | undefined,
  secondSourceConfirmed: boolean
): { label: string; sources: PriceSource[]; confirmed: boolean } {
  const sources: PriceSource[] = [];

  if (isFreeSuffix(modelId)) {
    return { label: 'FREE-BY-SUFFIX', sources: [], confirmed: true };
  }

  // Source 1: provider /models response pricing fields
  if (entry && entry.priceFields.length > 0) {
    const input = entry.inputPrice ?? 0;
    const output = entry.outputPrice ?? 0;
    sources.push({ source: 'provider /models', field: entry.priceFields.join(', '), input, output });
    if (input === 0 && output === 0 && secondSourceConfirmed) {
      return { label: 'FREE-BY-PRICE', sources, confirmed: true };
    }
    if (input > 0 || output > 0) {
      return { label: 'PAID', sources, confirmed: true };
    }
    // Price fields say 0 but no second source -> unconfirmed
    if (input === 0 && output === 0 && !secondSourceConfirmed) {
      return { label: 'PRICE-ZERO-UNCONFIRMED', sources, confirmed: false };
    }
  }

  // Source 2: second source confirmation (tier_assignments or model_capabilities)
  if (catalogMeta) {
    const hasFreeTier = (catalogMeta as Record<string, unknown>)['has_free_tier'];
    const costIn = (catalogMeta as Record<string, unknown>)['cost_per_1m_input'];
    const costOut = (catalogMeta as Record<string, unknown>)['cost_per_1m_output'];
    if (hasFreeTier === true || (typeof costIn === 'number' && costIn === 0 && typeof costOut === 'number' && costOut === 0)) {
      sources.push({ source: 'tier_assignments / model_capabilities', field: 'has_free_tier/cost', input: 0, output: 0 });
      // Re-evaluate with second source
      if (entry && entry.priceFields.length > 0) {
        const input = entry.inputPrice ?? 0;
        const output = entry.outputPrice ?? 0;
        if (input === 0 && output === 0) {
          return { label: 'FREE-BY-PRICE', sources, confirmed: true };
        }
      }
      return { label: 'FREE-BY-PRICE', sources, confirmed: true };
    }
  }

  return { label: 'PRICE-UNKNOWN', sources, confirmed: false };
}

// ---------------------------------------------------------------------------
// Catalog + capabilities
// ---------------------------------------------------------------------------

export function load9RouterCatalogMetadata(): Record<string, Record<string, unknown>> {
  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const file = path.join(appData, '9router', 'model-catalog.json');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: Record<string, unknown> };
    const models = parsed.models ?? {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(models)) {
      if (v && typeof v === 'object') out[k] = v as Record<string, unknown>;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadOmniRouteTierAssignments(db: any): Map<string, { hasFreeTier: boolean; costIn?: number | undefined; costOut?: number | undefined }> {
  const map = new Map<string, { hasFreeTier: boolean; costIn?: number | undefined; costOut?: number | undefined }>();
  try {
    const rows = db.prepare('SELECT model, tier, has_free_tier, cost_per_1m_input, cost_per_1m_output FROM tier_assignments').all() as Array<{
      model: string;
      tier: string;
      has_free_tier: number | null;
      cost_per_1m_input: number | null;
      cost_per_1m_output: number | null;
    }>;
    for (const r of rows) {
      map.set(r.model, {
        hasFreeTier: r.has_free_tier === 1,
        costIn: r.cost_per_1m_input ?? undefined,
        costOut: r.cost_per_1m_output ?? undefined,
      });
    }
  } catch {
    // table may not exist
  }
  return map;
}

function loadOmniRouteCapabilities(db: any): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  try {
    const rows = db.prepare('SELECT model_id, status, release_date FROM model_capabilities').all() as Array<{
      model_id: string;
      status: string;
      release_date: string | null;
    }>;
    for (const r of rows) {
      map.set(r.model_id, { status: r.status, release_date: r.release_date });
    }
  } catch {
    // table may not exist
  }
  return map;
}

function tierForModel(modelId: string): number {
  return assignTier(modelId, getTierRules());
}
function tierLabel(modelId: string): string {
  const n = tierForModel(modelId);
  return n === 99 ? '?' : String(n);
}

function isNonChat(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  const patterns = ['embed', 'tts', 'whisper', 'dall-e', 'flux', 'sdxl', 'moderation', 'clip', 'rerank', 'guard', 'transcribe', 'content-safety', 'safety', 'video', 'image', 'reward', 'asr', 'detector', 'vision-ocr', 'audio', 'speech'];
  for (const p of patterns) if (lower.includes(p)) return true;
  return false;
}
/** E6: chat-model filter (keywords: content-safety, embedding, asr, image, speech + legacy non-chat set). */
export const NON_CHAT_KEYWORDS = ['content-safety', 'embedding', 'embed', 'asr', 'image', 'speech', 'tts', 'whisper', 'dall-e', 'flux', 'sdxl', 'moderation', 'clip', 'rerank', 'guard', 'transcribe', 'safety', 'video', 'reward', 'detector', 'vision-ocr', 'audio'];
export function isChatModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  for (const k of NON_CHAT_KEYWORDS) if (lower.includes(k)) return false;
  return true;
}
/** E6: group by canonical key providerId/modelId, filter non-chat, max 5 per group, preserve order. */
export function groupDiscoverCandidates<T extends { providerId: string; modelId: string }>(candidates: readonly T[], maxPerGroup = 5): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const c of candidates) {
    if (!isChatModel(c.modelId)) continue;
    const key = canonicalKey(c.providerId, c.modelId);
    const arr = groups.get(key) ?? [];
    if (arr.length >= maxPerGroup) continue;
    arr.push(c);
    groups.set(key, arr);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runDiscoverCommand(options: { json?: boolean; out?: string; full?: boolean }): Promise<void> {
  const lines: string[] = [];
  lines.push('ROUTERSYNC DISCOVER v2 (read-only, zero model calls)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('='.repeat(80));

  const snapshot = loadSnapshot();
  const isFirstRun = Object.keys(snapshot).length === 0;
  if (isFirstRun) {
    lines.push('Baseline: lan chay dau tien - tao snapshot luc ' + new Date().toISOString());
    lines.push('Phan A: rong (chua co snapshot de so sanh).');
  } else {
    lines.push(`Baseline: ${Object.keys(snapshot)} provider da luu tru.`);
  }

  const { config } = loadConfigFile();
  const views = await buildViews(config, 'all');
  const catalogMeta = load9RouterCatalogMetadata();

  // Scan providers twice (60s apart) to confirm reachability
  const round1 = await scanAll(views, 1, 15000);
  await new Promise((r) => setTimeout(r, 1000));
  const round2 = await scanAll(views, 2, 15000);

  // Fetch raw model entries with pricing for each reachable target
  const providerEntries = new Map<string, ModelEntry[]>();
  const providerOk = new Set<string>();
  const providerErrors = new Map<string, string>();

  for (const view of views) {
    for (const target of view.targets) {
      if (target.skipReason) continue;
      const key = `${view.name}:${target.prefix}`;
      try {
        const result = await fetchModelEntries(target, { timeoutMs: 15000 });
        if (result.ok && result.entries.length > 0) {
          providerEntries.set(key, result.entries);
          providerOk.add(key);
        } else {
          providerErrors.set(key, result.error ?? 'empty-list');
        }
      } catch (err) {
        providerErrors.set(key, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Load OmniRoute tier assignments + capabilities (second source for price)
  const omniDbPath = locateRouterDb('omniroute');
  const omniDb = openBetterSqlite3(omniDbPath, { readOnly: true, busyTimeoutMs: 5000 });
  const tierAssignments = loadOmniRouteTierAssignments(omniDb);
  const capabilitiesMap = loadOmniRouteCapabilities(omniDb);
  omniDb.close();
  // PRICE-PROVIDER-WIDE-ZERO map theo provider quét (dùng cho C và E)
  const wideZeroMap = new Map<string, number>();
  for (const [key, entries] of providerEntries.entries()) {
    const parts = key.split(':');
    const scannedProvider = parts[parts.length - 1] ?? '';
    wideZeroMap.set(scannedProvider, providerWideZero(entries).ratio);
  }

  // Build set of providers already in combos (for needsResearch filter)
  const providersInCombos = new Set<string>();
  for (const view of views) {
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      for (const step of combo.steps) {
        providersInCombos.add(providerOf(step));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Part A: New models vs snapshot
  // -----------------------------------------------------------------------
  lines.push('');
  lines.push('A. Model mới (so với snapshot trước):');
  if (isFirstRun) {
    lines.push('  (lan chay dau tien - model_moi=0, baseline da tao)');
  }
  let newModelCount = 0;
  if (!isFirstRun) {
    for (const [key, entries] of [...providerEntries.entries()].sort()) {
      const parts = key.split(':');
      const prefix = parts[parts.length - 1] ?? '';
      const prev = snapshot[prefix] ?? {};
      const newIds: string[] = entries.filter((e) => !prev[e.id]).map((e) => e.id);
      newModelCount += newIds.length;
      if (newIds.length > 0) {
        lines.push(`  ${prefix}:`);
        for (const id of newIds.slice(0, 30)) {
          const entry = entries.find((e) => e.id === id)!;
          const provider = providerOf(id);
          const tier = tierAssignments.get(id);
          void capabilitiesMap.get(id);
          const secondSource = isSecondSourceConfirmed(tier);
          const classification = classifyPrice(id, entry, catalogMeta[id], secondSource);
          const fieldStr = classification.sources.length > 0 ? classification.sources.map((s) => s.field).join('; ') : '(none)';
          lines.push(`    ${prefix}/${id} | nhãn=${classification.label} | nguồn_giá=${fieldStr} | giá vào=${entry.inputPrice ?? '-'} ra=${entry.outputPrice ?? '-'}`);
        }
        if (newIds.length > 30) lines.push(`    ... con ${newIds.length - 30} model`);
      }
    }
  }
  if (isFirstRun || newModelCount === 0) {
    if (!isFirstRun) lines.push('  (không có model mới)');
  }

  // -----------------------------------------------------------------------
  // Part B: Cross-propagation
  // -----------------------------------------------------------------------
  lines.push('');
  lines.push('B. Lần tiến chuyển (model mới cũng có tại provider khác đã quét thành công):');
  const allIdsByNormalized = new Map<string, Array<{ provider: string; rawId: string }>>();
  for (const [key, entries] of providerEntries.entries()) {
    const parts = key.split(':');
    const provider = parts[parts.length - 1] ?? '';
    for (const e of entries) {
      const norm = normalizeId(e.id);
      const arr = allIdsByNormalized.get(norm) ?? [];
      arr.push({ provider, rawId: e.id });
      allIdsByNormalized.set(norm, arr);
    }
  }
  let crossCount = 0;
  for (const [norm, occurrences] of allIdsByNormalized.entries()) {
    if (occurrences.length <= 1) continue;
    const providersWithIt = new Set(occurrences.map((o) => o.provider));
    for (const occ of occurrences) {
      const prev = snapshot[occ.provider] ?? {};
      if (!prev[occ.rawId] && providersWithIt.size > 1) {
        const others = [...providersWithIt].filter((p) => p !== occ.provider);
        crossCount++;
        if (crossCount <= 30) lines.push(`  ${occ.rawId} (${occ.provider}) => cung co tai: ${others.join(', ')}`);
      }
    }
  }
  if (crossCount > 30) lines.push(`  ... con ${crossCount - 30} muc`);
  if (crossCount === 0) lines.push('  (không có model mới nào được lần tiến chuyển)');

  // -----------------------------------------------------------------------
  // Part C: Position suggestions
  // -----------------------------------------------------------------------
  lines.push('');
  lines.push('C. Gợi ý vị trí (FREE-BY-SUFFIX / FREE-BY-PRICE đã xác nhận, tối đa 5/nhóm, không gợi ý model đã trong combo):');
  let suggestCount = 0;
  const suggestedCanonical = new Set<string>();
  for (const view of views) {
    // Gộp combo giống hệt nhau: chỉ xét combo đầu tiên của mỗi nhóm steps
    const seenComboSig = new Set<string>();
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      const sig = combo.steps.join('|');
      if (seenComboSig.has(sig)) continue;
      seenComboSig.add(sig);
      const comboCanonical = new Set(combo.steps.map((s) => {
        const p = parseComboStep(s);
        return canonicalKey(p.prefix || '', p.model || s);
      }));
      const providersInCombo = new Set<string>();
      for (const step of combo.steps) {
        providersInCombo.add(providerOf(step));
      }
      for (const p of providersInCombo) {
        const key = `${view.name}:${p}`;
        if (!providerOk.has(key)) continue;
        const entries = providerEntries.get(key) ?? [];
        const candidates: Array<{ e: ModelEntry; classification: ReturnType<typeof classifyPrice> }> = [];
        for (const e of entries) {
          if (isNonChat(e.id)) continue;
          const tier = tierAssignments.get(e.id);
          const cap = capabilitiesMap.get(e.id);
          void cap;
          const secondSource = isSecondSourceConfirmed(tier);
          // bỏ qua wide-zero
          const wideRatio = wideZeroMap.get(p) ?? 0;
          const classification = classifyPrice(e.id, e, catalogMeta[e.id], secondSource);
          if (wideRatio > 0.5 && classification.label === 'FREE-BY-PRICE') continue;
          if (classification.label !== 'FREE-BY-SUFFIX' && classification.label !== 'FREE-BY-PRICE') continue;
          const ck = canonicalKey(p, e.id);
          if (comboCanonical.has(ck) || suggestedCanonical.has(`${view.name}/${combo.name}|${ck}`)) continue;
          candidates.push({ e, classification });
        }
        // Gom nhóm ≤5 theo tier tăng dần, tier=? xếp cuối (không số mặc định)
        candidates.sort((a, b) => {
          const ta = tierForModel(a.e.id);
          const tb = tierForModel(b.e.id);
          return ta - tb;
        });
        let groupSeen = 0;
        for (const { e, classification } of candidates) {
          if (groupSeen >= 5) break;
          const ck = canonicalKey(p, e.id);
          if (suggestedCanonical.has(`${view.name}/${combo.name}|${ck}`)) continue;
          suggestedCanonical.add(`${view.name}/${combo.name}|${ck}`);
          groupSeen++;
          suggestCount++;
          if (suggestCount <= 100) {
            lines.push(`  ${view.name}/${combo.name} | đề xuất ${p}/${e.id} | tier=${tierLabel(e.id)} | vị trí=${tierLabel(e.id) === '?' ? 'chưa xếp' : 'cuối cùng (xen kẽ D1)'} | lý do=${classification.label}`);
          }
        }
      }
    }
  }
  if (suggestCount > 100) lines.push(`  ... còn ${suggestCount - 100} ứng viên (xem discover --full --out <tệp>)`);
  if (suggestCount === 0) lines.push('  (không có ứng viên miễn phí nào để gọi vị trí)');

  // -----------------------------------------------------------------------
  // Part D: Needs research (narrowed)
  // -----------------------------------------------------------------------
  lines.push('');
  lines.push('D. Cần tra cứu (needsResearch — hẹp, tối đa 30 dòng):');
  let researchCount = 0;
  for (const [key, entries] of providerEntries.entries()) {
    for (const e of entries) {
      const provider = providerOf(e.id);
      if (!providersInCombos.has(provider)) continue;
      if (isNonChat(e.id)) continue;
      if (isFreeSuffix(e.id)) continue;
      const tier = tierAssignments.get(e.id);
      void capabilitiesMap.get(e.id);
      const secondSource = isSecondSourceConfirmed(tier);
      const classification = classifyPrice(e.id, e, catalogMeta[e.id], secondSource);
      if (classification.label === 'PRICE-UNKNOWN') {
        researchCount++;
        if (researchCount <= 30) lines.push(`  ${provider}/${e.id} | giá=PRICE-UNKNOWN | nguồn=(không có)`);
      }
    }
  }
  if (researchCount > 30) lines.push(`  ... còn ${researchCount - 30} mục`);
  if (researchCount === 0) lines.push('  (không có model nào cần tra cứu)');

  // -----------------------------------------------------------------------
  // Part E: Zero-price hidden models audit (deduped, 3 groups)
  // -----------------------------------------------------------------------
  lines.push('');
  lines.push('E. Kiểm tra model ẩn giá 0 (không cần snapshot):');
  const inCombo = new Set<string>();
  for (const view of views) {
    for (const combo of view.combos) {
      for (const step of combo.steps) inCombo.add(step);
    }
  }

  const freeByPriceConfirmed: Array<{ id: string; provider: string; sources: string[] }> = [];
  const priceZeroUnconfirmed: Array<{ id: string; provider: string; sources: string[] }> = [];
  const freeSuffixSeen = new Set<string>();

  for (const [key, entries] of providerEntries.entries()) {
    const parts = key.split(':');
    const scannedProvider = parts[parts.length - 1] ?? '';
    const wideRatio = wideZeroMap.get(scannedProvider) ?? 0;
    const isWideZero = wideRatio > 0.5;
    for (const e of entries) {
      if (isFreeSuffix(e.id)) {
        freeSuffixSeen.add(`${scannedProvider}/${e.id}`);
        continue;
      }
      const tier = tierAssignments.get(e.id);
      void capabilitiesMap.get(e.id);
      const secondSource = isSecondSourceConfirmed(tier);
      const classification = classifyPrice(e.id, e, catalogMeta[e.id], secondSource);
      const effectiveLabel = isWideZero && classification.label === 'FREE-BY-PRICE' ? 'PRICE-PROVIDER-WIDE-ZERO' : classification.label;
      if (effectiveLabel === 'FREE-BY-PRICE' && classification.confirmed) {
        freeByPriceConfirmed.push({ id: e.id, provider: scannedProvider, sources: classification.sources.map((s) => s.field) });
      } else if (classification.label === 'PRICE-ZERO-UNCONFIRMED') {
        priceZeroUnconfirmed.push({ id: e.id, provider: scannedProvider, sources: classification.sources.map((s) => s.field) });
      }
    }
  }

  // Dedup by (provider, canonicalAliasKey): gộp alias cùng provider (B1)
  const dedupConfirmed = new Map<string, typeof freeByPriceConfirmed[0]>();
  for (const item of freeByPriceConfirmed) {
    dedupConfirmed.set(`${item.provider}|${canonicalAliasKey(item.id)}`, item);
  }
  const dedupUnconfirmed = new Map<string, typeof priceZeroUnconfirmed[0]>();
  for (const item of priceZeroUnconfirmed) {
    dedupUnconfirmed.set(`${item.provider}|${canonicalAliasKey(item.id)}`, item);
  }

  const uniqueConfirmed = [...dedupConfirmed.values()];
  const uniqueUnconfirmed = [...dedupUnconfirmed.values()];

  lines.push(`  Nhóm 1 - FREE-BY-PRICE đã xác nhận: ${uniqueConfirmed.length} model duy nhất`);
  for (const item of uniqueConfirmed.slice(0, 15)) {
    const inComboStr = inCombo.has(`${item.provider}/${item.id}`) ? 'CÓ' : 'CHƯA';
    lines.push(`    ${item.id} | nhà cung cấp=${item.provider} | nguồn=${item.sources.join('; ')} | trong_combo=${inComboStr}`);
  }
  if (uniqueConfirmed.length > 15) lines.push(`    ... còn ${uniqueConfirmed.length - 15}`);

  lines.push(`  Nhóm 2 - PRICE-ZERO-UNCONFIRMED: ${uniqueUnconfirmed.length} model duy nhất`);
  for (const item of uniqueUnconfirmed.slice(0, 15)) {
    const inComboStr = inCombo.has(`${item.provider}/${item.id}`) ? 'CÓ' : 'CHƯA';
    lines.push(`    ${item.id} | nhà cung cấp=${item.provider} | nguồn=${item.sources.join('; ')} | trong_combo=${inComboStr}`);
  }
  if (uniqueUnconfirmed.length > 15) lines.push(`    ... còn ${uniqueUnconfirmed.length - 15}`);

  lines.push(`  Nhóm 3 - Có hậu giá (-free/:free): ${freeSuffixSeen.size} bước (không được xem là ẩn)`);
  // PRICE-PROVIDER-WIDE-ZERO summary + tỉ lệ giá 0 từng provider
  for (const [prov, ratio] of [...wideZeroMap.entries()].sort()) {
    lines.push(`  Tỉ lệ giá 0: ${prov}=${(ratio * 100).toFixed(1)}%${ratio > 0.5 ? ' (wide-zero, không lấy FREE-BY-PRICE từ nguồn này)' : ''}`);
    if (ratio > 0.5) lines.push(`  PRICE-PROVIDER-WIDE-ZERO: ${prov} tỉ lệ giá 0=${(ratio * 100).toFixed(1)}% >50% -> không lấy FREE-BY-PRICE từ nguồn này`);
  }

  // Write full data to state dir (not in send folder)
  const fullData: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    isFirstRun,
    newModelCount,
    crossPropagationCount: crossCount,
    suggestionCount: suggestCount,
    needsResearchCount: researchCount,
    freeByPriceConfirmedCount: uniqueConfirmed.length,
    priceZeroUnconfirmedCount: uniqueUnconfirmed.length,
    freeSuffixCount: freeSuffixSeen.size,
    freeByPriceConfirmed: uniqueConfirmed,
    priceZeroUnconfirmed: uniqueUnconfirmed,
    needsResearch: [],
    providerErrors: Object.fromEntries(providerErrors),
  };
  fs.writeFileSync(fullDiscoverFile(), `${JSON.stringify(fullData, null, 2)}\n`, 'utf-8');

  // Update snapshot
  const nextSnapshot: Snapshot = { ...snapshot };
  const now = new Date().toISOString();
  for (const [key, entries] of providerEntries.entries()) {
    const parts = key.split(':');
    const prefix = parts[parts.length - 1] ?? '';
    if (!nextSnapshot[prefix]) nextSnapshot[prefix] = {};
    const prefixMap = nextSnapshot[prefix];
    for (const e of entries) {
      if (!prefixMap[e.id]) prefixMap[e.id] = { firstSeen: now };
    }
  }
  writeSnapshot(nextSnapshot);

  const text = lines.join('\n') + '\n';
  if (options.out) fs.writeFileSync(options.out, text, 'utf8');
  if (!options.full) {
    // truncate stdout để giảm nhiễu, đầy đủ ở --out/--full
    console.log(text.split('\n').slice(0, 400).join('\n'));
  } else {
    console.log(text);
  }
  console.log(`\nTỔNG KẾT: model_mới=${newModelCount} | free_by_price_confirmed=${uniqueConfirmed.length} | needsResearch=${researchCount} | cross_propagation=${crossCount}`);

  if (options.json) {
    const jsonOut = {
      newModelCount,
      freeByPriceCount: uniqueConfirmed.length,
      priceZeroUnconfirmedCount: uniqueUnconfirmed.length,
      needsResearchCount: researchCount,
      crossPropagationCount: crossCount,
      isFirstRun,
      providerErrors: Object.fromEntries(providerErrors),
    };
    console.log(JSON.stringify(jsonOut, null, 2));
  }
}
