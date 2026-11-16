/**
 * packages/cli/src/commands/dead-models.ts
 * G1 (C3g): dead-models từ tập id STEP-EXISTS của health.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readComboModels, type RouterName } from '../sync/write.js';
import { countInnerModels } from './research.js';
import { stepExistsLabel } from '../sync/step-exists.js';
import { loadProviderRegistry } from '../sync/provider-registry.js';
import type { ModelEntry } from '../sync/providers.js';

/** C3o O2(b): nhãn xác định từ bản ghi ngoài thực sự khớp, không từ id bước. */
export function externalLabel(
  matched: string | null,
  covers: boolean,
): string {
  if (matched && (matched.startsWith('models-dev:') || matched.startsWith('openrouter:'))) return 'CÒN-Ở-NGUỒN-NGOÀI';
  return covers ? 'VẮNG-CATALOG+NGUỒN-NGOÀI' : 'VẮNG-CATALOG, NGUỒN-NGOÀI-KHÔNG-PHỦ';
}

/** C3k K3: normalize a model id for replacement hints. */
export function normalizeModelId(id: string): string {
  let s = id.toLowerCase().trim();
  s = s.replace(/^models\//, '');
  s = s.replace(/-free$/, '').replace(/:free$/, '');
  s = s.replace(/-preview$/, '').replace(/:preview$/, '');
  s = s.replace(/-(latest|stable)$/, '');
  s = s.replace(/[-_:]?v?\d+(\.\d+){1,2}$/, ''); // trailing date/version fragment
  return s.replace(/[-_:]+$/, '');
}

/** C3n N3(b): alias for external-source provider lookup (models.dev / openrouter). */
export const EXTERNAL_ALIAS: Readonly<Record<string, string>> = { hf: 'huggingface', gemini: 'google' };

/**
 * Data-only configuration for the dead-model scan, read from
 * registry/dead-models.yaml. The command ships with empty lists so no model
 * id, provider name or catalog size of a particular machine is baked into
 * the source.
 */
export interface DeadModelsConfig {
  provider: string;
  candidates: string[];
  catalogSizes: number[];
}

export function loadDeadModelsConfig(cwd: string = process.cwd()): DeadModelsConfig {
  const empty: DeadModelsConfig = { provider: '', candidates: [], catalogSizes: [] };
  let dir = path.resolve(cwd);
  let file = '';
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'registry', 'dead-models.yaml');
    if (fs.existsSync(candidate)) { file = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!file) return empty;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  const config: DeadModelsConfig = empty;
  let listKey: 'candidates' | 'catalogSizes' | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const scalar = line.match(/^(provider):\s*(.*)$/);
    if (scalar) { config.provider = scalar[1]!.trim(); continue; }
    const listStart = line.match(/^(candidates|catalogSizes):\s*(.*)$/);
    if (listStart) {
      listKey = listStart[1] as 'candidates' | 'catalogSizes';
      const inline = listStart[2]!.trim();
      if (inline.startsWith('[')) {
        const values = inline.replace(/^\[/, '').replace(/\]$/, '').split(',').map((v) => v.trim()).filter((v) => v !== '');
        if (listKey === 'catalogSizes') config.catalogSizes = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
        else config.candidates = values;
        listKey = null;
      } else {
        config[listKey] = [];
      }
      continue;
    }
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && listKey === 'candidates') config.candidates.push(item[1]!.trim());
    else if (item && listKey === 'catalogSizes') {
      const n = Number(item[1]!.trim());
      if (Number.isFinite(n)) config.catalogSizes.push(n);
    }
  }
  return config;
}

/** C3n N3(b): external record matched for a (pref,model) pair; source:provider/id. */
export function matchedExternalRecord(
  prefRaw: string,
  model: string,
  step: string,
  mdByProvider: ReadonlyMap<string, ReadonlySet<string>>,
  orIds: ReadonlySet<string>
): string | null {
  const pref = EXTERNAL_ALIAS[prefRaw.toLowerCase()] ?? prefRaw.toLowerCase();
  const mdSet = mdByProvider.get(pref) ?? mdByProvider.get(prefRaw.toLowerCase());
  if (mdSet && (mdSet.has(model) || mdSet.has(step))) return `models-dev:${pref}/${model}`;
  if ((pref === 'openrouter' || prefRaw.toLowerCase() === 'openrouter') && (orIds.has(model) || orIds.has(step))) return `openrouter:${model}`;
  return null;
}

