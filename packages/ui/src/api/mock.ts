import { ApiClient } from './client';
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
  DoctorConditionViewModel,
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
} from './types';

/**
 * R14: every piece of PROTOTYPE SAMPLE content lives in this file.
 *
 * Rule (DECISIONS 2026-10-17-12 item 6, R14): a screen is a pure function of
 * its view-model. No string / number / chip in a screen may assert system state
 * unless it comes from the VM. The screens therefore carry no sample data of
 * their own; `MockApi` is the only place sample data exists.
 */
const SAMPLE_META: ResponseMeta = {
  source: 'sample',
  generatedAt: new Date().toISOString(),
};

/**
 * Sample doctor conditions (prototype). The live values come from the daemon
 * via GET /api/v1/doctor.
 */
const SAMPLE_DOCTOR_CONDITIONS: DoctorConditionViewModel[] = [
  { id: 'c1', condKey: 'c_at100_node', state: 'pass', code: 'node_runtime_ok' },
  // R16-4: a machine that was never configured has no routersync.yaml. That
  // is a normal S1 state, so c2 is "not checked", never a failure.
  { id: 'c2', condKey: 'c_at101_config', state: 'not_checked', reason: 'using_defaults', code: 'config_missing' },
  { id: 'c3', condKey: 'c_at97_db_file', state: 'pass', code: 'db_file_readable' },
  { id: 'c4', condKey: 'c_at97_fingerprint', state: 'fail', code: 'schema_fingerprint_failed' },
  { id: 'c5', condKey: 'c_at107_snapshot', state: 'not_checked', reason: 'no_snapshot_yet', code: 'snapshot_none_yet' },
  { id: 'c6', condKey: 'c_at95_doctor', state: 'pass', code: 'routers_reachable' },
  { id: 'c7', condKey: 'c_at110_syncloop', state: 'not_checked', reason: 'needs_p3a', code: 'deferred_to_p3a' },
  { id: 'c8', condKey: 'c_at111_fastloop', state: 'not_checked', reason: 'needs_p3a', code: 'deferred_to_p3a' },
  { id: 'c9', condKey: 'c_at94_mcp_ro', state: 'not_checked', reason: 'needs_p3a', code: 'deferred_to_p3a' },
];


/**
 * R14-2.2: the prototype combo builder needs a sample model list. It is
 * prototype content, so it lives here (and only here) and the builder tab is
 * rendered only when the collection meta says `sample`.
 */
export interface BuilderModelSample {
  id: string;
  prov: string;
  price: 'forever' | 'tier' | 'sub' | 'metered' | 'unknown';
  ctx: number;
  vis: boolean | null;
  score: number;
  flag: string;
}

export const SAMPLE_BUILDER_MODELS: BuilderModelSample[] = [
  { id: 'kite-code-3', prov: 'kite', price: 'sub', ctx: 200, vis: false, score: 92, flag: '' },
  { id: 'acme-coder-2', prov: 'acme', price: 'tier', ctx: 128, vis: false, score: 90, flag: 'new' },
  { id: 'acme-chat-4', prov: 'acme', price: 'metered', ctx: 128, vis: true, score: 95, flag: 'new' },
  { id: 'lumen-flash-2', prov: 'lumen', price: 'tier', ctx: 128, vis: true, score: 84, flag: '' },
  { id: 'lumen-vision-2', prov: 'lumen', price: 'tier', ctx: 128, vis: true, score: 83, flag: 'new' },
  { id: 'nova-chat-2', prov: 'nova', price: 'forever', ctx: 64, vis: false, score: 78, flag: '' },
  { id: 'nova-chat-1', prov: 'nova', price: 'forever', ctx: 32, vis: false, score: 60, flag: 'gone' },
  { id: 'orbit-pro-1', prov: 'orbit', price: 'metered', ctx: 200, vis: true, score: 93, flag: 'paused' },
  { id: 'zeta-mini', prov: 'zeta', price: 'unknown', ctx: 32, vis: null, score: 70, flag: '' },
  { id: 'kite-lite-2', prov: 'kite', price: 'sub', ctx: 64, vis: null, score: 74, flag: '' },
  { id: 'nova-vision-1', prov: 'nova', price: 'forever', ctx: 128, vis: true, score: 77, flag: 'degraded' },
];

export const SAMPLE_BUILDER_PROVIDERS: string[] = ['acme', 'lumen', 'nova', 'kite'];

export class MockApi implements ApiClient {
  private isFirstRunState = false;
  private isPausedState = false;

  isMock(): boolean {
    return true;
  }

