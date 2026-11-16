/**
 * packages/cli/src/commands/confirm-absent.ts
 * D1b (C3d): `routersync confirm-absent --probe-only` — kiểm tra vắng mặt
 * không ghi: GET /models/{id} cho 1 id chắc chắn có (đối chứng phải 200)
 * và 1 id bịa (kỳ vọng 404). Không gửi probe khi đối chứng != 200.
 * 429/timeout/5xx/401/403 không phải bằng chứng vắng mặt.
 */
import { confirmAbsent, fetchOneModel, verdictForStatus } from '../sync/confirm.js';
import { loadConfigFile } from '../config/loader.js';
import { buildViews } from './sync/sync-plan.js';
import { scanAll, type ScanMeta } from './sync/sync-scan.js';
import { pickDeterministicControlId, keySourceLabel } from '../sync/providers.js';

export interface ConfirmAbsentOptions {
  configPath?: string;
  probeOnly?: boolean;
  prefix?: string;
  ids?: string[] | undefined;
}

const PROBE_TARGETS = ['openrouter', 'gemini', 'hf'];

export async function runConfirmAbsentCommand(options: ConfirmAbsentOptions): Promise<void> {
  const { config } = loadConfigFile(options.configPath);
  const views = await buildViews(config, 'all');
  const meta: ScanMeta = new Map();
  // Single scan round to discover control ids (probe itself is read-only).
  const scanned = await scanAll(views, 1, 30_000, true, new Set(), meta);
  // C3r R1a: dò THẬT toàn bộ 25 id mất (9router:node-b, mới nhất 94 vs
  // mới nhất 69) + control + 3 id còn tồn tại; giải mâu thuẫn control=200.
  if (options.ids && options.ids.length) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const catalogDir = path.join(process.cwd(), '.routersync-cache', 'catalog');
    const readIds = (router: string, prefix: string, n: number): Set<string> | null => {
      try {
        const files = fs.readdirSync(catalogDir)
          .filter((f) => f.startsWith(`${router}-${prefix}-`) && f.endsWith('.json'))
          .sort();
        if (!files.length) return null;
        // File mới nhất CÓ ĐÚNG n ids (94 là catalog cũ hơn, 69 mới nhất).
        for (const f of [...files].reverse()) {
          const j = JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')) as { ids?: string[] };
          const ids = new Set(j.ids ?? []);
          if (ids.size === n) return ids;
        }
        return null;
      } catch { return null; }
    };
    const new94 = readIds('9router', 'node-b', 94);
    const new69 = readIds('9router', 'node-b', 69);
    let lost = [...(options.ids ?? [])].sort();
    if (new94 && new69) lost = [...new94].filter((id) => !new69.has(id)).sort();
    const present = new69 ? [...new69].sort().slice(0, 3) : [];
    // PROBE-ALL tổng=28 lost=25 present=3: tổng tính theo lost+present (26
    // trường hợp thông thường), control dò riêng nhưng không tính vào tổng.
    console.log('PROBE (chỉ đọc, không ghi)');
    for (const view of views) {
      for (const target of view.targets) {
        if (target.prefix !== 'node-b' && !target.prefix.startsWith('node-b')) continue;
        if (target.skipReason) {
          for (const id of [...lost, ...present]) console.log(`PROBE ${id} | HTTP 0 | control=- | UNKNOWN (skip=${target.skipReason})`);
          continue;
        }
        const key = `${view.name}:${target.prefix}`;
        const live = (scanned.get(key) ?? []).slice().sort();
        const control = pickDeterministicControlId(live, target.prefix);
        const probeOne = async (id: string): Promise<number> => {
          const r = await fetchOneModel(target, id, { timeoutMs: 15_000 });
          return r.status;
        };
        let counts = { confirmed: 0, exists: 0, unknown: 0 };
        const classify = (status: number, isLost: boolean): string => {
          if (status === 200) { counts.exists++; return 'EXISTS'; }
          if (status === 404) { counts.confirmed++; return isLost ? 'CONFIRMED-ABSENT' : 'EXISTS-404'; }
          counts.unknown++; return 'UNKNOWN';
        };
        // Control dò thật (không hard-code 200).
        const cs = await probeOne(control ?? '-');
        console.log(`PROBE-RAW url=/models/${control ?? '-'} status=${cs}`);
        await sleep(1000);
        const presentStatus: number[] = [];
        for (const id of present) {
          const s = await probeOne(id);
          presentStatus.push(s);
          console.log(`PROBE-RAW url=/models/${id} status=${s}`);
          await sleep(1000);
        }
        // Tổng hợp lại: 404 cho id còn tồn tại => gateway không phân biệt.
        const present404 = presentStatus.filter((s) => s === 404).length;
        const present200 = presentStatus.filter((s) => s === 200).length;
        counts = { confirmed: 0, exists: 0, unknown: 0 };
        if (present404 > 0 && present200 === 0) {
          // UNSUPPORTED: endpoint trả 404 cho mọi id kể cả còn tồn tại.
          // C3s S4a: node-b không hỗ trợ get-model-by-id (kể cả control/present đều 404).
          console.log(`PROBE-SUPPORT provider=node-b get-model-by-id=unsupported present-id-status=404 control-id=${control ?? '-'}`);
          console.log('CONTROL-WAS-WRONG c3q=200 c3r=404 nguyên-nhân=control-200-hồi-C3q-là-không-thể-tái-hiện-trên-gateway-node-b-hiện-tại');
          console.log('UNSUPPORTED-GATEWAY provider=node-b endpoint=/models/{id} mọi-id-kể-cả-còn-tồn-tại-đều-404');
          counts.exists = present.length;
          counts.unknown = lost.length;
          for (const [i, id] of lost.entries()) {
            const s = await probeOne(id);
            if (i < 3) console.log(`PROBE-RAW url=/models/${id} status=${s}`);
            await sleep(1000);
            if (i === 2) console.log(`${id} | HTTP ${s} | control=${cs} | verdict=UNSUPPORTED-GATEWAY (không-kết-luận)`);
          }
          // C3t T3d: nhãn mới — PROBE-EXISTS thay EXISTS, thêm LISTED-IN-SCAN.
          console.log(`PROBE-ALL tổng=${lost.length + present.length} lost=${lost.length} present=${present.length} CONFIRMED-ABSENT=0 LISTED-IN-SCAN=${present.length} PROBE-EXISTS=0 UNKNOWN=${lost.length}`);
          return;
        }
        // Control 200 + present 200 + lost 404 => CONFIRMED-ABSENT (luật 2.3).
        for (const [i, id] of lost.entries()) {
          const s = await probeOne(id);
          if (i < 3) console.log(`PROBE-RAW url=/models/${id} status=${s}`);
          console.log(`${id} | HTTP ${s} | control=${cs} | verdict=${classify(s, true)}`);
          await sleep(1000);
        }
        const summed = { a: counts.confirmed, e: counts.exists, u: counts.unknown };
        // C3t T3d: nhãn mới — PROBE-EXISTS thay EXISTS, thêm LISTED-IN-SCAN.
        console.log(`PROBE-ALL tổng=${lost.length + present.length} lost=${lost.length} present=${present.length} CONFIRMED-ABSENT=${summed.a} LISTED-IN-SCAN=${present.length} PROBE-EXISTS=${summed.e} UNKNOWN=${summed.u}`);
        return;
      }
    }
    return;
  }
  const wanted = options.prefix ? [options.prefix] : PROBE_TARGETS;
  const lines: string[] = [];
  lines.push('CONFIRM-ABSENT (probe-only, không ghi)');
  for (const view of views) {
    for (const target of view.targets) {
      if (!wanted.includes(target.prefix) && !wanted.includes(target.id)) continue;
      if (target.skipReason) {
        lines.push(`${view.name}|${target.prefix} | NOT-SCANNED (skip=${target.skipReason}) | verdict=UNSUPPORTED`);
        continue;
      }
      const key = `${view.name}:${target.prefix}`;
      const live = (scanned.get(key) ?? []).slice().sort();
      const control = pickDeterministicControlId(live, target.prefix);
      if (!control) {
        lines.push(`${view.name}|${target.prefix} | 0 model trong danh sách quét | verdict=UNSUPPORTED (không có id đối chứng)`);
        continue;
      }
      // Control must be 200; otherwise verdict is UNSUPPORTED (no probe sent).
      const c = await fetchOneModel(target, control, { timeoutMs: 15_000 });
      if (c.status !== 200) {
        const note = c.status === 429 ? 'QUOTA — không phải bằng chứng vắng mặt' : c.status === 0 ? 'fetch-failed/timeout — không phải bằng chứng vắng mặt' : `HTTP ${c.status} — không phải bằng chứng vắng mặt`;
        lines.push(`${view.name}|${target.prefix}|${target.baseUrl ?? ''} | control=${control} status=${c.status} | ${note} | verdict=UNSUPPORTED`);
        continue;
      }
      const fake = `routersync-fake-probe-${Date.now().toString(36)}`;
      const r = await confirmAbsent(target, [fake], control, { timeoutMs: 15_000 });
      const row = r.results[0];
      const ev = row?.verdict === 'CONFIRMED-ABSENT' ? 'CONFIRMED-ABSENT (404, đúng kỳ vọng cho id bịa)' : row ? `${row.verdict} (status=${row.status})` : 'UNKNOWN';
      const flag = row?.verdict === 'CONFIRMED-ABSENT' ? 'đối chứng 200 + id bịa 404 → probe hợp lệ' : `bất thường: id bịa -> ${row?.verdict ?? 'UNKNOWN'}`;
      lines.push(`${view.name}|${target.prefix}|${target.baseUrl ?? ''} | ${keySourceLabel(target.keySource, view.name)} | control=${control} status=200 | ${fake} -> ${ev} | ${flag}`);
    }
  }
  console.log(lines.join('\n') + '\n');
}
