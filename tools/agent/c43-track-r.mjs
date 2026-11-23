#!/usr/bin/env node
/**
 * tools/agent/c43-track-r.mjs
 *
 * C43 / C43A Track R:
 *   1. Bước 1 (runR2Offline): tính lại ngoại tuyến C38 + C40 với nhãn LOW-SAMPLE (0 request mạng).
 *   2. Bước 2 (checkR1Gate): cổng kiểm tra an toàn PATCH_V2 / PATCH_V3 + cổng TCP (0 GET /v1/models).
 *   3. Bước 3 (runR1Matrix): ma trận ngẫu nhiên 2×2 có kiểm soát (stream × concurrency, 18 mẫu/combo,
 *      trần cứng <= 40 request, dừng ngay khi 3 lần 429 liên tiếp, kèm tiết lộ nhiễu ponytailEnabled + promptTokens).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openBetterSqlite3, locateRouterDb } from '../../packages/core/dist/index.js';
import {
  parseReliabilityText,
  relabelReliabilityText,
} from '../../packages/cli/dist/commands/combos-reorder.js';
import {
  perStepConclusion,
  redact,
  runCombosProbeCommand,
} from '../../packages/cli/dist/commands/combos-probe.js';
import {
  MARK_V1,
  MARK_V2,
  MARK_V3,
  patchLoaded,
  readFileModifiedMs,
  readProcessStartMs,
  readVersion,
  routerPaths,
} from './nine-router-patch.mjs';
import { extractLowSampleCandidates, finalize } from './combo-finalize.mjs';

export const MAX_TRACK_R_REQUESTS = 40;
export const MAX_R1_CONSECUTIVE_429 = 3;
export const DEFAULT_R1_TIMEOUT_MS = 60_000;
export const DEFAULT_R1_GAP_MS = 30_000;
export const DEFAULT_R1_MAX_TOKENS = 8;
export const DEFAULT_R1_BASE_URL = 'http://127.0.0.1:20128';
export const R1_PROMPT = 'Trả lời đúng một từ: ok';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function maskPaths(text) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
  let out = String(text ?? '');
  if (home && home.length >= 3) {
    out = out.split(home).join('<HOME>');
    out = out.split(home.replace(/\\/g, '/')).join('<HOME>');
  }
  return out;
}

function readGitBlobOrThrow(refAndPath, cwd = process.cwd()) {
  return execFileSync('git', ['show', refAndPath], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Bước 1: tính lại ngoại tuyến C38 (w4) + C40 (x2 + combo-rs) hoàn toàn không gọi mạng.
 */
export function runR2Offline(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const cwd = opts.cwd ?? process.cwd();
  const w4Text = opts.w4Text ?? (opts.w4Path ? fs.readFileSync(opts.w4Path, 'utf8') : readGitBlobOrThrow('origin/evidence/c38:evidence/C38/w4-reliability.out.txt', cwd));
  const x2Text = opts.x2Text ?? (opts.x2Path ? fs.readFileSync(opts.x2Path, 'utf8') : readGitBlobOrThrow('origin/evidence/c40:evidence/C40/x2-remaining.out.txt', cwd));
  const listsText = opts.listsText ?? (opts.listsPath ? fs.readFileSync(opts.listsPath, 'utf8') : readGitBlobOrThrow('origin/evidence/c40:evidence/C40/combo-rs.txt', cwd));

  const w4Relabeled = relabelReliabilityText(w4Text);
  const x2Relabeled = relabelReliabilityText(x2Text);
  const changes = [...w4Relabeled.changes, ...x2Relabeled.changes];

  const parsedX2After = parseReliabilityText(x2Relabeled.text);
  const keptDead = [...parsedX2After.entries()]
    .filter(([, info]) => info.label === 'DEAD')
    .map(([step]) => step);
  const keptRateLimited = [...parsedX2After.entries()]
    .filter(([, info]) => info.label === 'RATE-LIMITED')
    .map(([step]) => step);

  const beforeFinalize = finalize(listsText, [w4Text, x2Text]);
  const afterFinalize = finalize(listsText, [w4Relabeled.text, x2Relabeled.text]);
  const rsFastUnchanged = JSON.stringify(beforeFinalize.fast) === JSON.stringify(afterFinalize.fast);
  const lowSampleCandidates = extractLowSampleCandidates([w4Relabeled.text, x2Relabeled.text]);

  log(
    `R2_OFFLINE changes=${changes.length} keptDead=${keptDead.length} keptRateLimited=${keptRateLimited.length} rsFastUnchanged=${rsFastUnchanged} lowSampleCandidates=${lowSampleCandidates.length}`
  );
  for (const item of lowSampleCandidates) {
    log(`R2_CANDIDATE ${item.step}\tLOW-SAMPLE\tok=${item.ok}/${item.attempts}\tp90=${item.p90Ms ?? '-'}ms`);
  }
  for (const deadStep of keptDead) {
    const d = parsedX2After.get(deadStep);
    log(`R2_KEPT_DEAD ${deadStep}\tDEAD\tok=${d?.ok ?? 0}/${d?.attempts ?? 0}\tp90=${d?.p90Ms ?? '-'}ms`);
  }

  return {
    changesCount: changes.length,
    changes,
    keptDead,
    keptRateLimited,
    rsFastUnchanged,
    rsFast: afterFinalize.fast,
    rsMax: afterFinalize.max,
    lowSampleCandidates,
  };
}

