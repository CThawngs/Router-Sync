/**
 * packages/cli/src/commands/drift.ts
 *
 * `routersync apps drift` — đối chiếu model trong app agent với trạng thái router
 * (chỉ đọc, không ghi).
 */

import * as os from 'node:os';
import type { AgentAppInspection, AgentAppRouterRef } from '@routersync/adapter-sdk';
import type { DriftStatus, DriftResult, DriftEntry } from '../apps/drift.js';
import type { RouterConfig } from '../config/schema.js';
import {
  loadConfigFile,
  resolveConfigFilePath,
} from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import {
  AGENT_APP_ADAPTERS,
  getAgentAppAdapter,
  type AgentAppId,
} from '../apps/inspect.js';
import {
  buildRouterView,
  buildDriftReport,
  classifyModelDrift,
  DRIFT_STATUSES,
  inspectAppDrift,
  loadLocalProviderAllowlist,
  getPublicProviderRegistry,
  ProviderRedactor,
  providerToRouter,
  shouldRedactProvider,
  stripProviderPrefix,
  zeroTotals,
  computeTotalsFromEntries,
  renderDriftTable,
  type DriftReport,
  type RouterDriftView,
} from '../apps/drift.js';

export interface AppsDriftOptions {
  app?: string | undefined;
  router?: string | undefined;
  json?: boolean | undefined;
  home?: string | undefined;
  config?: string | undefined;
  redact?: boolean | undefined;
}

async function loadRouterViews(options: AppsDriftOptions): Promise<RouterDriftView[]> {
  const configPath = resolveConfigFilePath(options.config);
  let routers: RouterConfig[] = [];
  try {
    const { config } = loadConfigFile(configPath);
    routers = config.routers;
  } catch {
    return [];
  }

  const wanted = options.router ? options.router.trim() : undefined;
  const views: RouterDriftView[] = [];
  for (const router of routers) {
    if (wanted && router.adapter !== wanted) continue;
    try {
      const adapter = createAdapterForRouter(router);
      const combos = await adapter.readCombos();
      const view = await buildRouterView(router.adapter, combos);
      views.push(view);
    } catch {
      views.push({ router: router.adapter, state: undefined, error: 'không đọc được router', comboNames: new Set(), aliasNames: new Set(), availableIds: new Set(), disabledIds: new Set(), comboIds: new Set() });
    }
  }
  return views;
}

async function inspectSelectedApps(options: AppsDriftOptions): Promise<AgentAppInspection[]> {
  const homeDir = options.home ?? os.homedir();
  const wanted = options.app ? options.app.trim() : undefined;
  const inspections: AgentAppInspection[] = [];
  const adapters = wanted ? [getAgentAppAdapter(wanted)] : AGENT_APP_ADAPTERS;
  for (const adapter of adapters) {
    if (!adapter) continue;
    try {
      const inspection = await adapter.inspect({
        ...(options.config && adapters.length === 1 ? { configPath: options.config } : {}),
        homeDir,
      });
      inspections.push(inspection);
    } catch {
      // App không đọc được ⇒ bỏ qua.
    }
  }
  return inspections;
}

