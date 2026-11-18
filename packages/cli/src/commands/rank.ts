/**
 * packages/cli/src/commands/rank.ts
 *
 * Handler for `routersync rank`.
 * Evaluates, scores, and reorders models in combos using:
 * - Deterministic gating filters (blacklist, non-chat, price-gate with zero-payment providers)
 * - Strict Lexicographic Priority-Order Comparator (Policy §8.4)
 * - Dynamic Tier Assignment from config
 * - Provider Interleaving on Tail (D1)
 * - Invariant I3 verification (>= 2 steps)
 * - Test combo exclusion (excludeCombos)
 *
 * PREVIEW-ONLY: Never writes to router databases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';
import { loadConfigFile } from '../config/loader.js';
import { buildViews, printTargets, type RouterView } from './sync/sync-plan.js';
import { scanAll } from './sync/sync-scan.js';
import { confirm, writeLastApplied, writeLastSync, type LastSyncRecord } from './sync/sync-state.js';
import { loadRankingConfig } from '../rank/config.js';
import { rankComboModels, isComboExcluded } from '../rank/ranker.js';
import type { ComboRankResult, RankingConfig } from '../rank/types.js';
import { isLowResource } from '../low-resource.js';
import {
  readComboModels,
  readCombosWithDetails,
  backupRouterDb,
  tableFence,
  applyStepReordering,
  assertWriteTargetMatchesPlan,
  grantLiveWriteToken,
  type RouterName,
  type ComboReorderChange,
} from '../sync/write.js';

export interface RankCommandOptions {
  router?: string | undefined;
  config?: string | undefined;
  json?: boolean | undefined;
  full?: boolean | undefined;
  out?: string | undefined;
  dryRun?: boolean | undefined;
  apply?: boolean | undefined;
  scanGapMs?: number | undefined;
  timeoutMs?: number | undefined;
  scan?: boolean | undefined;
  writeOutputs?: boolean | undefined;
  outputDir?: string | undefined;
  maxShrinkRatio?: number | undefined;
}

export function formatClassifyOutput(results: ComboRankResult[]): string {
  const lines: string[] = [];
  lines.push('ROUTERSYNC MODEL CLASSIFICATION REPORT (CLASSIFY.txt)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('='.repeat(100));
  lines.push(
    [
      'ROUTER'.padEnd(10),
      'COMBO'.padEnd(20),
      'STATUS'.padEnd(10),
      'TIER'.padEnd(10),
      'PRICE'.padEnd(18),
      'PROVIDER'.padEnd(15),
      'MODEL ID',
    ].join(' | ')
  );
  lines.push('-'.repeat(100));

  for (const res of results) {
    // Ranked models
    for (const m of res.rankedModels) {
      const tierStr = m.tier === 99 ? 'UNRATED' : `Tier ${m.tier}`;
      lines.push(
        [
          res.routerId.padEnd(10),
          res.comboName.slice(0, 20).padEnd(20),
          'RETAINED'.padEnd(10),
          tierStr.padEnd(10),
          m.priceStatus.padEnd(18),
          m.provider.slice(0, 15).padEnd(15),
          m.id,
        ].join(' | ')
      );
    }
    // Dropped models
    for (const m of res.droppedModels) {
      lines.push(
        [
          res.routerId.padEnd(10),
          res.comboName.slice(0, 20).padEnd(20),
          `DROPPED`.padEnd(10),
          `DROP:${m.dropReason ?? 'unknown'}`.padEnd(10),
          m.priceStatus.padEnd(18),
          m.provider.slice(0, 15).padEnd(15),
          m.id,
        ].join(' | ')
      );
    }
  }

  lines.push('='.repeat(100));
  return lines.join('\n') + '\n';
}

export function formatUnratedOutput(results: ComboRankResult[]): string {
  const lines: string[] = [];
  lines.push('ROUTERSYNC UNRATED MODELS AUDIT (UNRATED.txt)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Policy: Models falling into Tier 99 (UNRATED) have no matching tier pattern in configuration.');
  lines.push('='.repeat(80));

  const unratedMap = new Map<string, { provider: string; combos: Set<string> }>();

  for (const res of results) {
    for (const m of res.rankedModels) {
      if (m.tier === 99) {
        if (!unratedMap.has(m.id)) {
          unratedMap.set(m.id, { provider: m.provider, combos: new Set() });
        }
        unratedMap.get(m.id)!.combos.add(`${res.routerId}:${res.comboName}`);
      }
    }
  }

  lines.push(`Total Unique Unrated Models: ${unratedMap.size}`);
  lines.push('-'.repeat(80));

  for (const [id, info] of Array.from(unratedMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- Model: ${id}`);
    lines.push(`  Provider: ${info.provider}`);
    lines.push(`  Present in combos: ${Array.from(info.combos).join(', ')}`);
  }

  lines.push('='.repeat(80));
  return lines.join('\n') + '\n';
}

export function formatRankPreviewOutput(results: ComboRankResult[], config: RankingConfig): string {
  const lines: string[] = [];
  lines.push('ROUTERSYNC RANKING PREVIEW (RANK-PREVIEW.txt)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Mode: PREVIEW-ONLY (No database mutations)');
  lines.push('Active Tiers in Config: ' + (Object.keys(config.tierRules).join(', ') || '(neutral - none)'));
  lines.push('='.repeat(80));

  let totalLostProviders = 0;

  for (const res of results) {
    lines.push(`\n[${res.routerId.toUpperCase()}] Combo: ${res.comboName}`);
    lines.push(`  Steps count: ${res.originalCount} -> ${res.retainedCount} (Dropped: ${res.droppedCount})`);
    lines.push(`  Position changes count: ${res.positionChangesCount}`);
    lines.push(`  Lost providers: ${res.lostProviders.length > 0 ? res.lostProviders.join(', ') : 'None (0)'}`);
    totalLostProviders += res.lostProviders.length;

    lines.push('  Top 15 Steps Before:');
    for (let i = 0; i < Math.min(15, res.top15Before.length); i++) {
      lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${res.top15Before[i]}`);
    }

    lines.push('  Top 15 Steps After (Proposed):');
    for (let i = 0; i < Math.min(15, res.top15After.length); i++) {
      const item = res.rankedModels[i];
      const tierTag = item ? (item.tier === 99 ? '[UNRATED]' : `[Tier ${item.tier}]`) : '';
      lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${tierTag} ${res.top15After[i]}`);
    }

    const beforeCov = Object.entries(res.coverageBefore)
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => `${p}:${c}`)
      .join(', ');
    const afterCov = Object.entries(res.coverageAfter)
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => `${p}:${c}`)
      .join(', ');

    lines.push(`  Coverage Before: ${beforeCov}`);
    lines.push(`  Coverage After:  ${afterCov}`);
  }

  lines.push('\n' + '='.repeat(80));
  lines.push(`TOTAL LOST PROVIDERS ACROSS ALL COMBOS: ${totalLostProviders}`);
  lines.push('='.repeat(80));
  return lines.join('\n') + '\n';
}

function stableRankPlanHash(results: ComboRankResult[], config: RankingConfig): string {
  return createHash('sha256').update(JSON.stringify({
    configVersion: config.version,
    results: results.map((r) => ({
      routerId: r.routerId,
      comboName: r.comboName,
      originalCount: r.originalCount,
      retainedCount: r.retainedCount,
      droppedCount: r.droppedCount,
      positionChangesCount: r.positionChangesCount,
      top15After: r.top15After,
    })),
  })).digest('hex').slice(0, 16);
}

/**
 * The database path of one router, resolved the SAME way the read/plan path
 * resolves it (C4n/N5).
 *
 * `locateRouterDb` now consults the configured paths installed from
 * `config.yaml`, so the strategy and the health figure below are read from the
 * same file the plan was computed from and the apply writes to.
 */
