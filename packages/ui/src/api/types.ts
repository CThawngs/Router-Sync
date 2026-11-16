/**
 * packages/ui/src/api/types.ts
 *
 * View-Model types for the RouterSync UI (UI-0 slice).
 * Mapped to Core domain models in docs/ui/API-CONTRACT.md.
 */

export interface ResponseMeta {
  source: 'live' | 'sample' | 'unavailable';
  generatedAt: string;
  reason?: string | undefined;
  /**
   * R18-1: only `/api/v1/combos` sends this today — per-router readability of
   * the combo databases. Optional everywhere else, so a payload that omits it
   * is not a contract violation.
   */
  routers?: Record<
    string,
    { source: 'live' | 'unavailable'; reason?: string | undefined }
  >;
}

export interface TodoItem {
  id: string;
  type: 'amber' | 'cross' | 'question' | 'diamond';
  code?: string | undefined;
  params?: Record<string, string | number> | undefined;
  text?: string | undefined;
  actionKey: string;
  targetSection: string;
}

export interface RecentEvent {
  id: string;
  timeAgo: string;
  timeAgoKey?: string | undefined;
  type: 'diamond' | 'amber' | 'green';
  code?: string | undefined;
  params?: Record<string, string | number> | undefined;
  highlightText?: string | undefined;
  textPrefix?: string | undefined;
  textSuffix?: string | undefined;
}

export interface SystemOverview {
  meta?: ResponseMeta | undefined;
  isFirstRun?: boolean | undefined;
  isPaused?: boolean | undefined;
  isSampleData?: boolean | undefined;
  /** R17-3: the first-run checklist and detections, when they were measured. */
  firstRun?: FirstRunViewModel | undefined;
  /**
   * R14-6.1: `activeProviders` was removed. The daemon S1 measures router
   * reachability, not provider activity, so the overview tile shows
   * `routers: { upCount, probedCount }` (ADR-DAEMON-01 §2.4 item 2).
   */
  routers?: {
    upCount: number;
    probedCount: number;
  } | undefined;
  /**
   * R16-2.5: the metric blocks carry DATA only. A display sentence used to
   * live here (`subtitle`), which made the shell print a hard-coded string in
   * whatever language the sample happened to be written in. The S1 daemon
   * never sends one, so the field is gone: the screen shows the measured
   * number and the "not measured in S1" label when there is no number.
   */
  trackedModels: {
    count?: number | undefined;
  };
  billableRequestsToday: {
    count?: number | undefined;
    code?: string | undefined;
  };
  lastCheck: {
    code?: string | undefined;
    lastCheckAt?: string | undefined;
  };
  todoItems?: TodoItem[] | undefined;
  recentEvents?: RecentEvent[] | undefined;
}

/** One doctor condition, exactly as the daemon reports it (D1: no free-form text). */
export interface DoctorConditionViewModel {
  id: string;
  condKey: string;
  state: 'pass' | 'fail' | 'not_checked';
  reason?: string | undefined;
  code?: string | undefined;
  params?: Record<string, string | number> | undefined;
}

/** GET /api/v1/doctor payload as a view-model. */
export interface DoctorReportViewModel {
  meta?: ResponseMeta | undefined;
  overallStatus?: 'healthy' | 'warning' | 'error' | undefined;
  conditions: DoctorConditionViewModel[];
}

export interface PipelineModule {
  id: string;
  step?: number;
  titleKey: string;
  descKey: string;
  /**
   * R16-2.7: age of the module data in seconds. Absent -> the screen shows
   * "—" and renders NO "Age: ..." line, because S1 measures no module age.
   */
  ageSeconds?: number | undefined;
  status: 'ok' | 'amber' | 'stale' | 'unk';
  isDashed?: boolean;
  /** R14: the module counter comes from the VM. Missing -> the screen shows "—". */
  count?: string | undefined;
}

/**
 * R16-2.3: what the daemon reports about ITSELF (GET /api/v1/health).
 * `reachable` is false when the client could not reach the daemon at all.
 */
export interface DaemonHealthViewModel {
  meta?: ResponseMeta | undefined;
  reachable: boolean;
  /** Daemon uptime in seconds (from the daemon's own counter). */
  uptimeSeconds?: number | undefined;
  /** True when the S1 daemon is the strictly read-only build. */
  readOnly?: boolean | undefined;
  /** Per-router reachability as measured by the daemon. */
  routers?: Array<{
    id: string;
    reachability: 'up' | 'down' | 'unknown';
    httpStatus?: number | undefined;
    lastChecked?: string | undefined;
  }> | undefined;
}

/**
 * R16-2.3: the heartbeat box of the sidebar.
 *
 * S1 has NO background scanner, so there is no "scanned a moment ago" story to
 * tell. The box reports what the daemon really answers:
 *  - `source: 'measured'` only when a real heartbeat history was served;
 *  - `source: 'unavailable'` -> every tick renders as a dashed grey mark,
 *    because the S1 daemon does not expose `/api/v1/heartbeat` yet;
 *  - `uptimeSeconds` is the daemon's own uptime counter;
 *  - `lastProbeAt` is the newest router probe the daemon performed.
 */