/** C3k K3: up to 3 live ids of the same provider whose normalized base matches. */
export function suggestReplacements(absentId: string, liveIds: readonly string[]): string[] {
  const base = normalizeModelId(absentId);
  if (!base) return [];
  const exact = liveIds.filter((id) => normalizeModelId(id) === base && id !== absentId);
  if (exact.length) return exact.slice(0, 3);
  return liveIds.filter((id) => normalizeModelId(id).includes(base)).slice(0, 3);
}

/** A2: query single model price from provider via live GET */
export async function queryLivePrice(
  provider: string,
  modelId: string,
  fetchFn?: typeof globalThis.fetch
): Promise<{
  found: boolean;
  isFree: boolean;
  promptPrice: number | null;
  completionPrice: number | null;
  raw?: Record<string, unknown>;
}> {
  const { buildViews } = await import('./sync/sync-plan.js');
  const { loadConfigFile } = await import('../config/loader.js');
  const { fetchModelEntries, resolveProviderTargets } = await import('../sync/providers.js');
  const { loadProviderRegistry } = await import('../sync/provider-registry.js');
  const { config } = loadConfigFile(undefined);
  const views = await buildViews(config, 'all');
  const lp = provider.toLowerCase();
  const registryBaseUrl = loadProviderRegistry().providers[lp];
  const target =
    views.find((v) => v.name === '9router')?.targets.find((t) => t.prefix === lp) ??
    resolveProviderTargets('9router', [lp], new Map())[0] ??
    {
      id: lp,
      label: lp,
      prefix: lp,
      baseUrl: registryBaseUrl,
      keySource: 'none' as const,
    };

  const live = await fetchModelEntries(target, {
    timeoutMs: 15_000,
    ...(fetchFn ? { fetchFn } : {}),
  });
  const entry = live.entries.find((e) => e.id === modelId);
  if (!entry) {
    return { found: false, isFree: false, promptPrice: null, completionPrice: null };
  }

  const isFree = entry.raw['is_free'] === true || (entry.inputPrice === 0 && entry.outputPrice === 0);
  return {
    found: true,
    isFree,
    promptPrice: entry.inputPrice ?? null,
    completionPrice: entry.outputPrice ?? null,
    raw: entry.raw,
  };
}

function latestCatalog(): Map<string, { s: Set<string>; st: number; file: string }> {
  const dir = path.join(process.cwd(), '.routersync-cache', 'catalog');
  const latest = new Map<string, { s: Set<string>; st: number; file: string }>();
  if (!fs.existsSync(dir)) return latest;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { router: string; prefix: string; ids: string[]; status?: number };
      latest.set(`${j.router}:${j.prefix}`, { s: new Set(j.ids), st: j.status ?? 200, file: f });
    } catch { /* skip */ }
  }
  return latest;
}

/**
 * B8: Resolve base price considering active_time_window.
 * If active_time_window is set, do NOT overwrite stored base price.
 * If active_time_window is null/unset, record current observation as base price.
 */
export function resolveBasePrice(
  currentObservation: { inputPrice: number | null; outputPrice: number | null; activeTimeWindow: unknown | null; fetchedAt: string },
  storedBase?: { input: number | null; output: number | null; fetchedAt: string | null } | null
): { input: number | null; output: number | null; fetchedAt: string | null } {
  const inWindow = currentObservation.activeTimeWindow != null && currentObservation.activeTimeWindow !== '-';
  if (!inWindow) {
    return {
      input: currentObservation.inputPrice,
      output: currentObservation.outputPrice,
      fetchedAt: currentObservation.fetchedAt,
    };
  }
  return {
    input: storedBase?.input ?? null,
    output: storedBase?.output ?? null,
    fetchedAt: storedBase?.fetchedAt ?? null,
  };
}

