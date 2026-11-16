/**
 * packages/cli/src/commands/diff.ts
 * D3 (C3d): `routersync diff` — so sánh danh mục quét mới nhất vs lần trước.
 * Chỉ in NEW / GONE-UNCONFIRMED, không đề xuất gỡ.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashIdSet } from './sync/sync-scan.js';

export interface DiffOptions { catalogDir?: string | undefined; }

export function loadCatalogs(catalogDir: string): Map<string, Array<{ file: string; scanId: string; hash: string; ids: string[] }>> {
  const out = new Map<string, Array<{ file: string; scanId: string; hash: string; ids: string[] }>>();
  if (!fs.existsSync(catalogDir)) return out;
  for (const f of fs.readdirSync(catalogDir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')) as { router: string; prefix: string; scanId: string; ids: string[] };
      const k = `${j.router}:${j.prefix}`;
      const arr = out.get(k) ?? [];
      arr.push({ file: f, scanId: j.scanId, hash: hashIdSet(j.ids), ids: [...j.ids].sort() });
      out.set(k, arr);
    } catch { /* skip bad */ }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.scanId.localeCompare(b.scanId));
  return out;
}

export async function runDiffCommand(options: DiffOptions = {}): Promise<void> {
  const dir = options.catalogDir ?? path.join(process.cwd(), '.routersync-cache', 'catalog');
  const maps = loadCatalogs(dir);
  const lines: string[] = ['DIFF danh mục quét (NEW / GONE-UNCONFIRMED, không đề xuất gỡ)'];
  if (maps.size === 0) { console.log(lines.join('\n') + '\ncatalog rỗng: chưa đủ 2 lần quét\n'); return; }
  for (const [k, arr] of [...maps.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (arr.length < 2) { lines.push(`${k} | chưa đủ 2 lần quét (đã có ${arr.length})`); continue; }
    const prev = arr[arr.length - 2]!;
    const cur = arr[arr.length - 1]!;
    const pset = new Set(prev.ids);
    const cset = new Set(cur.ids);
    const added = cur.ids.filter((i) => !pset.has(i)).sort();
    const gone = prev.ids.filter((i) => !cset.has(i)).sort();
    lines.push(`${k} | hash ${prev.hash} -> ${cur.hash} | ${added.length === 0 && gone.length === 0 ? 'rỗng-diff' : `NEW=${added.length} GONE-UNCONFIRMED=${gone.length}`}`);
    for (const i of added) lines.push(`NEW ${k} ${i}`);
    for (const i of gone) lines.push(`GONE-UNCONFIRMED ${k} ${i}`);
  }
  console.log(lines.join('\n') + '\n');
}
