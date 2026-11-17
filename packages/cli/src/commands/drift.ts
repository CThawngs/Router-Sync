/**
 * packages/cli/src/commands/drift.ts
 *
 * `routersync apps drift` — đối chiếu model trong app agent với trạng thái router
 * (chỉ đọc, không ghi).
 */

import * as os from 'node:os';
import type { AgentAppInspection } from '@routersync/adapter-sdk';
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
  classifyAppDrift,
  DRIFT_STATUSES,
  inspectAppDrift,
  renderDriftTable,
  type DriftResult,
  type RouterDriftView,
} from '../apps/drift.js';

export interface AppsDriftOptions {
  app?: string | undefined;
  router?: string | undefined;
  json?: boolean | undefined;
  home?: string | undefined;
  config?: string | undefined;
}

async function loadRouterViews(options: AppsDriftOptions): Promise<RouterDriftView[]> {
  // preAction hook đã gọi installConfiguredRouterDbPaths; tải config để biết danh sách routers.
  const configPath = resolveConfigFilePath(options.config);
  let routers: RouterConfig[] = [];
  try {
    const { config } = loadConfigFile(configPath);
    routers = config.routers;
  } catch {
    // Không có config hợp lệ ⇒ không đọc được router, trả view rỗng (tất cả UNKNOWN handled ở caller).
    return [];
  }

  const wanted = options.router ? options.router.trim() : undefined;
  const views: RouterDriftView[] = [];
  for (const router of routers) {
    if (wanted && router.adapter !== wanted) continue;
    try {
      const adapter = createAdapterForRouter(router);
      const [catalog, combos] = await Promise.all([adapter.readCatalog(), adapter.readCombos()]);
      views.push(buildRouterView(router.adapter, catalog, combos));
    } catch {
      // Router không đọc được ⇒ báo UNKNOWN cho các entry của router này (xử lý ở caller qua view rỗng).
      views.push({ router: router.adapter, catalogIds: new Set(), comboNames: new Set(), aliasNames: new Set() });
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
      // App không đọc được ⇒ bỏ qua (không có model để đối chiếu).
    }
  }
  return inspections;
}

export async function runAppsDriftCommand(options: AppsDriftOptions = {}): Promise<void> {
  const views = await loadRouterViews(options);
  const inspections = await inspectSelectedApps(options);

  const results: Array<{ app: string; result: DriftResult }> = [];
  for (const inspection of inspections) {
    for (const view of views) {
      results.push({
        app: inspection.app,
        result: classifyAppDrift(inspection.app, inspection, view),
      });
    }
  }

  // Nếu không có router view nào (config thiếu/lỗi), đánh giá UNKNOWN cho mọi model router.
  if (views.length === 0) {
    for (const inspection of inspections) {
      for (const adapter of AGENT_APP_ADAPTERS) {
        if (adapter.app !== inspection.app) continue;
        const entries = inspection.models.map((m) => ({
          app: inspection.app,
          router: 'UNKNOWN',
          name: `${m.provider}/${m.id}`,
          modelId: m.id,
          kind: 'model' as const,
          status: 'UNKNOWN' as const,
          reason: 'không đọc được router',
        }));
        results.push({
          app: inspection.app,
          result: {
            app: inspection.app,
            router: 'UNKNOWN',
            entries,
            totals: { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: entries.length, 'NOT-ROUTED': 0 },
          },
        });
      }
      break;
    }
  }

  const report = buildDriftReport(
    results.map((x) => x.result),
    views
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderDriftTable(report)}\n`);
}
