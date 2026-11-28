/**
 * packages/cli/src/sync/confirm.ts
 *
 * confirmAbsent(provider, ids[]): xác thực từng id nghi vắng bằng GET /models/{id}
 * tới đúng host của provider (kèm khóa trong RAM, chỉ đọc, không in khóa).
 *_CONTROL = id chắc chắn có, phải trả 200; không 200 => UNSUPPORTED.
 */
import type { ProviderTarget } from './providers.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBundledRegistryFile } from '../registry/bundled.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * C3r R3a: một nguồn sự thật cho QUOTA — scan --completeness và
 * health COVERAGE cùng gọi. 429 = giới hạn mức, không phải "chưa quét".
 */
export function quotaStatus(status: number): boolean {
  return status === 429;
}

export interface CatalogTrustEntry { provider: string; trustComplete: boolean; pagination: string; doc: string }
/** Đọc registry/catalog-trust.yaml (dữ liệu). Không có dòng nguồn => không COMPLETE. */
export function loadCatalogTrust(cwd = process.cwd()): CatalogTrustEntry[] {
  let dir = cwd;
  let p = path.join(dir, 'registry', 'catalog-trust.yaml');
  for (let i = 0; i < 10 && !fs.existsSync(p); i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    p = path.join(dir, 'registry', 'catalog-trust.yaml');
  }
  if (!fs.existsSync(p)) {
    const bundled = findBundledRegistryFile(MODULE_DIR, 'catalog-trust.yaml');
    if (!bundled) return [];
    p = bundled;
  }
  const text = fs.readFileSync(p, 'utf8');
  const out: CatalogTrustEntry[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+-\s+provider:\s*(.+)$/);
    if (m) { if (cur) out.push(cur as unknown as CatalogTrustEntry); cur = { provider: m[1]!.trim() }; continue; }
    if (cur) {
      const k = line.match(/^\s+(trustComplete|pagination|doc):\s*(.*)$/);
      if (k) cur[k[1]!] = k[2]!.trim();
    }
  }
  if (cur) out.push(cur as unknown as CatalogTrustEntry);
  return out.map((e) => ({ provider: e.provider, trustComplete: (e as unknown as Record<string,string>).trustComplete === 'true', pagination: (e as unknown as Record<string,string>).pagination ?? 'none', doc: (e as unknown as Record<string,string>).doc ?? '' }));
}
export function trustCompleteFor(provider: string, entries: CatalogTrustEntry[]): boolean {
  return entries.find((e) => e.provider.toLowerCase() === provider.toLowerCase())?.trustComplete ?? false;
}

export type ConfirmVerdict = 'CONFIRMED-ABSENT' | 'STILL-EXISTS' | 'AUTH' | 'QUOTA' | 'UNKNOWN' | 'UNSUPPORTED' | 'PROBE-INVALID';

export function normalizeKey(id: string): string {
  let s = id.toLowerCase().replace(/[.]/g, '-');
  if (s.endsWith(':free')) s = s.slice(0, -5);
  else if (s.endsWith('-free')) s = s.slice(0, -5);
  return s;
}

/** So khớp không phân biệt hoa thường (D3.2): cả hai phía lower trước khi so. */
export function isInScannedList(id: string, scannedIds: string[]): boolean {
  const key = id.toLowerCase();
  return scannedIds.some((x) => x.toLowerCase() === key);
}

/** Bỏ tiền tố provider khỏi id combo (vd groq/allam-2-7b → allam-2-7b). */
export function stripProviderPrefix(prefix: string, modelId: string): string {
  const lower = modelId.toLowerCase();
  const p = prefix.toLowerCase() + '/';
  return lower.startsWith(p) ? modelId.slice(p.length) : modelId;
}

/** Bỏ tiền tố models/ thừa của gemini (lặp lại: models/models/x → x). */
export function stripRedundantModelsPrefix(id: string): string {
  let s = id;
  while (s.toLowerCase().startsWith('models/')) s = s.slice(7);
  return s;
}

/**
 * Dựng URL GET /models/{id} DUY NHẤT cho cả control lẫn candidate (D2.1):
 * bỏ tiền tố provider, bỏ models/ thừa (gemini), mã hóa từng đoạn đường dẫn
 * (id có dấu / giữ đúng cấu trúc org/repo của host).
 */
export function buildModelProbeUrl(baseUrl: string, prefix: string, modelId: string): string {
  const bare = stripRedundantModelsPrefix(stripProviderPrefix(prefix, modelId));
  const encoded = bare.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/models/${encoded}`;
}

/** URL nguồn thứ hai của Hugging Face (D3.1). */
export function hfModelUrl(modelId: string): string {
  const encoded = modelId.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `https://huggingface.co/api/models/${encoded}?expand[]=inferenceProviderMapping`;
}

