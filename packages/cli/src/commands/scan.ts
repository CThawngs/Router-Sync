/**
 * packages/cli/src/commands/scan.ts
 *
 * Implements `routersync scan` command.
 * Probes router health and reads current combo definitions.
 * `--completeness` mode: two-round zero-token scan with real
 * bytes/first3/r1Time/r2Time/rawCount columns (F2 fix).
 */

import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter, getRouterReadBackInfo } from '../adapters.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyModelTier, readRouterModelState } from '@routersync/core';
import { buildViews, loadCatalogCounts, type RouterView } from './sync/sync-plan.js';
import { scanAll, buildProviderLive, hashIdSet, type ScanMeta } from './sync/sync-scan.js';
import { buildScanCompleteness, scanCompleteness, quotaStatus, type ScanCompletenessRow } from '../sync/confirm.js';
import { skipReasonLabel } from '../sync/providers.js';

export interface ScanCommandOptions {
  configPath?: string;
  json?: boolean;
  completeness?: boolean;
  parity?: boolean;
  perNode?: boolean | string;
  delta?: boolean;
  scanGapMs?: number;
  catalogDir?: string;
}

function nowVN(): string {
  const d = new Date();
  const vn = new Date(d.getTime() + 7 * 3_600_000);
  return vn.toISOString().replace('Z', '+07:00');
}

/**
 * C3p P1: kết luận quét theo node tính từ 3 vòng thật.
 * ponytail: pure helper để unit test khóa cả hai nhánh; không giấu hàng.
 */
export function perNodeConclusion(roundIds: Array<readonly string[]>): {
  conclusion: 'STABLE-UNCONFIRMED' | 'UNSTABLE';
  diff: string[];
  stable: boolean;
} {
  const hashes = roundIds.map((ids) => hashIdSet(ids));
  const stable = hashes.every((h) => h === hashes[0]) && roundIds.every((ids) => ids.length === roundIds[0]?.length);
  const union = new Set(roundIds.flat());
  const inter = new Set(roundIds[0] ?? []);
  for (const ids of roundIds.slice(1)) for (const x of [...inter]) if (!ids.includes(x)) inter.delete(x);
  const diff = [...union].filter((x) => !inter.has(x)).sort().slice(0, 30);
  return { conclusion: stable ? 'STABLE-UNCONFIRMED' : 'UNSTABLE', diff, stable };
}

/** C3p P1: cùng host mà băm khác nhau trong cùng một vòng = HOST-LỆCH. */
export function hostSkewLines(pairs: Array<{ id: string; host: string; hash: string }>): string[] {
  const byHost = new Map<string, Map<string, string>>();
  for (const p of pairs) {
    const m = byHost.get(p.host) ?? new Map<string, string>();
    m.set(p.id, p.hash);
    byHost.set(p.host, m);
  }
  const lines: string[] = [];
  for (const [host, m] of [...byHost.entries()].sort()) {
    const hashes = new Set(m.values());
    if (hashes.size > 1) {
      lines.push(`HOST-LỆCH host=${host} pairs=${[...m.keys()].join(',')} hashes=${[...hashes].join(',')} conclusion=UNSTABLE`);
    }
  }
  return lines;
}

/** C3q Q1: co lại quá 10% so với catalog tốt mới nhất = SHRUNK-SUSPECT; tăng = GROWN. */
export function shrinkVerdict(oldN: number, newN: number): 'SHRUNK-SUSPECT' | 'GROWN' | 'SAME' {
  if (oldN > 0 && newN <= oldN * 0.9) return 'SHRUNK-SUSPECT';
  if (newN > oldN) return 'GROWN';
  return 'SAME';
}