export interface HeartbeatHistory {
  ticks: Array<{
    id: string;
    status: 'ok' | 'warning' | 'missed';
  }>;
  source: 'measured' | 'unavailable';
  /** Daemon uptime in seconds, as measured by the daemon. */
  uptimeSeconds?: number | undefined;
  /** ISO timestamp of the most recent router probe. */
  lastProbeAt?: string | undefined;
  /** True when the daemon answered at all. */
  daemonReachable?: boolean | undefined;
}

/** R15: free-quota bar of a provider (measured, or sample content in mock.ts). */
export interface ProviderQuotaViewModel {
  used: number;
  limit: number;
}

export interface ProviderViewModel {
  meta?: ResponseMeta | undefined;
  id: string;
  name: string;
  status: 'active' | 'key_error' | 'no_list_api';
  keySource: 'os_store' | 'env_var' | 'router_imported';
  keySourceLabel: string;
  modelsCount: number;
  freeQuotaToday: string;
  lastScan: string;
  autoAddNew: boolean;
  autoRemoveGone: boolean;
  notice?: string;
  manualCount?: number;
  /**
   * R15: price-kind chip as an i18n key (`pk_forever` / `pk_tier` / `pk_sub` /
   * `pk_metered` / `pk_unknown`). Absent -> the screen renders no chip.
   */
  priceKindKey?: string | undefined;
  /** R15: quota bar. Absent -> the screen renders "—". */
  quota?: ProviderQuotaViewModel | undefined;
  /** R15: models kept when the provider key failed. */
  retainedCount?: number | undefined;
  /** R15: detail-mode footnote (sample content lives in mock.ts). */
  detail?: string | undefined;
}

/**
 * R15: settings as a view-model. The daemon S1 measures `policyMode` only;
 * every other field is omitted there, and the screen renders "—" for them.
 */
export interface SettingsViewModel {
  meta?: ResponseMeta | undefined;
  policyMode?: 'manual' | 'shadow' | 'auto-low-risk' | 'auto' | undefined;
  /**
   * R17-2: where `policyMode` came from. `default` means the daemon had no
   * `routersync.yaml` and fell back — the screen must say so instead of
   * presenting the fallback as the owner's choice.
   */
  policyModeSource?: 'config' | 'default' | undefined;
  /** R17-2: sample-only address of the local UI (lives in mock.ts). */
  localUrl?: string | undefined;
  scanSchedule?: string | undefined;
  maxDailyRequests?: number | undefined;
  mcpClients?: Array<{
    client: string;
    configured: boolean;
    mode: 'read_only' | 'rw';
  }> | undefined;
  /** R15: sample-only prototype numbers (they live in mock.ts). */
  shadowWeek?: { day: number; total: number } | undefined;
  limits?: {
    impactPercent?: number | undefined;
    minModels?: number | undefined;
    minProviders?: number | undefined;
    backups?: number | undefined;
    waitBeforeGoneKey?: string | undefined;
    quarantineKey?: string | undefined;
  } | undefined;
}

/**
 * R15: the "what would RouterSync do" preview of the setup wizard. The daemon
 * S1 has no such endpoint, so the live view-model carries no numbers and the
 * screen renders "—" inside a dashed frame.
 */
export interface SetupPreviewViewModel {
  meta?: ResponseMeta | undefined;
  modelsFound?: number | undefined;
  combosSuggested?: number | undefined;
  billableRequests?: number | undefined;
  writtenToConfig?: number | undefined;
  /**
   * R17-2: what the wizard really detected on this machine (router ports, the
   * OpenCode config path). Absent -> the wizard shows "—", because an address
   * or a path is a claim that it found something.
   */
  detections?: FirstRunDetectionItem[] | undefined;
}

/** R15: one row of the first-run "machine self-check" list. */
export interface FirstRunDetectionItem {
  id: string;
  /** i18n key of the label. */
  textKey: string;
  /** Optional measured / sample value (address, path, ...). */
  value?: string | undefined;
  state: 'ok' | 'warn' | 'unk';
}

/** R15: the view-model of the first-run branch of the overview. */
export interface FirstRunViewModel {
  checklistDone?: number | undefined;
  detections?: FirstRunDetectionItem[] | undefined;
}

export interface ModelViewModel {
  meta?: ResponseMeta | undefined;
  id: string;
  canonicalId: string;
  provider: string;
  priceKind: 'free_forever' | 'free_tier' | 'subscription' | 'metered' | 'unknown';
  priceText: string;
  context: string;
  score: number;
  status: 'healthy' | 'new' | 'due_removal' | 'paused' | 'degraded';
  hasVision: 'yes' | 'no' | 'unknown';
  aliases: string[];
  whereUsed: string[];
  scoreExplanation: string;
  isDisputed?: boolean;
}

export interface ComboStep {
  position: number;
  modelId: string;
  description?: string | undefined;
  score?: number | undefined;
  status?: 'ok' | 'proposed_remove' | 'degraded' | undefined;
}

