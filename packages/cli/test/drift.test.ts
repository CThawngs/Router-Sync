/**
 * packages/cli/test/drift.test.ts
 *
 * Kiểm thử logic phân loại drift (chỉ đọc, không cần router thật).
 * Dữ liệu tổng hợp, không chứa khóa/URL riêng.
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentAppModel,
  AgentAppProvider,
} from '@routersync/adapter-sdk';
import {
  buildRouterView,
  buildDriftReport,
  classifyModelDrift,
  driftKindOf,
  providerToRouter,
  shouldRedactProvider,
  stripProviderPrefix,
  tierToStatus,
  type DriftReport,
  type RouterDriftView,
  ProviderRedactor,
  checkIdFormatMismatch,
} from '../src/apps/drift.js';

const provider = (id: string): AgentAppProvider => ({ id, kind: 'router' as const, baseUrlPresent: false, keyPresent: false });
const model = (provider: string, id: string): AgentAppModel => ({ provider, id, enabled: 'UNKNOWN' });

// Tạo RouterModelState mock (không cần DB thật)
function mockState(enabled: string[] = [], disabled: string[] = [], catalog: string[] = [], versionMismatch = false): any {
  const enabledSet = new Set(enabled);
  const disabledSet = new Set(disabled);
  const catalogSet = new Set(catalog);
  const availableSet = new Set([...enabled, ...catalog]);
  return {
    router: '9router',
    versionMismatch,
    enabledModels: enabledSet,
    disabledModels: disabledSet,
    comboModels: new Set<string>(),
    customModels: new Set<string>(),
    catalogModels: catalogSet,
    availableModels: availableSet,
    connectionEnabledModels: new Set<string>(),
    classify(_prov: string, modelId: string) {
      const normId = modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId;
      if (disabledSet.has(normId)) {
        return { tier: 'B' as const, inCombo: false, reason: 'Disabled in router kv' };
      }
      if (versionMismatch && !availableSet.has(normId)) {
        return { tier: 'UNKNOWN' as const, inCombo: false, reason: 'snapshot-version-mismatch' };
      }
      if (availableSet.has(normId)) {
        return { tier: 'A' as const, inCombo: false, reason: 'Available in router UI' };
      }
      if (catalogSet.has(normId)) {
        return { tier: 'B' as const, inCombo: false, reason: 'Suggested in router catalog' };
      }
      return { tier: 'C' as const, inCombo: false, reason: 'Unconfigured in router' };
    },
  };
}

const viewFromState = (router: string, state: any): RouterDriftView => ({
  router,
  state,
  error: undefined,
  comboNames: new Set<string>(),
  aliasNames: new Set<string>(),
});

const inspection = (app: string, models: AgentAppModel[], providers: AgentAppProvider[]) => ({
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

describe('providerToRouter', () => {
  it('9router provider → 9router', () => {
    expect(providerToRouter('9router')).toBe('9router');
  });
  it('omniroute provider → omniroute', () => {
    expect(providerToRouter('omniroute')).toBe('omniroute');
  });
  it('nine-router → 9router (DSH pattern)', () => {
    expect(providerToRouter('nine-router')).toBe('9router');
    expect(providerToRouter('nine-router-vision')).toBe('9router');
  });
  it('hugging-face → UNKNOWN (NOT-ROUTED)', () => {
    expect(providerToRouter('hugging-face')).toBe('UNKNOWN');
  });
  it('baseURL with 9router host → 9router', () => {
    expect(providerToRouter('my-provider', 'https://9router.example.com/v1')).toBe('9router');
  });
});

describe('stripProviderPrefix', () => {
  it('9router/test-3 → test-3', () => {
    expect(stripProviderPrefix('9router/test-3')).toBe('test-3');
  });
  it('omniroute/OmniRoute-Coder-1 → OmniRoute-Coder-1', () => {
    expect(stripProviderPrefix('omniroute/OmniRoute-Coder-1')).toBe('OmniRoute-Coder-1');
  });
  it('no prefix → unchanged', () => {
    expect(stripProviderPrefix('test-3')).toBe('test-3');
  });
});

describe('tierToStatus', () => {
  it('A → OK', () => expect(tierToStatus('A')).toBe('OK'));
  it('B → DISABLED', () => expect(tierToStatus('B')).toBe('DISABLED'));
  it('C → MISSING', () => expect(tierToStatus('C')).toBe('MISSING'));
  it('UNKNOWN → UNKNOWN', () => expect(tierToStatus('UNKNOWN')).toBe('UNKNOWN'));
});

describe('classifyModelDrift', () => {
  it('OK khi model active trong router (tier A)', () => {
    const view = viewFromState('9router', mockState(['9Router-Coder-1']));
    const result = classifyModelDrift('9router/9Router-Coder-1', '9router', view);
    expect(result.entry.status).toBe('OK');
    expect(result.entry.modelId).toBe('9Router-Coder-1');
  });

  it('DISABLED khi model bị tắt (tier B)', () => {
    const view = viewFromState('9router', mockState([], ['Ghost-Model']));
    const result = classifyModelDrift('9router/Ghost-Model', '9router', view);
    expect(result.entry.status).toBe('DISABLED');
  });

  it('MISSING khi model không có trong router (tier C)', () => {
    const view = viewFromState('9router', mockState(['9Router-Coder-1']));
    const result = classifyModelDrift('9router/NonExistent', '9router', view);
    expect(result.entry.status).toBe('MISSING');
  });

  it('UNKNOWN khi versionMismatch và model không available', () => {
    const view = viewFromState('9router', mockState([], [], [], true));
    const result = classifyModelDrift('9router/UnknownModel', '9router', view);
    expect(result.entry.status).toBe('UNKNOWN');
  });

  it('NOT-ROUTED khi không đọc được router (state undefined)', () => {
    const view: RouterDriftView = { router: '9router', state: undefined, error: 'db locked', comboNames: new Set(), aliasNames: new Set() };
    const result = classifyModelDrift('9router/9Router-Coder-1', '9router', view);
    expect(result.entry.status).toBe('UNKNOWN');
    expect(result.entry.reason).toContain('không đọc được router');
  });

  it('mỗi model chỉ được phân loại với một router (providerToRouter quyết định)', () => {
    const view9 = viewFromState('9router', mockState(['test-3']));
    const viewOmni = viewFromState('omniroute', mockState([]));

    // Model 9router/test-3 chỉ khớp với view 9router, không với omniroute
    const r9 = classifyModelDrift('9router/test-3', '9router', view9);
    expect(r9.entry.status).toBe('OK');

    const rOmni = classifyModelDrift('9router/test-3', '9router', viewOmni);
    expect(rOmni.entry.status).toBe('MISSING'); // không có trong omniroute
  });
});

describe('buildRouterView', () => {
  it('trả về view có cấu trúc đúng', async () => {
    const view = await buildRouterView('9router', [
      { id: 'rs-coder', name: 'RS Coder', models: ['9Router-Coder-1'] },
    ]);
    expect(view.router).toBe('9router');
    expect(view.comboNames.has('rs-coder')).toBe(true);
    expect(view.comboNames.has('RS Coder')).toBe(true);
  });
});

describe('buildDriftReport', () => {
  it('tính tổng và UNUSED', () => {
    const view9: RouterDriftView = {
      router: '9router',
      state: mockState([], [], ['A', 'B', 'C']),
      error: undefined,
      comboNames: new Set(['rs-coder']),
      aliasNames: new Set(),
    };
    const viewOmni: RouterDriftView = {
      router: 'omniroute',
      state: mockState([], [], ['X']),
      error: undefined,
      comboNames: new Set(),
      aliasNames: new Set(),
    };

    // Tạo results thủ công
    const r1: import('../src/apps/drift.js').DriftResult = {
      app: 'hermes',
      router: '9router',
      entries: [
        { app: 'hermes', router: '9router', name: '9router/A', modelId: 'A', provider: '9router', kind: 'model', status: 'OK', reason: 'ok' },
        { app: 'hermes', router: '9router', name: '9router/Z', modelId: 'Z', provider: '9router', kind: 'model', status: 'MISSING', reason: 'missing' },
      ],
      totals: { OK: 1, DISABLED: 0, MISSING: 1, UNKNOWN: 0, 'NOT-ROUTED': 0 },
    };
    const r2: import('../src/apps/drift.js').DriftResult = {
      app: 'dsh',
      router: 'omniroute',
      entries: [
        { app: 'dsh', router: 'omniroute', name: 'omniroute/X', modelId: 'X', provider: 'omniroute', kind: 'model', status: 'OK', reason: 'ok' },
      ],
      totals: { OK: 1, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 },
    };

    const report = buildDriftReport([r1, r2], [view9, viewOmni], new ProviderRedactor(), new Set(), new Set());
    expect(report.totals.OK).toBe(2);
    expect(report.totals.MISSING).toBe(1);
    // B, C không được dùng bởi bất kỳ app nào ⇒ UNUSED
    const unusedNames = report.unused.map((u) => u.name);
    expect(unusedNames).toContain('B');
    expect(unusedNames).toContain('C');
    expect(unusedNames).not.toContain('A');
    expect(unusedNames).not.toContain('X');
  });
});

describe('providerToRouter → mỗi model chỉ một router', () => {
  it('provider nine-router → 9router (không phải NOT-ROUTED)', () => {
    expect(providerToRouter('nine-router')).toBe('9router');
    expect(providerToRouter('nine-router-vision')).toBe('9router');
  });

  it('provider hugging-face → UNKNOWN (NOT-ROUTED)', () => {
    expect(providerToRouter('hugging-face')).toBe('UNKNOWN');
  });
});

describe('shouldRedactProvider + ProviderRedactor', () => {
  it('provider trong public registry không bị redact', () => {
    const pub = new Set(['9router', 'omniroute', 'hugging-face']);
    const local = new Set<string>();
    expect(shouldRedactProvider('9router', pub, local)).toBe(false);
    expect(shouldRedactProvider('hugging-face', pub, local)).toBe(false);
  });

  it('provider trong local allowlist không bị redact', () => {
    const pub = new Set<string>();
    const local = new Set(['my-private-provider']);
    expect(shouldRedactProvider('my-private-provider', pub, local)).toBe(false);
  });

  it('provider không có trong cả hai ⇒ bị redact', () => {
    const pub = new Set(['9router']);
    const local = new Set<string>();
    expect(shouldRedactProvider('xkiro', pub, local)).toBe(true);
    expect(shouldRedactProvider('tokenharbor', pub, local)).toBe(true);
  });

  it('ProviderRedactor gán số thứ tự duy nhất', () => {
    const redactor = new ProviderRedactor();
    const r1 = redactor.redact('xkiro');
    const r2 = redactor.redact('tokenharbor');
    const r3 = redactor.redact('xkiro'); // cùng provider ⇒ cùng mã
    expect(r1).toBe('<private-provider-1>');
    expect(r2).toBe('<private-provider-2>');
    expect(r3).toBe(r1); // xkiro lại được mã cũ
  });
});

describe('checkIdFormatMismatch', () => {
  it('không suspected khi có ít nhất 1 model khớp', () => {
    const r1: import('../src/apps/drift.js').DriftResult = {
      app: 'hermes',
      router: '9router',
      entries: [
        { app: 'hermes', router: '9router', name: '9router/A', modelId: 'A', provider: '9router', kind: 'model', status: 'OK', reason: 'ok' },
      ],
      totals: { OK: 1, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 },
    };
    const view: RouterDriftView = {
      router: '9router',
      state: mockState([], [], ['A']),
      error: undefined,
      comboNames: new Set(),
      aliasNames: new Set(),
    };
    const result = checkIdFormatMismatch([r1], [view]);
    expect(result.suspected).toBe(false);
  });

  it('suspected khi catalog > 0 nhưng 0 khớp', () => {
    const r1: import('../src/apps/drift.js').DriftResult = {
      app: 'hermes',
      router: '9router',
      entries: [
        { app: 'hermes', router: '9router', name: '9router/Z', modelId: 'Z', provider: '9router', kind: 'model', status: 'MISSING', reason: 'missing' },
      ],
      totals: { OK: 0, DISABLED: 0, MISSING: 1, UNKNOWN: 0, 'NOT-ROUTED': 0 },
    };
    const view: RouterDriftView = {
      router: '9router',
      state: mockState([], [], ['A', 'B']),
      error: undefined,
      comboNames: new Set(),
      aliasNames: new Set(),
    };
    const result = checkIdFormatMismatch([r1], [view]);
    expect(result.suspected).toBe(true);
    expect(result.examples.length).toBeGreaterThan(0);
  });
});

describe('driftKindOf', () => {
  it('phân loại combo/alias/model', () => {
    const comboNames = new Set(['rs-coder']);
    const aliasNames = new Set(['auto/coding']);
    expect(driftKindOf('rs-coder', comboNames, aliasNames)).toBe('combo');
    expect(driftKindOf('auto/coding', comboNames, aliasNames)).toBe('alias');
    expect(driftKindOf('9Router-Coder-1', comboNames, aliasNames)).toBe('model');
  });
});
