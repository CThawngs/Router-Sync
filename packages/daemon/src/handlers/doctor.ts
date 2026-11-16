/**
 * packages/daemon/src/handlers/doctor.ts
 *
 * Handler for GET /api/v1/doctor.
 * Returns honest, verifiable read-only diagnostic checks (c1..c6).
 * c7..c9 return state: 'not_checked' with reason: 'needs_p3a'.
 * Strictly returns structured { code, params } per D1 (no free-form English sentences).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendJson } from '../security/network.js';
import type { DoctorCondition, DoctorReportResponse } from '../types.js';
import { readDaemonConfig } from '../config/reader.js';
import { locateRouterDb } from '../db/reader.js';
import { openReadOnlyDb } from '@routersync/core/readonly';
import { probeAllRouters } from '../probe/reachability.js';

function getEngineNodeRequirement(): string {
  try {
    let curDir = process.cwd();
    while (curDir) {
      const candidate = path.join(curDir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (pkg.engines?.node) {
          return pkg.engines.node;
        }
      }
      const parent = path.dirname(curDir);
      if (parent === curDir) break;
      curDir = parent;
    }
  } catch {
    // fallback
  }
  return '>=22.12.0';
}

function parseSemver(v: string): [number, number, number] {
  const clean = v.replace(/[^0-9.]/g, '');
  const [maj = '0', min = '0', pat = '0'] = clean.split('.');
  return [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10)];
}

function isNodeVersionSatisfied(current: string, required: string): boolean {
  const [cMaj, cMin, cPat] = parseSemver(current);
  const [rMaj, rMin, rPat] = parseSemver(required);

  if (cMaj > rMaj) return true;
  if (cMaj < rMaj) return false;
  if (cMin > rMin) return true;
  if (cMin < rMin) return false;
  return cPat >= rPat;
}

export async function handleDoctor(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nowIso = new Date().toISOString();
  const conditions: DoctorCondition[] = [];

  // c1: Node.js runtime threshold from package.json
  const requiredNode = getEngineNodeRequirement();
  const nodeSatisfied = isNodeVersionSatisfied(process.versions.node, requiredNode);
  conditions.push({
    id: 'c1',
    condKey: 'c_at100_node',
    state: nodeSatisfied ? 'pass' : 'fail',
    code: nodeSatisfied ? 'node_runtime_ok' : 'node_runtime_too_low',
    params: {
      current: process.versions.node,
      required: requiredNode,
    },
  });

  // c2: config file readable & valid
  //
  // R16-4 (DECISIONS 2026-10-20-01, safety-first): a machine that was never
  // configured has NO routersync.yaml. That is a NORMAL S1 state, not a
  // failure -> 'not_checked' with reason 'using_defaults'. Only a config
  // file that EXISTS but cannot be read or is broken stays a 'fail'.
  const config = readDaemonConfig();
  if (config.configStatus === 'ok' && config.configPath) {
    conditions.push({
      id: 'c2',
      condKey: 'c_at101_config',
      state: 'pass',
      code: 'config_readable',
      params: {
        file: path.basename(config.configPath),
      },
    });
  } else if (config.configStatus === 'missing') {
    conditions.push({
      id: 'c2',
      condKey: 'c_at101_config',
      state: 'not_checked',
      reason: 'using_defaults',
      code: 'config_missing',
    });
  } else if (config.configStatus === 'unreadable') {
    conditions.push({
      id: 'c2',
      condKey: 'c_at101_config',
      state: 'fail',
      reason: config.configReason ?? 'read_failed',
      code: 'config_unreadable',
      params: {
        file: path.basename(config.configPath ?? ''),
      },
    });
  } else {
    conditions.push({
      id: 'c2',
      condKey: 'c_at101_config',
      state: 'fail',
      reason: config.configReason ?? 'invalid_yaml',
      code: 'config_invalid',
      params: {
        file: path.basename(config.configPath ?? ''),
      },
    });
  }

  // c3: DB file readable & non-empty
  const omniDb = config.omniDbPath ?? locateRouterDb('omniroute');
  const nineDb = config.nineDbPath ?? locateRouterDb('9router');
  const targetDb = omniDb ?? nineDb;
  let dbPresent = false;
  let dbStat: fs.Stats | undefined;

  if (targetDb && fs.existsSync(targetDb)) {
    try {
      dbStat = fs.statSync(targetDb);
      if (dbStat.size > 0) {
        dbPresent = true;
      }
    } catch {
      dbPresent = false;
    }
  }

  if (dbPresent && targetDb) {
    conditions.push({
      id: 'c3',
      condKey: 'c_at97_db_file',
      state: 'pass',
      code: 'db_file_readable',
      params: {
        file: path.basename(targetDb),
        size: dbStat?.size ?? 0,
      },
    });
  } else {
    conditions.push({
      id: 'c3',
      condKey: 'c_at97_db_file',
      state: 'fail',
      code: targetDb ? 'db_file_empty' : 'db_file_missing',
    });
  }

  // c4: DB schema passes integrity_check & has expected tables (schema fingerprint)
  if (dbPresent && targetDb) {
    try {
      const db = openReadOnlyDb(targetDb);
      try {
        const integrity = db.pragma('integrity_check', { simple: true });
        const tables = db
          .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'")
          .get() as { count: number } | undefined;
        if (integrity === 'ok' && tables && tables.count > 0) {
          conditions.push({
            id: 'c4',
            condKey: 'c_at97_fingerprint',
            state: 'pass',
            code: 'schema_fingerprint_ok',
            params: {
              tables: tables.count,
            },
          });
        } else {
          conditions.push({
            id: 'c4',
            condKey: 'c_at97_fingerprint',
            state: 'fail',
            code: 'schema_fingerprint_failed',
          });
        }
      } finally {
        db.close();
      }
    } catch {
      conditions.push({
        id: 'c4',
        condKey: 'c_at97_fingerprint',
        state: 'fail',
        code: 'db_verification_error',
      });
    }
  } else {
    conditions.push({
      id: 'c4',
      condKey: 'c_at97_fingerprint',
      state: 'fail',
      code: 'db_not_accessible',
    });
  }

  // c5: snapshot dir writable & has >= 1 snapshot if DB present
  const stateDirOverride = process.env['ROUTERSYNC_STATE_DIR'];
  let baseStateDir: string;
  if (stateDirOverride && stateDirOverride.trim().length > 0) {
    baseStateDir = path.resolve(stateDirOverride.trim());
  } else if (process.platform === 'win32') {
    const localAppData =
      process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    baseStateDir = path.join(localAppData, 'routersync');
  } else {
    const xdgState = process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
    baseStateDir = path.join(xdgState, 'routersync');
  }
  const snapshotsDir = path.join(baseStateDir, 'snapshots');

  if (!fs.existsSync(snapshotsDir)) {
    conditions.push({
      id: 'c5',
      condKey: 'c_at107_snapshot',
      state: 'not_checked',
      reason: 'no_snapshot_dir_yet',
      code: 'snapshot_dir_missing',
    });
  } else {
    let unwritable = false;
    let snapshotCount = 0;
    try {
      fs.accessSync(snapshotsDir, fs.constants.W_OK);
      const files = fs.readdirSync(snapshotsDir);
      snapshotCount = files.filter((f) => f.endsWith('.json')).length;
    } catch {
      unwritable = true;
    }

    if (unwritable) {
      conditions.push({
        id: 'c5',
        condKey: 'c_at107_snapshot',
        state: 'fail',
        code: 'snapshot_dir_unwritable',
      });
    } else if (dbPresent && snapshotCount === 0) {
      conditions.push({
        id: 'c5',
        condKey: 'c_at107_snapshot',
        state: 'not_checked',
        reason: 'no_snapshot_yet',
        code: 'snapshot_none_yet',
        params: {
          snapshots: 0,
        },
      });
    } else {
      conditions.push({
        id: 'c5',
        condKey: 'c_at107_snapshot',
        state: 'pass',
        code: 'snapshot_dir_writable',
        params: {
          snapshots: snapshotCount,
        },
      });
    }
  }

  // c6: active router loopback probe
  const probe = await probeAllRouters();
  const anyUp = probe.omniroute.reachability === 'up' || probe.ninerouter.reachability === 'up';
  if (anyUp) {
    conditions.push({
      id: 'c6',
      condKey: 'c_at95_doctor',
      state: 'pass',
      code: 'routers_reachable',
      params: {
        omniroute: probe.omniroute.reachability,
        ninerouter: probe.ninerouter.reachability,
      },
    });
  } else {
    conditions.push({
      id: 'c6',
      condKey: 'c_at95_doctor',
      state: 'fail',
      code: 'routers_unreachable',
      params: {
        omniroute: probe.omniroute.reachability,
        ninerouter: probe.ninerouter.reachability,
      },
    });
  }

  // c7..c9: sync loop, fast-loop drift, MCP server readiness (P3a)
  conditions.push({
    id: 'c7',
    condKey: 'c_at110_syncloop',
    state: 'not_checked',
    reason: 'needs_p3a',
    code: 'deferred_to_p3a',
  });
  conditions.push({
    id: 'c8',
    condKey: 'c_at111_fastloop',
    state: 'not_checked',
    reason: 'needs_p3a',
    code: 'deferred_to_p3a',
  });
  conditions.push({
    id: 'c9',
    condKey: 'c_at94_mcp_ro',
    state: 'not_checked',
    reason: 'needs_p3a',
    code: 'deferred_to_p3a',
  });

  const hasFail = conditions.some((c) => c.state === 'fail');
  const hasNotChecked = conditions.some((c) => c.state === 'not_checked');
  const overallStatus = hasFail ? 'error' : hasNotChecked ? 'warning' : 'healthy';

  const report: DoctorReportResponse = {
    meta: {
      source: 'live',
      generatedAt: nowIso,
    },
    overallStatus,
    conditions,
  };

  sendJson(res, 200, report);
}