export interface ComboViewModel {
  meta?: ResponseMeta | undefined;
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
  cascadeCombos?: string[];
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
  readBackLevel?: 'full' | 'existence-only' | 'db-only' | 'db-only (degraded)' | undefined;
  derivedFrom?: string | undefined;
  // R19-2: 'unwritten' is ADDED (DECISIONS 2026-10-18-01, installed in
  // ROUND19). The daemon S1 still never emits an applyState at all.
  applyState?: 'verified' | 'written-pending-reload' | 'unwritten' | undefined;
  policyMode?: 'manual' | 'shadow' | undefined;
  policyCappedReason?: string | undefined;
  versionGate?: string | undefined;
  breakerState?: 'closed' | 'open' | undefined;
  integrationTier?: 'T1' | 'T2' | 'T3' | undefined;
  integrationNotes?: string | undefined;
  cloudSyncWarning?: boolean | undefined;
  defaultSlotsState?: string | undefined;
  filterRule?: string | undefined;
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

export interface ChangeAction {
  id: string;
  type: 'add' | 'remove' | 'reorder';
  modelId: string;
  titleKey: string;
  description: string;
  appliesTo: string;
  risk: 'low' | 'medium' | 'high';
  source: 'auto' | 'agent';
  agentName?: string;
  evidenceSnippet?: string;
}

export interface PlanViewModel {
  meta?: ResponseMeta | undefined;
  id: string;
  proposalCode: string; // e.g. "#a41f"
  planHash: string;
  computedTimeAgo: string;
  /** R16-3: translation key of the age. Preferred over the plain text. */
  computedTimeAgoKey?: string | undefined;
  impactPercent: number; // e.g. 12
  maxImpactPercent: number; // 50
  billableRequestsCount: number;
  targetsSummary: string; // a short measured summary of the targets
  hasRollbackBackup: boolean;
  sourceSummary: string; // "4 + 1"
  sourceDetail: string; // "4 tự động · 1 từ agent"
  actions: ChangeAction[];
  deliberateExclusions: string[];
  unifiedDiff: string;
}

export interface SnapshotViewModel {
  meta?: ResponseMeta | undefined;
  id: string;
  target: string;
  timestamp: string;
  timeAgo: string;
  changedCount: number;
  size: string;
  summary: string;
  approvedBy: string;
}

export interface HealthSummaryViewModel {
  meta?: ResponseMeta | undefined;
  billableRequestsToday?: number | undefined;
  costTodayUsd?: number | undefined;
  healthyModelsCount?: number | undefined;
  degradedModelsCount?: number | undefined;
  dueRemovalCount?: number | undefined;
  /** R16-3.3: models paused by the owner. Absent -> no number is shown. */
  pausedModelsCount?: number | undefined;
  safetyMode?: 'manual' | 'auto_low_risk' | 'auto' | undefined;
  hourlyRequestsUsed?: number | undefined;
  hourlyRequestsMax?: number | undefined;
  lumenRequestsUsed?: number | undefined;
  lumenRequestsMax?: number | undefined;
  novaRequestsUsed?: number | undefined;
  novaRequestsMax?: number | undefined;
  usdBudgetUsed?: number | undefined;
  usdBudgetMax?: number | undefined;
  trustScorecard?: {
    scansMatching: string;
    wrongRemovals: number;
    driftDetected: number;
    driftFixed: number;
    rollbacks: number;
  } | undefined;
  /**
   * Probe ladder rows (P-0, P-0b, ...). `state` is the measured switch state;
   * when a row is absent the screen must render "—" instead of assuming a value.
   */
  probeLadder?: Array<{ id: string; state: 'on' | 'off' | 'unknown' }> | undefined;
  doctorConditions: DoctorConditionViewModel[];
  recentAlerts: Array<{
    id: string;
    timeAgo: string;
    text: string;
  }>;
}

export interface UnmatchedNameItem {
  id: string;
  seenName: string;
  suspectedModel: string;
  confidence: string;
  sourceText: string;
}

export interface UnknownTraitItem {
  id: string;
  modelId: string;
  unknownTrait: string;
}

export interface TrackStatusResponse {
  running: boolean;
  lastRun?: string | undefined;
  providerCount: number;
  trackedCount: number;
  totalModels: number;
}

export interface TrackEventItem {
  timestamp: string;
  type: 'model_added' | 'model_removed' | 'provider_skipped';
  provider: string;
  models?: string[] | undefined;
  run?: number | undefined;
}

export interface TrackEventsResponse {
  events: TrackEventItem[];
}

export interface McpClientItem {
  name: string;
  version?: string | undefined;
  connectedAt?: string | undefined;
}

export interface McpClientsResponse {
  clients: McpClientItem[];
}

export interface MaintainPlanResponse {
  status?: string | undefined;
  actions: Array<{
    type: string;
    comboId?: string | undefined;
    modelId?: string | undefined;
    target?: string | undefined;
    reason?: string | undefined;
  }>;
  summary?: string | undefined;
  state?: unknown;
}