/** C3q Q1: ghi anomaly vào .routersync-cache/anomalies/ và in dòng ANOMALY-LOG. */
function logAnomaly(pair: string, oldIds: readonly string[], newIds: readonly string[]): string {
  const dir = path.join(process.cwd(), '.routersync-cache', 'anomalies');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${pair.replace(/[^a-zA-Z0-9._-]/g, '_')}-${stamp}.json`);
  const lost = oldIds.filter((x) => !newIds.includes(x)).sort();
  const added = newIds.filter((x) => !oldIds.includes(x)).sort();
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pair, old: oldIds.length, nuevo: newIds.length, lost, added, verdict: shrinkVerdict(oldIds.length, newIds.length) }, null, 1), 'utf8');
  console.log(`ANOMALY-LOG tệp=${file} cặp=${pair} cũ=${oldIds.length} mới=${newIds.length}`);
  return file;
}

export async function runScanCommand(options: ScanCommandOptions): Promise<void> {
  if (options.perNode === true || (typeof options.perNode === 'string' && !options.perNode.trim())) {
    console.error('[routersync] Error: --per-node requires target parameter (e.g. --per-node <router:node> or comma-separated list).');
    console.error('Usage: routersync scan --per-node <router:node[,router:node...]>');
    process.exitCode = 2;
    return;
  }
  const { config, filePath } = loadConfigFile(options.configPath);
  if (options.delta) {
    // C3q Q1: so catalog mới nhất với catalog tốt (HTTP 200) mới nhất trong cache, theo cặp.
    const catalogDir = options.catalogDir ?? path.join(process.cwd(), '.routersync-cache', 'catalog');
    const byPair = new Map<string, Array<{ file: string; status: number; ids: string[] }>>();
    if (fs.existsSync(catalogDir)) {
      for (const f of fs.readdirSync(catalogDir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')) as { router: string; prefix: string; ids: string[]; status?: number };
          const key = `${j.router}:${j.prefix}`;
          const arr = byPair.get(key) ?? [];
          arr.push({ file: f, status: j.status ?? 200, ids: [...(j.ids ?? [])] });
          byPair.set(key, arr);
        } catch { /* skip */ }
      }
    }
    console.log('cặp | cũ | mới | thêm | mất | %');
    for (const key of [...byPair.keys()].sort()) {
      const arr = byPair.get(key)!;
      const nuevo = arr[arr.length - 1]!;
      // Cũ = catalog tốt mới nhất TRƯỚC file mới nhất (không tự so với chính nó);
      // mới nhất hỏng/không có catalog cũ hơn -> cũ = chính nó (SAME).
      const good = arr.slice(0, -1).reverse().find((e) => e.status === 200 && e.ids.length > 0) ?? nuevo;
      const oldIds = good.ids;
      const newIds = nuevo.ids;
      const added = newIds.filter((x) => !oldIds.includes(x)).sort();
      const lost = oldIds.filter((x) => !newIds.includes(x)).sort();
      const pct = oldIds.length ? Math.round(((newIds.length - oldIds.length) / oldIds.length) * 100) : 0;
      const verdict = shrinkVerdict(oldIds.length, newIds.length);
      console.log(`${key} | cũ=${oldIds.length} | mới=${newIds.length} | thêm=${added.length} | mất=${lost.length} | ${pct}% | ${verdict} | cũtừ=${good.file} mới_từ=${nuevo.file}`);
      if (key.endsWith(':node-b')) {
        console.log(`NODE-B-DIFF cũ=${oldIds.length} mới=${newIds.length} mất=${lost.length} thêm=${added.length}`);
        for (const id of lost.slice(0, 40)) console.log(`  - ${id}`);
        for (const id of added.slice(0, 40)) console.log(`  + ${id}`);
      }
      if (verdict === 'SHRUNK-SUSPECT' || verdict === 'GROWN') logAnomaly(key, oldIds, newIds);
    }
    return;
  }
  if (options.parity) {
    const { runScanJob } = await import('@routersync/daemon');
    const views = await buildViews(config, 'all');
    const metaOut: ScanMeta = new Map();
    const round = await scanAll(views, 1, 30_000, true, undefined, metaOut);
    const targets: Array<Parameters<typeof runScanJob>[0]['targets'][number]> = [];
    for (const view of views) {
      for (const target of view.targets) {
        targets.push({
          id: `${view.name}:${target.prefix}`,
          label: `${view.name}:${target.label}`,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          skipReason: target.skipReason,
        });
      }
    }
    const daemon = await runScanJob({
      targets,
      fetchModelList: async (t) => {
        const ids = round.get(t.id) ?? [];
        const status = t.skipReason ? 0 : (metaOut.get(t.id)?.status ?? 0);
        return { ok: status === 200, status, models: [...ids], latencyMs: 0 };
      },
    });
    const dById = new Map(daemon.providers.map((p) => [p.id, p]));
    console.log('cặp | CLI(status,n,băm16) | daemon(status,n,băm) | KHỚP/LỆCH');
    let match = 0;
    let total = 0;
    for (const view of views) {
      for (const target of view.targets) {
        const id = `${view.name}:${target.prefix}`;
        const cliIds = round.get(id) ?? [];
        const d = dById.get(id);
        const dIds = d ? (daemon.modelLists.get(id) ?? []) : [];
        const dStatus = d?.status ?? 0;
        const cliStatus = target.skipReason ? 0 : (metaOut.get(id)?.status ?? 0);
        const cliHash = hashIdSet(cliIds);
        const dHash = hashIdSet(dIds);
        total++;
        const ok = cliStatus === dStatus && cliIds.length === dIds.length && cliHash === dHash ? 'KHỚP' : 'LỆCH';
        if (ok === 'KHỚP') match++;
        console.log(`${id} | CLI(${cliStatus},${cliIds.length},${cliHash}) | daemon(${dStatus},${dIds.length},${dHash}) | ${ok}`);
      }
    }
    console.log(`KHỚP ${match}/${total}`);
    // C3p P1: nhóm theo host; cùng host băm khác = HOST-LỆCH (kết luận UNSTABLE cho các cặp đó).
    {
      const hostPairs: Array<{ id: string; host: string; hash: string }> = [];
      for (const view of views) {
        for (const target of view.targets) {
          if (target.skipReason) continue;
          const id = `${view.name}:${target.prefix}`;
          hostPairs.push({ id, host: target.baseUrl ? new URL(target.baseUrl).hostname : '(không có host)', hash: hashIdSet(round.get(id) ?? []) });
        }
      }
      const skew = hostSkewLines(hostPairs);
      if (skew.length) for (const l of skew) console.log(l);
      else console.log('HOST-KHỚP: không lệch băm theo host trong vòng parity này (xem --per-node 3 lần quét)');
    }
    // C3o O1(c): kế hoạch CLI vs daemon trên cùng snapshot (cùng nguồn DB).
    const { generatePlansForConfig, isPlanSuspect } = await import('./plan.js');
    const { buildDaemonPlan } = await import('./daemon.js');
    const { createHash } = await import('node:crypto');
    const cliPlans = await generatePlansForConfig(options.configPath);
    const daemonPlans = await buildDaemonPlan(options.configPath);
    console.log('router | CLI(COUNTS, planHash) | daemon(COUNTS, planHash) | KHỚP/LỆCH');
    let planMatch = 0;
    let planTotal = 0;
    for (const cp of cliPlans.results) {
      const dp = daemonPlans.find((d) => d.routerId === cp.routerId);
      const planHash = createHash('sha256')
        .update(JSON.stringify({ a: cp.plan.additions, m: cp.plan.modifications, d: cp.plan.deletions, r: cp.plan.reasons ?? {} }))
        .digest('hex').slice(0, 16);
      const suspect = isPlanSuspect(cp.totalSteps, cp.plan.deletions.length, cp.keepSteps);
      planTotal++;
      const ok = dp && dp.planHash === planHash ? 'KHỚP' : 'LỆCH';
      if (ok === 'KHỚP') planMatch++;
      console.log(`${cp.routerId} | CLI(add=${cp.plan.additions.length} remove=${cp.plan.deletions.length} keep=${cp.keepSteps} total=${cp.totalSteps} planHash=${planHash}${suspect ? ' PLAN-SUSPECT' : ''}) | daemon(${dp ? `${dp.counts} planHash=${dp.planHash}${dp.suspect ? ' PLAN-SUSPECT' : ''}` : 'missing'}) | ${ok}`);
    }
    console.log(`KHỚP ${planMatch}/${planTotal} kế hoạch`);
    return;
  }
  if (options.perNode) {
    // Custom per-node scan: 3 rounds >=60s apart per target node (Condition Z3).
    const rawTargets =
      typeof options.perNode === 'string' && options.perNode !== 'true'
        ? options.perNode
        : process.env['ROUTERSYNC_PER_NODE_TARGETS'];
    if (!rawTargets || !rawTargets.trim()) {
      console.error('[routersync] Error: --per-node requires target parameter (e.g. --per-node <router:node> or comma-separated list).');
      console.error('Usage: routersync scan --per-node <router:node[,router:node...]>');
      process.exitCode = 2;
      return;
    }
    const views = await buildViews(config, 'all');
    const want: Array<[string, string]> = rawTargets
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => {
        const idx = t.indexOf(':');
        return idx !== -1 ? [t.slice(0, idx), t.slice(idx + 1)] : ['9router', t];
      });
    // prefix match: exact or prefix with trailing dash.
    const matchPrefix = (tPrefix: string, p: string): boolean => tPrefix === p || tPrefix.startsWith(p + '-');
    const kept: RouterView[] = views.map((v) => ({
      ...v,
      targets: v.targets.filter((t) => want.some(([r, p]) => r === v.name && matchPrefix(t.prefix, p))),
    }));
    const keyFor = (router: string, prefix: string): string => {
      const view = views.find((v) => v.name === router);
      const t = view?.targets.find((x) => matchPrefix(x.prefix, prefix));
      return t ? `${router}:${t.prefix}` : `${router}:${prefix}`;
    };
    const roundMaps: Array<Map<string, string[]>> = [];
    const roundMetas: Array<ScanMeta> = [];
    const gapMs = Math.max(60_000, options.scanGapMs ?? 60_000);
    for (let round = 1; round <= 3; round++) {
      const meta: ScanMeta = new Map();
      roundMaps.push(await scanAll(kept, round, 30_000, true, undefined, meta));
      roundMetas.push(meta);
      if (round < 3) await new Promise((r) => setTimeout(r, gapMs));
    }
    console.log('node | r1=số-id/băm16/giờ | r2=số-id/băm16/giờ | r3=số-id/băm16/giờ | kết luận | hiệu đối xứng(tối đa 30 id)');
    const rows: string[] = [];
    let stableCount = 0;
    for (const [router, prefix] of want) {
      const key = keyFor(router, prefix);
      const fmt = (i: number): string => {
        const ids = roundMaps[i]?.get(key) ?? [];
        const at = roundMetas[i]?.get(key)?.at ?? '-';
        const hh = /T(\d{2}:\d{2}:\d{2})/.exec(at)?.[1] ?? at.slice(11, 19);
        return `${ids.length}/${hashIdSet(ids)}/${hh}`;
      };
      const perRound = [0, 1, 2].map((i) => (roundMaps[i]?.get(key) ?? []).slice());
      const c = perNodeConclusion(perRound);
      if (c.stable) stableCount++;
      rows.push(`${router}:${prefix} | ${fmt(0)} | ${fmt(1)} | ${fmt(2)} | ${c.conclusion} | ${c.diff.join(',') || '-'}`);
    }
    for (const r of rows) console.log(r);
    // C3q Q1: node-b bất ổn định thì ghi anomaly (old=r1, new=r3)
    for (const [router, prefix] of want) {
      if (prefix !== 'node-b') continue;
      const key = keyFor(router, prefix);
      const c = perNodeConclusion([0, 1, 2].map((i) => (roundMaps[i]?.get(key) ?? []).slice()));
      if (!c.stable) logAnomaly(key, roundMaps[0]?.get(key) ?? [], roundMaps[2]?.get(key) ?? []);
    }
    // Số hàng in phải bằng số node xét (5); lệch thì báo THIẾU-HÀNG.
    const examined = want.length;
    if (rows.length !== examined) console.log(`THIẾU-HÀNG ${examined - rows.length}`);
    console.log(`ổn định ${stableCount}/${rows.length}`);
    return;
  }
  if (options.completeness) {
    const views = await buildViews(config, 'all');
    const catalog = loadCatalogCounts();
    // Two rounds, gap >=60s between them (zero-token GETs, no LLM calls).
    const meta1: ScanMeta = new Map();
    const meta2: ScanMeta = new Map();
    const incomplete1 = new Set<string>();
    const incomplete2 = new Set<string>();
    const round1 = await scanAll(views, 1, 30_000, true, incomplete1, meta1);
    const gapMs = Math.max(60_000, options.scanGapMs ?? 60_000);
    await new Promise((r) => setTimeout(r, gapMs));
    const round2 = await scanAll(views, 2, 30_000, true, incomplete2, meta2);
    buildProviderLive(views, round1, round2, catalog, new Set<string>([...incomplete1, ...incomplete2]));
    // D3: persist sorted id catalog per (router, prefix, scan-id) + set hash.
    const scanId = new Date().toISOString().replace(/[:.]/g, '-');
    const catalogDir = options.catalogDir ?? path.join(process.cwd(), '.routersync-cache', 'catalog');
    if (!fs.existsSync(catalogDir)) fs.mkdirSync(catalogDir, { recursive: true });
    for (const view of views) {
      for (const target of view.targets) {
        if (target.skipReason) continue;
        const key = `${view.name}:${target.prefix}`;
        const ids = (round2.get(key) ?? []).slice().sort();
        // K2c: persist the HTTP conclusion alongside ids so STEP-EXISTS can
        // refuse EXISTS-IN-SCAN from a stale/failed scan of the same pair.
        const status = meta2.get(key)?.status ?? meta1.get(key)?.status ?? 0;
        // C3r R3a: cặp 429 (ids rỗng) vẫn lưu catalog status-only để
        // health/COVERAGE dùng cùng nguồn sự thật (QUOTA, không chưa-quét).
        if (!ids.length && status !== 429) continue;
        // C3m M1: khóa catalog theo (router,node/prefix), không theo host dùng chung.
        const payload = JSON.stringify({ scanId, router: view.name, node: target.prefix, prefix: target.prefix, keySource: target.keySource, status, hash: hashIdSet(ids), count: ids.length, ids }, null, 1);
        // C3r R1c: anomaly lúc LƯU (không chỉ --delta): file mới co hơn file
        // mới nhất trước đó cùng cặp thì ghi anomalies/ ngay + in ANOMALY-AUTO.
        try {
          const prev = fs.readdirSync(catalogDir)
            .filter((f) => f.startsWith(`${view.name}-${target.prefix}-`) && f.endsWith('.json'))
            .sort().pop();
          if (prev) {
            const pj = JSON.parse(fs.readFileSync(path.join(catalogDir, prev), 'utf8')) as { ids?: string[] };
            const oldN = (pj.ids ?? []).length;
            if (ids.length < oldN) {
              const adir = path.join(path.dirname(catalogDir), 'anomalies');
              if (!fs.existsSync(adir)) fs.mkdirSync(adir, { recursive: true });
              const afile = path.join(adir, `${view.name}-${target.prefix}-${scanId}.json`);
              fs.writeFileSync(afile, JSON.stringify({ at: new Date().toISOString(), pair: key, old: oldN, nuevo: ids.length }, null, 1), 'utf8');
              console.log(`ANOMALY-AUTO tệp=${afile} cặp=${key} cũ=${oldN} mới=${ids.length} lúc-lưu`);
            }
          }
        } catch { /* bỏ qua lỗi ghi anomaly */ }
        fs.writeFileSync(path.join(catalogDir, `${view.name}-${target.prefix}-${scanId}.json`), payload, 'utf8');
      }
    }
    const rows: ScanCompletenessRow[] = [];
    for (const view of views) {
      for (const target of view.targets) {
        const key = `${view.name}:${target.prefix}`;
        const host = target.baseUrl ? new URL(target.baseUrl).hostname : '(không có host)';
        const path2 = target.baseUrl ? new URL(target.baseUrl).pathname : '/models';
        const m1 = meta1.get(key);
        const m2 = meta2.get(key);
        const unsent = target.skipReason !== undefined;
        const countR1 = round1.get(key)?.length ?? 0;
        const countR2 = round2.get(key)?.length ?? 0;
        const status = unsent ? 0 : (m2?.status ?? m1?.status ?? 0);
        const rawCount = m1?.rawCount ?? 0;
        const bytes = m1?.bytes ?? 0;
        rows.push({
          router: view.name,
          prefix: target.prefix,
          host,
          path: path2,
          key: target.keySource === 'none' ? 'none' : target.keySource,
          status,
          countR1,
          countR2,
          pagination: incomplete2.has(key) || incomplete1.has(key) ? 'multi-page-incomplete' : 'single-page',
          // C3m M1: UNSUPPORTED chỉ cho 404/405/400; lỗi mạng sau retry = TRANSIENT-ERROR; r1-ok/r2-fail = UNSTABLE.
          conclusion: (unsent ? 'NOT-SCANNED' : quotaStatus(status) ? 'QUOTA' : [404, 405, 400].includes(status) ? 'UNSUPPORTED' : (m2?.errorClass || m1?.errorClass) ? 'TRANSIENT-ERROR' : status === 0 ? 'TRANSIENT-ERROR' : status !== 200 ? 'UNKNOWN-NO-SIGNAL' : (m1?.status === 200 && m2?.status !== 200 ? 'UNSTABLE' : scanCompleteness({ controlStatus: status, httpStatus: status, hasTopLevelJson: true, paginationExhausted: !incomplete1.has(key) && !incomplete2.has(key), modelCount: rawCount, bytes, trustComplete: false }))) as ScanCompletenessRow['conclusion'],
          first3: hashIdSet(countR2 ? round2.get(key) ?? round1.get(key) ?? [] : round1.get(key) ?? []),
          rawCount,
          bytes,
          r1Time: m1?.at ?? '-',
          r2Time: m2?.at ?? '-',
          reason: unsent ? skipReasonLabel(target.skipReason!) : status === 200 ? 'OK: 200, quét trực tiếp từ host của provider' : `HTTP ${status} từ host của provider`,
          controlStatus: status,
        });
      }
    }
    const text = buildScanCompleteness(rows, []);
    if (options.json) {
      console.log(JSON.stringify({ rows }, null, 2));
    } else {
      console.log(text);
    }
    return;
  }

  const results: Array<{
    id: string;
    adapter: string;
    validated: boolean;
    health: { ok: boolean; status: string; latencyMs?: number | undefined; message?: string | undefined };
    readBackLevel: 'full' | 'existence-only' | 'db-only (degraded)';
    degradedReason?: string | undefined;
    comboCount: number;
    modelsCount: number;
    tiers?: {
      A: number;
      B: number;
      C: number;
      total: number;
    } | undefined;
  }> = [];

  for (const router of config.routers) {
    const adapter = createAdapterForRouter(router);
    const health = await adapter.checkHealth();
    const readBackInfo = getRouterReadBackInfo(router);

    let comboCount = 0;
    let modelsCount = 0;
    let tierA = 0;
    let tierB = 0;
    let tierC = 0;

    try {
      const combos = await adapter.readCombos();
      comboCount = combos.length;
      const catalog = await adapter.readCatalog();
      modelsCount = catalog.length;

      const comboModelSet = new Set<string>();
      for (const cb of combos) {
        for (const m of cb.models) {
          comboModelSet.add(m);
        }
      }

      const routerState = readRouterModelState(router.adapter, {
        dbPath: router.db?.path,
        comboModels: comboModelSet,
      });

      for (const m of catalog) {
        const isDeadOrQuarantined = m.status === 'dead' || m.status === 'quarantined';
        const classification = routerState.classify(m.provider || '', m.id);
        let tier = classification.tier;
        if (isDeadOrQuarantined) {
          tier = 'B';
        } else if (tier === 'UNKNOWN' && (classification.inCombo || m.status === 'active')) {
          tier = 'A';
        }
        if (tier === 'A') tierA++;
        else if (tier === 'B') tierB++;
        else tierC++;
      }
      if (tierA === 0 && comboModelSet.size > 0) {
        tierA = comboModelSet.size;
      }
    } catch {
      // Non-fatal if DB not yet initialized
    }

    const isLiveHealthy = health.ok && health.status !== 'down';
    const readBackLevel: 'full' | 'existence-only' | 'db-only (degraded)' = isLiveHealthy
      ? readBackInfo.level
      : 'db-only (degraded)';

    const degradedReason = isLiveHealthy
      ? readBackInfo.reason
      : `Router API unreachable (${health.message || health.status}) - serving path unconfirmed, degraded to db-only`;

    results.push({
      id: router.id,
      adapter: router.adapter,
      validated: Boolean(router.validated),
      health: {
        ok: health.ok,
        status: health.status,
        latencyMs: health.latencyMs,
        message: health.message,
      },
      readBackLevel,
      degradedReason,
      comboCount,
      modelsCount,
      tiers: {
        A: tierA,
        B: tierB,
        C: tierC,
        total: tierA + tierB + tierC,
      },
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, configFile: filePath, routers: results }, null, 2));
  } else {
    console.log(`[routersync] Scanned ${config.routers.length} router(s) from ${filePath}:`);
    for (const r of results) {
      const statusSymbol = r.health.ok ? '✓' : '✗';
      console.log(
        `  ${statusSymbol} [${r.id}] (${r.adapter}) - Status: ${r.health.status} (${r.health.latencyMs ?? 0}ms) | Read-Back: ${r.readBackLevel} | Combos: ${r.comboCount} | Models: ${r.modelsCount}`
      );
      if (r.degradedReason) {
        console.log(`      Read-Back Info: ${r.degradedReason}`);
      }
      if (r.health.message) {
        console.log(`      Detail: ${r.health.message}`);
      }
    }
  }
}