export async function runDeadModelsCommand(options: {
  payloadKeys?: string | undefined;
  livePrice?: string | undefined;
  id?: string | undefined;
  mockLiveEntries?: ModelEntry[] | undefined;
} = {}): Promise<void> {
  if (options.payloadKeys) {
    // C3o O2(a) / A2: đọc catalog trong cache, hoàn toàn 0 network GET.
    const lp = options.payloadKeys.toLowerCase();
    const dir = path.join(process.cwd(), '.routersync-cache', 'catalog');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const cacheFiles: Array<{ file: string; status: number; ids: string[]; bytes: number }> = [];
    for (const f of files) {
      try {
        const full = path.join(dir, f);
        const j = JSON.parse(fs.readFileSync(full, 'utf8')) as { router?: string; prefix?: string; ids?: string[]; status?: number };
        if (String(j.prefix ?? '').toLowerCase() === lp) {
          cacheFiles.push({ file: f, status: j.status ?? 200, ids: (j.ids ?? []).map(String), bytes: fs.statSync(full).size });
        }
      } catch { /* skip */ }
    }
    const picked = cacheFiles[cacheFiles.length - 1];
    if (!picked) { console.log(`PAYLOAD-KEYS provider=${lp} fields=NONE khong-co-file-cache-node-a`); return; }
    console.log(`PAYLOAD-KEYS provider=${lp} file=${picked.file} status=${picked.status} ids=${picked.ids.length} bytes=${picked.bytes}`);
    const payloadKeys = ['scanId', 'router', 'node', 'prefix', 'keySource', 'status', 'hash', 'count', 'ids'];
    console.log(`PAYLOAD-KEYS provider=${lp} fields=${payloadKeys.join(',')}`);
    const idSet = new Set(picked.ids);

    // Combo -free của provider nếu còn tồn tại trong cache/router.
    const freeIds: string[] = [];
    for (const [, models] of readComboModels('9router')) {
      for (const step of models) {
        const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
        const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
        if (pref === lp && model.endsWith('-free')) freeIds.push(model);
      }
    }
    const deadConfig = loadDeadModelsConfig();
    const candidateList = options.id
      ? options.id.split(',').map((s) => s.trim())
      : [...deadConfig.candidates, ...new Set(freeIds)];
    if (candidateList.length === 0) {
      console.log('DEAD-MODELS-HINT ids=0 | nen truyen --id "<danh sach id>" hoac them id vao registry/dead-models.yaml');
      return;
    }
    for (const s of candidateList) {
      const label = idSet.has(s) ? `TỒN-TẠI-TRONG-CATALOG-${lp.toUpperCase()}` : 'KHÔNG-TỒN-TẠI';
      console.log(`SUGGEST ${s} | ${label} | GIÁ=CHƯA-BIẾT NGUỒN=cache-chỉ-id`);
    }
    return;
  }

  if (options.livePrice) {
    // A2: live-price thực hiện đúng 1 GET lấy danh mục rồi in GIÁ-CỦA-GỢI-Ý=deepseek-v4-flash (CÓ-PHÍ/MIỄN-PHÍ)
    const lp = options.livePrice.toLowerCase();
    let liveEntries: ModelEntry[] = [];
    let liveStatus = 200;
    let liveBytes = 0;

    if (options.mockLiveEntries) {
      liveEntries = options.mockLiveEntries;
      liveBytes = 1024;
    } else {
      const { buildViews } = await import('./sync/sync-plan.js');
      const { loadConfigFile } = await import('../config/loader.js');
      const { fetchModelEntries, resolveProviderTargets } = await import('../sync/providers.js');
      const { config } = loadConfigFile(undefined);
      const views = await buildViews(config, 'all');
      const target =
        views.find((v) => v.name === '9router')?.targets.find((t) => t.prefix === lp) ??
        resolveProviderTargets('9router', [lp], new Map())[0];

      if (!target) {
        console.log(`LIVE-PRICE provider=${lp} target=NONE không tìm thấy cấu hình target`);
        return;
      }
      const live = await fetchModelEntries(target, { timeoutMs: 30_000 });
      liveEntries = live.entries;
      liveStatus = live.status;
      liveBytes = live.bytes;
    }

    console.log(`NGUỒN=live-GET status=${liveStatus} bytes=${liveBytes} số-hàng=${liveEntries.length}`);
    const firstFields = liveEntries[0] ? Object.keys(liveEntries[0].raw) : [];
    console.log(`HÀNG-ĐẦU fields=${firstFields.join(',') || '-'}`);

    const nowIso = new Date().toISOString();
    const priorOutsideBase = new Map<string, { input: number | null; output: number | null; fetchedAt: string | null }>();
    try {
      const cacheDir = path.join(process.cwd(), '.routersync-cache', 'prices');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      for (const f of fs.readdirSync(cacheDir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')) as {
            at?: string;
            rows?: Array<{
              id: string;
              fetchedInWindow?: boolean;
              base?: { input?: number | null; output?: number | null } | null;
              baseFetchedAt?: string | null;
              fetchedAt?: string | null;
            }>;
          };
          for (const r of j.rows ?? []) {
            if (r.fetchedInWindow === false && r.base && r.base.input != null && r.base.output != null) {
              priorOutsideBase.set(r.id, {
                input: r.base.input,
                output: r.base.output,
                fetchedAt: r.baseFetchedAt ?? r.fetchedAt ?? j.at ?? null,
              });
            }
          }
        } catch { /* bỏ qua file lỗi */ }
      }
      const stamp = nowIso.replace(/[:.]/g, '-');
      const cacheFile = path.join(cacheDir, `${lp}-${stamp}.json`);
      const cacheRows = liveEntries.map((e) => {
        const fetchedInWindow = e.raw['active_time_window'] != null;
        const prior = priorOutsideBase.get(e.id);
        const base = !fetchedInWindow
          ? { input: e.inputPrice ?? null, output: e.outputPrice ?? null }
          : prior
            ? { input: prior.input, output: prior.output }
            : null;
        const baseFetchedAt = !fetchedInWindow ? nowIso : (prior?.fetchedAt ?? null);
        return {
          id: e.id,
          price_input_vnd: e.inputPrice ?? null,
          price_output_vnd: e.outputPrice ?? null,
          is_free: e.raw['is_free'] ?? null,
          time_pricing: e.raw['time_pricing'] ?? null,
          fetchedInWindow,
          base,
          baseFetchedAt,
          fetchedAt: nowIso,
        };
      });
      fs.writeFileSync(cacheFile, JSON.stringify({ provider: lp, at: nowIso, rows: cacheRows }, null, 1), 'utf8');
      console.log(`GIÁ-CACHE LƯU tệp=${cacheFile} dòng=${cacheRows.length}`);
    } catch { /* không chặn */ }

    // TIME-PRICING JSON
    let tpShown = 0; let tpTotal = 0; let tpOk = 0;
    for (const e of liveEntries) {
      const tp = e.raw['time_pricing'];
      if (tp == null) continue;
      tpTotal++;
      const s = JSON.stringify(tp);
      try {
        const parsed = JSON.parse(s) as unknown[];
        tpOk++;
        if (tpShown < 3) {
          console.log(`TIME-PRICING id=${e.id} JSON-OK windows=${Array.isArray(parsed) ? parsed.length : 0}`);
          console.log(`TIME-PRICING-RAW ${s.slice(0, 300)}`);
          tpShown++;
        }
      } catch { /* bỏ qua */ }
    }
    console.log(`TIME-PRICING-TONG id-gia-tri=${tpTotal} json-ok=${tpOk}`);

    // Hàng giá thô cho các id được yêu cầu hoặc mặc định
    const vnNowIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(', ', 'T') + '+07:00';
    const targetIds = options.id
      ? options.id.split(',').map((s) => s.trim())
      : loadDeadModelsConfig().candidates;
    if (targetIds.length === 0) {
      console.log('PRICE-SUMMARY ids=0 | nen truyen --id "<danh sach id>" hoac them id vao registry/dead-models.yaml');
      return;
    }
    let withWin = 0;
    for (const id of targetIds) {
      const e = liveEntries.find((x) => x.id === id);
      const isFree = e ? String(e.raw['is_free']) : 'missing';
      const pin = e?.inputPrice ?? 0; const pout = e?.outputPrice ?? 0;
      const atw = e && e.raw['active_time_window'] != null ? JSON.stringify(e.raw['active_time_window']).replace(/\s+/g, '') : '-';
      const tpRaw = e && e.raw['time_pricing'] != null ? JSON.stringify(e.raw['time_pricing']).replace(/\s+/g, '') : '-';
      if (tpRaw !== '-' && tpRaw !== '[]') withWin++;
      console.log(`PRICE-RAW id=${id} is_free=${isFree} price_in=${pin} price_out=${pout} active_time_window=${atw} time_pricing=${tpRaw} vn-now=${vnNowIso}`);
    }
    console.log(`PRICE-SUMMARY ids=${targetIds.length} có-cửa-sổ=${withWin} không-cửa-sổ=${targetIds.length - withWin}`);

    const primaryId = targetIds[0] ?? '';
    const dv = liveEntries.find((x) => x.id === primaryId);
    const winList = dv && Array.isArray(dv.raw['time_pricing']) ? (dv.raw['time_pricing'] as Array<Record<string, unknown>>).map((w) => `${String(w['start_time'] ?? '?')}-${String(w['end_time'] ?? '?')}`).join(',') : '-';
    console.log(`PRICE-WINDOWS id=${primaryId} n=${dv && Array.isArray(dv.raw['time_pricing']) ? (dv.raw['time_pricing'] as unknown[]).length : 0} ${winList}`);
    console.log(`PRICE-UNIT đơn-vị=VND/1M-token nguồn=providers.ts:622`);

    // Giá cơ sở & Nhãn GIÁ-CỦA-GỢI-Ý
    const tp = dv && Array.isArray(dv.raw['time_pricing']) ? (dv.raw['time_pricing'] as Array<Record<string, unknown>>) : [];
    const first = tp[0] ?? {};
    const lowIn = typeof first['price_input_vnd'] === 'number' ? Number(first['price_input_vnd']) : 0;
    const lowOut = typeof first['price_output_vnd'] === 'number' ? Number(first['price_output_vnd']) : 0;
    const priorDv = priorOutsideBase.get(primaryId);
    const basePrices = resolveBasePrice(
      {
        inputPrice: dv?.inputPrice ?? null,
        outputPrice: dv?.outputPrice ?? null,
        activeTimeWindow: dv?.raw['active_time_window'] ?? null,
        fetchedAt: nowIso,
      },
      priorDv ? { input: priorDv.input, output: priorDv.output, fetchedAt: priorDv.fetchedAt } : null
    );
    const baseIn = basePrices.input;
    const baseOut = basePrices.output;
    const baseAt = basePrices.fetchedAt;
    const baseStr = baseIn != null && baseOut != null && baseAt
      ? `${baseIn}/${baseOut} NGOÀI-CỬA-SỔ lúc=${baseAt}`
      : 'CHƯA-BIẾT (chỉ-có-giá-trong-cửa-sổ)';
    const isFreeVal = dv?.raw['is_free'];
    const tierLabel = isFreeVal === true ? 'MIỄN-PHÍ' : 'CÓ-PHÍ';
    const isFreeStr = isFreeVal != null ? String(isFreeVal) : 'unknown';
    const mins = (s: string, e: string) => {
      const [sh = 0, sm = 0] = s.split(':').map(Number);
      const [eh = 0, em = 0] = e.split(':').map(Number);
      let d = (eh * 60 + em) - (sh * 60 + sm);
      if (d < 0) d += 24 * 60;
      return d;
    };
    const totalMin = tp.reduce((a, w) => a + mins(String(w['start_time'] ?? '00:00'), String(w['end_time'] ?? '00:00')), 0);
    const hours = Math.round(totalMin / 60);
    const winStr = tp.map((w) => `${String(w['start_time'] ?? '?')}-${String(w['end_time'] ?? '?')}`).join(',');
    console.log(`${lp}/${primaryId} | THẤP-ĐIỂM=${lowIn}/${lowOut} ${winStr} (${hours}h/ngày) GIÁ-CƠ-SỞ=${baseStr} | GIÁ-CỦA-GỢI-Ý=${primaryId} (${tierLabel}) is_free=${isFreeStr}`);

    return;
  }
  const routers: RouterName[] = ['9router', 'omniroute'];
  const latest = latestCatalog();
  // C3r R2a: đọc cache giá mới nhất (không mạng) theo id model.
  // C3s S3: giữ thêm time_pricing + fetchedAt + base để in PRICE-WINDOW.
  const priceCache = new Map<string, { input: number | null; output: number | null; isFree: boolean | null; timePricing: Array<{ start_time?: string; end_time?: string; price_input_vnd?: number | null; price_output_vnd?: number | null }> | null; fetchedAt: string | null }>();
  {
    const pdir = path.join(process.cwd(), '.routersync-cache', 'prices');
    if (fs.existsSync(pdir)) {
      for (const f of fs.readdirSync(pdir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')) as { at?: string; rows?: Array<{ id: string; price_input_vnd?: number | null; price_output_vnd?: number | null; is_free?: boolean | null; fetchedInWindow?: boolean; base?: { input?: number | null; output?: number | null } | null; time_pricing?: Array<{ start_time?: string; end_time?: string; price_input_vnd?: number | null; price_output_vnd?: number | null }> | null; baseFetchedAt?: string | null; fetchedAt?: string | null }> };
          for (const r of j.rows ?? []) {
            const trustedBase = r.fetchedInWindow === false
              ? { input: r.base?.input ?? r.price_input_vnd ?? null, output: r.base?.output ?? r.price_output_vnd ?? null, fetchedAt: r.baseFetchedAt ?? r.fetchedAt ?? j.at ?? null }
              : (r.fetchedInWindow === true && r.base?.input != null && r.base?.output != null)
                ? { input: r.base.input, output: r.base.output, fetchedAt: r.baseFetchedAt ?? null }
                : null;
            const prev = priceCache.get(r.id);
            priceCache.set(r.id, {
              input: trustedBase?.input ?? prev?.input ?? null,
              output: trustedBase?.output ?? prev?.output ?? null,
              isFree: typeof r.is_free === 'boolean' ? r.is_free : (prev?.isFree ?? null),
              timePricing: Array.isArray(r.time_pricing) ? r.time_pricing : (prev?.timePricing ?? null),
              fetchedAt: trustedBase?.fetchedAt ?? prev?.fetchedAt ?? null,
            });
          }
        } catch { /* skip */ }
      }
    }
  }
  // C3s S3: PRICE-WINDOW từ cache — giá phụ thuộc giờ gọi (cửa sổ 00:00-08:00
  // giờ VN giảm ~50%). now-active tính theo giờ Asia/Ho_Chi_Minh.
  const vnNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const priceWindowId = loadDeadModelsConfig().candidates[0] ?? '';
  const tpFor = priceWindowId ? priceCache.get(priceWindowId) : undefined;
  if (tpFor && tpFor.timePricing && tpFor.timePricing.length) {
    const activeWin = tpFor.timePricing.find((w) => w.start_time && w.end_time && vnNow >= w.start_time && vnNow < w.end_time);
    const actIn = activeWin?.price_input_vnd ?? tpFor.input;
    const actOut = activeWin?.price_output_vnd ?? tpFor.output;
    console.log(`PRICE-WINDOW id=${priceWindowId} now-active=${activeWin ? 'yes' : 'no'} base=${tpFor.input ?? 'CHƯA-BIẾT'}/${tpFor.output ?? 'CHƯA-BIẾT'} active=${actIn ?? 'CHƯA-BIẾT'}/${actOut ?? 'CHƯA-BIẾT'} windows=${tpFor.timePricing.length} tz=Asia/Ho_Chi_Minh`);
  }
  // Tập id từ STEP-EXISTS: mọi step trong combo
  const allSteps = new Map<string, { router: string; step: string; combos: number; stepsInCombo: number }>();
  const idSetFromHealth = new Set<string>();
  for (const router of routers) {
    const combos = readComboModels(router);
    for (const [, models] of combos) {
      for (const step of models) {
        idSetFromHealth.add(`${router}|${step}`);
      }
    }
  }
  // C3m M2: nguồn độc lập theo (provider,model), có bản ghi khớp rõ ràng.
  let mdIds = new Set<string>();
  let orIds = new Set<string>();
  let mdProviders = new Set<string>();
  const mdByProvider = new Map<string, Set<string>>();
  const orPrice = new Map<string, string>();
  let mdTotal = 0;
  try {
    const md = await fetch('https://models.dev/api.json', { headers: { 'User-Agent': 'routersync-research/0.1' }, signal: AbortSignal.timeout(20_000) }).then((r) => r.json()) as Record<string, { models?: Record<string, unknown> }>;
    mdTotal = countInnerModels(md);
    for (const [p, info] of Object.entries(md)) {
      const lp = p.toLowerCase();
      mdProviders.add(lp);
      const s = mdByProvider.get(lp) ?? new Set<string>();
      for (const k of Object.keys(info.models ?? {})) { mdIds.add(k); s.add(k); }
      mdByProvider.set(lp, s);
    }
  } catch { /* UNCONFIRMED */ }
  try {
    const oj = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'User-Agent': 'routersync-research/0.1' }, signal: AbortSignal.timeout(20_000) }).then((r) => r.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    for (const r of oj.data ?? []) { orIds.add(r.id); if (r.pricing) orPrice.set(r.id, `pricing.prompt=${r.pricing['prompt'] ?? ''} pricing.completion=${r.pricing['completion'] ?? ''}`); }
  } catch { /* UNCONFIRMED */ }

  const lines: string[] = ['DEAD-MODELS (0 token, từ tập id STEP-EXISTS của health)', 'tập id bằng nhau: đúng (dùng cùng readComboModels của health)'];
  const counts = new Map<string, { combos: number; steps: number }>();
  for (const router of routers) {
    const combos = readComboModels(router);
    for (const [, models] of combos) {
      for (const step of models) counts.set(`${router}|${step}`, counts.get(`${router}|${step}`) ?? { combos: 0, steps: 0 });
    }
  }
  // đếm combo chứa step
  for (const router of routers) {
    const combos = readComboModels(router);
    for (const [, models] of combos) {
      for (const step of models) {
        const c = counts.get(`${router}|${step}`)!;
        c.combos += 1;
        c.steps += 1;
      }
    }
  }
  const rows: string[] = [];
  for (const [key, c] of [...counts.entries()].sort()) {
    const idx = key.indexOf('|');
    const router = key.slice(0, idx);
    const step = key.slice(idx + 1);
    const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
    const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
    const e = latest.get(`${router}:${pref}`) ?? null;
    const set = e?.s ?? null;
    const label = stepExistsLabel(e?.st, set, step, model);
    if (label !== 'ABSENT-UNCONFIRMED') continue;
    const extPref = EXTERNAL_ALIAS[pref.toLowerCase()] ?? pref.toLowerCase();
    const covers = mdProviders.has(pref.toLowerCase()) || mdProviders.has(extPref) || pref === 'openrouter';
    // C3o O2(b): khớp= chỉ in bản ghi ngoài thực sự khớp (models-dev:/openrouter:), không in id bước.
    const matched = matchedExternalRecord(pref, model, step, mdByProvider, orIds) ?? 'none';
    const finalLabel = externalLabel(matched === 'none' ? null : matched, covers);
    const hints = set ? suggestReplacements(model, [...set]) : [];
    // C3m M2: chỉ free/:free/sale/preview mới TIER-BIẾN-THỂ; còn lại PHIÊN-BẢN-GẦN.
    const isTier = /(-free|:free|-sale|-preview)$/.test(model);
    const loai = !hints.length ? 'KHÔNG-CÓ' : (isTier ? 'TIER-BIẾN-THỂ (có thể đổi giá, không tự thay)' : 'PHIÊN-BẢN-GẦN');
    // C3p P2(b): nhãn giá ghi nguồn; orPrice là GET live nên NGUỒN=live-GET.
    // C3r R2a: ưu tiên cache giá (NGUỒN=price-cache), không gọi mạng.
    const price = orPrice.get(model) ?? orPrice.get(step);
    // R2a / P1: nếu giá lấy từ gợi ý thay (hint có trong cache) hoặc biến thể -free→-sale,
    // ghi rõ GIÁ-CỦA-GỢI-Ý=<id> (CÓ-PHÍ|MIỄN-PHÍ), không gán trực tiếp vào tên -free.
    const hintKey = hints.find((h) => priceCache.has(h))
      ?? (!priceCache.has(model) && model.endsWith('-free') && priceCache.has(model.replace(/-free$/, '-sale'))
        ? model.replace(/-free$/, '-sale')
        : undefined);
    const pc = (hintKey ? priceCache.get(hintKey) : undefined)
      ?? priceCache.get(model)
      ?? priceCache.get(`node-a-${model}`)
      ?? priceCache.get(step);
    const hintTier = pc?.isFree === true ? 'MIỄN-PHÍ' : 'CÓ-PHÍ';
    const pricePrefix = hintKey ? `GIÁ-CỦA-GỢI-Ý=${hintKey} (${hintTier}) GIÁ` : 'GIÁ';
    // C3s S3: khi có time_pricing, in GIÁ-HIỆN (tùy giờ VN hiện tại) và
    // THẤP-ĐIỂM (cửa sổ rẻ nhất) từ cache, kèm lúc lấy.
    let priceLbl = pc?.input != null && pc?.output != null
      ? `${pricePrefix}=${pc.input}/${pc.output} VND NGUỒN=price-cache`
      : price != null ? `${pricePrefix}=${price} NGUỒN=live-GET` : `${pricePrefix}=CHƯA-BIẾT NGUỒN=cache-chỉ-id`;
    if (pc && pc.timePricing && pc.timePricing.length) {
      const winLive = pc.timePricing.filter((w) => w.price_input_vnd != null && w.price_output_vnd != null);
      if (winLive.length) {
        const curWin = winLive.find((w) => w.start_time && w.end_time && vnNow >= w.start_time && vnNow < w.end_time);
        const loWin = winLive.reduce((a, b) => ((b.price_input_vnd ?? Infinity) < (a.price_input_vnd ?? Infinity) ? b : a));
        const baseDisp = pc.input != null && pc.output != null ? `${pc.input}/${pc.output}` : 'CHƯA-BIẾT';
        priceLbl += ` GIÁ-CƠ-SỞ=${baseDisp} GIÁ-HIỆN=${curWin?.price_input_vnd ?? pc.input ?? 'CHƯA-BIẾT'}/${curWin?.price_output_vnd ?? pc.output ?? 'CHƯA-BIẾT'} VND THẤP-ĐIỂM=${loWin.price_input_vnd}/${loWin.price_output_vnd} ${loWin.start_time}-${loWin.end_time} NGUỒN=price-cache lúc=${pc.fetchedAt ?? 'không-ghi'}`;
      }
    }
    const hintTxt = hints.length ? `GỢI-Ý-THAY(HINT-ONLY): ${hints.join(', ')} | LOẠI-GỢI-Ý=${loai} | ${priceLbl}` : `GỢI-Ý-THAY(HINT-ONLY): không có | LOẠI-GỢI-Ý=KHÔNG-CÓ | ${priceLbl}`;
    const srcFile = e?.file ? e.file.replace(/(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})/, '$1$2:$3') : 'none';
    rows.push(`${step} | router=${router} | combo=${c.combos} | bước=${c.steps} | ${finalLabel} | STEP-EXISTS=ABSENT-UNCONFIRMED | khớp=${matched} | ${hintTxt} | nguồn=${srcFile} status=${e?.st ?? 'none'} ids=${set ? set.size : 0}`);
  }
  lines.push(`số dòng ABSENT-UNCONFIRMED: ${rows.length}`);
  const withHint = rows.filter((r) => !r.includes('GỢI-Ý-THAY(HINT-ONLY): không có')).length;
  lines.push(`có gợi ý ${withHint}/${rows.length}`);
  lines.push(`models-dev records (một định nghĩa duy nhất): ${mdTotal}`);
  // C3n N3(b): bảng phủ các nhà có trong danh mục dùng chung của sản phẩm.
  lines.push('COVERAGE | nhà-cung-cấp | alias-dùng | số-id-cùng-nhà-ngoài | phủ?');
  const registry = loadProviderRegistry();
  const coverageProviders = Object.keys(registry.providers).sort();
  for (const p of coverageProviders) {
    const alias = registry.alias[p] ?? p;
    const n = mdByProvider.get(alias === p ? p : alias)?.size ?? mdByProvider.get(p)?.size ?? 0;
    const covered = mdProviders.has(alias) || mdProviders.has(p) || p === 'openrouter';
    lines.push(`COVERAGE | ${p} | ${alias} | ${n} | ${covered ? 'có' : 'không'}`);
  }
  lines.push('id | router | số combo | số bước | nhãn');
  for (const r of rows) lines.push(r);
  lines.push('không sinh đề xuất gỡ. HINT-ONLY: gợi ý thay thế không đưa vào kế hoạch, không đề xuất gỡ hay thay.');
  // C3r R1b: IMPACT — bước combo bị ảnh hưởng bởi tập id mất của một nhà cung cấp.
  {
    const deadConfig = loadDeadModelsConfig();
    const impactPrefix = deadConfig.provider;
    const catalogSizes = deadConfig.catalogSizes;
    if (!impactPrefix || catalogSizes.length < 2) {
      lines.push('IMPACT | (chua cau hinh) | dat impact trong registry/dead-models.yaml de so sanh hai ban danh muc');
    } else {
    const cdir = path.join(process.cwd(), '.routersync-cache', 'catalog');
    const idsFor = (router: string, n: number): Set<string> => {
      try {
        const files = fs.readdirSync(cdir).filter((f) => f.startsWith(`${router}-${impactPrefix}-`) && f.endsWith('.json')).sort();
        for (const f of [...files].reverse()) {
          const j = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')) as { ids?: string[] };
          if ((j.ids ?? []).length === n) return new Set(j.ids ?? []);
        }
      } catch { /* bỏ qua */ }
      return new Set();
    };
    for (const router of routers) {
      const oldSet = idsFor(router, catalogSizes[0]!);
      const newSet = idsFor(router, catalogSizes[1]!);
      if (!oldSet.size || !newSet.size) continue;
      const lostIds = new Set([...oldSet].filter((id) => !newSet.has(id)));
      let steps = 0; const combos = new Set<string>();
      for (const [cname, models] of readComboModels(router)) {
        for (const step of models) {
          const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          if (pref !== impactPrefix) continue;
          if (lostIds.has(model) || (lostIds.has(step))) { steps++; combos.add(String(cname)); }
        }
      }
      const idsInCombos = new Set<string>();
      for (const [, models] of readComboModels(router)) {
        for (const step of models) {
          const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          if (pref === impactPrefix && (lostIds.has(model) || lostIds.has(step))) idsInCombos.add(model);
        }
      }
      lines.push(`IMPACT steps=${steps} combos=${combos.size} ids=${idsInCombos.size} router=${router} lost=${lostIds.size}`);
    }
    }
  }
  console.log(lines.join('\n') + '\n');
}