/**
 * Đọc trạng thái tệp custom-server.js của 9Router ở chế độ chỉ đọc.
 */
export function inspectRouterPatchStatus(statusOpts = {}) {
  const defaults = routerPaths();
  const target = statusOpts.target ?? defaults.target;
  const packageJson = statusOpts.packageJson ?? defaults.packageJson;
  if (!fs.existsSync(target)) {
    return {
      found: false,
      version: null,
      patchV1: false,
      patchV2: false,
      patchV3: false,
      loaded: 'unknown',
    };
  }
  const source = fs.readFileSync(target, 'utf8');
  const version = readVersion(packageJson);
  let pid = typeof statusOpts.pid === 'number' ? statusOpts.pid : Number.NaN;
  if (statusOpts.pid === undefined) {
    try {
      const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
      const pidFile = statusOpts.pidFile ?? path.join(appData, '9router', 'launcher.pid');
      const parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (typeof parsed.serverPid === 'number') pid = parsed.serverPid;
    } catch {
      pid = Number.NaN;
    }
  }
  const processStartMs = statusOpts.processStartMs ?? readProcessStartMs(pid);
  const fileModifiedMs = statusOpts.fileModifiedMs ?? readFileModifiedMs(target);
  return {
    found: true,
    version,
    patchV1: source.includes(MARK_V1),
    patchV2: source.includes(MARK_V2),
    patchV3: source.includes(MARK_V3),
    loaded: patchLoaded(processStartMs, fileModifiedMs),
  };
}

/**
 * Kiểm tra cổng TCP bằng net.createConnection (tuyệt đối 0 HTTP /v1/models).
 */