export function nearestLive(suspect: string, live: string[], n = 3): string[] {
  const key = normalizeKey(suspect);
  return live
    .map((id) => ({ id, d: levenshtein(key, normalizeKey(id)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.id);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export async function fetchOneModel(
  target: ProviderTarget,
  modelId: string,
  options: { fetchFn?: typeof globalThis.fetch; timeoutMs?: number } = {}
): Promise<{ status: number; error?: string; unsupported?: boolean }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!target.baseUrl) return { status: 0, error: 'no-base-url' };
  const url = buildModelProbeUrl(target.baseUrl, target.prefix, modelId);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (target.apiKey) headers['Authorization'] = `Bearer ${target.apiKey}`;
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) {
      // node-b (và một số gateway tương tự) trả 404 cho mọi GET /models/{id}
      // kể cả id đang sống, nên kết luận vắng mặt (hoặc sống) qua endpoint
      // đơn-model là không tin cậy ở đây. Danh sách quét mới là nguồn chân lý.
      const probeUnsupported = matchesUnsupportedSingleModelProbe(target);
      return { status: res.status, ...(probeUnsupported ? { unsupported: true } : {}) };
    }
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.name : 'fetch-failed' };
  }
}

function matchesUnsupportedSingleModelProbe(target: ProviderTarget): boolean {
  // Host của gateway không implement GET /models/{id}: api.node-b.example trả
  // 404 cho cả id đối chứng đang sống (đối chứng: id này có trong danh
  // sách quét, nhưng probe trả 404).
  const host = target.baseUrl ? new URL(target.baseUrl).hostname : '';
  return host.toLowerCase() === 'api.node-b.example';
}

export function verdictForStatus(status: number): ConfirmVerdict {
  // D1b (C3d): 404 là bằng chứng vắng mặt khi đối chứng 200 (node-b trả lời
  // 404 cho mọi GET /models/{id} đều phép.)
  if (status === 404) return 'CONFIRMED-ABSENT';
  if (status === 200) return 'STILL-EXISTS';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'QUOTA';
  return 'UNKNOWN';
}

export interface ConfirmOptions {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** (b) ba control dương tính — đều phải 200 mới tin kết quả âm. */
  controlIds?: string[];
  /** (a)+(c) id có trong danh sách quét r1/r2 + controls, để phát hiện PROBE-INVALID. */
  knownIds?: string[];
  /** Quét COMPLETE (hoặc trust-complete) — cần cho DROP-DEAD. */
  scanComplete?: boolean;
  /** Nguồn thứ hai đồng ý vắng. */
  secondSourceAbsent?: boolean;
}

export interface ConfirmResult {
  controlStatus: number;
  supported: boolean;
  probeInvalid: boolean;
  results: Array<{ id: string; status: number; verdict: ConfirmVerdict }>;
}

/**
 * Điều kiện hợp lệ (D2.2): (b) mọi control dương tính đều 200; (a) candidate
 * vắng cả r1+r2; (c) candidate trùng id quét/control mà 404 ⇒ PROBE-INVALID,
 * không có DROP-DEAD cho host đó.
 */
export async function confirmAbsent(
  target: ProviderTarget,
  ids: string[],
  controlId: string,
  options: ConfirmOptions = {}
): Promise<ConfirmResult> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  const capped = unique.slice(0, 30);
  const controls = (options.controlIds?.length ? options.controlIds : [controlId]).slice(0, 3);
  const controlStatuses: number[] = [];
  for (const c of controls) {
    const r = await fetchOneModel(target, c, options);
    controlStatuses.push(r.status);
  }
  const supported = controlStatuses.every((s) => s === 200);
  const controlStatus = controlStatuses[0] ?? 0;
  if (!supported) {
    return {
      controlStatus,
      supported: false,
      probeInvalid: false,
      results: capped.map((id) => ({ id, status: 0, verdict: 'UNSUPPORTED' as ConfirmVerdict })),
    };
  }
  const known = new Set((options.knownIds ?? [...controls]).map((x) => x.toLowerCase()));
  const results: ConfirmResult['results'] = [];
  let probeInvalid = false;
  for (const id of capped) {
    const r = await fetchOneModel(target, id, options);
    let verdict = verdictForStatus(r.status);
    // (c) trùng id quét/control mà 404 ⇒ host PROBE-INVALID.
    if (verdict === 'CONFIRMED-ABSENT' && known.has(stripProviderPrefix(target.prefix, id).toLowerCase())) {
      verdict = 'PROBE-INVALID';
      probeInvalid = true;
    }
    results.push({ id, status: r.status, verdict });
  }
  return { controlStatus, supported: true, probeInvalid, results };
}

