/**
 * packages/daemon/src/types.ts
 *
 * TypeScript types for the RouterSync S1 Read-Only Daemon.
 */

export interface ResponseMeta {
  source: 'live' | 'sample' | 'unavailable';
  reason?: string | undefined;
  generatedAt: string;
}

export interface DaemonServerInfo {
  status: 'running';
  version: string;
  port: number;
  host: '127.0.0.1';
  readOnly: true;
}

export interface RouterProbeResult {
  reachability: 'up' | 'down' | 'unknown';
  url: string;
  lastChecked: string;
  httpStatus?: number | undefined;
  error?: string | undefined;
}

export interface DaemonHealthResponse {
  meta: ResponseMeta;
  daemon: 'ok';
  status: 'healthy' | 'routers_down';
  version?: string | undefined;
  readOnly: true;
  uptime: number;
  routers: {
    omniroute: RouterProbeResult;
    '9router': RouterProbeResult;
  };
}

export interface TargetViewModel {
  meta?: ResponseMeta | undefined;
  id: string;
  name: string;
  type: 'router' | 'agent_app' | 'config_file';
  addressOrPath: string;
  mode?: 'preview' | 'active' | undefined;
  supportsCombos: boolean;
  providersSynced?: number | undefined;
  combosManaged?: number | undefined;
  combosAdopted?: number | undefined;
  readBackLevel?: 'full' | 'existence-only' | 'db-only' | 'db-only (degraded)' | undefined;
  derivedFrom?: string | undefined;
  // R11-3: `applyState` is intentionally ABSENT from the S1 view model.
  // The daemon performs no writes, so it can never truthfully report
  // `verified` or `written-pending-reload`. The field returns with P3b
  // (see DECISIONS 2026-10-18-01 for the enum-gap review).
  policyMode?: 'manual' | 'shadow' | undefined;
  policyCappedReason?: string | undefined;
  versionGate?: string | undefined;
  breakerState?: 'closed' | 'open' | undefined;
  integrationTier?: 'T1' | 'T2' | 'T3' | undefined;
  integrationNotes?: string | undefined;
  cloudSyncWarning?: boolean | undefined;
  db?: {
    meta: ResponseMeta;
    combosManaged?: number | undefined;
    combosAdopted?: number | undefined;
  } | undefined;
  probe?: {
    meta: ResponseMeta;
    reachability: 'up' | 'down' | 'unknown';
    httpStatus?: number | undefined;
  } | undefined;
}

/**
 * R18-1 (AT-145): `/api/v1/combos` carries a COLLECTION envelope, like
 * `/providers` and `/models` already do. The route used to answer a bare array
 * on success and `{ meta, combos }` only when BOTH databases failed, so a
 * client could not tell "read fine, zero combos" from "nothing was readable":
 * the empty array carried no `meta` at all.
 *
 * `routers` says, per router, whether ITS combos were read. That is what lets
 * the screen warn "combos of <router> could not be read" while still painting
 * the combos of the router that WAS readable, without a second request.
 */
export interface CombosResponseMeta extends ResponseMeta {
  routers?: Record<
    'omniroute' | '9router',
    { source: 'live' | 'unavailable'; reason?: string | undefined }
  >;
}

export interface CombosResponse {
  meta: CombosResponseMeta;
  combos: ComboViewModel[];
}

export interface ComboStep {
  position: number;
  modelId: string;
  description?: string | undefined;
  score?: number | undefined;
  status?: 'ok' | 'proposed_remove' | 'degraded' | undefined;
}

export interface ComboViewModel {
  meta: ResponseMeta;
  id: string;
  name: string;
  type: 'managed' | 'free_only' | 'cascade' | 'adopted' | 'custom';
  badgeKey: string;
  targets: string[];
  /** R17-0.2: absent when the router stores no strategy for this combo. */
  strategy?: string | undefined;
  steps: ComboStep[];
  actualVsDesired?: Array<{
    position: number;
    actual: string;
    desired: string;
    status: 'match' | 'waiting';
  }> | undefined;
  isFreeOnly?: boolean | undefined;
}

export interface SystemOverview {
  meta: ResponseMeta;
  isFirstRun?: boolean | undefined;
  isPaused?: boolean | undefined;
  isSampleData?: boolean | undefined;
  modeSummary?: string | undefined;
  activeProviders?: {
    activeCount: number;
    totalCount: number;
    subtitle?: string | undefined;
  } | undefined;
  routers?: {
    upCount: number;
    probedCount: number;
  } | undefined;
  trackedModels: {
    count: number;
    subtitle?: string | undefined;
  };
  billableRequestsToday: {
    count?: number | undefined;
    code?: string | undefined;
    subtitle?: string | undefined;
  };
  lastCheck: {
    code?: string | undefined;
    lastCheckAt?: string | undefined;
    timeAgo?: string | undefined;
    subtitle?: string | undefined;
  };
  todoItems?: Array<{
    id: string;
    type: 'amber' | 'cross' | 'question' | 'diamond';
    code?: string | undefined;
    params?: Record<string, string | number> | undefined;
    text?: string | undefined;
    actionKey: string;
    targetSection: string;
  }> | undefined;
  recentEvents?: Array<{
    id: string;
    timeAgo: string;
    timeAgoKey?: string | undefined;
    type: 'diamond' | 'amber' | 'green';
    code?: string | undefined;
    params?: Record<string, string | number> | undefined;
    highlightText?: string | undefined;
    textPrefix?: string | undefined;
    textSuffix?: string | undefined;
  }> | undefined;
}

export interface DoctorCondition {
  id: string;
  condKey: string;
  state: 'pass' | 'fail' | 'not_checked';
  /**
   * WHY the condition has that state. Machine token, never a free-form
   * sentence. Used by the c2 config check (`'using_defaults'` when no config
   * file exists, the errno code when the file cannot be read, the lint token
   * when the file is broken) and by the deferred c7..c9 checks
   * (`'needs_p3a'`).
   */
  reason?: string | undefined;
  code?: string | undefined;
  params?: Record<string, string | number> | undefined;
  resultText?: string | undefined;
}

export interface DoctorReportResponse {
  meta: ResponseMeta;
  overallStatus: 'healthy' | 'warning' | 'error';
  conditions: DoctorCondition[];
}

export interface SettingsResponse {
  meta: ResponseMeta;
  policyMode?: 'manual' | 'shadow' | 'auto-low-risk' | 'auto' | undefined;
  /**
   * R16-4: where `policyMode` came from.
   * - `'config'`  -> a config file exists and was read successfully.
   * - `'default'` -> there is no config file, or it could not be read or is
   *   invalid; `policyMode` then falls back to `'manual'`.
   */
  policyModeSource?: 'config' | 'default' | undefined;
  scanSchedule?: string | undefined;
  maxDailyRequests?: number | undefined;
  mcpClients?: Array<{
    client: string;
    configured: boolean;
    mode: 'read_only' | 'rw';
  }> | undefined;
}