export function checkTcpListening(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Đọc ponytailEnabled và sự hiện diện của 9Router-Agent-1 / rs-fast từ SQLite ở chế độ chỉ đọc.
 */
export function readTrackRDbInfo(dbPath) {
  const resolved = dbPath?.trim() || process.env['ROUTERSYNC_9ROUTER_DB']?.trim() || locateRouterDb('9router');
  if (!resolved || !fs.existsSync(resolved)) {
    return { dbReadable: false, ponytailEnabled: null, hasAgent1: false, hasRsFast: false };
  }
  let db;
  try {
    db = openBetterSqlite3(resolved, { readOnly: true, busyTimeoutMs: 5000 });
    let ponytailEnabled = null;
    try {
      const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      if (settingsRow && typeof settingsRow.data === 'string') {
        const parsed = JSON.parse(settingsRow.data);
        if (typeof parsed?.ponytailEnabled === 'boolean') {
          ponytailEnabled = parsed.ponytailEnabled;
        }
      }
    } catch {
      ponytailEnabled = null;
    }
    const comboRows = db.prepare('SELECT name FROM combos').all();
    const names = new Set(comboRows.map((r) => String(r.name)));
    return {
      dbReadable: true,
      ponytailEnabled,
      hasAgent1: names.has('9Router-Agent-1'),
      hasRsFast: names.has('rs-fast'),
    };
  } catch {
    return { dbReadable: false, ponytailEnabled: null, hasAgent1: false, hasRsFast: false };
  } finally {
    db?.close();
  }
}

function parseHostPort(baseUrl) {
  const u = new URL(baseUrl);
  const host = u.hostname || '127.0.0.1';
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { host, port };
}

/**
 * Bước 2: Cổng an toàn trước khi đo R1 (0 HTTP request, 0 GET /v1/models).
 */
export async function checkR1Gate(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const baseUrl = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_R1_BASE_URL;
  const { host, port } = parseHostPort(baseUrl);
  const inspectFn = opts.inspectStatus ?? inspectRouterPatchStatus;
  const tcpFn = opts.tcpCheck ?? checkTcpListening;

  const patchInfo = inspectFn(opts.statusOpts ?? {});
  const portListening = await tcpFn(host, port, opts.tcpTimeoutMs ?? 1500);
  const dbInfo = opts.dbPath === null ? { dbReadable: false, ponytailEnabled: null, hasAgent1: false, hasRsFast: false } : readTrackRDbInfo(opts.dbPath);

  const gate = {
    version: patchInfo.version ?? 'unknown',
    patchV1: Boolean(patchInfo.patchV1),
    patchV2: Boolean(patchInfo.patchV2),
    patchV3: Boolean(patchInfo.patchV3),
    loaded: patchInfo.loaded ?? 'unknown',
    portListening: Boolean(portListening),
    ponytailEnabled: dbInfo.ponytailEnabled,
    hasAgent1: Boolean(dbInfo.hasAgent1),
    hasRsFast: Boolean(dbInfo.hasRsFast),
  };

  log(
    `R1_GATE version=${gate.version} patchV1=${gate.patchV1} patchV2=${gate.patchV2} patchV3=${gate.patchV3} loaded=${gate.loaded} portListening=${gate.portListening} ponytailEnabled=${gate.ponytailEnabled ?? 'unknown'} hasAgent1=${gate.hasAgent1} hasRsFast=${gate.hasRsFast}`
  );

  let blockReason = null;
  if (!opts.liveR1) blockReason = 'missing_live_r1_flag';
  else if (!opts.yesSpendTokens) blockReason = 'missing_yes_spend_tokens';
  else if (gate.patchV2 === true) blockReason = 'patchV2_present';
  else if (gate.portListening !== true) blockReason = 'port_not_listening';

  if (blockReason !== null) {
    log(`R1_STATUS=chưa đo reason=${blockReason}`);
    return { allowed: false, status: 'chưa đo', reason: blockReason, gate };
  }

  return { allowed: true, status: 'đủ điều kiện', reason: null, gate };
}

function createMulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildShuffledR1Schedule(seed) {
  const cells = [];
  const defs = [
    { cell: 'stream_on_c1', stream: true, concurrency: 1 },
    { cell: 'stream_off_c1', stream: false, concurrency: 1 },
    { cell: 'stream_on_c2', stream: true, concurrency: 2 },
    { cell: 'stream_off_c2', stream: false, concurrency: 2 },
  ];
  for (const def of defs) {
    for (let rep = 1; rep <= 3; rep += 1) {
      cells.push({ ...def, rep });
    }
  }
  const rng = createMulberry32(seed);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cells[i];
    cells[i] = cells[j];
    cells[j] = tmp;
  }
  return cells;
}

function isHangVerdict(verdict) {
  return (
    verdict === 'HANG-NO-USAGE' ||
    verdict === 'HANG-AFTER-USAGE' ||
    verdict === 'TIMEOUT-NO-HEADER'
  );
}

function averagePromptTokens(rows) {
  const vals = rows
    .map((r) => r.promptTokens)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Number.isInteger(avg) ? avg : Math.round(avg * 10) / 10;
}

/**
 * Phân loại kết quả ma trận 2×2 theo đúng quy tắc C43 §3.3 & C43A §3.3.
 */