export async function runAppsDriftCommand(options: AppsDriftOptions = {}): Promise<void> {
  const redact = options.redact !== false; // mặc định bật
  const views = await loadRouterViews(options);
  const inspections = await inspectSelectedApps(options);

  const publicRegistry = getPublicProviderRegistry();
  const localAllowlist = loadLocalProviderAllowlist();
  const redactor = new ProviderRedactor();

  // Thu thập tất cả model của app (để kiểm tra tổng kết sau này)
  const allAppModels: Array<{ app: string; provider: string; modelId: string; routerRef: AgentAppRouterRef }> = [];
  for (const inspection of inspections) {
    for (const model of inspection.models) {
      const routerRef = providerToRouter(model.provider);
      allAppModels.push({
        app: inspection.app,
        provider: model.provider,
        modelId: stripProviderPrefix(`${model.provider}/${model.id}`),
        routerRef,
      });
    }
  }

  // Nhóm model theo (app, router) pair
  // Model có routerRef = 'UNKNOWN' (provider trực tiếp) ⇒ NOT-ROUTED
  const notRoutedByApp: Map<string, Array<{ provider: string; modelId: string }>> = new Map();
  const routedByAppRouter: Map<string, Map<string, Array<{ provider: string; modelId: string }>>> = new Map();

  for (const m of allAppModels) {
    if (m.routerRef === 'UNKNOWN') {
      let arr = notRoutedByApp.get(m.app);
      if (!arr) {
        arr = [];
        notRoutedByApp.set(m.app, arr);
      }
      arr.push({ provider: m.provider, modelId: m.modelId });
    } else {
      let byRouter = routedByAppRouter.get(m.app);
      if (!byRouter) {
        byRouter = new Map();
        routedByAppRouter.set(m.app, byRouter);
      }
      let arr = byRouter.get(m.routerRef);
      if (!arr) {
        arr = [];
        byRouter.set(m.routerRef, arr);
      }
      arr.push({ provider: m.provider, modelId: m.modelId });
    }
  }

  const results: Array<{ app: string; result: DriftResult }> = [];

  // Xử lý từng (app, router) pair
  for (const [app, byRouter] of routedByAppRouter) {
    for (const [routerRef, models] of byRouter) {
      const view = views.find(v => v.router === routerRef);
      if (!view) continue;

      const entries: DriftEntry[] = [];
      const totals: Record<DriftStatus, number> = { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };

      for (const m of models) {
        const provider = shouldRedactProvider(m.provider, publicRegistry, localAllowlist)
          ? redactor.redact(m.provider)
          : m.provider;

        const classified = classifyModelDrift(`${m.provider}/${m.modelId}`, m.provider, view);
        const entry: DriftEntry = {
          app,
          router: view.router,
          name: classified.entry.name,
          modelId: classified.entry.modelId,
          provider,
          kind: classified.entry.kind,
          status: classified.entry.status,
          reason: classified.entry.reason,
          inCombo: classified.entry.inCombo,
        };
        entries.push(entry);
      }

      // Tính tổng từ các entries (thay vì tăng dần mỗi entry)
      Object.assign(totals, computeTotalsFromEntries(entries));

      if (entries.length > 0) {
        results.push({
          app,
          result: {
            app,
            router: routerRef,
            entries,
            totals: totals as Record<DriftStatus, number>,
          },
        });
      }
    }
  }

  // Thêm NOT-ROUTED entries cho provider trực tiếp
  if (notRoutedByApp.size > 0) {
    for (const [app, models] of notRoutedByApp) {
      const entries: DriftEntry[] = [];
      const totals: Record<DriftStatus, number> = { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };

      // Gộp tất cả NOT-ROUTED theo provider
      const notRoutedByProvider: Map<string, { count: number; modelIds: string[] }> = new Map();
      for (const m of models) {
        let entry = notRoutedByProvider.get(m.provider);
        if (!entry) {
          entry = { count: 0, modelIds: [] };
          notRoutedByProvider.set(m.provider, entry);
        }
        entry.count++;
        entry.modelIds.push(m.modelId);
      }

      // Tạo một entry tổng hợp cho mỗi provider NOT-ROUTED
      for (const [provider, info] of notRoutedByProvider) {
        const redactedProvider = shouldRedactProvider(provider, publicRegistry, localAllowlist)
          ? redactor.redact(provider)
          : provider;

        // Chỉ hiển thị 3 model ID đầu tiên làm ví dụ
        const exampleIds = info.modelIds.slice(0, 3);
        const exampleNames = exampleIds.map(id => `${provider}/${id}`).join(', ');
        const more = info.count > 3 ? ` +${info.count - 3} models` : '';

        entries.push({
          app,
          router: 'UNKNOWN',
          name: `${redactedProvider}/${exampleNames}${more}`,
          modelId: exampleIds[0] ?? '',
          provider: redactedProvider,
          kind: 'NOT-ROUTED',
          status: 'NOT-ROUTED',
          reason: 'provider trực tiếp, không qua router',
          inCombo: false,
        });
        totals['NOT-ROUTED'] += info.count;
      }

      if (entries.length > 0) {
        results.push({
          app,
          result: {
            app,
            router: 'UNKNOWN',
            entries,
            totals: totals as Record<DriftStatus, number>,
          },
        });
      }
    }
  }

  // Nếu không có router view nào, đánh giá UNKNOWN cho mọi model router
  if (views.length === 0) {
    for (const inspection of inspections) {
      const entries: DriftEntry[] = [];
      const totals: Record<DriftStatus, number> = { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
      for (const model of inspection.models) {
        const routerRef = providerToRouter(model.provider);
        if (routerRef === 'UNKNOWN') {
          entries.push({
            app: inspection.app,
            router: 'UNKNOWN',
            name: `${model.provider}/${model.id}`,
            modelId: stripProviderPrefix(`${model.provider}/${model.id}`),
            provider: model.provider,
            kind: 'NOT-ROUTED',
            status: 'NOT-ROUTED',
            reason: 'provider trực tiếp, không qua router',
            inCombo: false,
          });
          totals['NOT-ROUTED']++;
        } else {
          entries.push({
            app: inspection.app,
            router: routerRef,
            name: `${model.provider}/${model.id}`,
            modelId: stripProviderPrefix(`${model.provider}/${model.id}`),
            provider: model.provider,
            kind: 'model',
            status: 'UNKNOWN',
            reason: 'không đọc được router',
            inCombo: false,
          });
          totals.UNKNOWN++;
        }
      }
      if (entries.length > 0) {
        results.push({
          app: inspection.app,
          result: {
            app: inspection.app,
            router: 'UNKNOWN',
            entries,
            totals: totals as Record<DriftStatus, number>,
          },
        });
      }
    }
  }

  // Kiểm tra tổng kết: tổng các trạng thái phải bằng tổng số model app liệt kê
  let totalAppModels = allAppModels.length;
  const reportTotals: Record<DriftStatus, number> = { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
  for (const r of results) {
    for (const s of DRIFT_STATUSES) reportTotals[s] += r.result.totals[s];
  }
  const assertionPass = totalAppModels === Object.values(reportTotals).reduce((a: number, b: number) => a + b, 0);

  // Thu thập tập provider đang kết nối (được app tham chiếu và map tới router)
  const connectedProviders = new Set<string>();
  for (const m of allAppModels) {
    if (m.routerRef !== 'UNKNOWN') {
      connectedProviders.add(m.provider);
    }
  }

  const report = buildDriftReport(
    results.map((x) => x.result),
    views,
    redactor,
    publicRegistry,
    localAllowlist,
    connectedProviders
  );

  if (options.json) {
    const totalStatusModels = Object.values(reportTotals).reduce((a: number, b: number) => a + b, 0);
    const jsonOut = {
      ...report,
      assertion: { totalAppModels, totalStatusModels, pass: assertionPass },
    };
    process.stdout.write(`${JSON.stringify(jsonOut, null, 2)}\n`);
    return;
  }

  // In biểu ngữ EXPERIMENTAL trên tất cả các dòng đầu ra
  process.stdout.write(
    `EXPERIMENTAL: kết quả chưa đáng tin (OmniRoute chưa đọc được combo; tên combo chưa tra).\n` +
    `Không nhắc nó như tính năng ổn định.\n`
  );

  process.stdout.write(`${renderDriftTable(report)}\n`);

  // In thông tin assertion (không gây fail nếu không pass, chỉ cảnh báo)
  if (!assertionPass) {
    const totalStatusModels = Object.values(reportTotals).reduce((a: number, b: number) => a + b, 0);
    process.stderr.write(
      `CẢNH BÁO: Tổng số trạng thái (${totalStatusModels}) ≠ tổng số model app (${totalAppModels}). Có thể có model bị bỏ qua.\n`
    );
  }
}
