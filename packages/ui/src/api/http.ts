import { ApiClient } from './client.js';
import {
  SystemOverview,
  PipelineModule,
  HeartbeatHistory,
  ProviderViewModel,
  ModelViewModel,
  ComboViewModel,
  TargetViewModel,
  PlanViewModel,
  SnapshotViewModel,
  HealthSummaryViewModel,
  DoctorReportViewModel,
  DaemonHealthViewModel,
  UnmatchedNameItem,
  UnknownTraitItem,
  ResponseMeta,
  SettingsViewModel,
  SetupPreviewViewModel,
  TrackStatusResponse,
  TrackEventsResponse,
  McpClientsResponse,
  MaintainPlanResponse,
} from './types.js';

/**
 * HttpApi (Phase 3b S1 Slice)
 *
 * Implements ApiClient contract connecting to the background daemon over localhost.
 * Strictly read-only for S1: mutating operations reject with "cần daemon (P3b/P4)".
 */
export class HttpApi implements ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '') {
    // Empty baseUrl uses relative path so Vite proxy forwards /api -> http://127.0.0.1:3128
    this.baseUrl = baseUrl;
  }

  isMock(): boolean {
    return false;
  }

  private async fetchJson<T>(endpoint: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${endpoint}: ${res.statusText}`);
    }

    return (await res.json()) as T;
  }

  async getOverview(): Promise<SystemOverview> {
    return this.fetchJson<SystemOverview>('/api/v1/overview');
  }

  async setFirstRun(_isFirstRun: boolean): Promise<void> {
    throw new Error('Thao tác ghi cần daemon (P3b/P4). Daemon hiện tại là S1 chỉ-đọc.');
  }

  async toggleEmergencyPause(): Promise<{ isPaused: boolean }> {
    throw new Error('Thao tác ghi cần daemon (P3b/P4). Daemon hiện tại là S1 chỉ-đọc.');
  }

  async getDaemonHealth(): Promise<DaemonHealthViewModel> {
    try {
      const res = await this.fetchJson<{
        meta: ResponseMeta;
        daemon: string;
        status: string;
        readOnly: boolean;
        uptime: number;
        routers: Record<
          string,
          { reachability: 'up' | 'down' | 'unknown'; httpStatus?: number; lastChecked?: string }
        >;
      }>('/api/v1/health');

      const routers = Object.entries(res.routers ?? {}).map(([id, probe]) => ({
        id,
        reachability: probe.reachability,
        httpStatus: probe.httpStatus,
        lastChecked: probe.lastChecked,
      }));

      return {
        meta: res.meta,
        reachable: true,
        uptimeSeconds: res.uptime,
        readOnly: res.readOnly,
        routers,
      };
    } catch {
      // R16-2.3: the daemon could not be reached. The UI must say so instead
      // of pretending the background service is alive.
      return { reachable: false };
    }
  }

  async getHeartbeat(): Promise<HeartbeatHistory> {
    // R16-2.3: the S1 daemon does NOT expose a heartbeat history yet
    // (GET /api/v1/heartbeat answers "unavailable"). There is no background
    // scanner in S1, so there is nothing to plot: every tick renders as a
    // dashed grey mark and the box reports the daemon's real uptime and the
    // newest router probe instead of a made-up "scanned two minutes ago" line.
    const health = await this.getDaemonHealth();

    const lastProbeAt = (health.routers ?? [])
      .map((r: { lastChecked?: string | undefined }) => r.lastChecked)
      .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
      .sort()
      .pop();

    return {
      ticks: Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, status: 'missed' as const })),
      source: 'unavailable',
      uptimeSeconds: health.uptimeSeconds,
      lastProbeAt,
      daemonReachable: health.reachable,
    };
  }

  async getPipelineModules(): Promise<PipelineModule[]> {
    // R16-2.7: the S1 daemon exposes no pipeline module state. The keys below
    // exist in the catalog, but the screen must render "—" for every counter
    // and NO "Age" line, because no age was measured.
    return (['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'] as const).map((id, index) => ({
      id,
      step: index + 1,
      titleKey: id,
      descKey: `${id}d`,
      status: 'unk' as const,
    }));
  }

  async getProviders(): Promise<ProviderViewModel[]> {
    // R17-1: keep the collection envelope. Without it the screen cannot tell
    // "unavailable / nothing measured" from "measured zero providers", and it
    // painted six prototype cards in both cases.
    const res = await this.fetchJson<{ meta?: ResponseMeta; data: ProviderViewModel[] }>(
      '/api/v1/providers'
    );
    const list = res.data || [];
    if (res.meta) {
      (list as unknown as { meta: ResponseMeta }).meta = res.meta;
    }
    return list;
  }

  async getModels(): Promise<ModelViewModel[]> {
    // R17-0.3: keep the collection envelope. Without it the screen cannot
    // distinguish "unavailable / nothing measured" from "measured zero", and
    // it painted a hard 0 in both cases.
    const res = await this.fetchJson<{ meta?: ResponseMeta; data: ModelViewModel[] }>(
      '/api/v1/models'
    );
    const list = res.data || [];
    if (res.meta) {
      (list as unknown as { meta: ResponseMeta }).meta = res.meta;
    }
    return list;
  }

  async getUnmatchedNames(): Promise<UnmatchedNameItem[]> {
    return [];
  }

  async getUnknownTraits(): Promise<UnknownTraitItem[]> {
    return [];
  }

  async getSettings(): Promise<SettingsViewModel> {
    // R17-2: the S1 daemon answers `/api/v1/settings` with `policyMode` and
    // `policyModeSource` only. Every other field stays absent so the screen
    // renders "—" instead of a prototype value.
    const res = await this.fetchJson<{
      meta: ResponseMeta;
      policyMode: 'manual' | 'shadow' | 'auto-low-risk' | 'auto';
      policyModeSource: 'config' | 'default';
    }>('/api/v1/settings');
    return {
      meta: res.meta,
      policyMode: res.policyMode,
      policyModeSource: res.policyModeSource,
    };
  }

  async getSetupPreview(): Promise<SetupPreviewViewModel> {
    // R17-2: the S1 daemon has no setup-preview route yet, so the wizard must
    // not print a single number. The envelope says why.
    try {
      const res = await this.fetchJson<SetupPreviewViewModel>('/api/v1/setup-preview');
      return res;
    } catch {
      return {
        meta: {
          source: 'unavailable',
          reason: 'needs_p3a',
          generatedAt: new Date().toISOString(),
        },
      };
    }
  }

  async getCombos(): Promise<ComboViewModel[]> {
    const res = await this.fetchJson<ComboViewModel[] | { meta?: ResponseMeta; combos: ComboViewModel[] }>('/api/v1/combos');
    if (Array.isArray(res)) return res;
    const list = res.combos || [];
    if (res.meta) {
      (list as unknown as { meta: ResponseMeta }).meta = res.meta;
    }
    return list;
  }

  async getTargets(): Promise<TargetViewModel[]> {
    return this.fetchJson<TargetViewModel[]>('/api/v1/targets');
  }

  async getPendingPlan(): Promise<PlanViewModel> {
    try {
      const res = await this.fetchJson<Partial<PlanViewModel>>('/api/v1/changes/pending');
      const nowIso = new Date().toISOString();
      return {
        meta: res.meta ?? { source: 'unavailable', reason: 'needs_p3a', generatedAt: nowIso },
        id: res.id || 'plan-empty',
        proposalCode: res.proposalCode || '#none',
        planHash: res.planHash || '',
        computedTimeAgo: res.computedTimeAgo || 'Chưa có kế hoạch thay đổi',
        computedTimeAgoKey: res.computedTimeAgoKey,
        impactPercent: typeof res.impactPercent === 'number' ? res.impactPercent : 0,
        maxImpactPercent: typeof res.maxImpactPercent === 'number' ? res.maxImpactPercent : 50,
        billableRequestsCount: typeof res.billableRequestsCount === 'number' ? res.billableRequestsCount : 0,
        targetsSummary: res.targetsSummary || '',
        hasRollbackBackup: Boolean(res.hasRollbackBackup),
        sourceSummary: res.sourceSummary || '0',
        sourceDetail: res.sourceDetail || '',
        actions: Array.isArray(res.actions) ? res.actions : [],
        deliberateExclusions: Array.isArray(res.deliberateExclusions) ? res.deliberateExclusions : [],
        unifiedDiff: res.unifiedDiff || '',
      };
    } catch {
      const nowIso = new Date().toISOString();
      return {
        meta: { source: 'unavailable', reason: 'daemon_unreachable', generatedAt: nowIso },
        id: 'plan-empty',
        proposalCode: '#none',
        planHash: '',
        computedTimeAgo: 'Chưa có kế hoạch thay đổi',
        impactPercent: 0,
        maxImpactPercent: 50,
        billableRequestsCount: 0,
        targetsSummary: '',
        hasRollbackBackup: false,
        sourceSummary: '0',
        sourceDetail: '',
        actions: [],
        deliberateExclusions: [],
        unifiedDiff: '',
      };
    }
  }

  async approvePlan(planId: string, token = ''): Promise<{ success: boolean; messageKey: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/changes/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          planHash: planId,
          token: token || planId,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          meta?: { reason?: string };
        };
        return {
          success: false,
          messageKey: body.meta?.reason || body.error || `HTTP_${res.status}`,
        };
      }

      return {
        success: true,
        messageKey: 'plan_approved',
      };
    } catch (err: unknown) {
      return {
        success: false,
        messageKey: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rejectPlan(_planId: string): Promise<{ success: boolean; messageKey: string }> {
    return {
      success: false,
      messageKey: 'cần daemon (P3b/P4)',
    };
  }

  async getSnapshots(): Promise<SnapshotViewModel[]> {
    try {
      const res = await this.fetchJson<{ meta?: ResponseMeta; snapshots: SnapshotViewModel[] }>(
        '/api/v1/changes/history'
      );
      const list = res.snapshots || [];
      if (res.meta) {
        (list as unknown as { meta: ResponseMeta }).meta = res.meta;
      }
      return list;
    } catch {
      return [];
    }
  }

  async rollbackSnapshot(_snapshotId: string): Promise<{ success: boolean; messageKey: string }> {
    return {
      success: false,
      messageKey: 'cần daemon (P3b/P4)',
    };
  }
  async getHealthSummary(): Promise<HealthSummaryViewModel> {
    // R14: the S1 daemon measures none of the budget / cost / model-health
    // numbers yet. They stay undefined on purpose so the screen renders "—"
    // instead of an invented value. The doctor conditions come from the
    // daemon and are the only measured part of this report.
    const doctor = await this.getDoctor();
    return {
      meta: doctor.meta,
      doctorConditions: doctor.conditions,
      recentAlerts: [],
    };
  }

  async getDoctor(): Promise<DoctorReportViewModel> {
    return this.fetchJson<DoctorReportViewModel>('/api/v1/doctor');
  }

  async getTrackStatus(): Promise<TrackStatusResponse> {
    return this.fetchJson<TrackStatusResponse>('/api/v1/track/status');
  }

  async getTrackEvents(): Promise<TrackEventsResponse> {
    return this.fetchJson<TrackEventsResponse>('/api/v1/track/events');
  }

  async getMcpClients(): Promise<McpClientsResponse> {
    return this.fetchJson<McpClientsResponse>('/api/v1/mcp/clients');
  }

  async getMaintainPlan(): Promise<MaintainPlanResponse> {
    return this.fetchJson<MaintainPlanResponse>('/api/v1/maintain/plan');
  }
}
