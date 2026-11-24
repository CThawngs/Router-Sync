#!/usr/bin/env node
/**
 * tools/agent/c44-track-w.mjs
 *
 * C44 Track W Gated Runner (9Router 0.5.123):
 *   - w1 (runTrackWW1): 3 vòng đo đồng thời GET /v1/models + POST /v1/chat/completions (trần 3 GET + 3 chat).
 *   - w3 (runTrackWW3): lấy mẫu tuổi tiến trình router hoàn toàn 0 GET /v1/models (chỉ dùng readRouterPid,
 *     readRouterProcess, readProcessStartMs, os.freemem()) + tối đa 3 probe stream ngắn khi đủ mốc tuổi.
 *   - w5 (runTrackWW5): kiểm tra rs-fast trong DB chỉ đọc (0 HTTP khi vắng mặt) hoặc chạy ma trận 2×2 18 mẫu.
 *   - Sổ cái gộp toàn Track W: MAX_TRACK_W_CHAT = 30, MAX_TRACK_W_MODELS_GET = 3, MAX_TRACK_W_CONSECUTIVE_429 = 3.
 *   - Mặc định dry-run: không có --yes-spend-tokens thì gửi đúng 0 HTTP request.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBetterSqlite3, locateRouterDb } from '../../packages/core/dist/index.js';
import { reconcileSentVsUsage } from '../../packages/cli/dist/commands/combos-budget.js';
import {
  callComboWithUsage,
  perStepConclusion,
  readRouterState,
  redact,
  runCombosProbeCommand,
} from '../../packages/cli/dist/commands/combos-probe.js';
import { readRouterPid, readRouterProcess } from '../../packages/cli/dist/commands/router-watch.js';
import { readProcessStartMs } from './nine-router-patch.mjs';
import {
  DEFAULT_R1_BASE_URL,
  DEFAULT_R1_GAP_MS,
  DEFAULT_R1_MAX_TOKENS,
  DEFAULT_R1_TIMEOUT_MS,
  R1_PROMPT,
  buildShuffledR1Schedule,
  classifyR1Matrix,
  inspectRouterPatchStatus,
  readTrackRDbInfo,
} from './c43-track-r.mjs';

export const MAX_TRACK_W_CHAT = 30;
export const MAX_TRACK_W_MODELS_GET = 3;
export const MAX_TRACK_W_CONSECUTIVE_429 = 3;
export const DEFAULT_TRACK_W_LEDGER_PATH = '.agent/evidence/c44-track-w-ledger.json';
export const DEFAULT_W1_INTERVAL_MS = 60_000;
export const DEFAULT_W1_MODELS_TIMEOUT_MS = 15_000;
export const DEFAULT_W1_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_W3_MIN_AGE_HOURS = 5.5;

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

function normalizeLedgerObject(target = {}) {
  target.chatSent = Number.isInteger(target.chatSent) && target.chatSent >= 0 ? target.chatSent : 0;
  target.modelsGetSent =
    Number.isInteger(target.modelsGetSent) && target.modelsGetSent >= 0 ? target.modelsGetSent : 0;
  target.consecutive429 =
    Number.isInteger(target.consecutive429) && target.consecutive429 >= 0 ? target.consecutive429 : 0;
  target.haltedReason = typeof target.haltedReason === 'string' && target.haltedReason ? target.haltedReason : null;
  target.baselinePid = typeof target.baselinePid === 'number' && Number.isFinite(target.baselinePid) ? target.baselinePid : null;
  target.baselineProcessStartIso =
    typeof target.baselineProcessStartIso === 'string' && target.baselineProcessStartIso
      ? target.baselineProcessStartIso
      : null;
  return target;
}

function openLedgerStore(opts = {}) {
  if (opts.ledger && typeof opts.ledger === 'object') {
    const ledger = normalizeLedgerObject(opts.ledger);
    return {
      ledger,
      save() {
        normalizeLedgerObject(ledger);
      },
    };
  }
  const ledgerPath = opts.ledgerPath ?? DEFAULT_TRACK_W_LEDGER_PATH;
  let loaded = {};
  if (ledgerPath && fs.existsSync(ledgerPath)) {
    try {
      loaded = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    } catch {
      loaded = {};
    }
  }
  const ledger = normalizeLedgerObject(loaded);
  return {
    ledger,
    save() {
      normalizeLedgerObject(ledger);
      if (!ledgerPath) return;
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    },
  };
}

function resolveExistingDbFile(dbPath) {
  const candidate = dbPath?.trim() || process.env['ROUTERSYNC_9ROUTER_DB']?.trim() || locateRouterDb('9router');
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

function readUsageRowCount(dbPath) {
  const file = resolveExistingDbFile(dbPath);
  if (!file) return 0;
  let db;
  try {
    db = openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
    const row = db.prepare('SELECT COUNT(*) AS n FROM usageHistory').get();
    return typeof row?.n === 'number' && Number.isFinite(row.n) ? row.n : 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

function readMaxUsageId(dbPath) {
  const file = resolveExistingDbFile(dbPath);
  if (!file) return null;
  let db;
  try {
    db = openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM usageHistory').get();
    return typeof row?.maxId === 'number' && Number.isFinite(row.maxId) ? row.maxId : 0;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function readUsageRowsSinceId(maxIdBefore, startMs, dbPath) {
  const file = resolveExistingDbFile(dbPath);
  if (!file || maxIdBefore === null) return [];
  let db;
  try {
    db = openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
    const rows = db
      .prepare(
        'SELECT id, timestamp, provider, model, status, promptTokens, completionTokens FROM usageHistory WHERE id > ? ORDER BY id ASC'
      )
      .all(maxIdBefore);
    return rows.map((r) => {
      const parsedTs = Date.parse(r.timestamp);
      return {
        id: r.id,
        atMs: Number.isFinite(parsedTs) ? Math.max(0, parsedTs - startMs) : 0,
        provider: r.provider,
        model: r.model,
        status: r.status ?? null,
        promptTokens: typeof r.promptTokens === 'number' && Number.isFinite(r.promptTokens) ? r.promptTokens : null,
        completionTokens:
          typeof r.completionTokens === 'number' && Number.isFinite(r.completionTokens) ? r.completionTokens : null,
      };
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function logRemainingBudget(log, ledger) {
  const chatRem = Math.max(0, MAX_TRACK_W_CHAT - ledger.chatSent);
  const modelsRem = Math.max(0, MAX_TRACK_W_MODELS_GET - ledger.modelsGetSent);
  log(
    `TRACK_W_BUDGET chatSent=${ledger.chatSent}/${MAX_TRACK_W_CHAT} chatRemaining=${chatRem} modelsGetSent=${ledger.modelsGetSent}/${MAX_TRACK_W_MODELS_GET} modelsGetRemaining=${modelsRem} haltedReason=${ledger.haltedReason ?? 'none'}`
  );
}

function checkPreFlightSafety(opts, ledger, log) {
  if (ledger.haltedReason !== null) {
    log(`TRACK_W_HALTED reason=${ledger.haltedReason}`);
    return { ok: false, reason: ledger.haltedReason };
  }
  const inspectFn = opts.inspectStatus ?? inspectRouterPatchStatus;
  const patchInfo = inspectFn(opts.statusOpts ?? {});
  if (patchInfo.patchV2 === true) {
    log('TRACK_W_REFUSED reason=patchV2_present');
    return { ok: false, reason: 'patchV2_present' };
  }
  return { ok: true, reason: null, patchInfo };
}

/**
 * Phân loại thuần cho W1 (3 vòng đo nghẽn vòng lặp sự kiện /v1/models).
 */