function routerDbPath(router: '9router' | 'omniroute'): string {
  return locateRouterDb(router);
}

function load9RouterStrategies(): Map<string, { strategy: string; isRoundRobin: boolean }> {
  const map = new Map<string, { strategy: string; isRoundRobin: boolean }>();
  try {
    const db = openBetterSqlite3(routerDbPath('9router'), { readOnly: true, busyTimeoutMs: 5000 });
    try {
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data?: string } | undefined;
      if (row?.data) {
        const parsed = JSON.parse(row.data) as { comboStrategies?: Record<string, { fallbackStrategy?: string }> };
        if (parsed.comboStrategies && typeof parsed.comboStrategies === 'object') {
          for (const [name, val] of Object.entries(parsed.comboStrategies)) {
            const strat = val?.fallbackStrategy ?? 'fallback';
            map.set(name, { strategy: strat, isRoundRobin: strat === 'round-robin' });
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // ignore
  }
  return map;
}

export function compute7DayHealthFromDb(
  db: { prepare(sql: string): { get(...args: any[]): any; all(...args: any[]): any[] } },
  router: '9router' | 'omniroute'
): string {
  const tableName = router === '9router' ? 'usageHistory' : 'call_logs';
  try {
    const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string; type: string }>;
    if (!cols || cols.length === 0) return 'UNKNOWN';
    if (!cols.some(c => c.name === 'timestamp')) return 'UNKNOWN';
    if (router === 'omniroute' && !cols.some(c => c.name === 'status')) return 'UNKNOWN';

    const sample = db.prepare(`SELECT timestamp, typeof(timestamp) AS t_type FROM "${tableName}" WHERE timestamp IS NOT NULL LIMIT 1`).get() as { timestamp: unknown; t_type: string } | undefined;
    if (!sample) {
      return `0 request trong 7 ngày (bảng ${tableName} rỗng)`;
    }

    const tType = sample.t_type;
    let whereClause = '';
    const now = Date.now();
    const sevenDaysAgoMs = now - 7 * 24 * 60 * 60 * 1000;

    if (tType === 'text') {
      const isoCutoff = new Date(sevenDaysAgoMs).toISOString();
      whereClause = `timestamp >= '${isoCutoff}'`;
    } else if (tType === 'integer' || tType === 'real') {
      const num = Number(sample.timestamp);
      if (isNaN(num)) return 'UNKNOWN';
      if (num > 100000000000) {
        whereClause = `timestamp >= ${sevenDaysAgoMs}`;
      } else {
        whereClause = `timestamp >= ${Math.floor(sevenDaysAgoMs / 1000)}`;
      }
    } else {
      return 'UNKNOWN';
    }

    if (router === '9router') {
      const hasStatus = cols.some(c => c.name === 'status');
      if (hasStatus) {
        const res = db.prepare(`SELECT count(*) as total, sum(case when lower(status) IN ('ok', 'success', '200') then 1 else 0 end) as success FROM "${tableName}" WHERE ${whereClause}`).get() as { total: number; success: number | null } | undefined;
        if (res && typeof res.total === 'number' && res.total > 0) {
          const successCount = res.success ?? 0;
          if (successCount < res.total) {
            const pct = ((successCount / res.total) * 100).toFixed(1);
            return `${successCount.toLocaleString()}/${res.total.toLocaleString()} thành công (${pct}%)`;
          }
          return `${res.total.toLocaleString()} request trong 7 ngày (dữ liệu 9Router hiện chỉ có trạng thái ok, không đo được tỷ lệ lỗi)`;
        }
        if (res && res.total === 0) {
          return '0 request trong 7 ngày (bảng usageHistory)';
        }
        return 'UNKNOWN';
      }
      const res = db.prepare(`SELECT count(*) as total FROM "${tableName}" WHERE ${whereClause}`).get() as { total: number } | undefined;
      if (res && typeof res.total === 'number' && res.total > 0) {
        return `${res.total.toLocaleString()} request trong 7 ngày (dữ liệu 9Router hiện chỉ có trạng thái ok, không đo được tỷ lệ lỗi)`;
      }
      if (res && res.total === 0) {
        return '0 request trong 7 ngày (bảng usageHistory)';
      }
      return 'UNKNOWN';
    } else {
      const res = db.prepare(`SELECT count(*) as total, sum(case when status BETWEEN 200 AND 399 then 1 else 0 end) as success FROM "${tableName}" WHERE ${whereClause}`).get() as { total: number; success: number | null } | undefined;
      if (res && typeof res.total === 'number' && res.total > 0) {
        const successCount = res.success ?? 0;
        const pct = ((successCount / res.total) * 100).toFixed(1);
        return `${successCount.toLocaleString()}/${res.total.toLocaleString()} thành công (${pct}%)`;
      }
      if (res && res.total === 0) {
        return '0 request trong 7 ngày (bảng call_logs)';
      }
      return 'UNKNOWN';
    }
  } catch {
    return 'UNKNOWN';
  }
}

function getSevenDayHealth(router: string): string {
  if (router === '9router') {
    try {
      const db = openBetterSqlite3(routerDbPath('9router'), { readOnly: true, busyTimeoutMs: 5000 });
      try {
        return compute7DayHealthFromDb(db, '9router');
      } finally {
        db.close();
      }
    } catch {
      return 'UNKNOWN';
    }
  }
  if (router === 'omniroute') {
    try {
      const db = openBetterSqlite3(routerDbPath('omniroute'), { readOnly: true, busyTimeoutMs: 5000 });
      try {
        return compute7DayHealthFromDb(db, 'omniroute');
      } finally {
        db.close();
      }
    } catch {
      return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

export function formatPlanShownOutput(
  results: ComboRankResult[],
  config: RankingConfig,
  planHash?: string
): string {
  const lines: string[] = [];
  lines.push('='.repeat(80));
  lines.push('ROUTERSYNC RANKING PLAN (PLAN-SHOWN.txt)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('='.repeat(80));

  lines.push('\n[PHẦN 1: BÁO CÁO NỢ BƯỚC A/B]');
  lines.push(`- Rank planHash: ${planHash ?? stableRankPlanHash(results, config)}`);
  lines.push('- Chế độ xem trước không gọi mạng: danh sách model lấy từ danh mục của router.');
  lines.push('\n[PHẦN 2: KẾ HOẠCH HOÁN VỊ THỨ TỰ COMBO CHI TIẾT]');
  let maxMovedSteps = 0;
  let maxMovedComboName = '';
  let maxMovedComboCount = 0;
  let totalMoved9Router = 0;
  let totalSteps9Router = 0;
  let totalMovedOmniRoute = 0;
  let totalStepsOmniRoute = 0;

  // C4o/O5: the 7-day health and the fallback strategies are read ONCE per
  // router and reused across combos. The 9Router settings table is read in
  // one query and cached, not once per combo.
  const healthByRouter = new Map<string, string>();
  const strategyByRouter = new Map<string, Map<string, { strategy: string; isRoundRobin: boolean }>>();

  for (const res of results) {
    let healthInfo = healthByRouter.get(res.routerId);
    if (healthInfo === undefined) {
      healthInfo = getSevenDayHealth(res.routerId);
      healthByRouter.set(res.routerId, healthInfo);
    }
    let stratMap = strategyByRouter.get(res.routerId);
    if (!stratMap) {
      stratMap = res.routerId === '9router' ? load9RouterStrategies() : new Map();
      strategyByRouter.set(res.routerId, stratMap);
    }
    const defaultStrat = res.routerId === '9router'
      ? { strategy: 'fallback', isRoundRobin: false }
      : { strategy: 'order-dependent / fallback', isRoundRobin: false };
    const stratInfo = stratMap.get(res.comboName) ?? defaultStrat;
    const movedPct = res.originalCount > 0 ? ((res.positionChangesCount / res.originalCount) * 100).toFixed(1) : '0.0';

    if (res.routerId === '9router') {
      totalMoved9Router += res.positionChangesCount;
      totalSteps9Router += res.originalCount;
    } else {
      totalMovedOmniRoute += res.positionChangesCount;
      totalStepsOmniRoute += res.originalCount;
    }

    if (res.positionChangesCount > maxMovedSteps) {
      maxMovedSteps = res.positionChangesCount;
      maxMovedComboName = `[${res.routerId.toUpperCase()}] ${res.comboName}`;
      maxMovedComboCount = res.originalCount;
    }

    lines.push(`\n--------------------------------------------------------------------------------`);
    lines.push(`Router: ${res.routerId.toUpperCase()} | Combo: ${res.comboName}`);
    lines.push(`  Strategy hiện tại: ${stratInfo.strategy}${stratInfo.isRoundRobin ? ' [CẢNH BÁO: round-robin sẽ xoay vòng model thay vì ưu tiên tuyệt đối theo thứ tự xếp hạng]' : ''}`);
    lines.push(`  Sức khỏe 7 ngày của router (không tách theo combo): ${healthInfo}`);
    lines.push(`  Số bước:           ${res.originalCount} -> ${res.retainedCount} (Loại bỏ: ${res.droppedCount})`);
    lines.push(`  Số bước đổi chỗ:   ${res.positionChangesCount}/${res.originalCount} (${movedPct}%)`);
    lines.push(`  Top 15 Bước Hiện Tại (Trước):`);
    for (let i = 0; i < Math.min(15, res.top15Before.length); i++) {
      lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${res.top15Before[i]}`);
    }
    lines.push(`  Top 15 Bước Sau Khi Xếp Hạng:`);
    for (let i = 0; i < Math.min(15, res.top15After.length); i++) {
      const item = res.rankedModels[i];
      const tierLabel = item ? (item.tier === 99 ? '[UNRATED]' : `[Tier ${item.tier}]`) : '';
      lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${tierLabel} ${res.top15After[i]}`);
    }
  }

  const pct9 = totalSteps9Router > 0 ? ((totalMoved9Router / totalSteps9Router) * 100).toFixed(1) : '0';
  const pctOmni = totalStepsOmniRoute > 0 ? ((totalMovedOmniRoute / totalStepsOmniRoute) * 100).toFixed(1) : '0';

  lines.push('\n' + '='.repeat(80));
  lines.push('[PHẦN 3: TỔNG KẾT VÀ ĐIỀU KIỆN XÁC NHẬN]');
  lines.push(`- 9Router:   ${totalMoved9Router}/${totalSteps9Router} bước đổi vị trí (${pct9}%)`);
  lines.push(`- OmniRoute: ${totalMovedOmniRoute}/${totalStepsOmniRoute} bước đổi vị trí (${pctOmni}%)`);
  lines.push(`- Bước đổi vị trí lớn nhất trong một combo: ${maxMovedSteps}/${maxMovedComboCount} bước (${maxMovedComboName})`);
  lines.push(`- Ngưỡng an toàn: > 25% đổi vị trí -> YÊU CẦU XÁC NHẬN LẦN 2 BẰNG CÁCH GÕ LẠI CHÍNH XÁC: "${maxMovedSteps}"`);
  lines.push('='.repeat(80));
  return lines.join('\n') + '\n';
}

async function applyRanking(
  results: ComboRankResult[],
  targets: RouterName[],
  options: RankCommandOptions,
  rankOpts: { allowOperatorDisabled?: boolean; allowProviderInactive?: boolean; maxShrinkRatio?: number } = {
    maxShrinkRatio: 0.10,
  },
  planDbPaths: Partial<Record<RouterName, string>> = {}
): Promise<string> {
  grantLiveWriteToken('routersync-live-write');
  const resultLines: string[] = [];
  resultLines.push('='.repeat(80));
  resultLines.push('ROUTERSYNC RANKING APPLY RESULT (APPLY-RESULT.txt)');
  resultLines.push('Timestamp: ' + new Date().toISOString());
  resultLines.push('='.repeat(80));

  const record: LastSyncRecord = {
    at: new Date().toISOString(),
    planHash: 'rank-' + Date.now().toString(16),
    routers: {},
  };

  for (const router of targets) {
    const routerResults = results.filter((r) => r.routerId === router);
    if (routerResults.length === 0) continue;

    // C4n/N5: the plan was computed from a specific database file; refuse to
    // write a different one.
    try {
      assertWriteTargetMatchesPlan(router, planDbPaths[router]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      resultLines.push(`ABORT: ${msg}`);
      continue;
    }

    console.log(`\n>>> [BƯỚC 1/5] Sao lưu SQLite trước ghi cho router=${router}...`);
    let backup;
    try {
      backup = backupRouterDb(router);
    } catch (err) {
      const msg = `Lỗi sao lưu database router=${router}: ${String(err)}`;
      console.error(msg);
      resultLines.push(`ERROR: ${msg}`);
      continue;
    }

    console.log(`SYNC-BACKUP router=${router} path=${backup.path} bytes=${backup.bytes} integrity=${backup.integrity}`);
    resultLines.push(`SYNC-BACKUP router=${router} path=${backup.path} bytes=${backup.bytes} integrity=${backup.integrity}`);

    if (backup.integrity !== 'ok') {
      const msg = `SYNC-ABORT router=${router} backup integrity failure (${backup.integrity}). Không ghi gì vào router này.`;
      console.error(msg);
      resultLines.push(`ABORT: ${msg}`);
      continue;
    }

    // Content fence before
    const fenceBefore = tableFence(router);
    console.log(`SYNC-FENCE-BEFORE router=${router} digest=${fenceBefore.digest} tables=${fenceBefore.tables}`);
    resultLines.push(`SYNC-FENCE-BEFORE router=${router} digest=${fenceBefore.digest} tables=${fenceBefore.tables}`);

    // Prepare changes
    const detailsMap = readCombosWithDetails(router);
    const changes: ComboReorderChange[] = [];

    for (const res of routerResults) {
      const detail = detailsMap.get(res.comboName);
      if (!detail) {
        console.warn(`[WARN] Không tìm thấy combo detail cho ${res.comboName}`);
        continue;
      }
      changes.push({
        id: detail.id,
        name: res.comboName,
        orderedModelIds: res.rankedModels.map((m) => m.id),
      });
    }

    console.log(`>>> [BƯỚC 2/5] Áp dụng hoán vị in-place qua writer hẹp cho ${changes.length} combos...`);
    const outcome = applyStepReordering(router, changes);
    console.log(`SYNC-APPLIED router=${router} combos=${outcome.written.length} errors=${outcome.errors.length}`);
    resultLines.push(`SYNC-APPLIED router=${router} combos=${outcome.written.length} errors=${outcome.errors.length}`);
    if (outcome.errors.length > 0) {
      for (const err of outcome.errors) {
        console.error(`  - Error: ${err}`);
        resultLines.push(`  - Error: ${err}`);
      }
    }

    // Content fence after
    const fenceAfter = tableFence(router);
    console.log(`SYNC-FENCE-AFTER router=${router} digest=${fenceAfter.digest} tables=${fenceAfter.tables}`);
    resultLines.push(`SYNC-FENCE-AFTER router=${router} digest=${fenceAfter.digest} tables=${fenceAfter.tables}`);

    if (fenceBefore.digest === fenceAfter.digest) {
      console.log(`FENCE-VERIFIED: Digest trùng khớp (${fenceBefore.digest}). Không bảng nào ngoài 'combos' bị thay đổi.`);
      resultLines.push(`FENCE-VERIFIED: Digest trùng khớp (${fenceBefore.digest}).`);
    } else {
      console.warn(`[WARN] FENCE-MISMATCH: Digest khác nhau trước và sau ghi!`);
      resultLines.push(`[WARN] FENCE-MISMATCH: Digest khác nhau trước và sau ghi!`);
    }

    // Read-back verification
    console.log(`>>> [BƯỚC 3/5] Đọc lại kiểm tra trực tiếp từ database (Read-back verification)...`);
    const readBackMap = readCombosWithDetails(router);
    let allExact = true;
    for (const change of changes) {
      const actual = readBackMap.get(change.name)?.models ?? [];
      const expected = change.orderedModelIds;
      if (actual.length !== expected.length || actual.some((m, idx) => m !== expected[idx])) {
        allExact = false;
        console.error(`  - READ-BACK MISMATCH combo=${change.name}: expected ${expected.length} steps, got ${actual.length}`);
        resultLines.push(`  - READ-BACK MISMATCH combo=${change.name}`);
      }
    }

    if (allExact) {
      console.log(`READ-BACK VERDICT=EXACT router=${router} (100% combo có thứ tự khớp chính xác tuyệt đối với kế hoạch xếp hạng).`);
      resultLines.push(`READ-BACK VERDICT=EXACT router=${router}`);
    } else {
      console.error(`READ-BACK VERDICT=MISMATCH router=${router}`);
      resultLines.push(`READ-BACK VERDICT=MISMATCH router=${router}`);
    }

    // Re-scan verification
    console.log(`>>> [BƯỚC 4/5] Quét lại xác nhận trạng thái ổn định (Re-scan verification)...`);
    const { config } = loadRankingConfig(options.config);
    let reScanMoved = 0;
    let reScanDropped = 0;
    for (const [comboName, detail] of readBackMap.entries()) {
      if (isComboExcluded(comboName, config.excludeCombos)) continue;
      const reRank = rankComboModels(comboName, router, detail.models, config, rankOpts);
      reScanMoved += reRank.positionChangesCount;
      reScanDropped += reRank.droppedCount;
    }

    console.log(`RE-SCAN VERIFIED router=${router} remove=${reScanDropped} moved=${reScanMoved}`);
    resultLines.push(`RE-SCAN VERIFIED router=${router} remove=${reScanDropped} moved=${reScanMoved}`);

    record.routers[router] = {
      backup: backup.path,
      changed: changes.map((c) => c.name),
    };
  }

  // Write record for undo
  writeLastSync(record);

  // Write fingerprint for drift detection (autopilot plan)
  const fpCombos: Record<string, string> = {};
  for (const router of targets) {
    const detailsMap = readCombosWithDetails(router);
    for (const [name, detail] of detailsMap.entries()) {
      fpCombos[`${router}/${name}`] = JSON.stringify(detail.models);
    }
  }
  writeLastApplied({ router: 'all', combos: fpCombos });

  resultLines.push('\n[PHẦN HƯỚNG DẪN HOÀN TÁC (UNDO)]');
  resultLines.push('Chạy các lệnh sau nếu cần khôi phục lại trạng thái cũ:');
  for (const [router, entry] of Object.entries(record.routers)) {
    const cmd = `routersync undo --router ${router} --backup "${entry.backup}"`;
    resultLines.push(`  ${cmd}`);
    console.log(`\nSYNC-UNDO: ${cmd}`);
  }

  const resultText = resultLines.join('\n') + '\n';
  const outDir = options.outputDir ?? process.cwd();
  fs.writeFileSync(path.join(outDir, 'APPLY-RESULT.txt'), resultText, 'utf8');
  console.log(`\nĐã ghi kết quả áp dụng ra file: ${path.join(outDir, 'APPLY-RESULT.txt')}`);

  return resultText;
}

export async function runRankCommand(options: RankCommandOptions): Promise<ComboRankResult[]> {
  const routerTarget = (options.router || 'all').toLowerCase();
  const { config, sourcePath, isDefault } = loadRankingConfig(options.config);

  const targets: RouterName[] =
    routerTarget === '9router'
      ? ['9router']
      : routerTarget === 'omniroute'
        ? ['omniroute']
        : ['9router', 'omniroute'];

  const targetDir = options.outputDir ?? process.cwd();

  // If --apply is specified, run the strict safety pipeline (Confirmation 1 -> 2-Round Scan -> Plan -> Confirmation 2 -> Apply -> Read-back -> Re-scan)
  if (options.apply) {
    if (!process.stdin.isTTY) {
      throw new Error('Write Execution Blocked: rank --apply requires an interactive TTY terminal.');
    }
    if (isDefault) {
      throw new Error(`Refusing to write: ranking.yaml is using built-in default schema (${sourcePath}).`);
    }
    console.log('='.repeat(78));
    console.log('ROUTERSYNC RANK APPLY — KHUNG AN TOÀN SYNC');
    console.log('='.repeat(78));

    let allowOperatorDisabled = false;
    if ((config.operatorDisabled?.length ?? 0) > 0) {
      allowOperatorDisabled = await confirm(
        'chay',
        `Phát hiện ${config.operatorDisabled!.length} mẫu OPERATOR-DISABLED (disabledModels). Gõ "chay" để cho phép gỡ nhóm này (hoặc Enter để giữ nguyên): `
      );
    }

    let allowProviderInactive = false;
    if ((config.providerInactive?.length ?? 0) > 0) {
      allowProviderInactive = await confirm(
        'chay',
        `Phát hiện ${config.providerInactive!.length} mẫu PROVIDER-INACTIVE (is_active=0). Gõ "chay" để cho phép gỡ nhóm này (hoặc Enter để giữ nguyên): `
      );
    }

    const { config: syncConfig } = loadConfigFile();
    const views = await buildViews(syncConfig, routerTarget === 'all' ? 'all' : routerTarget);

    console.log('SYNC-PROVIDERS danh sách nhà cung cấp và host sẽ gọi bằng khóa (không in khóa):');
    printTargets(views);

    const keyed = views.reduce((n: number, v: RouterView) => n + v.targets.filter((t) => !t.skipReason).length, 0);
    if (keyed === 0) {
      console.log('SYNC-NOOP không có nhà cung cấp nào có khóa; bỏ qua quét.');
    } else {
      console.log('\n>>> [XÁC NHẬN 1/2]');
      if (!(await confirm('chay', 'Gõ "chay" để bắt đầu quét model của các nhà cung cấp trên: '))) {
        console.log('SYNC-REFUSED step=pre-scan (không nhận được "chay").');
        process.exitCode = 2;
        return [];
      }

      const gapMs = options.scanGapMs ?? 60_000;
      const timeoutMs = options.timeoutMs ?? 15_000;

      console.log(`SYNC-SCAN-START gap_ms=${gapMs} timeout_ms=${timeoutMs}`);
      console.log('SYNC-SCAN round=1 quét model của các nhà cung cấp...');
      await scanAll(views, 1, timeoutMs);

      console.log(`SYNC-SCAN wait=${gapMs}ms chờ giữa 2 lần quét...`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));

      console.log('SYNC-SCAN round=2 quét lại để kiểm chứng...');
      await scanAll(views, 2, timeoutMs);
    }

    const rankOpts = {
      allowOperatorDisabled,
      allowProviderInactive,
      maxShrinkRatio: 0.10,
    };

    // Evaluate combos from databases
    const allResults: ComboRankResult[] = [];
    // C4n/N5: remember the database each router's plan was computed from, so
    // the apply step can refuse to write a different file.
    const planDbPaths: Partial<Record<RouterName, string>> = {};
    for (const router of targets) {
      let comboMap: Map<string, string[]>;
      try {
        planDbPaths[router] = locateRouterDb(router);
        comboMap = readComboModels(router);
      } catch (err) {
        console.warn(`[WARN] Không thể đọc database của router ${router}: ${String(err)}`);
        continue;
      }

      for (const [comboName, models] of comboMap.entries()) {
        if (isComboExcluded(comboName, config.excludeCombos)) {
          continue;
        }
        const result = rankComboModels(comboName, router, models, config, rankOpts);
        allResults.push(result);
      }
    }

    // Generate PLAN-SHOWN.txt and display. The preview never calls the network.
    const rankPlanHash = stableRankPlanHash(allResults, config);
    const planText = formatPlanShownOutput(allResults, config, rankPlanHash);
    console.log(planText);
    if (options.writeOutputs || options.apply) {
      fs.writeFileSync(path.join(targetDir, 'PLAN-SHOWN.txt'), planText, 'utf8');
    }

    // Determine max moved steps and threshold
    const maxMovedCombo = allResults.reduce(
      (max, r) => (r.positionChangesCount > max.positionChangesCount ? r : max),
      allResults[0] ?? { positionChangesCount: 0, originalCount: 0 }
    );
    const maxMovedPercent =
      maxMovedCombo.originalCount > 0 ? maxMovedCombo.positionChangesCount / maxMovedCombo.originalCount : 0;

    let requireWord = 'chay';
    let confirmPrompt = 'Gõ "chay" để áp dụng thứ tự xếp hạng lên router live: ';

    if (maxMovedPercent > 0.25) {
      requireWord = String(maxMovedCombo.positionChangesCount);
      confirmPrompt = `\n>>> [XÁC NHẬN 2/2: Tỷ lệ đổi vị trí > 25% (lớn nhất là ${maxMovedCombo.positionChangesCount}/${maxMovedCombo.originalCount} bước - ${(maxMovedPercent * 100).toFixed(1)}%)]\nGõ lại chính xác "${requireWord}" để xác nhận ghi live vào database: `;
    } else {
      confirmPrompt = `\n>>> [XÁC NHẬN 2/2]\nGõ "chay" để xác nhận ghi live vào database: `;
    }

    if (!(await confirm(requireWord, confirmPrompt))) {
      console.log(`SYNC-REFUSED step=confirm-2 (không nhận được "${requireWord}").`);
      process.exitCode = 2;
      return allResults;
    }

    // Apply ranking live
    await applyRanking(allResults, targets, options, rankOpts, planDbPaths);

    // Also write outputs if requested
    if (options.writeOutputs) {
      fs.writeFileSync(path.join(targetDir, 'CLASSIFY.txt'), formatClassifyOutput(allResults), 'utf8');
      fs.writeFileSync(path.join(targetDir, 'UNRATED.txt'), formatUnratedOutput(allResults), 'utf8');
      fs.writeFileSync(path.join(targetDir, 'RANK-PREVIEW.txt'), formatRankPreviewOutput(allResults, config), 'utf8');
    }

    return allResults;
  }

  // PREVIEW-ONLY mode
  const allResults: ComboRankResult[] = [];

  for (const router of targets) {
    let comboMap: Map<string, string[]>;
    try {
      comboMap = readComboModels(router);
    } catch (err) {
      if (!options.json) {
        console.warn(`[WARN] Không thể đọc database của router ${router}: ${String(err)}`);
      }
      continue;
    }

    const rankOpts = {
      maxShrinkRatio: options.maxShrinkRatio ?? 0.10,
    };

    for (const [comboName, models] of comboMap.entries()) {
      // Exclude test combos per Round 59 rule 2
      if (isComboExcluded(comboName, config.excludeCombos)) {
        continue;
      }

      const result = rankComboModels(comboName, router, models, config, rankOpts);
      if (result.shrinkCappedCount && result.shrinkCappedCount > 0) {
        console.log(
          `CAP-BLOCKED combo=${comboName} router=${router} capped=${result.shrinkCappedCount} (trần co rút <=10% chặn việc gỡ quá mức, giữ lại ${result.shrinkCappedCount} bước)`
        );
      }
      allResults.push(result);
    }
  }

  // Calculate total lost providers
  let totalLostProviders = 0;
  for (const res of allResults) {
    totalLostProviders += res.lostProviders.length;
  }

  if (options.json) {
    // Default: compact summary ≤ 100 KB (--full for complete output)
    const wantFull = options.full === true;
    const payload = wantFull
      ? allResults
      : allResults.map((r) => ({
          routerId: r.routerId,
          comboName: r.comboName,
          originalCount: r.originalCount,
          retainedCount: r.retainedCount,
          droppedCount: r.droppedCount,
          positionChangesCount: r.positionChangesCount,
          lostProviders: r.lostProviders,
          top5After: r.top15After.slice(0, 5),
          coverageAfter: r.coverageAfter,
        }));
    const text = JSON.stringify(payload, null, 2);
    if (options.out) fs.writeFileSync(options.out, text + '\n', 'utf8');
    else console.log(text);
    return allResults;
  }

  // Dynamic tier list from config
  const activeTiers = Object.keys(config.tierRules);
  const tierSummary = activeTiers.length > 0 ? activeTiers.join(', ') : '(neutral - no custom tiers)';

  console.log('='.repeat(78));
  console.log('ROUTERSYNC MODEL RANKING — PREVIEW ONLY (Policy §8.4 + Dynamic Tiers + D1)');
  console.log('='.repeat(78));
  console.log(`Lost Providers Count (Target 0): ${totalLostProviders}`);
  console.log(`Config: ${sourcePath} (${isDefault ? 'default schema' : 'custom loaded'})`);
  console.log(`Active Tiers in Config: ${tierSummary}`);
  console.log(`Excluded Combos: ${config.excludeCombos.join(', ')}`);
  console.log(`Mode: PREVIEW-ONLY (Không thay đổi dữ liệu trong router DB)`);
  console.log(`Criteria: Lexicographic Priority (${config.criteria.map((c) => `${c.priority}:${c.name}`).join(' -> ')})`);
  console.log(`Tail Interleaving (D1): ${config.interleaving.enabled ? 'Bật (xen kẽ provider round-robin ở Fallback & UNRATED)' : 'Tắt'}`);
  console.log('-'.repeat(78));

  for (const res of allResults) {
    console.log(`\n[${res.routerId.toUpperCase()}] Combo: ${res.comboName}`);
    console.log(
      `  Số bước: ${res.originalCount} -> ${res.retainedCount} (Loại bỏ: ${res.droppedCount} [${res.droppedModels.map((m) => `${m.id}: ${m.dropReason}`).slice(0, 3).join(', ')}${res.droppedCount > 3 ? '...' : ''}])`
    );
    console.log(`  Số bước đổi vị trí: ${res.positionChangesCount}`);
    console.log(`  Nhà cung cấp mất đại diện: ${res.lostProviders.length > 0 ? res.lostProviders.join(', ') : '0'}`);

    console.log('  Top 5 Trước:');
    for (let i = 0; i < Math.min(5, res.top15Before.length); i++) {
      console.log(`    ${i + 1}. ${res.top15Before[i]}`);
    }

    console.log('  Top 5 Sau khi Xếp Hạng:');
    for (let i = 0; i < Math.min(5, res.top15After.length); i++) {
      const item = res.rankedModels[i];
      const tierLabel = item ? (item.tier === 99 ? 'UNRATED' : `Tier ${item.tier}`) : '';
      console.log(`    ${i + 1}. [${tierLabel}] ${res.top15After[i]}`);
    }

    const providerList = Object.entries(res.coverageAfter)
      .sort((a, b) => b[1] - a[1])
      .map(([p, count]) => `${p}:${count}`)
      .join(', ');
    console.log(`  Độ phủ Provider Sau: ${providerList}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`TỔNG KẾT: Hoàn thành xếp hạng xem trước trên ${allResults.length} combo.`);
  console.log(`TỔNG NHÀ CUNG CẤP MẤT ĐẠI DIỆN: ${totalLostProviders}`);
  console.log('LƯU Ý: Đây là bản xem trước an toàn (PREVIEW-ONLY). Router DB hoàn toàn giữ nguyên.');
  console.log('='.repeat(78));

  const rankPlanHash = stableRankPlanHash(allResults, config);
  const planText = formatPlanShownOutput(allResults, config, rankPlanHash);
  if (options.writeOutputs) {
    fs.writeFileSync(path.join(targetDir, 'PLAN-SHOWN.txt'), planText, 'utf8');
  }

  if (options.writeOutputs) {
    fs.writeFileSync(path.join(targetDir, 'CLASSIFY.txt'), formatClassifyOutput(allResults), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'UNRATED.txt'), formatUnratedOutput(allResults), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'RANK-PREVIEW.txt'), formatRankPreviewOutput(allResults, config), 'utf8');
  }

  return allResults;
}
