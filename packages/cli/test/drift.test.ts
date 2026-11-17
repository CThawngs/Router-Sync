/**
 * packages/cli/test/drift.test.ts
 *
 * Kiểm thử logic phân loại drift (chỉ đọc, không cần router thật).
 * Dữ liệu tổng hợp, không chứa khóa/URL riêng.
 */

import { describe, expect, it } from 'vitest';
import type { AgentAppInspection, AgentAppModel, AgentAppProvider, ComboDefinition, ModelInfo } from '@routersync/adapter-sdk';
import {
  buildRouterView,
  buildDriftReport,
  classifyAppDrift,
  driftKindOf,
  type DriftReport,
} from '../src/apps/drift.js';

const provider = (id: string, kind: AgentAppProvider['kind']): AgentAppProvider => ({ id, kind, baseUrlPresent: false, keyPresent: false });
const model = (provider: string, id: string): AgentAppModel => ({ provider, id, enabled: 'UNKNOWN' });

const inspection = (app: string, models: AgentAppModel[], providers: AgentAppProvider[]): AgentAppInspection => ({
  app,
  configPath: `<HOME>/.config/${app}/config.json`,
  format: 'json',
  readOnly: true,
  providers,
  models,
  activeModel: 'UNKNOWN',
  routerRef: 'UNKNOWN',
  certainty: 'C',
  warnings: [],
});

const modelCatalog = (ids: string[]): ModelInfo[] => ids.map((id) => ({ id, provider: '9router', status: 'active' as const }));
const combos = (rows: { id: string; name?: string; models?: string[] }[]): ComboDefinition[] =>
  rows.map((r) => ({ id: r.id, name: r.name ?? r.id, strategy: 'round-robin', models: r.models ?? [], managed: false, updatedAt: '2026-01-01' }));

describe('driftKindOf', () => {
  it('phân loại combo/alias/model', () => {
    const comboNames = new Set(['rs-coder']);
    const aliasNames = new Set(['auto/coding']);
    expect(driftKindOf('rs-coder', comboNames, aliasNames)).toBe('combo');
    expect(driftKindOf('auto/coding', comboNames, aliasNames)).toBe('alias');
    expect(driftKindOf('9Router-Coder-1', comboNames, aliasNames)).toBe('model');
  });
});

describe('buildRouterView', () => {
  it('trích xuất catalogIds + comboNames từ router', () => {
    const view = buildRouterView('9router', modelCatalog(['9Router-Coder-1', 'OmniRoute-Dev']), combos([{ id: 'rs-coder', models: ['9Router-Coder-1'] }]));
    expect(view.catalogIds.has('9Router-Coder-1')).toBe(true);
    expect(view.catalogIds.has('OmniRoute-Dev')).toBe(true);
    expect(view.comboNames.has('rs-coder')).toBe(true);
  });
});

describe('classifyAppDrift', () => {
  it('OK khi model có trong router, MISSING khi không, NOT-ROUTED khi provider trực tiếp', () => {
    const view = buildRouterView(
      '9router',
      modelCatalog(['9Router-Coder-1']),
      combos([{ id: 'rs-coder', models: ['9Router-Coder-1'] }])
    );
    const insp = inspection(
      'hermes',
      [model('9router', '9Router-Coder-1'), model('9router', 'Ghost-Model'), model('hugging-face', 'Qwen/Qwen3')],
      [provider('9router', 'router'), provider('hugging-face', 'direct')]
    );
    const result = classifyAppDrift('hermes', insp, view);

    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
    expect(byName['9router/9Router-Coder-1'].status).toBe('OK');
    expect(byName['9router/9Router-Coder-1'].kind).toBe('model');
    expect(byName['9router/Ghost-Model'].status).toBe('MISSING');
    expect(byName['hugging-face/Qwen/Qwen3'].status).toBe('NOT-ROUTED');
    expect(byName['hugging-face/Qwen/Qwen3'].kind).toBe('NOT-ROUTED');
    expect(result.totals.OK).toBe(1);
    expect(result.totals.MISSING).toBe(1);
    expect(result.totals['NOT-ROUTED']).toBe(1);
  });

  it('combo được phân loại kind=combo khi khớp tên combo', () => {
    const view = buildRouterView(
      '9router',
      modelCatalog(['9Router-Coder-1', 'rs-coder']),
      combos([{ id: 'rs-coder', models: ['9Router-Coder-1'] }])
    );
    const insp = inspection('dsh', [model('9router', 'rs-coder')], [provider('9router', 'router')]);
    const result = classifyAppDrift('dsh', insp, view);
    expect(result.entries[0].kind).toBe('combo');
    expect(result.entries[0].status).toBe('OK');
  });
});

describe('buildDriftReport', () => {
  it('tính tổng và UNUSED', () => {
    const view9 = buildRouterView('9router', modelCatalog(['A', 'B', 'C']), combos([{ id: 'rs-coder' }]));
    const viewOmni = buildRouterView('omniroute', modelCatalog(['X']), combos([]));

    const insp1 = inspection('hermes', [model('9router', 'A'), model('9router', 'Z')], [provider('9router', 'router')]);
    const r1 = classifyAppDrift('hermes', insp1, view9); // A=OK, Z=MISSING
    const insp2 = inspection('dsh', [model('omniroute', 'X')], [provider('omniroute', 'router')]);
    const r2 = classifyAppDrift('dsh', insp2, viewOmni); // X=OK

    const report = buildDriftReport([r1, r2], [view9, viewOmni]);
    expect(report.totals.OK).toBe(2);
    expect(report.totals.MISSING).toBe(1);
    // B, C chưa dùng trong router ⇒ UNUSED = B, C
    const unusedNames = report.unused.map((u) => u.name);
    expect(unusedNames).toContain('B');
    expect(unusedNames).toContain('C');
    expect(unusedNames).not.toContain('A');
    expect(unusedNames).not.toContain('X');
  });

  it('UNUSED chỉ lấy 20 đầu khi render (kiểm tra slice)', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `M${i}`);
    const view = buildRouterView('9router', modelCatalog(ids), combos([]));
    const insp = inspection('hermes', [], []);
    const r = classifyAppDrift('hermes', insp, view);
    const report = buildDriftReport([r], [view]);
    expect(report.unused.length).toBe(25);
    expect(report.unused.slice(0, 20).length).toBe(20);
  });
});

describe('F2 mutation test — phân loại MISSING', () => {
  it('model không có trong router ⇒ MISSING (ĐỨC)', () => {
    const view = buildRouterView('9router', modelCatalog(['9Router-Coder-1']), combos([]));
    const insp = inspection('hermes', [model('9router', 'Ghost-Model')], [provider('9router', 'router')]);
    const result = classifyAppDrift('hermes', insp, view);
    expect(result.entries[0].status).toBe('MISSING');
    expect(result.totals.MISSING).toBe(1);
  });
});
