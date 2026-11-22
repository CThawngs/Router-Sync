/**
 * packages/cli/src/commands/apps-drift.ts
 *
 * C41 Y2: đối chiếu model mà app agent trỏ tới với router (chỉ đọc).
 * Không ghi vào DB router hay cấu hình app; không in key/token/host riêng.
 */
import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { openBetterSqlite3, locateRouterDb } from '@routersync/core';
import { readRouterState } from './combos-probe.js';
import { parseReliabilityText, type ReliabilityInfo } from './combos-reorder.js';
import { defaultOpenMausPath, readOpenMausConfig, triedPaths } from '../apps/openmausbot.js';

export type DriftVerdict = 'OK' | 'MISSING' | 'RISK-HANG-BEFORE-FIRST-GOOD' | 'UNVERIFIABLE';

export interface DriftRow {
  instance: string;
  model: string;
  url: string;
  verdict: DriftVerdict;
  steps: number | null;
  strategy: string | null;
  firstGoodIndex: number | null;
  hangBeforeFirstGood: number | null;
  note: string;
}

export interface DriftOptions {
  homeDir?: string | undefined;
  configPath?: string | undefined;
  from?: string[] | undefined;
  log?: ((line: string) => void) | undefined;
}

function readStrategies(): Record<string, string> {
  try {
    const db = openBetterSqlite3(locateRouterDb('9router'), { readOnly: true, busyTimeoutMs: 5000 });
    try {
      const raw = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data?: string } | undefined;
      const map = (raw?.data ? JSON.parse(raw.data) : {}).comboStrategies ?? {};
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(map)) {
        const v = value as { fallbackStrategy?: unknown } | undefined;
        out[name] = v && typeof v.fallbackStrategy === 'string' ? v.fallbackStrategy : 'mặc định';
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** Vị trí bước chạy được đầu tiên và số bước HANG đứng trước nó. */
export function firstGoodAndHangs(steps: string[], rel: Map<string, ReliabilityInfo>): {
  index: number | null;
  hangBefore: number | null;
} {
  for (let i = 0; i < steps.length; i += 1) {
    const label = rel.get(steps[i] ?? '')?.label;
    if (label === 'RELIABLE' || label === 'SLOW') {
      return { index: i, hangBefore: rel ? [...rel.entries()].filter(([s, info]) => {
        const pos = steps.indexOf(s);
        return pos >= 0 && pos < i && info.label === 'HANG';
      }).length : 0 };
    }
  }
  return { index: null, hangBefore: null };
}

export function runAppsDrift(options: DriftOptions = {}): { rows: DriftRow[]; notes: string[] } {
  const log = options.log ?? ((line: string) => console.log(line));
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? defaultOpenMausPath(homeDir);
  const read = readOpenMausConfig(configPath);

  const rel = new Map<string, ReliabilityInfo>();
  for (const file of options.from ?? []) {
    try {
      for (const [step, info] of parseReliabilityText(readFileSync(file, 'utf8'))) rel.set(step, info);
    } catch {
      // Tệp không đọc được thì bỏ qua số đo, không đoán.
    }
  }

  const strategies = readStrategies();
  const state = readRouterState();
  const allSteps = new Set(state.combos.flatMap((c) => c.steps));

  const rows: DriftRow[] = [];
  if (read.instances.length === 0) {
    log('không tìm thấy cấu hình OpenMausBot');
    for (const p of triedPaths(homeDir)) log(`  đã thử: ${p}`);
    for (const note of read.notes) log(`  ${note}`);
    return { rows, notes: read.notes };
  }

  for (const instance of read.instances) {
    const base = {
      instance: instance.id,
      model: instance.model,
      url: instance.url,
    };
    const combo = state.combos.find((c) => c.name === instance.model);
    if (combo) {
      const good = firstGoodAndHangs(combo.steps, rel);
      const verdict: DriftVerdict =
        good.index === null ? 'UNVERIFIABLE' : good.hangBefore && good.hangBefore > 0 ? 'RISK-HANG-BEFORE-FIRST-GOOD' : 'OK';
      rows.push({
        ...base,
        verdict,
        steps: combo.steps.length,
        strategy: strategies[instance.model] ?? 'mặc định',
        firstGoodIndex: good.index,
        hangBeforeFirstGood: good.hangBefore,
        note: good.index === null ? 'không có số đo reliability cho combo này' : `bước chạy được đầu tiên ở vị trí ${good.index}`,
      });
      continue;
    }
    const known = allSteps.has(instance.model);
    rows.push({
      ...base,
      verdict: known ? 'OK' : 'MISSING',
      steps: null,
      strategy: null,
      firstGoodIndex: null,
      hangBeforeFirstGood: null,
      note: known ? 'id lẻ có trong danh sách bước của router' : 'không phải combo và không có trong danh sách bước',
    });
  }

  log('instance'.padEnd(24) + 'model'.padEnd(24) + 'kết luận');
  for (const row of rows) {
    log(
      row.instance.padEnd(24) +
        row.model.padEnd(24) +
        row.verdict +
        (row.steps !== null ? ` (${row.steps} bước, ${row.strategy})` : '')
    );
    log(`  ${row.note}`);
  }
  return { rows, notes: read.notes };
}