/** Nguồn thứ hai Hugging Face (D3.1): existence qua /api/models/{id}. */
export async function fetchHfModelExists(
  modelId: string,
  options: { fetchFn?: typeof globalThis.fetch; timeoutMs?: number } = {}
): Promise<{ status: number; bodySample?: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchFn(hfModelUrl(modelId), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
    const text = res.status === 200 ? await res.text() : '';
    return { status: res.status, bodySample: text.slice(0, 200) };
  } catch {
    return { status: 0 };
  }
}

/** Nhãn gửi probe: status 0 khi control!=200 nghĩa là chưa gửi, không phải kết quả provider. */
export function confirmStatusLabel(status: number, supported: boolean): string {
  if (!supported) return 'NOT-SENT (control!=200)';
  if (status === 0) return 'NOT-SENT (fetch-failed)';
  return String(status);
}
export type ServedOutcome = 'STILL-SERVED' | 'NOT-SERVED-2-SOURCES' | 'UNKNOWN';
/** Chỉ khi cả hai nguồn cùng vắng mới NOT-SERVED-2-SOURCES (được sang DROP-CANDIDATE khi đủ grace + chủ duyệt). */
export function combineServedSources(v1: ConfirmVerdict | null, v2: ConfirmVerdict | null): ServedOutcome {
  if (v1 === 'STILL-EXISTS' || v2 === 'STILL-EXISTS') return 'STILL-SERVED';
  if (v1 === 'CONFIRMED-ABSENT' && v2 === 'CONFIRMED-ABSENT') return 'NOT-SERVED-2-SOURCES';
  return 'UNKNOWN';
}
/** Luật gỡ (D2.2): DROP-DEAD chỉ khi VERDICT=CONFIRMED-ABSENT + COMPLETE + controlsOk + secondSource.
 *  opts vắng ⇒ giữ luật cũ cho call-site/tưong thích (DROP-DEAD khi CONFIRMED-ABSENT,
 *  hoặc UNSUPPORTED+COMPLETE). Code mới phải truyền opts đầy đủ. */
export function dropDecision(
  verdict: ConfirmVerdict,
  scanCompleteness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN' | 'POSSIBLE-CAP',
  opts?: { controlsOk?: boolean; secondSourceAbsent?: boolean; probeInvalid?: boolean; possibleCap?: boolean }
): 'DROP-DEAD' | 'DROP-HOLD' {
  if (opts) {
    if (opts.probeInvalid) return 'DROP-HOLD';
    if (opts.possibleCap) return 'DROP-HOLD'; // ponytail: bỏ cờ khi count không phải số tròn nghi cap
    if (
      verdict === 'CONFIRMED-ABSENT' &&
      scanCompleteness === 'COMPLETE' &&
      opts.controlsOk === true &&
      opts.secondSourceAbsent === true
    ) {
      return 'DROP-DEAD';
    }
    return 'DROP-HOLD';
  }
  if (verdict === 'CONFIRMED-ABSENT') return 'DROP-DEAD';
  if (verdict === 'UNSUPPORTED' && scanCompleteness === 'COMPLETE') return 'DROP-DEAD';
  return 'DROP-HOLD';
}

/**
 * Quy tắc duy nhất COMPLETE vs HOLD (sinh bằng mã, không viết tay):
 *  - control GET /models/{id} != 200  → UNSUPPORTED, không kết luận nào.
 *  - COMPLETE chỉ khi: (a) tín hiệu hết trang rõ ràng, hoặc (b) provider thuộc
 *    trust-complete của chủ, hoặc (c) confirmAbsent đối chứng 200.
 *  - Còn lại (200 + JSON cấp 1 + modelCount>0 nhưng không tín hiệu phân trang)
 *    → UNKNOWN-NO-SIGNAL. Không tín hiệu ≠ hết trang.
 */
export type ScanCompleteness = 'COMPLETE' | 'POSSIBLE-CAP' | 'UNKNOWN-NO-SIGNAL' | 'UNSUPPORTED' | 'STABLE-UNCONFIRMED' | 'QUOTA' | 'NOT-SCANNED' | 'TRANSIENT-ERROR' | 'UNSTABLE';