  async getOverview(): Promise<SystemOverview> {
    return {
      meta: SAMPLE_META,
      isFirstRun: this.isFirstRunState,
      isPaused: this.isPausedState,
      isSampleData: true,
      // R17-3: the first-run checklist and the machine detections are sample
      // content too, so the overview branch of the screen reads them here.
      firstRun: {
        checklistDone: 1,
        detections: [
          { id: 'd1', textKey: 'f_d1', state: 'ok' },
          { id: 'd2', textKey: 'f_d2', state: 'ok' },
          { id: 'd3', textKey: 'f_d3', value: 'localhost:30128', state: 'ok' },
          { id: 'd4', textKey: 'f_d4', value: 'localhost:20128', state: 'ok' },
          {
            id: 'd5',
            textKey: 'f_d5',
            value: '~/.config/opencode/opencode.json',
            state: 'ok',
          },
          { id: 'd6', textKey: 'f_d6', state: 'warn' },
        ],
      },
      // R16-2.1: the S1 daemon has no "mode" and sends no display sentence for
      // the metrics, so the sample client does not invent one either.
      routers: {
        upCount: 2,
        probedCount: 2,
      },
      trackedModels: {
        count: 412,
      },
      billableRequestsToday: {
        count: 0,
        code: 'by_design_zero_inference',
      },
      lastCheck: {
        code: 'daemon_running',
      },
      todoItems: [
        {
          id: 'td1',
          type: 'amber',
          code: 'd_td1',
          text: 'Duyệt thay đổi #a41f: thêm 3 model, gỡ 1 model, đổi thứ tự 1 combo (1 việc do agent đề xuất).',
          actionKey: 'd_td1b',
          targetSection: 'changes',
        },
        {
          id: 'td2',
          type: 'cross',
          code: 'd_td2',
          text: 'Khóa của nhà cung cấp orbit bị lỗi (401). Chưa có model nào bị gỡ.',
          actionKey: 'd_td2b',
          targetSection: 'providers',
        },
        {
          id: 'td3',
          type: 'question',
          code: 'd_td3',
          text: '9 model chưa rõ đặc điểm (ví dụ có vision hay không). Chúng không vào bộ lọc cho tới khi bạn xác nhận.',
          actionKey: 'd_td3b',
          targetSection: 'models',
        },
        {
          id: 'td4',
          type: 'diamond',
          code: 'd_td4',
          text: 'Agent (OpenCode, tự khai) đề xuất ghép tên model acme-coder-2-0912 với acme-coder-2, kèm nguồn. Nó chưa đổi gì cho tới khi bạn đồng ý.',
          actionKey: 'd_td4b',
          targetSection: 'models',
        },
      ],
      recentEvents: [
        {
          id: 'ev1',
          timeAgo: '2 phút trước',
          timeAgoKey: 'ago2',
          type: 'diamond',
          code: 'd_e1',
          params: { model: 'acme-coder-2', provider: 'acme' },
          textPrefix: 'Phát hiện model mới ',
          highlightText: 'acme-coder-2',
          textSuffix: ' ở nhà cung cấp acme.',
        },
        {
          id: 'ev2',
          timeAgo: '2 phút trước',
          timeAgoKey: 'ago2',
          type: 'amber',
          code: 'd_e2_full',
          params: { model: 'nova-chat-1' },
          highlightText: 'nova-chat-1',
          textSuffix: ' vắng 2 lần quét liên tiếp: đủ điều kiện gỡ, đang chờ bạn duyệt.',
          textPrefix: '',
        },
        {
          id: 'ev3',
          timeAgo: '8 phút trước',
          timeAgoKey: 'ago8',
          type: 'green',
          code: 'd_e3',
          textPrefix: 'Quét xong 4 nhà cung cấp. 0 request tốn phí.',
        },
        {
          id: 'ev4',
          timeAgo: '12 phút trước',
          timeAgoKey: 'ago12',
          type: 'diamond',
          code: 'd_e4',
          textPrefix: 'Agent (OpenCode, tự khai) gửi 2 đề xuất. RouterSync đã kiểm tra hợp lệ và đưa vào hàng chờ duyệt.',
        },
        {
          id: 'ev5',
          timeAgo: '31 phút trước',
          timeAgoKey: 'ago31',
          type: 'amber',
          code: 'd_e4_full',
          params: { provider: 'orbit' },
          textPrefix: 'Nhà cung cấp ',
          highlightText: 'orbit',
          textSuffix: ' báo lỗi khóa 401: tạm dừng quét, không gỡ model nào.',
        },
        {
          id: 'ev6',
          timeAgo: '53 phút trước',
          timeAgoKey: 'ago53',
          type: 'green',
          code: 'd_e5',
          textPrefix: 'Tính xong thay đổi #a41f ở chế độ chạy thử (chưa ghi gì).',
        },
      ],
    };
  }