export function classifyW1Blocking(samples) {
  if (!Array.isArray(samples) || samples.length < 3) {
    return 'không đủ dữ liệu';
  }
  const rounds = samples.slice(0, 3);
  for (const r of rounds) {
    if (
      !r ||
      r.modelsStatus !== 200 ||
      r.chatStatus === null ||
      r.chatStatus === undefined ||
      r.chatStatus === 429 ||
      typeof r.modelsTotalMs !== 'number' ||
      !Number.isFinite(r.modelsTotalMs) ||
      typeof r.chatHeaderMs !== 'number' ||
      !Number.isFinite(r.chatHeaderMs)
    ) {
      return 'không đủ dữ liệu';
    }
  }
  const isBlocking = rounds.some(
    (r) => r.modelsTotalMs >= 3_000 || (r.modelsTotalMs >= 2_000 && r.chatHeaderMs >= r.modelsTotalMs * 0.8)
  );
  return isBlocking ? 'còn nghẽn' : 'hết nghẽn';
}

async function measureW1Models(baseUrl, apiKey, timeoutMs, fetchImpl) {
  const t0 = Date.now();
  let headerMs = null;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    headerMs = Date.now() - t0;
    const rawBuf = Buffer.from(await res.arrayBuffer());
    return {
      modelsStatus: res.status,
      modelsHeaderMs: headerMs,
      modelsTotalMs: Date.now() - t0,
      modelsBytes: rawBuf.byteLength,
    };
  } catch {
    return {
      modelsStatus: null,
      modelsHeaderMs: headerMs,
      modelsTotalMs: Date.now() - t0,
      modelsBytes: 0,
    };
  }
}