/** ponytail: 100/200/500/1000 là cap phổ biến; ratio bytes/count bất thường cũng nghi. */
export const POSSIBLE_CAP_COUNTS: ReadonlySet<number> = new Set([100, 200, 500, 1000]);
export function isPossibleCap(count: number, bytes?: number | string | undefined): boolean {
  if (!Number.isFinite(count) || count <= 0) return false;
  if (POSSIBLE_CAP_COUNTS.has(count)) return true;
  const n = typeof bytes === 'string' ? Number(bytes.replace(/,/g, '')) : bytes;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    const ratio = n / count;
    if (ratio < 5 || ratio > 5000) return true;
  }
  return false;
}

export function scanCompleteness(input: {
  controlStatus: number;
  httpStatus: number;
  hasTopLevelJson: boolean;
  paginationExhausted: boolean;
  modelCount: number;
  trustComplete?: boolean;
  confirmContradicted?: boolean;
  bytes?: number | string | undefined;
}): ScanCompleteness {
  if (input.controlStatus === 429) return 'QUOTA';
  if (input.controlStatus !== 200) return 'UNSUPPORTED';
  if (input.confirmContradicted) return 'COMPLETE';
  if (input.trustComplete) return 'COMPLETE';
  // R1 (C3c): single-page / paginationExhausted alone is NOT COMPLETE.
  // COMPLETE requires registry trustComplete, confirmAbsent contradiction,
  // or owner trust-complete (all above). Otherwise stable-but-unconfirmed.
  if (input.httpStatus === 200 && input.hasTopLevelJson && input.modelCount > 0 && input.bytes !== undefined && isPossibleCap(input.modelCount, input.bytes)) {
    return 'POSSIBLE-CAP';
  }
  if (input.httpStatus === 200 && input.hasTopLevelJson && input.modelCount > 0) {
    return 'STABLE-UNCONFIRMED';
  }
  return 'UNKNOWN-NO-SIGNAL';
}

export interface ScanCompletenessRow {
  router: string; prefix: string; host: string; path: string; key: string;
  status: number; countR1: number; countR2: number; pagination: string; conclusion: ScanCompleteness;
  /** D4.1: các cột bổ sung; thiếu ⇒ in '(thiếu)' (không bịa). */
  bytes?: string | number;
  first3?: string;
  r1Time?: string;
  r2Time?: string;
  // C2b: đối chiếu đếm với mảng thô + lý do + control.
  rawCount?: number | undefined;
  reason?: string | undefined;
  controlStatus?: number | undefined;
}

/** Render SCAN-COMPLETENESS hoàn toàn từ dữ liệu quét thật. */
export function buildScanCompleteness(rows: ScanCompletenessRow[], notes: string[] = []): string {
  const lines: string[] = [];
  lines.push('ĐỘ ĐẦY ĐỦ QUÉT (SCAN-COMPLETENESS) — sinh bằng mã (không viết tay)');
  lines.push('Thời gian: ' + new Date().toISOString());
  lines.push('Quy tắc: control!=200→UNSUPPORTED; COMPLETE chỉ khi hết trang rõ ràng/trust-complete/confirmAbsent đối chứng 200; count tròn 100/200/500/1000 hoặc ratio bytes/count bất thường→POSSIBLE-CAP; ngược lại UNKNOWN-NO-SIGNAL.');
  lines.push('Bảng: router|prefix|host|đường dẫn|khóa|status|số r1|r2|bytes|băm tập id đã sắp xếp|giờ r1|giờ r2|tín hiệu phân trang|đếm==mảng thô|POSSIBLE-CAP|lý do|kết luận');
  for (const r of rows) {
    const keyLabel = r.key === '9router-key' ? (r.router === '9router' ? 'OWN-KEY (9router-key)' : 'BORROWED-KEY (9router-key muon)') : r.key === 'omniroute-key' ? 'omniroute-key' : r.key;
    const countMatch = r.rawCount === undefined || (r.rawCount === null)
      ? '(thiếu)'
      : (r.rawCount === r.countR1 && r.rawCount === r.countR2 ? 'PASS' : 'FAIL');
    const cap = r.conclusion === 'POSSIBLE-CAP' || isPossibleCap(r.countR1, r.bytes) ? 'POSSIBLE-CAP' : 'không';
    lines.push(
      `${r.router}|${r.prefix}|${r.host}|${r.path}|${keyLabel}|${r.status}|${r.countR1}|${r.countR2}|${r.bytes ?? '(thiếu)'}|${r.first3 ?? '(thiếu)'}|${r.r1Time ?? '(thiếu)'}|${r.r2Time ?? '(thiếu)'}|${r.pagination}|${countMatch}|${cap}|${r.reason ?? '(thiếu)'}|${r.conclusion}`
    );
  }
  for (const n of notes) lines.push(n);
  return lines.join('\n') + '\n';
}
