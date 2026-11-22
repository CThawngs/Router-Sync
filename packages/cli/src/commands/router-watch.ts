/**
 * packages/cli/src/commands/router-watch.ts
 *
 * C35 R1: lấy mẫu sức khỏe router trong lúc máy đang chạy thật.
 *
 * Mỗi chu kỳ ghi một dòng JSONL:
 *   { t, freeMemMB, load1, routerRssMB, routerCpuSec, routerAgeSec,
 *     modelsMs, modelsStatus, combo?: { model, headerMs, usageMs, servedBy, verdict } }
 *
 * `GET /v1/models` được đo cả khi lỗi/quá hạn (15 s). Combo (nếu có) chạy mỗi
 * `--combo-every-min` phút, tối đa 20 lần, `max_tokens` 8, stream bật, hạn 180 s.
 *
 * `router watch --summarize <file.jsonl>` in phân vị theo khoảng RAM trống và hệ
 * số tương quan giữa RAM trống và độ trễ `/v1/models`. Ô dưới 5 mẫu: "không đủ mẫu".
 *
 * Không ghi vào router. Chỉ đọc.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem, loadavg } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { openBetterSqlite3, locateRouterDb } from '@routersync/core';
import { callComboWithUsage, readRouterState } from './combos-probe.js';

export interface WatchSample {
  t: string;
  freeMemMB: number;
  load1: number | null;
  routerRssMB: number | null;
  routerCpuSec: number | null;
  routerAgeSec: number | null;
  modelsMs: number;
  modelsStatus: number | null;
  combo?:
    | {
        model: string;
        headerMs: number | null;
        usageMs: number | null;
        servedBy: string | null;
        verdict: string;
      }
    | undefined;
}

function homedirSafe(): string {
  return process.env.APPDATA ?? process.env.HOME ?? '.';
}

export function readRouterPid(): number | null {
  const file = process.env['ROUTERSYNC_9ROUTER_LAUNCHER_PID'] ?? join(homedirSafe(), '9router', 'launcher.pid');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { serverPid?: number };
    return typeof parsed.serverPid === 'number' ? parsed.serverPid : null;
  } catch {
    return null;
  }
}

/** RSS/CPU/tuổi của tiến trình router. Windows: Get-Process; POSIX: ps. */
export function readRouterProcess(
  pid: number | null
): { rssMB: number | null; cpuSec: number | null; ageSec: number | null } {
  if (!pid || pid <= 0) return { rssMB: null, cpuSec: null, ageSec: null };
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (process.platform === 'win32') {
    const out = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){"{0}|{1}|{2}" -f [math]::Round($p.WorkingSet64/1MB,0), [math]::Round($p.CPU,1), [math]::Round(((Get-Date)-$p.StartTime).TotalSeconds,0)}`,
    ]);
    const line = String(out).trim().split('\n')[0] ?? '';
    const [rss, cpu, age] = line.split('|');
    return { rssMB: num(rss), cpuSec: num(cpu), ageSec: num(age) };
  }
  const out = spawn('ps', ['-o', 'rss=,pcpu=,etimes=', '-p', String(pid)]);
  const line = String(out).trim().split('\n')[0] ?? '';
  const [rssKB, pcpu, age] = line.trim().split(/\s+/);
  const rss = num(rssKB);
  return { rssMB: rss === null ? null : Math.round(rss / 1024), cpuSec: num(pcpu), ageSec: num(age) };
}

function spawn(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.stdout ?? '';
}

function cpuLoad1(): number | null {
  try {
    const [one] = loadavg();
    return typeof one === 'number' && Number.isFinite(one) ? Math.round(one * 100) / 100 : null;
  } catch {
    return null;
  }
}

export async function measureModels(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ ms: number; status: number | null }> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(15_000) });
    return { ms: Date.now() - t0, status: res.status };
  } catch {
    return { ms: Date.now() - t0, status: null };
  }
}

export function usageRowsReader(comboStartRef: { value: number }) {
  return () => {
    try {
      const db = openBetterSqlite3(locateRouterDb('9router'), { readOnly: true, busyTimeoutMs: 5000 });
      try {
        const rows = db
          .prepare(
            'SELECT timestamp, provider, model, status, completionTokens FROM usageHistory ORDER BY id DESC LIMIT 50'
          )
          .all() as Array<{
          timestamp: string;
          provider: string;
          model: string;
          status: string | null;
          completionTokens: number | null;
        }>;
        return rows
          .map((r) => ({
            atMs: Date.parse(r.timestamp) - comboStartRef.value,
            provider: r.provider,
            model: r.model,
            status: r.status ?? null,
            completionTokens: r.completionTokens ?? null,
          }))
          .filter((r) => Number.isFinite(r.atMs) && r.atMs >= 0)
          .sort((a, b) => a.atMs - b.atMs);
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  };
}

export interface WatchOptions {
  minutes?: number | undefined;
  intervalSec?: number | undefined;
  combo?: string | undefined;
  comboEveryMin?: number | undefined;
  out?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

const MAX_COMBO_REQUESTS = 20;
const COMBO_TIMEOUT_MS = 180_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runRouterWatch(options: WatchOptions = {}): Promise<{ out: string; samples: number }> {
  const log = options.log ?? ((l: string) => console.log(l));
  const minutes = Math.max(1, Math.floor(options.minutes ?? 10));
  const intervalSec = Math.max(1, Math.floor(options.intervalSec ?? 10));
  const comboEveryMin = Math.max(1, Math.floor(options.comboEveryMin ?? 5));
  const out = options.out ?? '.agent/evidence/router-watch.jsonl';
  const baseUrl = options.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? 'http://127.0.0.1:20128';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, '', 'utf8');

  const pid = readRouterPid();
  const state = options.combo ? readRouterState() : null;
  const apiKey = state?.apiKey ?? '';
  const comboName = options.combo;
  const comboStartRef = { value: clock() };
  const readUsage = usageRowsReader(comboStartRef);

  const deadline = clock() + minutes * 60_000;
  let comboCount = 0;
  let samples = 0;

  while (clock() < deadline) {
    const proc = readRouterProcess(pid);
    const models = await measureModels(baseUrl, fetchImpl);
    const sample: WatchSample = {
      t: new Date(clock()).toISOString(),
      freeMemMB: Math.round(freemem() / (1024 * 1024)),
      load1: cpuLoad1(),
      routerRssMB: proc.rssMB,
      routerCpuSec: proc.cpuSec,
      routerAgeSec: proc.ageSec,
      modelsMs: models.ms,
      modelsStatus: models.status,
      combo: undefined,
    };

    const sinceCombo = comboCount === 0 ? Number.POSITIVE_INFINITY : clock() - comboStartRef.value;
    if (comboName && (comboCount === 0 || sinceCombo >= comboEveryMin * 60_000)) {
      if (comboCount < MAX_COMBO_REQUESTS) {
        comboStartRef.value = clock();
        const res = await callComboWithUsage(
          `${baseUrl}/v1/chat/completions`,
          apiKey,
          { model: comboName, messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }], max_tokens: 8, stream: true },
          COMBO_TIMEOUT_MS,
          fetchImpl,
          () => 0,
          1_000,
          undefined,
          undefined,
          readUsage,
          true
        );
        comboCount += 1;
        sample.combo = {
          model: comboName,
          headerMs: res.row.headerMs,
          usageMs: res.firstUsageMs,
          servedBy: res.row.usageServedBy,
          verdict: String(res.row.verdict),
        };
      }
    }

    appendFileSync(out, `${JSON.stringify(sample)}\n`, 'utf8');
    samples += 1;
    log(
      `#${samples} free=${sample.freeMemMB}MB load=${sample.load1 ?? '-'} rss=${sample.routerRssMB ?? '-'}MB models=${models.ms}ms(${models.status ?? 'timeout'})${sample.combo ? ` combo=${sample.combo.verdict} header=${sample.combo.headerMs ?? '-'}ms` : ''}`
    );

    const remain = deadline - clock();
    if (remain <= 0) break;
    await sleep(Math.min(intervalSec * 1000, remain));
  }

  return { out, samples };
}

