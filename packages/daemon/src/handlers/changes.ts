/**
 * packages/daemon/src/handlers/changes.ts
 *
 * Handler for GET /api/v1/changes/pending and GET /api/v1/changes/history (Phase 3c / SPEC §31.9 ④).
 *
 * Provides real inspection of pending plans and persisted rollback snapshots.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendJson } from '../security/network.js';

export interface ChangeActionItem {
  id: string;
  type: 'add' | 'remove' | 'reorder';
  modelId: string;
  titleKey: string;
  description: string;
  appliesTo: string;
  risk: 'low' | 'medium' | 'high';
  source: 'auto' | 'agent';
  agentName?: string | undefined;
  evidenceSnippet?: string | undefined;
}

export interface PendingPlanPayload {
  id: string;
  proposalCode: string;
  planHash: string;
  computedTimeAgo: string;
  computedTimeAgoKey?: string | undefined;
  impactPercent: number;
  maxImpactPercent: number;
  billableRequestsCount: number;
  targetsSummary: string;
  hasRollbackBackup: boolean;
  sourceSummary: string;
  sourceDetail: string;
  actions: ChangeActionItem[];
  deliberateExclusions: string[];
  unifiedDiff: string;
}

let activePendingPlan: PendingPlanPayload | null = null;

export function setPendingPlanForTesting(plan: PendingPlanPayload | null): void {
  activePendingPlan = plan;
}

export function locateSnapshotsDir(): string {
  const override = process.env['ROUTERSYNC_STATE_DIR'];
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim(), 'snapshots');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'routersync', 'snapshots');
  }
  const xdgState = process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'routersync', 'snapshots');
}

export async function handlePendingChanges(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nowIso = new Date().toISOString();

  if (activePendingPlan) {
    sendJson(res, 200, {
      meta: { source: 'live', generatedAt: nowIso },
      ...activePendingPlan,
    });
    return;
  }

  // Return honest empty live state when no plan is pending
  sendJson(res, 200, {
    meta: { source: 'live', generatedAt: nowIso },
    id: 'plan-none',
    proposalCode: '#none',
    planHash: '',
    computedTimeAgo: 'Chưa có kế hoạch thay đổi',
    impactPercent: 0,
    maxImpactPercent: 50,
    billableRequestsCount: 0,
    targetsSummary: '',
    hasRollbackBackup: false,
    sourceSummary: '0',
    sourceDetail: '0 hành động',
    actions: [],
    deliberateExclusions: [],
    unifiedDiff: '',
  });
}

export async function handleHistoryChanges(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nowIso = new Date().toISOString();
  const dir = locateSnapshotsDir();

  if (!fs.existsSync(dir)) {
    sendJson(res, 200, {
      meta: { source: 'live', generatedAt: nowIso },
      snapshots: [],
    });
    return;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const snapshots: Array<{
      id: string;
      target: string;
      timestamp: string;
      timeAgo: string;
      changedCount: number;
      size: string;
      summary: string;
      approvedBy: string;
    }> = [];

    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.json')) {
        const fullPath = path.join(dir, ent.name);
        try {
          const stats = fs.statSync(fullPath);
          const raw = fs.readFileSync(fullPath, 'utf8');
          const parsed = JSON.parse(raw);
          const changedCount = Array.isArray(parsed.combos) ? parsed.combos.length : 0;
          const sizeKb = Math.max(0.1, Math.round((stats.size / 1024) * 10) / 10);

          snapshots.push({
            id: parsed.id ?? path.basename(ent.name, '.json'),
            target: parsed.target ?? 'all',
            timestamp: parsed.createdAt ?? stats.mtime.toISOString(),
            timeAgo: 'recently',
            changedCount,
            size: `${sizeKb} KB`,
            summary: parsed.summary ?? `Snapshot for ${parsed.target ?? 'all'}`,
            approvedBy: parsed.approvedBy ?? 'human',
          });
        } catch {}
      }
    }

    // Sort newest first
    snapshots.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    sendJson(res, 200, {
      meta: { source: 'live', generatedAt: nowIso },
      snapshots,
    });
  } catch (err: unknown) {
    sendJson(res, 500, {
      meta: { source: 'unavailable', reason: 'snapshots_unreadable', generatedAt: nowIso },
      error: err instanceof Error ? err.message : String(err),
      snapshots: [],
    });
  }
}