  async setFirstRun(isFirstRun: boolean): Promise<void> {
    this.isFirstRunState = isFirstRun;
  }

  async toggleEmergencyPause(): Promise<{ isPaused: boolean }> {
    this.isPausedState = !this.isPausedState;
    return { isPaused: this.isPausedState };
  }

  async getDaemonHealth(): Promise<DaemonHealthViewModel> {
    // R16-2.3: sample content. The whole app shows the "sample data" strip
    // while the mock client is in charge, so these numbers are never read as
    // measurements.
    return {
      meta: SAMPLE_META,
      reachable: true,
      uptimeSeconds: 120,
      readOnly: true,
      routers: [
        { id: 'omniroute', reachability: 'up', httpStatus: 200, lastChecked: '2026-10-20T09:00:00.000Z' },
        { id: '9router', reachability: 'up', httpStatus: 200, lastChecked: '2026-10-20T09:00:02.000Z' },
      ],
    };
  }

  async getHeartbeat(): Promise<HeartbeatHistory> {
    const ticks: HeartbeatHistory['ticks'] = [];
    for (let i = 0; i < 24; i++) {
      if (i === 11) {
        ticks.push({ id: `tick_${i}`, status: 'warning' });
      } else if (i === 17) {
        ticks.push({ id: `tick_${i}`, status: 'missed' });
      } else {
        ticks.push({ id: `tick_${i}`, status: 'ok' });
      }
    }
    return {
      ticks,
      source: 'measured',
      uptimeSeconds: 120,
      lastProbeAt: '2026-10-20T09:00:02.000Z',
      daemonReachable: true,
    };
  }

  async getPipelineModules(): Promise<PipelineModule[]> {
    return [
      { id: 'm1', step: 1, titleKey: 'm1', descKey: 'm1d', ageSeconds: 120, status: 'ok', count: '6/6' },
      { id: 'm2', step: 2, titleKey: 'm2', descKey: 'm2d', ageSeconds: 120, status: 'ok', count: '4/6' },
      { id: 'm3', step: 3, titleKey: 'm3', descKey: 'm3d', ageSeconds: 120, status: 'amber', count: '412' },
      { id: 'm4', step: 4, titleKey: 'm4', descKey: 'm4d', ageSeconds: 480, status: 'ok', count: '3 · 4' },
      { id: 'm5', step: 5, titleKey: 'm5', descKey: 'm5d', ageSeconds: 3180, status: 'ok', count: '5' },
      { id: 'm6', step: 6, titleKey: 'm6', descKey: 'm6d', ageSeconds: 3180, status: 'amber', count: '1' },
      { id: 'm7', step: 7, titleKey: 'm7', descKey: 'm7d', ageSeconds: 86400, status: 'ok', count: '3' },
      { id: 'm8', step: 8, titleKey: 'm8', descKey: 'm8d', status: 'unk', isDashed: true },
    ];
  }