export function classifyR1Matrix(rows, opts = {}) {
  const ponytailEnabled = opts.ponytailEnabled ?? null;
  const stoppedEarly = opts.stoppedEarly ?? null;

  const streamOnC1Hangs = rows.filter((r) => r.stream === true && r.concurrency === 1 && isHangVerdict(r.verdict)).length;
  const streamOffC1Hangs = rows.filter((r) => r.stream === false && r.concurrency === 1 && isHangVerdict(r.verdict)).length;
  const streamOnC2Hangs = rows.filter((r) => r.stream === true && r.concurrency === 2 && isHangVerdict(r.verdict)).length;
  const streamOffC2Hangs = rows.filter((r) => r.stream === false && r.concurrency === 2 && isHangVerdict(r.verdict)).length;

  const c1Hangs = streamOnC1Hangs + streamOffC1Hangs;
  const c2Hangs = streamOnC2Hangs + streamOffC2Hangs;
  const totalHangs = c1Hangs + c2Hangs;

  const streamOnC1 = rows.filter((r) => r.stream === true && r.concurrency === 1);
  const streamOffC1 = rows.filter((r) => r.stream === false && r.concurrency === 1);
  const streamOnAvgTokens =
    averagePromptTokens(streamOnC1) ?? averagePromptTokens(rows.filter((r) => r.stream === true));
  const streamOffAvgTokens =
    averagePromptTokens(streamOffC1) ?? averagePromptTokens(rows.filter((r) => r.stream === false));

  const breakdown = {
    streamOnC1Hangs,
    streamOffC1Hangs,
    streamOnC2Hangs,
    streamOffC2Hangs,
    c1Hangs,
    c2Hangs,
    totalHangs,
    streamOnAvgTokens,
    streamOffAvgTokens,
  };

  if (stoppedEarly && /429/.test(String(stoppedEarly))) {
    return {
      label: 'dừng sớm (3 lần 429 liên tiếp)',
      confounderNote: null,
      breakdown,
    };
  }
  if (stoppedEarly && rows.length < 18) {
    return {
      label: `dừng sớm (${stoppedEarly})`,
      confounderNote: null,
      breakdown,
    };
  }
  if (totalHangs === 0 && rows.length >= 18) {
    return {
      label: 'không tái hiện trong 18 mẫu',
      confounderNote: null,
      breakdown,
    };
  }
  if (c2Hangs > 0 && c1Hangs === 0) {
    return {
      label: 'do đồng thời',
      confounderNote: null,
      breakdown,
    };
  }
  if (streamOnC1Hangs > 0 && streamOffC1Hangs === 0) {
    const confounderNote = `C43A §3.3 cảnh báo nhiễu (confounder): chế độ stream=true và cơ chế tiêm prompt ponytailEnabled=${ponytailEnabled ?? 'unknown'} (chỉ kích hoạt khi stream: true) bị trộn lẫn; promptTokens trung bình của ô stream=true là ${streamOnAvgTokens ?? '-'} so với stream=false là ${streamOffAvgTokens ?? '-'}.`;
    return {
      label: 'nghi đường stream',
      confounderNote,
      breakdown,
    };
  }
  if (streamOnC1Hangs > 0 && streamOffC1Hangs > 0) {
    return {
      label: 'treo ở cả hai chế độ stream (cần tách bước thượng nguồn)',
      confounderNote: null,
      breakdown,
    };
  }
  return {
    label: `cần tách thêm theo ô (s1c1=${streamOnC1Hangs}, s0c1=${streamOffC1Hangs}, s1c2=${streamOnC2Hangs}, s0c2=${streamOffC2Hangs})`,
    confounderNote: null,
    breakdown,
  };
}

function normalizeMatrixVerdict(probeRow) {
  if (probeRow.httpStatus === 429) return 'RATE-LIMITED';
  if (probeRow.httpStatus !== null && probeRow.httpStatus >= 400) {
    return perStepConclusion({
      status: probeRow.httpStatus,
      body: probeRow.detail,
      headerReceived: probeRow.headerMs !== null,
      usageRowAdded: probeRow.usageServedBy !== null,
      timedOut: false,
    });
  }
  return probeRow.verdict;
}