async function measureW1Chat(baseUrl, apiKey, timeoutMs, fetchImpl) {
  const t0 = Date.now();
  let headerMs = null;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: '9Router-Agent-1',
        messages: [{ role: 'user', content: R1_PROMPT }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    headerMs = Date.now() - t0;
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    } else {
      await res.text().catch(() => '');
    }
    return {
      chatStatus: res.status,
      chatHeaderMs: headerMs,
      chatTotalMs: Date.now() - t0,
    };
  } catch {
    return {
      chatStatus: null,
      chatHeaderMs: headerMs,
      chatTotalMs: Date.now() - t0,
    };
  }
}

/**
 * Subcommand w1: đo 3 vòng đồng thời GET /v1/models + POST /v1/chat/completions.
 */
export async function runTrackWW1(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const baseUrl = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_R1_BASE_URL;
  const intervalMs = Math.max(0, Math.floor(opts.intervalMs ?? DEFAULT_W1_INTERVAL_MS));
  const modelsTimeoutMs = Math.max(50, Math.floor(opts.modelsTimeoutMs ?? DEFAULT_W1_MODELS_TIMEOUT_MS));
  const chatTimeoutMs = Math.max(50, Math.floor(opts.chatTimeoutMs ?? DEFAULT_W1_CHAT_TIMEOUT_MS));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const { ledger, save: saveLedger } = openLedgerStore(opts);

  logRemainingBudget(log, ledger);
  if (!opts.yesSpendTokens) {
    log(`W1_DRY_RUN baseUrl=${baseUrl} rounds=3 plannedModelsGet=3 plannedChat=3 intervalMs=${intervalMs}`);
    return { dryRun: true, sentChat: 0, sentModelsGet: 0, ledger };
  }

  const safety = checkPreFlightSafety(opts, ledger, log);
  if (!safety.ok) {
    return {
      dryRun: false,
      allowed: false,
      reason: safety.reason,
      stoppedEarly: safety.reason,
      sentChat: 0,
      sentModelsGet: 0,
      rounds: [],
      conclusion: 'không đủ dữ liệu',
      ledger,
    };
  }

  if (
    MAX_TRACK_W_MODELS_GET - ledger.modelsGetSent < 3 ||
    MAX_TRACK_W_CHAT - ledger.chatSent < 3
  ) {
    log('W1_REFUSED reason=insufficient_track_w_budget');
    return {
      dryRun: false,
      allowed: false,
      reason: 'insufficient_track_w_budget',
      stoppedEarly: 'insufficient_track_w_budget',
      sentChat: 0,
      sentModelsGet: 0,
      rounds: [],
      conclusion: 'không đủ dữ liệu',
      ledger,
    };
  }

  const apiKey = opts.apiKey !== undefined ? opts.apiKey : readRouterState(opts.dbPath).apiKey;
  const usageBefore = readUsageRowCount(opts.dbPath);
  const rounds = [];
  let sentChat = 0;
  let sentModelsGet = 0;
  let stoppedEarly = null;

  for (let round = 1; round <= 3; round += 1) {
    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
      saveLedger();
      break;
    }
    if (round > 1 && intervalMs > 0) {
      await sleepImpl(intervalMs);
    }

    ledger.modelsGetSent += 1;
    sentModelsGet += 1;
    const modelsPromise = measureW1Models(baseUrl, apiKey, modelsTimeoutMs, fetchImpl);

    ledger.chatSent += 1;
    sentChat += 1;
    saveLedger();
    const chatPromise = measureW1Chat(baseUrl, apiKey, chatTimeoutMs, fetchImpl);

    const [modelsRes, chatRes] = await Promise.all([modelsPromise, chatPromise]);
    if (chatRes.chatStatus === 429) {
      ledger.consecutive429 += 1;
    } else {
      ledger.consecutive429 = 0;
    }
    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
    }
    saveLedger();

    const sample = {
      round,
      ...modelsRes,
      ...chatRes,
    };
    rounds.push(sample);
    log(
      `W1_ROUND round=${round} modelsStatus=${sample.modelsStatus ?? '-'} modelsHeaderMs=${sample.modelsHeaderMs ?? '-'} modelsTotalMs=${sample.modelsTotalMs ?? '-'} modelsBytes=${sample.modelsBytes} chatStatus=${sample.chatStatus ?? '-'} chatHeaderMs=${sample.chatHeaderMs ?? '-'} chatTotalMs=${sample.chatTotalMs ?? '-'}`
    );

    if (stoppedEarly) break;
  }

  const conclusion = classifyW1Blocking(rounds);
  log(`W1_CONCLUSION=${conclusion}`);
  if (conclusion === 'còn nghẽn') {
    log(
      'W1_OWNER_NOTE PATCH_V3 đủ điều kiện đưa vào hàng đợi chờ chủ dự án: node tools/agent/nine-router-patch.mjs apply --yes-write-router (tác tử tuyệt đối không tự chạy)'
    );
  }

  const usageAfter = readUsageRowCount(opts.dbPath);
  const reconciliation = reconcileSentVsUsage(sentChat, Math.max(0, usageAfter - usageBefore));
  log(
    `W1_RECONCILE sent=${reconciliation.sentRequests} usageHistory=${reconciliation.usageHistoryRows} delta=${reconciliation.delta}`
  );

  return {
    dryRun: false,
    allowed: true,
    stoppedEarly,
    sentChat,
    sentModelsGet,
    rounds,
    conclusion,
    reconciliation,
    ledger,
  };
}