  /**
   * R17-1: the PROTOTYPE provider content lives here and only here.
   *
   * The R16 screen painted its own copy of these cards (86 / 41 / 120 / 97
   * models, a "620/1000" quota, a "31 min ago" scan age) and the two copies
   * disagreed. Now the view-model is the single source: the screen renders
   * these fields, and the live daemon renders its own.
   */
  async getProviders(): Promise<ProviderViewModel[]> {
    const providers: ProviderViewModel[] = [
      {
        id: 'acme',
        name: 'acme',
        status: 'active',
        keySource: 'os_store',
        keySourceLabel: 'p_key_os',
        modelsCount: 86,
        freeQuotaToday: '1000/1000 req',
        lastScan: 'ago2',
        autoAddNew: true,
        autoRemoveGone: true,
        notice: 'p_a1',
        priceKindKey: 'pk_metered',
        detail: 'T1 API · quota: 1000/1000 requests/day',
      },
      {
        id: 'lumen',
        name: 'lumen',
        status: 'active',
        keySource: 'env_var',
        keySourceLabel: 'p_key_env',
        modelsCount: 64,
        freeQuotaToday: '500/500 req',
        lastScan: 'ago4',
        autoAddNew: true,
        autoRemoveGone: true,
        notice: 'p_n1',
        priceKindKey: 'pk_tier',
        quota: { used: 620, limit: 1000 },
        detail: 'T1 API · quota: 620/1000 requests/day',
      },
      {
        id: 'apex',
        name: 'apex',
        status: 'active',
        keySource: 'os_store',
        keySourceLabel: 'p_key_os',
        modelsCount: 114,
        freeQuotaToday: 'p_unlimited',
        lastScan: 'ago8',
        autoAddNew: true,
        autoRemoveGone: true,
        priceKindKey: 'pk_metered',
      },
      {
        id: 'zenith',
        name: 'zenith',
        status: 'active',
        keySource: 'router_imported',
        keySourceLabel: 'p_key_rt',
        modelsCount: 80,
        freeQuotaToday: '120/200 req',
        lastScan: 'ago12',
        autoAddNew: true,
        autoRemoveGone: true,
        priceKindKey: 'pk_sub',
      },
      {
        id: 'orbit',
        name: 'orbit',
        status: 'key_error',
        keySource: 'os_store',
        keySourceLabel: 'p_key_bad',
        modelsCount: 63,
        freeQuotaToday: '0/0 req',
        lastScan: 'ago31',
        autoAddNew: true,
        autoRemoveGone: false,
        notice: 'p_o1',
        priceKindKey: 'pk_unknown',
        retainedCount: 68,
        detail: 'lifecycle: auth_failed · HTTP 401 · retry with backoff',
      },
      {
        id: 'vortex',
        name: 'vortex',
        status: 'no_list_api',
        keySource: 'os_store',
        keySourceLabel: 'p_key_os',
        modelsCount: 5,
        freeQuotaToday: '—',
        lastScan: 'p_never',
        autoAddNew: false,
        autoRemoveGone: false,
        notice: 'p_z1',
        manualCount: 5,
        priceKindKey: 'pk_unknown',
        detail: 'lifecycle: no_list_api · manual list',
      },
    ];
    // R17-1: the collection carries its envelope, so the screen can tell
    // "sample content" apart from "the daemon measured nothing".
    (providers as unknown as { meta: ResponseMeta }).meta = SAMPLE_META;
    return providers;
  }
  async getModels(): Promise<ModelViewModel[]> {
    const models: ModelViewModel[] = [
      {
        id: 'kite-code-3',
        canonicalId: 'kite/kite-code-3',
        provider: 'kite',
        priceKind: 'subscription',
        priceText: 'pk_sub',
        context: '256k',
        score: 96,
        status: 'healthy',
        hasVision: 'yes',
        aliases: ['kite-coder-latest'],
        whereUsed: ['coding-fast (pos 1)', 'smart-cascade (pos 1)'],
        scoreExplanation: 'Coding: 96 · Latency: 420ms · 4 sources',
      },
      {
        id: 'acme-coder-2',
        canonicalId: 'acme/acme-coder-2',
        provider: 'acme',
        priceKind: 'metered',
        priceText: 'pk_metered',
        context: '128k',
        score: 94,
        status: 'new',
        hasVision: 'yes',
        aliases: ['acme/code-2.1'],
        whereUsed: ['coding-fast (pos 2)'],
        scoreExplanation: 'Coding: 94 · Latency: 380ms · 3 sources',
      },
      {
        id: 'lumen-flash-2',
        canonicalId: 'lumen/lumen-flash-2',
        provider: 'lumen',
        priceKind: 'free_tier',
        priceText: 'pk_tier',
        context: '128k',
        score: 91,
        status: 'healthy',
        hasVision: 'yes',
        aliases: ['lumen-f2-preview'],
        whereUsed: ['coding-fast (pos 3)', 'free-all (pos 1)'],
        scoreExplanation: 'Coding: 91 · Free quota: 1000/day',
      },
      {
        id: 'nova-vision-1',
        canonicalId: 'nova/nova-vision-1',
        provider: 'nova',
        priceKind: 'free_forever',
        priceText: 'pk_forever',
        context: '128k',
        score: 88,
        status: 'degraded',
        hasVision: 'yes',
        aliases: [],
        whereUsed: ['smart-cascade (pos 2)', 'free-all (pos 2)'],
        scoreExplanation: 'Vision: 88 · Recent 5xx errors recorded',
      },
      {
        id: 'acme-chat-3',
        canonicalId: 'acme/acme-chat-3',
        provider: 'acme',
        priceKind: 'free_tier',
        priceText: 'pk_tier',
        context: '64k',
        score: 87,
        status: 'healthy',
        hasVision: 'no',
        aliases: ['acme/chat-3-turbo'],
        whereUsed: ['smart-cascade (pos 3)'],
        scoreExplanation: 'General: 87 · Latency: 310ms',
      },
      {
        id: 'orbit-pro-1',
        canonicalId: 'orbit/orbit-pro-1',
        provider: 'orbit',
        priceKind: 'metered',
        priceText: 'pk_metered',
        context: '128k',
        score: 85,
        status: 'paused',
        hasVision: 'yes',
        aliases: [],
        whereUsed: ['my-old-combo (pos 1)'],
        scoreExplanation: 'Paused: provider key error 401',
      },
      {
        id: 'lumen-dense-1',
        canonicalId: 'lumen/lumen-dense-1',
        provider: 'lumen',
        priceKind: 'free_tier',
        priceText: 'pk_tier',
        context: '32k',
        score: 83,
        status: 'healthy',
        hasVision: 'no',
        aliases: [],
        whereUsed: ['free-all (pos 3)'],
        scoreExplanation: 'General: 83 · Free tier',
      },
      {
        id: 'nova-chat-1',
        canonicalId: 'nova/nova-chat-1',
        provider: 'nova',
        priceKind: 'free_forever',
        priceText: 'pk_forever',
        context: '64k',
        score: 79,
        status: 'due_removal',
        hasVision: 'no',
        aliases: [],
        whereUsed: ['coding-fast (pending removal)'],
        scoreExplanation: 'Missing in 2/2 scans',
      },
      {
        id: 'kite-lite-2',
        canonicalId: 'kite/kite-lite-2',
        provider: 'kite',
        priceKind: 'subscription',
        priceText: 'pk_sub',
        context: '32k',
        score: 74,
        status: 'healthy',
        hasVision: 'unknown',
        aliases: [],
        whereUsed: ['Not used in active combos'],
        scoreExplanation: 'Speed: 92 · Unknown vision trait',
      },
      {
        id: 'orbit-mini-1',
        canonicalId: 'orbit/orbit-mini-1',
        provider: 'orbit',
        priceKind: 'metered',
        priceText: 'pk_metered',
        context: '32k',
        score: 71,
        status: 'paused',
        hasVision: 'no',
        aliases: [],
        whereUsed: ['my-old-combo (pos 2)'],
        scoreExplanation: 'Paused: provider key error 401',
      },
      {
        id: 'zeta-mini',
        canonicalId: 'zeta/zeta-mini',
        provider: 'zeta',
        priceKind: 'metered',
        priceText: 'pk_metered',
        context: '16k',
        score: 68,
        status: 'healthy',
        hasVision: 'unknown',
        aliases: [],
        whereUsed: ['Manual test only'],
        scoreExplanation: 'Manual provider · No list API',
      },
    ];
    // R17-0.3: the collection carries its own envelope, so the screen can tell
    // "sample content" apart from "the daemon measured nothing".
    (models as unknown as { meta: ResponseMeta }).meta = SAMPLE_META;
    return models;
  }


