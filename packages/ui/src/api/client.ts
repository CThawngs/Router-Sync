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
  SettingsViewModel,
  SetupPreviewViewModel,
  UnmatchedNameItem,
  UnknownTraitItem,
  TrackStatusResponse,
  TrackEventsResponse,
  McpClientsResponse,
  MaintainPlanResponse,
} from './types.js';

export interface ApiClient {
  isMock(): boolean;
  getOverview(): Promise<SystemOverview>;
  setFirstRun(isFirstRun: boolean): Promise<void>;
  toggleEmergencyPause(): Promise<{ isPaused: boolean }>;
  /**
   * R16-2.3: the daemon's own health (GET /api/v1/health). `reachable` is
   * false when the daemon could not be reached at all.
   */
  getDaemonHealth(): Promise<DaemonHealthViewModel>;
  getHeartbeat(): Promise<HeartbeatHistory>;
  getPipelineModules(): Promise<PipelineModule[]>;
  getProviders(): Promise<ProviderViewModel[]>;
  getModels(): Promise<ModelViewModel[]>;
  /** R17-2: GET /api/v1/settings (policyMode + where it came from). */
  getSettings(): Promise<SettingsViewModel>;
  /** R17-2: the setup-wizard preview. Unavailable in the S1 slice. */
  getSetupPreview(): Promise<SetupPreviewViewModel>;
  getUnmatchedNames(): Promise<UnmatchedNameItem[]>;
  getUnknownTraits(): Promise<UnknownTraitItem[]>;
  getCombos(): Promise<ComboViewModel[]>;
  getTargets(): Promise<TargetViewModel[]>;
  getPendingPlan(): Promise<PlanViewModel>;
  approvePlan(planId: string, token?: string): Promise<{ success: boolean; messageKey: string }>;
  rejectPlan(planId: string): Promise<{ success: boolean; messageKey: string }>;
  getSnapshots(): Promise<SnapshotViewModel[]>;
  rollbackSnapshot(snapshotId: string): Promise<{ success: boolean; messageKey: string }>;
  getHealthSummary(): Promise<HealthSummaryViewModel>;
  /** R14-3: the doctor report is its own view-model (R14-3.2 / AT-138). */
  getDoctor(): Promise<DoctorReportViewModel>;
  /** R49: zero-token track status from live daemon. */
  getTrackStatus(): Promise<TrackStatusResponse>;
  /** R49: zero-token track events from live daemon. */
  getTrackEvents(): Promise<TrackEventsResponse>;
  /** R49: connected MCP clients from live daemon. */
  getMcpClients(): Promise<McpClientsResponse>;
  /** R50: maintenance plan from live daemon. */
  getMaintainPlan(): Promise<MaintainPlanResponse>;
}
