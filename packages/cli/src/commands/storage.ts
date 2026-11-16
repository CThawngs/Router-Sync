/**
 * packages/cli/src/commands/storage.ts
 *
 * B1: `routersync storage inspect --router omniroute` — read-only inspection
 * on a COPY. Allow-listed columns per table, secrets redacted.
 *
 * Tables inspected:
 *   key_value (key, value-short) | discovery_results (model_id, provider, status)
 *   provider_connections.provider_specific_data (json, redacted)
 *   model_combo_mappings (combo_name, model_id, position)
 *   model_capabilities (model_id, status, release_date)
 * Note: model_context_overrides source is `auto:discovery` (concluded label).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';

const ALLOW: Record<string, string[]> = {
  key_value: ['key', 'value'],
  discovery_results: ['model_id', 'provider', 'status', 'discovered_at'],
  provider_connections: ['provider', 'provider_specific_data'],
  model_combo_mappings: ['combo_name', 'model_id', 'position'],
  model_capabilities: ['model_id', 'status', 'release_date'],
};

export function redactValue(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s
    .replace(/sk-[A-Za-z0-9-]{4,}/g, 'sk-***')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '***')
    .slice(0, 120);
}

function columns(db: ReturnType<typeof openBetterSqlite3>, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch { return []; }
}

export function inspectOmniRouteStorage(dbPath: string): string[] {
  const lines: string[] = [];
  const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    for (const [table, allow] of Object.entries(ALLOW)) {
      const cols = columns(db, table);
      if (cols.length === 0) { lines.push(`== ${table}: NOT FOUND ==`); continue; }
      const sel = allow.filter((c) => cols.includes(c));
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as Record<string, unknown>)?.['n'] ?? '?';
      lines.push(`== ${table}: rows=${count} cols=${sel.join(',')} ==`);
      if (table === 'provider_connections' && cols.includes('provider_specific_data')) {
        lines.push('   note: source=auto:discovery (model_context_overrides: concluded, no inference)');
      }
      const rows = db.prepare(`SELECT ${sel.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT 50`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        lines.push('   ' + sel.map((c) => `${c}=${redactValue(r[c])}`).join(' | '));
      }
      if (Number(count) > 50) lines.push(`   ... còn ${Number(count) - 50} dòng`);
    }
    lines.push('KẾT LUẬN: model_context_overrides nguồn auto:discovery; storage inspect chỉ đọc allow-list, đã redact.');
  } finally { db.close(); }
  return lines;
}

export async function runStorageInspectCommand(options: { router?: string; out?: string }): Promise<void> {
  const router = (options.router ?? 'omniroute').toLowerCase();
  if (router !== 'omniroute') throw new Error(`storage inspect: router unsupported (${router}); only omniroute in B1.`);
  const src = locateRouterDb('omniroute');
  const tmpDir = path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'routersync', 'state', 'storage');
  fs.mkdirSync(tmpDir, { recursive: true });
  const copyPath = path.join(tmpDir, 'omniroute.storage-copy.sqlite');
  const db = openBetterSqlite3(src, { readOnly: true, busyTimeoutMs: 5000 });
  try { db.backup(copyPath); } finally { db.close(); }
  const lines = ['ROUTERSYNC STORAGE INSPECT (read-only copy, redacted)', `router=omniroute copy=${copyPath}`, ...inspectOmniRouteStorage(copyPath)];
  const text = lines.join('\n') + '\n';
  if (options.out) fs.writeFileSync(options.out, text, 'utf8');
  console.log(text);
}