  async getUnmatchedNames(): Promise<UnmatchedNameItem[]> {
    return [
      {
        id: 'u1',
        seenName: 'acme-coder-2-0912',
        suspectedModel: 'acme-coder-2',
        confidence: 'm_hi',
        sourceText: 'm_ag',
      },
      {
        id: 'u2',
        seenName: 'lumen-flash-2.0-preview',
        suspectedModel: 'lumen-flash-2',
        confidence: 'm_mid',
        sourceText: 'm_sr3',
      },
      {
        id: 'u3',
        seenName: 'zenith-v2-chat',
        suspectedModel: 'zenith-instruct',
        confidence: 'm_low',
        sourceText: 'm_sr4',
      },
    ];
  }

  async getUnknownTraits(): Promise<UnknownTraitItem[]> {
    return [
      { id: 'q1', modelId: 'zenith-mini', unknownTrait: 'Vision (có hay không?)' },
      { id: 'q2', modelId: 'vortex-custom', unknownTrait: 'Vision (có hay không?)' },
      { id: 'q3', modelId: 'apex-code-experimental', unknownTrait: 'Function Calling' },
      { id: 'q4', modelId: 'orbit-fast-embed', unknownTrait: 'Context Length chính xác' },
      { id: 'q5', modelId: 'acme-embed-3', unknownTrait: 'Pricing kind' },
      { id: 'q6', modelId: 'lumen-vision-lite', unknownTrait: 'Context Length' },
      { id: 'q7', modelId: 'zenith-legacy-chat', unknownTrait: 'Tool use support' },
      { id: 'q8', modelId: 'kite-small-1', unknownTrait: 'Reasoning capability' },
      { id: 'q9', modelId: 'orbit-mini-chat', unknownTrait: 'Pricing kind' },
    ];
  }

