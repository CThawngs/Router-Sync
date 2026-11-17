/**
 * packages/cli/src/commands/drift.ts
 *
 * `routersync apps drift` — đối chiếu model trong app agent với trạng thái router
 * (chỉ đọc, không ghi).
 */

import * as os from 'node:os';
import type { AgentAppInspection } from '@routersync/adapter-sdk';
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
      views.push({ router: router.adapter, state: undefined, error: 'không đọc được router', comboNames: new Set(), aliasNames: new Set() });
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

  const results: Array<{ app: string; result: DriftResult }> = [];
  for (const inspection of inspections) {
    for (const view of views) {
      // Mỗi model chỉ được đối chiếu với router mà provider của nó ánh xạ tới.
      const entries: DriftEntry[] = [];
      const totals: Record<DriftStatus, number> = { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };

      for (const model of inspection.models) {
        const routerRef = providerToRouter(model.provider);
        if (routerRef !== view.router) continue; // không phải router này ⇒ bỏ qua

        const provider = shouldRedactProvider(model.provider, publicRegistry, localAllowlist)
          ? redactor.redact(model.provider)
          : model.provider;

        const classified = classifyModelDrift(`${model.provider}/${model.id}`, model.provider, view);
        const entry: DriftEntry = {
          app: inspection.app,
          router: view.router,
          name: classified.entry.name,
          modelId: classified.entry.modelId,
          provider,
          kind: classified.entry.kind,
          status: classified.entry.status,
          reason: classified.entry.reason,
        };
        entries.push(entry);
        totals[entry.status] = (totals[entry.status] || 0) + 1;
      }

      if (entries.length > 0) {
        results.push({
          app: inspection.app,
          result: {
            app: inspection.app,
            router: view.router,
            entries,
            totals: totals as Record<DriftStatus, number>,
          },
        });
      }
    }
  }

  // Nếu không có router view nào, đánh giá UNKNOWN cho mọi model router.
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
            modelId: model.id,
            provider: model.provider,
            kind: 'model',
            status: 'NOT-ROUTED',
            reason: 'provider trực tiếp, không qua router',
          });
          totals['NOT-ROUTED']++;
        } else {
          entries.push({
            app: inspection.app,
            router: routerRef,
            name: `${model.provider}/${model.id}`,
            modelId: model.id,
            provider: model.provider,
            kind: 'model',
            status: 'UNKNOWN',
            reason: 'không đọc được router',
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

  const report = buildDriftReport(
    results.map((x) => x.result),
    views,
    redactor,
    publicRegistry,
    localAllowlist
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderDriftTable(report)}\n`);
}
