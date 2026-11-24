/**
 * packages/cli/src/commands/apps.ts
 *
 * `routersync apps inspect` — read-only view of an agent app's provider and
 * model configuration.
 *
 * C45-WP2 (`Phục vụ: S3`): adds `apps plan`, `apps apply`, and `apps rollback`
 * backed by `HarnessWriteAdapter` with strict sandbox-copy enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { maskHomePath } from '@routersync/adapter-sdk';
import type { AgentAppInspection, HarnessCatalogInput } from '@routersync/adapter-sdk';
import {
  AGENT_APP_ADAPTERS,
  AgentAppInspectError,
  getAgentAppAdapter,
} from '../apps/inspect.js';
import {
  assertHarnessWriteSandboxAllowed,
  getHarnessWriteAdapter,
  listHarnessWriteAdapters,
  resolveEffectiveHarnessHomeDir,
} from '../apps/write-adapter.js';

export interface AppsInspectOptions {
  app?: string | undefined;
  home?: string | undefined;
  config?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsPlanCommandOptions {
  app: string;
  config?: string | undefined;
  catalog: string;
  home?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsApplyCommandOptions {
  app: string;
  config: string;
  catalog: string;
  home?: string | undefined;
  sandboxCopy?: boolean | undefined;
  planHash?: string | undefined;
  backup?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsRollbackCommandOptions {
  app: string;
  config: string;
  backup?: string | undefined;
  expectedPreSha256?: string | undefined;
  json?: boolean | undefined;
}

function statusLabel(enabled: AgentAppInspection['models'][number]['enabled']): string {
  if (enabled === true) return 'bật';
  if (enabled === false) return 'tắt';
  return 'UNKNOWN';
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(rows: string[][]): string {
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
  }
  return rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

export async function runAppsInspectCommand(options: AppsInspectOptions = {}): Promise<void> {
  const homeDir = options.home ?? os.homedir();
  const wanted = options.app?.trim();

  let adapters = AGENT_APP_ADAPTERS;
  if (wanted) {
    const adapter = getAgentAppAdapter(wanted);
    if (!adapter) {
      process.stderr.write(
        `app không hỗ trợ: ${wanted} (hỗ trợ: ${AGENT_APP_ADAPTERS.map((a) => a.app).join(', ')})\n`
      );
      process.exitCode = 1;
      return;
    }
    adapters = [adapter];
  }

  const results: AgentAppInspection[] = [];
  const failures: Array<{ app: string; code: string; message: string }> = [];

  for (const adapter of adapters) {
    try {
      const inspection = await adapter.inspect({
        ...(options.config && adapters.length === 1 ? { configPath: options.config } : {}),
        homeDir,
      });
      results.push(inspection);
    } catch (error) {
      const code = error instanceof AgentAppInspectError ? error.code : 'UNSUPPORTED';
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ app: adapter.app, code, message });
    }
  }

  const masked = results.map((inspection) => ({
    ...inspection,
    configPath: maskHomePath(inspection.configPath, homeDir),
  }));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ apps: masked, failures }, null, 2)}\n`);
    return;
  }

  const rows: string[][] = [['app', 'provider', 'model', 'trạng thái']];
  for (const inspection of masked) {
    if (inspection.models.length === 0) {
      rows.push([inspection.app, '—', '—', 'UNKNOWN']);
      continue;
    }
    for (const model of inspection.models) {
      rows.push([inspection.app, model.provider, model.id, statusLabel(model.enabled)]);
    }
  }

  const lines: string[] = [];
  lines.push(renderTable(rows));

  for (const inspection of masked) {
    lines.push('');
    lines.push(`[${inspection.app}]`);
    lines.push(`  cấu hình      : ${inspection.configPath} (${inspection.format}, chỉ đọc)`);
    lines.push(`  model đang dùng: ${inspection.activeModel}`);
    lines.push(`  router        : ${inspection.routerRef}`);
    lines.push(`  độ chắc chắn  : ${inspection.certainty}`);
    for (const warning of inspection.warnings) lines.push(`  cảnh báo      : ${warning}`);
  }

  for (const failure of failures) {
    lines.push('');
    lines.push(`[${failure.app}] không đọc được (${failure.code}): ${failure.message}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function loadCatalogJson(catalogPath: string): HarnessCatalogInput {
  if (!catalogPath || !fs.existsSync(catalogPath)) {
    throw new Error(`Không tìm thấy tệp catalog: ${catalogPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tệp catalog không hợp lệ: ${catalogPath}`);
  }
  return parsed as HarnessCatalogInput;
}

function requireWriteAdapter(app: string) {
  const adapter = getHarnessWriteAdapter(app);
  if (!adapter) {
    const supported = listHarnessWriteAdapters().map((a) => a.app).join(', ');
    throw new Error(`Harness không hỗ trợ: ${app} (hỗ trợ: ${supported})`);
  }
  return adapter;
}

export async function runAppsPlanCommand(options: AppsPlanCommandOptions): Promise<void> {
  const adapter = requireWriteAdapter(options.app);
  const catalog = loadCatalogJson(options.catalog);
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
  const maskBaseHome = options.home ?? os.homedir();
  const plan = await adapter.plan({
    configPath: options.config,
    homeDir: effectiveHomeDir,
    catalog,
  });
  const maskedPlan = {
    ...plan,
    configPath: maskHomePath(plan.configPath, maskBaseHome),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(maskedPlan, null, 2)}\n`);
    return;
  }

  const lines = [
    `[${maskedPlan.app}] chế độ=${maskedPlan.directionAMode} editable=${maskedPlan.editable} planHash=${maskedPlan.planHash}`,
    `  cấu hình        : ${maskedPlan.configPath}`,
    `  provider đích   : ${maskedPlan.targetProviders.join(', ') || '—'}`,
    `  thêm model      : ${maskedPlan.additions.map((a) => `${a.provider}/${a.model}`).join(', ') || '0'}`,
    `  gỡ model        : ${maskedPlan.removals.map((r) => `${r.provider}/${r.model}`).join(', ') || '0'}`,
  ];
  for (const w of maskedPlan.defaultSlotWarnings) {
    lines.push(`  cảnh báo default: ${w.slot}=${w.currentModel} -> gợi ý ${w.suggestion}`);
  }
  for (const g of maskedPlan.guidance) {
    lines.push(`  hướng dẫn       : ${g}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export async function runAppsApplyCommand(options: AppsApplyCommandOptions): Promise<void> {
  if (!options.sandboxCopy) {
    throw new Error(
      'Yêu cầu cờ --sandbox-copy khi chạy `routersync apps apply` (chỉ áp dụng trên bản sao tạm trong os.tmpdir()).'
    );
  }
  assertHarnessWriteSandboxAllowed(options.config);
  const adapter = requireWriteAdapter(options.app);
  const catalog = loadCatalogJson(options.catalog);
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
  const res = await adapter.apply({
    configPath: options.config,
    homeDir: effectiveHomeDir,
    catalog,
    expectedPlanHash: options.planHash,
    backupPath: options.backup,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[${res.app}] applied=${res.applied} readBackVerified=${res.readBackVerified} preSha256=${res.preSha256} postSha256=${res.postSha256}\n`
  );
}

export async function runAppsRollbackCommand(options: AppsRollbackCommandOptions): Promise<void> {
  assertHarnessWriteSandboxAllowed(options.config);
  const adapter = requireWriteAdapter(options.app);
  const res = await adapter.rollback({
    configPath: options.config,
    backupPath: options.backup,
    expectedPreSha256: options.expectedPreSha256,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[${res.app}] restored=${res.restored} byteIdenticalToPreApply=${res.byteIdenticalToPreApply} postSha256=${res.postSha256}\n`
  );
}