/**
 * Bước 3: Chạy ma trận ngẫu nhiên 2×2 có kiểm soát khi và chỉ khi qua cổng checkR1Gate.
 */
export async function runR1Matrix(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const gateResult = await checkR1Gate(opts);
  if (!gateResult.allowed) {
    return {
      allowed: false,
      status: gateResult.status,
      reason: gateResult.reason,
      gate: gateResult.gate,
      totalRequests: 0,
      stoppedEarly: gateResult.reason,
      combos: {},
    };
  }

  const baseUrl = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_R1_BASE_URL;
  const timeoutMs = Math.max(20, Math.floor(opts.timeoutMs ?? DEFAULT_R1_TIMEOUT_MS));
  const gapMs = Math.max(0, Math.floor(opts.gapMs ?? DEFAULT_R1_GAP_MS));
  const maxTokens = Math.min(DEFAULT_R1_MAX_TOKENS, Math.max(1, Math.floor(opts.maxTokens ?? DEFAULT_R1_MAX_TOKENS)));
  const hardCap = Math.min(MAX_TRACK_R_REQUESTS, Math.max(1, Math.floor(opts.maxRequests ?? MAX_TRACK_R_REQUESTS)));
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const pollSleepImpl = opts.pollSleepImpl ?? undefined;
  const baseSeed = Number.isInteger(opts.seed) ? opts.seed : Math.floor(Math.random() * 0x7fffffff);

  const targetCombos = ['9Router-Agent-1'];
  if (gateResult.gate.hasRsFast === true) {
    targetCombos.push('rs-fast');
  } else {
    log('R1_RS_FAST=chưa đo reason=combo_not_in_db');
  }

  let totalRequests = 0;
  let consecutive429 = 0;
  let stoppedEarly = null;
  let hasLaunchedAnyCell = false;
  const combosOut = {};

  for (let comboIdx = 0; comboIdx < targetCombos.length; comboIdx += 1) {
    const comboName = targetCombos[comboIdx];
    const comboSeed = (baseSeed + comboIdx * 1009) >>> 0;
    const schedule = buildShuffledR1Schedule(comboSeed);
    log(`R1_MATRIX_START combo=${comboName} seed=${comboSeed} cells=${schedule.length} maxTokens=${maxTokens} timeoutMs=${timeoutMs} gapMs=${gapMs}`);

    const comboRows = [];
    for (const item of schedule) {
      if (consecutive429 >= MAX_R1_CONSECUTIVE_429) {
        stoppedEarly = '3x429';
        break;
      }
      if (totalRequests + item.concurrency > hardCap) {
        stoppedEarly = `cap=${hardCap}`;
        break;
      }
      if (hasLaunchedAnyCell) {
        await sleepImpl(gapMs);
      }
      hasLaunchedAnyCell = true;

      const probeReport = await runCombosProbeCommand({
        mode: 'combo',
        combos: [comboName],
        concurrency: item.concurrency,
        repeat: 1,
        stream: item.stream,
        maxTokens,
        comboTimeoutMs: timeoutMs,
        yesSpendTokens: true,
        dbPath: opts.dbPath,
        baseUrl,
        fetchImpl: opts.fetchImpl,
        sleepImpl: pollSleepImpl,
        budget: item.concurrency,
        log: () => undefined,
      });

      probeReport.rows.forEach((pRow, slotIdx) => {
        totalRequests += 1;
        const verdict = normalizeMatrixVerdict(pRow);
        if (pRow.httpStatus === 429 || verdict === 'RATE-LIMITED') {
          consecutive429 += 1;
        } else {
          consecutive429 = 0;
        }
        const entry = {
          combo: comboName,
          cell: item.cell,
          rep: item.rep,
          slot: slotIdx + 1,
          stream: item.stream,
          concurrency: item.concurrency,
          httpStatus: pRow.httpStatus,
          headerMs: pRow.headerMs,
          totalMs: pRow.totalMs,
          verdict,
          promptTokens: pRow.promptTokens ?? null,
          completionTokens: pRow.completionTokens ?? null,
          usageServedBy: pRow.usageServedBy ? maskPaths(redact(pRow.usageServedBy, [])) : null,
        };
        comboRows.push(entry);
        log(
          `R1_ROW combo=${entry.combo}\tcell=${entry.cell}\trep=${entry.rep}\tslot=${entry.slot}\tstream=${entry.stream}\tconcurrency=${entry.concurrency}\thttp=${entry.httpStatus ?? '-'}\theader=${entry.headerMs ?? '-'}ms\ttotal=${entry.totalMs}ms\tverdict=${entry.verdict}\ttokens_in=${entry.promptTokens ?? '-'}\ttokens_out=${entry.completionTokens ?? '-'}\tusage=${entry.usageServedBy ?? '-'}`
        );
      });

      if (consecutive429 >= MAX_R1_CONSECUTIVE_429) {
        stoppedEarly = '3x429';
        break;
      }
    }

    const classification = classifyR1Matrix(comboRows, {
      stoppedEarly,
      ponytailEnabled: gateResult.gate.ponytailEnabled,
    });
    combosOut[comboName] = {
      seed: comboSeed,
      rows: comboRows,
      classification,
    };
    log(`R1_CLASSIFY combo=${comboName} count=${comboRows.length} conclusion="${classification.label}"`);
    if (classification.confounderNote) {
      log(`R1_CONFOUNDER combo=${comboName} ${classification.confounderNote}`);
    }

    if (stoppedEarly) break;
  }

  return {
    allowed: true,
    status: stoppedEarly ? 'dừng sớm' : 'hoàn tất',
    reason: stoppedEarly,
    gate: gateResult.gate,
    totalRequests,
    stoppedEarly,
    combos: combosOut,
  };
}