function isHangVerdict(verdict) {
  return (
    verdict === 'HANG-NO-USAGE' ||
    verdict === 'HANG-AFTER-USAGE' ||
    verdict === 'TIMEOUT-NO-HEADER'
  );
}

/**
 * Subcommand w3: lấy mẫu tuổi tiến trình router hoàn toàn 0 GET /v1/models.
 */
export async function runTrackWW3(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const baseUrl = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_R1_BASE_URL;
  const minAgeHours =
    typeof opts.minAgeHours === 'number' && Number.isFinite(opts.minAgeHours)
      ? opts.minAgeHours
      : DEFAULT_W3_MIN_AGE_HOURS;
  const timeoutMs = Math.max(20, Math.floor(opts.timeoutMs ?? DEFAULT_R1_TIMEOUT_MS));
  const pollMs = Math.max(10, Math.floor(opts.pollMs ?? 1_000));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const nowFn = opts.now ?? Date.now;
  const nowMs = nowFn();
  const { ledger, save: saveLedger } = openLedgerStore(opts);

  // TUYỆT ĐỐI 0 GET /v1/models: chỉ đọc PID, thông tin tiến trình hệ điều hành và RAM trống.
  const pid = opts.pid !== undefined ? opts.pid : (opts.readRouterPidImpl ?? readRouterPid)();
  const proc = opts.processInfo ?? (opts.readRouterProcessImpl ?? readRouterProcess)(pid);
  const processStartMs =
    opts.processStartMs !== undefined
      ? opts.processStartMs
      : pid !== null
        ? (opts.readProcessStartMsImpl ?? readProcessStartMs)(pid)
        : Number.NaN;
  const freeMemBytes = opts.freeMemBytes !== undefined ? opts.freeMemBytes : os.freemem();

  const processStartIso = Number.isFinite(processStartMs) ? new Date(processStartMs).toISOString() : null;
  let ageHours = null;
  if (Number.isFinite(processStartMs)) {
    ageHours = Math.round((Math.max(0, nowMs - processStartMs) / 3_600_000) * 100) / 100;
  } else if (typeof proc?.ageSec === 'number' && Number.isFinite(proc.ageSec)) {
    ageHours = Math.round((Math.max(0, proc.ageSec) / 3600) * 100) / 100;
  }

  let restarted = false;
  if (pid === null || pid === undefined || pid <= 0) {
    restarted = true;
  } else if (ledger.baselinePid === null) {
    ledger.baselinePid = pid;
    ledger.baselineProcessStartIso = processStartIso;
    if (opts.yesSpendTokens || opts.ledger || opts.ledgerPath) {
      saveLedger();
    }
  } else if (
    ledger.baselinePid !== pid ||
    ledger.baselineProcessStartIso !== processStartIso
  ) {
    restarted = true;
  }

  const sample = {
    pid: pid ?? null,
    processStartIso,
    ageHours,
    restarted,
    freeMemMB: Math.round(freeMemBytes / (1024 * 1024)),
    routerRssMB: proc?.rssMB ?? null,
    routerCpuSec: proc?.cpuSec ?? null,
  };

  log(
    `W3_SAMPLE pid=${sample.pid ?? 'null'} processStart=${sample.processStartIso ?? 'null'} ageHours=${sample.ageHours ?? 'null'} restarted=${sample.restarted} freeMemMB=${sample.freeMemMB} routerRssMB=${sample.routerRssMB ?? 'null'} routerCpuSec=${sample.routerCpuSec ?? 'null'}`
  );
  logRemainingBudget(log, ledger);

  if (!opts.yesSpendTokens) {
    log(`W3_DRY_RUN minAgeHours=${minAgeHours} maxProbes=3 modelsGet=0`);
    return { dryRun: true, sentChat: 0, sentModelsGet: 0, sample, ledger };
  }

  const safety = checkPreFlightSafety(opts, ledger, log);
  if (!safety.ok) {
    return {
      dryRun: false,
      allowed: false,
      reason: safety.reason,
      stoppedEarly: safety.reason,
      sentChat: 0,
      sentModelsGet: 0,
      sample,
      rows: [],
      ledger,
    };
  }

  if (restarted) {
    log('W3_SKIP reason=router_restarted');
    return {
      dryRun: false,
      skippedReason: 'router_restarted',
      sentChat: 0,
      sentModelsGet: 0,
      sample,
      rows: [],
      ledger,
    };
  }

  if (ageHours === null || ageHours < minAgeHours) {
    log(`W3_SKIP reason=below_min_age ageHours=${ageHours ?? 'null'} minAgeHours=${minAgeHours}`);
    return {
      dryRun: false,
      skippedReason: 'below_min_age',
      sentChat: 0,
      sentModelsGet: 0,
      sample,
      rows: [],
      ledger,
    };
  }

  if (MAX_TRACK_W_CHAT - ledger.chatSent < 1) {
    log('W3_REFUSED reason=insufficient_track_w_budget');
    return {
      dryRun: false,
      allowed: false,
      reason: 'insufficient_track_w_budget',
      stoppedEarly: 'insufficient_track_w_budget',
      sentChat: 0,
      sentModelsGet: 0,
      sample,
      rows: [],
      ledger,
    };
  }

  const apiKey = opts.apiKey !== undefined ? opts.apiKey : readRouterState(opts.dbPath).apiKey;
  const usageBefore = readUsageRowCount(opts.dbPath);
  const rows = [];
  let sentChat = 0;
  let stoppedEarly = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
      saveLedger();
      break;
    }
    if (ledger.chatSent >= MAX_TRACK_W_CHAT) {
      stoppedEarly = 'max_track_w_chat';
      break;
    }

    ledger.chatSent += 1;
    sentChat += 1;
    saveLedger();

    const maxIdBefore = readMaxUsageId(opts.dbPath);
    const attemptUsageCount =
      maxIdBefore !== null ? () => readMaxUsageId(opts.dbPath) ?? maxIdBefore : () => 0;
    const attemptUsageRows =
      maxIdBefore !== null ? (t0) => readUsageRowsSinceId(maxIdBefore, t0, opts.dbPath) : () => [];

    const res = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      apiKey,
      {
        model: '9Router-Agent-1',
        messages: [{ role: 'user', content: R1_PROMPT }],
        max_tokens: 8,
        stream: true,
      },
      timeoutMs,
      fetchImpl,
      attemptUsageCount,
      pollMs,
      opts.pollSleepImpl,
      Date.now,
      attemptUsageRows,
      true,
      opts.dbPath
    );

    if (res.row.httpStatus === 429) {
      ledger.consecutive429 += 1;
    } else {
      ledger.consecutive429 = 0;
    }
    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
    }
    saveLedger();

    const safeServedBy = res.row.usageServedBy ? maskPaths(redact(res.row.usageServedBy, [apiKey])) : null;
    const safeUsageRows = (res.row.usageRows ?? res.usage ?? []).map((u) => ({
      atMs: u.atMs,
      provider: maskPaths(redact(String(u.provider ?? ''), [apiKey])),
      model: maskPaths(redact(String(u.model ?? ''), [apiKey])),
      status: u.status ?? null,
      promptTokens: u.promptTokens ?? null,
      completionTokens: u.completionTokens ?? null,
    }));

    const probeRow = {
      attempt,
      ageHours,
      startedAt: res.row.startedAt,
      httpStatus: res.row.httpStatus,
      headerMs: res.row.headerMs,
      totalMs: res.row.totalMs,
      verdict: res.row.verdict,
      usageServedBy: safeServedBy,
      usageRows: safeUsageRows,
    };
    rows.push(probeRow);
    log(
      `W3_PROBE attempt=${attempt} ageHours=${ageHours} verdict=${probeRow.verdict} http=${probeRow.httpStatus ?? '-'} headerMs=${probeRow.headerMs ?? '-'} totalMs=${probeRow.totalMs} usage=${probeRow.usageServedBy ?? '-'}`
    );

    if (isHangVerdict(probeRow.verdict)) {
      stoppedEarly = 'hang_detected';
      log(
        `W3_HANG_TRACE ${JSON.stringify({
          ageHours,
          attempt,
          verdict: probeRow.verdict,
          headerMs: probeRow.headerMs,
          totalMs: probeRow.totalMs,
          usageServedBy: probeRow.usageServedBy,
          usageRows: probeRow.usageRows,
          startedAt: probeRow.startedAt,
        })}`
      );
      break;
    }

    if (stoppedEarly) break;
  }

  const usageAfter = readUsageRowCount(opts.dbPath);
  const reconciliation = reconcileSentVsUsage(sentChat, Math.max(0, usageAfter - usageBefore));
  log(
    `W3_RECONCILE sent=${reconciliation.sentRequests} usageHistory=${reconciliation.usageHistoryRows} delta=${reconciliation.delta}`
  );

  return {
    dryRun: false,
    allowed: true,
    stoppedEarly,
    sentChat,
    sentModelsGet: 0,
    sample,
    rows,
    reconciliation,
    ledger,
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
 * Subcommand w5: kiểm tra rs-fast chỉ đọc hoặc đo ma trận 2×2 18 mẫu cho rs-fast.
 */
export async function runTrackWW5(opts = {}) {
  const log = opts.log ?? ((line) => console.log(line));
  const baseUrl = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_R1_BASE_URL;
  const timeoutMs = Math.max(20, Math.floor(opts.timeoutMs ?? DEFAULT_R1_TIMEOUT_MS));
  const gapMs = Math.max(0, Math.floor(opts.gapMs ?? DEFAULT_R1_GAP_MS));
  const maxTokens = Math.min(DEFAULT_R1_MAX_TOKENS, Math.max(1, Math.floor(opts.maxTokens ?? DEFAULT_R1_MAX_TOKENS)));
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const { ledger, save: saveLedger } = openLedgerStore(opts);

  const dbInfo = readTrackRDbInfo(opts.dbPath);
  logRemainingBudget(log, ledger);

  if (dbInfo.hasRsFast !== true) {
    log('W5_RS_FAST=chưa đo reason=combo_not_in_db');
    if (!opts.yesSpendTokens) {
      return {
        dryRun: true,
        status: 'chưa đo',
        reason: 'combo_not_in_db',
        sentChat: 0,
        sentModelsGet: 0,
        hasRsFast: false,
        ledger,
      };
    }
    return {
      dryRun: false,
      status: 'chưa đo',
      reason: 'combo_not_in_db',
      sentChat: 0,
      sentModelsGet: 0,
      hasRsFast: false,
      ledger,
    };
  }

  if (!opts.yesSpendTokens) {
    log(`W5_DRY_RUN combo=rs-fast plannedChat=18 modelsGet=0 baseUrl=${baseUrl}`);
    return { dryRun: true, sentChat: 0, sentModelsGet: 0, hasRsFast: true, ledger };
  }

  const safety = checkPreFlightSafety(opts, ledger, log);
  if (!safety.ok) {
    log(`W5_RS_FAST=chưa đo reason=${safety.reason}`);
    return {
      dryRun: false,
      allowed: false,
      status: 'chưa đo',
      reason: safety.reason,
      stoppedEarly: safety.reason,
      sentChat: 0,
      sentModelsGet: 0,
      hasRsFast: true,
      rows: [],
      ledger,
    };
  }

  if (MAX_TRACK_W_CHAT - ledger.chatSent < 18) {
    log('W5_RS_FAST=chưa đo reason=insufficient_track_w_budget');
    return {
      dryRun: false,
      allowed: false,
      status: 'chưa đo',
      reason: 'insufficient_track_w_budget',
      stoppedEarly: 'insufficient_track_w_budget',
      sentChat: 0,
      sentModelsGet: 0,
      hasRsFast: true,
      rows: [],
      ledger,
    };
  }

  const seed = Number.isInteger(opts.seed) ? opts.seed : Math.floor(Math.random() * 0x7fffffff);
  const schedule = buildShuffledR1Schedule(seed);
  const usageBefore = readUsageRowCount(opts.dbPath);
  const comboRows = [];
  let sentChat = 0;
  let stoppedEarly = null;
  let hasLaunchedAnyCell = false;

  log(`W5_MATRIX_START combo=rs-fast seed=${seed} cells=${schedule.length} maxTokens=${maxTokens} timeoutMs=${timeoutMs} gapMs=${gapMs}`);

  for (const item of schedule) {
    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
      saveLedger();
      break;
    }
    if (ledger.chatSent + item.concurrency > MAX_TRACK_W_CHAT) {
      stoppedEarly = 'max_track_w_chat';
      break;
    }
    if (hasLaunchedAnyCell && gapMs > 0) {
      await sleepImpl(gapMs);
    }
    hasLaunchedAnyCell = true;

    const probeReport = await runCombosProbeCommand({
      mode: 'combo',
      combos: ['rs-fast'],
      concurrency: item.concurrency,
      repeat: 1,
      stream: item.stream,
      maxTokens,
      comboTimeoutMs: timeoutMs,
      yesSpendTokens: true,
      dbPath: opts.dbPath,
      baseUrl,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.pollSleepImpl,
      budget: item.concurrency,
      log: () => undefined,
    });

    probeReport.rows.forEach((pRow, slotIdx) => {
      ledger.chatSent += 1;
      sentChat += 1;
      const verdict = normalizeMatrixVerdict(pRow);
      if (pRow.httpStatus === 429 || verdict === 'RATE-LIMITED') {
        ledger.consecutive429 += 1;
      } else {
        ledger.consecutive429 = 0;
      }
      const entry = {
        combo: 'rs-fast',
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
        `W5_ROW combo=rs-fast\tcell=${entry.cell}\trep=${entry.rep}\tslot=${entry.slot}\tstream=${entry.stream}\tconcurrency=${entry.concurrency}\thttp=${entry.httpStatus ?? '-'}\theader=${entry.headerMs ?? '-'}ms\ttotal=${entry.totalMs}ms\tverdict=${entry.verdict}\ttokens_in=${entry.promptTokens ?? '-'}\ttokens_out=${entry.completionTokens ?? '-'}\tusage=${entry.usageServedBy ?? '-'}`
      );
    });

    if (ledger.consecutive429 >= MAX_TRACK_W_CONSECUTIVE_429) {
      ledger.haltedReason = '3x429';
      stoppedEarly = '3x429';
    }
    saveLedger();

    if (stoppedEarly) break;
  }

  const classification = classifyR1Matrix(comboRows, {
    stoppedEarly,
    ponytailEnabled: dbInfo.ponytailEnabled,
  });
  log(`W5_CLASSIFY combo=rs-fast count=${comboRows.length} conclusion="${classification.label}"`);
  if (classification.confounderNote) {
    log(`W5_CONFOUNDER combo=rs-fast ${classification.confounderNote}`);
  }

  const usageAfter = readUsageRowCount(opts.dbPath);
  const reconciliation = reconcileSentVsUsage(sentChat, Math.max(0, usageAfter - usageBefore));
  log(
    `W5_RECONCILE sent=${reconciliation.sentRequests} usageHistory=${reconciliation.usageHistoryRows} delta=${reconciliation.delta}`
  );

  return {
    dryRun: false,
    allowed: true,
    status: stoppedEarly ? 'dừng sớm' : 'hoàn tất',
    stoppedEarly,
    sentChat,
    sentModelsGet: 0,
    hasRsFast: true,
    rows: comboRows,
    classification,
    reconciliation,
    ledger,
  };
}