export { MAX_COMBO_REQUESTS, COMBO_TIMEOUT_MS };

/* ------------------------------- summarize ------------------------------- */

export interface SummaryRow {
  bucket: string;
  n: number;
  modelsP50: number | null;
  modelsP90: number | null;
  modelsMax: number | null;
  comboN: number;
  comboP50: number | null;
  comboP90: number | null;
  comboMax: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function summarize(samples: WatchSample[]): { rows: SummaryRow[]; correlation: number | null; samples: number } {
  const buckets: Array<{ key: string; test: (mb: number) => boolean }> = [
    { key: 'ram <600 MB', test: (mb) => mb < 600 },
    { key: 'ram 600-1500 MB', test: (mb) => mb >= 600 && mb <= 1500 },
    { key: 'ram >1500 MB', test: (mb) => mb > 1500 },
  ];
  const rows: SummaryRow[] = [];
  for (const b of buckets) {
    const sel = samples.filter((s) => b.test(s.freeMemMB));
    const models = sel.map((s) => s.modelsMs).sort((x, y) => x - y);
    const combos = sel
      .filter((s) => s.combo && s.combo.headerMs !== null)
      .map((s) => (s.combo as { headerMs: number }).headerMs)
      .sort((x, y) => x - y);
    const enough = sel.length >= 5;
    const enoughCombo = combos.length >= 5;
    rows.push({
      bucket: b.key,
      n: sel.length,
      modelsP50: enough ? percentile(models, 50) : null,
      modelsP90: enough ? percentile(models, 90) : null,
      modelsMax: enough ? models[models.length - 1] ?? null : null,
      comboN: combos.length,
      comboP50: enoughCombo ? percentile(combos, 50) : null,
      comboP90: enoughCombo ? percentile(combos, 90) : null,
      comboMax: enoughCombo ? combos[combos.length - 1] ?? null : null,
    });
  }

  const xs = samples.map((s) => s.freeMemMB);
  const ys = samples.map((s) => s.modelsMs);
  const n = xs.length;
  let correlation: number | null = null;
  if (n >= 3) {
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
      const xi = xs[i] ?? 0;
      const yi = ys[i] ?? 0;
      num += (xi - mx) * (yi - my);
      dx += (xi - mx) ** 2;
      dy += (yi - my) ** 2;
    }
    correlation = dx === 0 || dy === 0 ? null : Math.round((num / Math.sqrt(dx * dy)) * 1000) / 1000;
  }
  return { rows, correlation, samples: n };
}

export function runSummarize(file: string, log: (l: string) => void = (l) => console.log(l)): void {
  const samples = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WatchSample);
  const s = summarize(samples);
  log(`mẫu=${s.samples} tương quan(RAM trống, /v1/models)=${s.correlation ?? 'không tính được'}`);
  log('khoảng RAM\tmẫu\tmodels p50/p90/max (ms)\tcombo n\tcombo p50/p90/max (ms)');
  for (const r of s.rows) {
    const note = r.n < 5 ? ' (không đủ mẫu)' : '';
    const noteCombo = r.comboN > 0 && r.comboN < 5 ? ' (combo không đủ mẫu)' : '';
    log(
      `${r.bucket}\t${r.n}\t${r.modelsP50 ?? '-'}/${r.modelsP90 ?? '-'}/${r.modelsMax ?? '-'}\t${r.comboN}\t${r.comboP50 ?? '-'}/${r.comboP90 ?? '-'}/${r.comboMax ?? '-'}${note}${noteCombo}`
    );
  }
}