  /**
   * R17-2: prototype settings. The S1 daemon measures `policyMode` only, so
   * everything below is sample content and is shown only when the collection
   * says `sample`.
   */
  async getSettings(): Promise<SettingsViewModel> {
    return {
      meta: SAMPLE_META,
      policyMode: 'shadow',
      policyModeSource: 'config',
      localUrl: 'http://127.0.0.1:4173',
      scanSchedule: 's_scan6h',
      maxDailyRequests: 50,
      mcpClients: [
        { client: 'Claude Code', configured: true, mode: 'read_only' },
        { client: 'OpenCode', configured: true, mode: 'read_only' },
        { client: 'Hermes Agent', configured: false, mode: 'read_only' },
      ],
      shadowWeek: { day: 3, total: 7 },
      limits: {
        impactPercent: 50,
        minModels: 2,
        minProviders: 2,
        backups: 30,
        waitBeforeGoneKey: 's_r1dv',
        quarantineKey: 's_r1ev',
      },
    };
  }

  /** R17-2: prototype preview of the setup wizard. */
  async getSetupPreview(): Promise<SetupPreviewViewModel> {
    return {
      meta: SAMPLE_META,
      modelsFound: 86,
      combosSuggested: 2,
      billableRequests: 0,
      writtenToConfig: 0,
      detections: [
        { id: 'omniroute', textKey: 'f_d3', value: 'localhost:30128', state: 'ok' },
        { id: '9router', textKey: 'f_d4', value: 'localhost:20128', state: 'ok' },
        {
          id: 'opencode',
          textKey: 'f_d5',
          value: '~/.config/opencode/opencode.json',
          state: 'ok',
        },
      ],
    };
  }

  async getCombos(): Promise<ComboViewModel[]> {
    const combos: ComboViewModel[] = [
      {
        meta: SAMPLE_META,
        id: 'coding-fast',
        name: 'coding-fast',
        type: 'managed',
        badgeKey: 'b_managed',
        targets: ['OmniRoute', '9Router'],
        strategy: 'priority',
        steps: [
          { position: 1, modelId: 'kite-code-3', description: 'b_l1', score: 96, status: 'ok' },
          { position: 2, modelId: 'lumen-flash-2', description: 'b_l2', score: 91, status: 'ok' },
          { position: 3, modelId: 'nova-chat-1', description: 'b_l3', score: 79, status: 'proposed_remove' },
        ],
        actualVsDesired: [
          { position: 1, actual: 'kite-code-3', desired: 'kite-code-3', status: 'match' },
          { position: 2, actual: 'lumen-flash-2', desired: 'acme-coder-2', status: 'waiting' },
          { position: 3, actual: 'nova-chat-1', desired: 'lumen-flash-2', status: 'waiting' },
        ],
        isFreeOnly: false,
      },
      {
        meta: SAMPLE_META,
        id: 'free-all',
        name: 'free-all',
        type: 'managed',
        badgeKey: 'b_managed',
        targets: ['OmniRoute', '9Router'],
        strategy: 'priority',
        steps: [
          { position: 1, modelId: 'lumen-flash-2', description: 'b_f1', score: 91, status: 'ok' },
          { position: 2, modelId: 'lumen-dense-1', description: 'b_f2', score: 83, status: 'ok' },
          { position: 3, modelId: 'acme-chat-3', description: 'b_f3', score: 87, status: 'ok' },
          { position: 4, modelId: 'nova-vision-1', description: 'b_f4', score: 88, status: 'degraded' },
        ],
        actualVsDesired: [],
        isFreeOnly: true,
      },
      {
        meta: SAMPLE_META,
        id: 'smart-cascade',
        name: 'smart-cascade',
        type: 'cascade',
        badgeKey: 'b_casc',
        targets: ['OmniRoute'],
        strategy: 'priority',
        steps: [
          { position: 1, modelId: 'coding-fast', description: 'b_c1', status: 'ok' },
          { position: 2, modelId: 'free-all', description: 'b_c2', status: 'ok' },
        ],
        actualVsDesired: [],
        isFreeOnly: false,
        cascadeCombos: ['coding-fast', 'free-all'],
      },
      {
        meta: SAMPLE_META,
        id: 'my-old-combo',
        name: 'my-old-combo',
        type: 'adopted',
        badgeKey: 'b_adopt',
        targets: ['9Router'],
        strategy: 'round-robin',
        steps: [
          { position: 1, modelId: 'kite-lite-2', description: 'b_my1', status: 'ok' },
          { position: 2, modelId: 'zeta-mini', description: 'b_my2', status: 'ok' },
        ],
        actualVsDesired: [],
        isFreeOnly: false,
      },
    ];
    // Collection-level meta: the screen uses it to tell sample data from live data.
    (combos as unknown as { meta: ResponseMeta }).meta = SAMPLE_META;
    return combos;
  }