export { inspectRouterPatchStatus as inspectStatus };

function parseCliFlags(argv) {
  const out = {
    w4Path: undefined,
    x2Path: undefined,
    listsPath: undefined,
    dbPath: undefined,
    baseUrl: undefined,
    seed: undefined,
    target: undefined,
    packageJson: undefined,
    liveR1: false,
    yesSpendTokens: false,
    skipR2: false,
    r2Only: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--w4' && argv[i + 1]) {
      out.w4Path = argv[++i];
    } else if (arg === '--x2' && argv[i + 1]) {
      out.x2Path = argv[++i];
    } else if (arg === '--lists' && argv[i + 1]) {
      out.listsPath = argv[++i];
    } else if (arg === '--db' && argv[i + 1]) {
      out.dbPath = argv[++i];
    } else if (arg === '--base-url' && argv[i + 1]) {
      out.baseUrl = argv[++i];
    } else if (arg === '--seed' && argv[i + 1]) {
      out.seed = Number.parseInt(argv[++i], 10);
    } else if (arg === '--live-r1') {
      out.liveR1 = true;
    } else if (arg === '--yes-spend-tokens') {
      out.yesSpendTokens = true;
    } else if (arg === '--target' && argv[i + 1]) {
      out.target = argv[++i];
    } else if (arg === '--package-json' && argv[i + 1]) {
      out.packageJson = argv[++i];
    } else if (arg === '--skip-r2') {
      out.skipR2 = true;
    } else if (arg === '--r2-only') {
      out.r2Only = true;
    }
  }
  return out;
}

async function main() {
  const flags = parseCliFlags(process.argv.slice(2));
  if (!flags.skipR2) {
    runR2Offline({
      w4Path: flags.w4Path,
      x2Path: flags.x2Path,
      listsPath: flags.listsPath,
    });
  }
  if (flags.r2Only) return;
  await runR1Matrix({
    dbPath: flags.dbPath,
    baseUrl: flags.baseUrl,
    seed: flags.seed,
    liveR1: flags.liveR1,
    yesSpendTokens: flags.yesSpendTokens,
    statusOpts:
      flags.target || flags.packageJson
        ? {
            ...(flags.target ? { target: flags.target } : {}),
            ...(flags.packageJson ? { packageJson: flags.packageJson } : {}),
            pid: -1,
          }
        : undefined,
  });
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  main().catch((err) => {
    console.error(`[c43-track-r] lỗi: ${maskPaths(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
}