function parseCliFlags(argv) {
  const out = {
    subcommand: undefined,
    baseUrl: undefined,
    dbPath: undefined,
    ledgerPath: DEFAULT_TRACK_W_LEDGER_PATH,
    intervalMs: undefined,
    minAgeHours: undefined,
    gapMs: undefined,
    timeoutMs: undefined,
    seed: undefined,
    target: undefined,
    packageJson: undefined,
    yesSpendTokens: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !out.subcommand) {
      out.subcommand = arg;
    } else if (arg === '--base-url' && argv[i + 1]) {
      out.baseUrl = argv[++i];
    } else if ((arg === '--db-path' || arg === '--db') && argv[i + 1]) {
      out.dbPath = argv[++i];
    } else if (arg === '--ledger' && argv[i + 1]) {
      out.ledgerPath = argv[++i];
    } else if (arg === '--interval-ms' && argv[i + 1]) {
      out.intervalMs = Number.parseInt(argv[++i], 10);
    } else if (arg === '--min-age-hours' && argv[i + 1]) {
      out.minAgeHours = Number.parseFloat(argv[++i]);
    } else if (arg === '--gap-ms' && argv[i + 1]) {
      out.gapMs = Number.parseInt(argv[++i], 10);
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      out.timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (arg === '--seed' && argv[i + 1]) {
      out.seed = Number.parseInt(argv[++i], 10);
    } else if (arg === '--target' && argv[i + 1]) {
      out.target = argv[++i];
    } else if (arg === '--package-json' && argv[i + 1]) {
      out.packageJson = argv[++i];
    } else if (arg === '--yes-spend-tokens') {
      out.yesSpendTokens = true;
    }
  }
  return out;
}