  async getTargets(): Promise<TargetViewModel[]> {
    const targets: TargetViewModel[] = [
      {
        meta: SAMPLE_META,
        id: 'omniroute',
        name: 'OmniRoute',
        type: 'router',
        addressOrPath: 'localhost:30128',
        mode: 'active',
        supportsCombos: true,
        providersSynced: 4,
        db: {
          meta: SAMPLE_META,
          combosManaged: 2,
          combosAdopted: 0,
        },
        readBackLevel: 'full',
        applyState: 'verified',
        versionGate: '3.8.50 (trong dải hỗ trợ)',
        breakerState: 'closed',
        integrationTier: 'T1',
        integrationNotes: 't_a1',
      },
      {
        meta: SAMPLE_META,
        id: '9router',
        name: '9Router',
        type: 'router',
        addressOrPath: 'localhost:20128',
        mode: 'active',
        supportsCombos: true,
        providersSynced: 4,
        db: {
          meta: SAMPLE_META,
          combosManaged: 2,
          combosAdopted: 1,
        },
        readBackLevel: 'db-only',
        applyState: 'written-pending-reload',
        policyMode: 'shadow',
        policyCappedReason: 'c_d26_cap',
        versionGate: '0.5.99 (trong dải hỗ trợ)',
        breakerState: 'closed',
        integrationTier: 'T3',
        integrationNotes: 't_a2',
        cloudSyncWarning: true,
        filterRule: 't_r5v',
      },
      {
        meta: SAMPLE_META,
        id: 'opencode',
        name: 'OpenCode',
        type: 'agent_app',
        addressOrPath: '~/.config/opencode/opencode.json',
        mode: 'preview',
        supportsCombos: false,
        providersSynced: 2,
        readBackLevel: 'full',
        applyState: 'verified',
        versionGate: '1.2.0 (trong dải hỗ trợ)',
        breakerState: 'closed',
        integrationTier: 'T2',
        integrationNotes: 't_a3',
        defaultSlotsState: 't_r6v',
      },
    ];
    // Collection-level meta: the screen uses it to tell sample data from live data.
    (targets as unknown as { meta: ResponseMeta }).meta = SAMPLE_META;
    return targets;
  }


  async getPendingPlan(): Promise<PlanViewModel> {
    return {
      meta: SAMPLE_META,
      id: 'plan_a41f',
      proposalCode: '#a41f',
      planHash: '9c1e3d08f2a41f',
      computedTimeAgo: '53 phút trước',
      computedTimeAgoKey: 'ago53',
      impactPercent: 12,
      maxImpactPercent: 50,
      billableRequestsCount: 0,
      targetsSummary: 'c_s3v',
      hasRollbackBackup: true,
      sourceSummary: '4 + 1',
      sourceDetail: 'c_s5v',
      actions: [
        {
          id: 'act1',
          type: 'add',
          modelId: 'acme-coder-2',
          titleKey: 'c_a1',
          description: 'c_a1w',
          appliesTo: 'c_a1t',
          risk: 'low',
          source: 'auto',
        },
        {
          id: 'act2',
          type: 'add',
          modelId: 'acme-chat-4',
          titleKey: 'c_a2',
          description: 'c_a2w',
          appliesTo: 'c_a2t',
          risk: 'low',
          source: 'auto',
        },
        {
          id: 'act3',
          type: 'add',
          modelId: 'lumen-flash-2',
          titleKey: 'c_a3',
          description: 'c_a3w',
          appliesTo: 'c_a3t',
          risk: 'low',
          source: 'auto',
        },
        {
          id: 'act4',
          type: 'remove',
          modelId: 'nova-chat-1',
          titleKey: 'c_a4',
          description: 'c_a4w',
          appliesTo: 'c_a4t',
          risk: 'low',
          source: 'auto',
        },
        {
          id: 'act5',
          type: 'reorder',
          modelId: 'coding-fast',
          titleKey: 'c_a5',
          description: 'c_a5w',
          appliesTo: 'c_a5t',
          risk: 'low',
          source: 'agent',
          agentName: 'c_src_ag',
          evidenceSnippet: 'c_a5e',
        },
      ],
      deliberateExclusions: [
        'c_x1',
        'c_x2',
        'c_x3',
        'c_x4',
        'c_x5',
      ],
      unifiedDiff: `omniroute · combos · "coding-fast"
- "nova/nova-chat-1"
+ "acme/acme-coder-2",
+ "lumen/lumen-flash-2"

9router · provider_models (sqlite · models table)
+ INSERT INTO model(provider, id) VALUES ('acme', 'acme-chat-4');
+ INSERT INTO model(provider, id) VALUES ('lumen', 'lumen-flash-2');
- DELETE FROM model WHERE provider='nova' AND id='nova-chat-1';

~/.config/opencode/opencode.json (preview, not written)
  "providers": { "acme": { "models": [
+   "acme-coder-2": {},
    "acme-chat-3": {}
  ] } }`,
    };
  }

