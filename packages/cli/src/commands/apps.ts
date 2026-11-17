/**
 * packages/cli/src/commands/apps.ts
 *
 * `routersync apps inspect` — read-only view of an agent app's provider and
 * model configuration. There is no write flag by design.
 */

import * as os from 'node:os';
import { maskHomePath } from '@routersync/adapter-sdk';
import type { AgentAppInspection } from '@routersync/adapter-sdk';
import {
  AGENT_APP_ADAPTERS,
  AgentAppInspectError,
  getAgentAppAdapter,
} from '../apps/inspect.js';

export interface AppsInspectOptions {
  app?: string | undefined;
  home?: string | undefined;
  config?: string | undefined;
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