async function main() {
  const flags = parseCliFlags(process.argv.slice(2));
  const statusOpts =
    flags.target || flags.packageJson
      ? {
          ...(flags.target ? { target: flags.target } : {}),
          ...(flags.packageJson ? { packageJson: flags.packageJson } : {}),
          pid: -1,
        }
      : undefined;

  const common = {
    baseUrl: flags.baseUrl,
    dbPath: flags.dbPath,
    ledgerPath: flags.ledgerPath,
    yesSpendTokens: flags.yesSpendTokens,
    statusOpts,
  };

  if (flags.subcommand === 'w1') {
    await runTrackWW1({
      ...common,
      intervalMs: flags.intervalMs,
      chatTimeoutMs: flags.timeoutMs,
    });
    return;
  }
  if (flags.subcommand === 'w3') {
    await runTrackWW3({
      ...common,
      minAgeHours: flags.minAgeHours,
      timeoutMs: flags.timeoutMs,
    });
    return;
  }
  if (flags.subcommand === 'w5') {
    await runTrackWW5({
      ...common,
      gapMs: flags.gapMs,
      timeoutMs: flags.timeoutMs,
      seed: flags.seed,
    });
    return;
  }
  const { ledger } = openLedgerStore({ ledgerPath: flags.ledgerPath });
  logRemainingBudget((l) => console.log(l), ledger);
  console.log(
    'dùng: node tools/agent/c44-track-w.mjs <w1|w3|w5> [--base-url <url>] [--db-path <sqlite>] [--ledger <json>] [--interval-ms <ms>] [--min-age-hours <h>] [--yes-spend-tokens]'
  );
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  main().catch((err) => {
    console.error(`[c44-track-w] lỗi: ${maskPaths(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
}