  async approvePlan(_planId: string): Promise<{ success: boolean; messageKey: string }> {
    return {
      success: true,
      messageKey: 'c_ok',
    };
  }

  async rejectPlan(_planId: string): Promise<{ success: boolean; messageKey: string }> {
    return {
      success: true,
      messageKey: 'c_rej',
    };
  }

  async getSnapshots(): Promise<SnapshotViewModel[]> {
    return [
      {
        id: 'snap_yesterday_2114',
        target: 'OmniRoute, 9Router',
        timestamp: '2026-10-14T21:14:00Z',
        timeAgo: 'c_t1',
        changedCount: 3,
        size: '14.2 KB',
        summary: 'c_t1d',
        approvedBy: 'c_by_ag',
      },
      {
        id: 'snap_2days_ago',
        target: 'OmniRoute, 9Router',
        timestamp: '2026-10-13T15:20:00Z',
        timeAgo: 'c_t2',
        changedCount: 1,
        size: '12.8 KB',
        summary: 'c_t2d',
        approvedBy: 'c_by_you',
      },
      {
        id: 'snap_4days_ago',
        target: '9Router',
        timestamp: '2026-10-11T10:05:00Z',
        timeAgo: 'c_t3',
        changedCount: 1,
        size: '12.8 KB',
        summary: 'c_t3d',
        approvedBy: 'Tự động hoàn tác (lệch kỳ vọng)',
      },
      {
        id: 'snap_6days_ago',
        target: 'OmniRoute',
        timestamp: '2026-10-09T08:30:00Z',
        timeAgo: 'c_t4',
        changedCount: 15,
        size: '18.0 KB',
        summary: 'c_t4d',
        approvedBy: 'c_by_you',
      },
    ];
  }

  async rollbackSnapshot(_snapshotId: string): Promise<{ success: boolean; messageKey: string }> {
    return {
      success: true,
      messageKey: 'c_ok',
    };
  }

  async getHealthSummary(): Promise<HealthSummaryViewModel> {
    return {
      meta: SAMPLE_META,
      billableRequestsToday: 0,
      costTodayUsd: 0.0,
      healthyModelsCount: 408,
      degradedModelsCount: 1,
      dueRemovalCount: 1,
      safetyMode: 'manual',
      hourlyRequestsUsed: 42,
      hourlyRequestsMax: 200,
      lumenRequestsUsed: 12,
      lumenRequestsMax: 50,
      novaRequestsUsed: 8,
      novaRequestsMax: 50,
      usdBudgetUsed: 0.0,
      usdBudgetMax: 0.1,
      trustScorecard: {
        scansMatching: '99.8%',
        wrongRemovals: 0,
        driftDetected: 1,
        driftFixed: 1,
        rollbacks: 1,
      },
      probeLadder: [
        { id: 'P-0', state: 'on' },
        { id: 'P-0b / P-0c', state: 'on' },
        { id: 'P-0d', state: 'off' },
        { id: 'P-1', state: 'off' },
      ],
      doctorConditions: SAMPLE_DOCTOR_CONDITIONS,
      recentAlerts: [
        { id: 'al1', timeAgo: 'ago2h', text: 'h_al1' },
        { id: 'al2', timeAgo: 'ago2h', text: 'h_al4' },
        { id: 'al3', timeAgo: 'h_al_t2', text: 'h_al2' },
        { id: 'al4', timeAgo: 'h_al_t3', text: 'h_al3' },
      ],
    };
  }

  async getDoctor(): Promise<DoctorReportViewModel> {
    return {
      meta: SAMPLE_META,
      overallStatus: 'warning',
      conditions: SAMPLE_DOCTOR_CONDITIONS,
    };
  }

  async getTrackStatus(): Promise<TrackStatusResponse> {
    return {
      running: false,
      lastRun: '2026-10-30T06:30:00.000Z',
      providerCount: 2,
      trackedCount: 2,
      totalModels: 42,
    };
  }

  async getTrackEvents(): Promise<TrackEventsResponse> {
    return {
      events: [
        {
          timestamp: '2026-10-30T06:30:00.000Z',
          type: 'model_added',
          provider: 'nvidia',
          models: ['nvidia/01-ai/yi-large'],
          run: 1,
        },
      ],
    };
  }

  async getMcpClients(): Promise<McpClientsResponse> {
    return {
      clients: [
        {
          name: 'claude-code',
          version: '1.0.0',
          connectedAt: '2026-10-30T06:30:00.000Z',
        },
      ],
    };
  }

  async getMaintainPlan(): Promise<MaintainPlanResponse> {
    return {
      status: 'ok',
      actions: [],
      summary: 'Mock maintain plan: zero actions needed',
    };
  }
}

