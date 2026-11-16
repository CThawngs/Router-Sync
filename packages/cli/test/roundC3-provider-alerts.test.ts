import { describe, it, expect } from 'vitest';
import { buildProviderAlerts, type ProviderAlertInput } from '../src/commands/health.js';

const base = (over: Partial<ProviderAlertInput>): ProviderAlertInput => ({
  router: '9router',
  provider: 'antigravity',
  data: {},
  modelsInCombo: 2,
  source: 'providerConnections.data',
  ...over,
});

describe('G3 provider alerts', () => {
  it('shared 404 over 2 combo models is P1 CONNECTION-ERROR, not per-model DEAD', () => {
    const alerts = buildProviderAlerts([base({ data: { errorCode: 404 } })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('P1');
    expect(alerts[0]?.code).toBe('CONNECTION-ERROR');
    expect(alerts[0]?.models).toBe(2);
    expect(alerts[0]?.detail).toContain('404 chung cho 2 model');
  });

  it('404 on a single model is P2, still CONNECTION-ERROR', () => {
    const alerts = buildProviderAlerts([base({ data: { errorCode: '404' }, modelsInCombo: 1 })]);
    expect(alerts[0]?.severity).toBe('P2');
    expect(alerts[0]?.code).toBe('CONNECTION-ERROR');
  });

  it('401/403 is P1 AUTH-FAILED', () => {
    const a = buildProviderAlerts([base({ data: { errorCode: 401 } })]);
    expect(a[0]?.code).toBe('AUTH-FAILED');
    expect(a[0]?.severity).toBe('P1');
    const b = buildProviderAlerts([base({ data: { errorCode: 403 } })]);
    expect(b[0]?.code).toBe('AUTH-FAILED');
  });

  it('429 and an active rateLimitedUntil both raise RATE-LIMITED', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const byCode = buildProviderAlerts([base({ data: { errorCode: 429 } })], now);
    expect(byCode[0]?.code).toBe('RATE-LIMITED');
    const byUntil = buildProviderAlerts([base({ data: { rateLimitedUntil: '2026-11-05T10:05:00Z' } })], now);
    expect(byUntil[0]?.code).toBe('RATE-LIMITED');
    const expired = buildProviderAlerts([base({ data: { rateLimitedUntil: '2026-11-05T09:00:00Z' } })], now);
    expect(expired).toHaveLength(0);
  });

  it('backoffLevel > 5 raises BACKOFF, <= 5 does not', () => {
    expect(buildProviderAlerts([base({ data: { backoffLevel: 6 } })])[0]?.code).toBe('BACKOFF');
    expect(buildProviderAlerts([base({ data: { backoffLevel: 3 } })])).toHaveLength(0);
  });

  it('OmniRoute is_active=0 raises P3 INACTIVE', () => {
    const alerts = buildProviderAlerts([
      base({ router: 'omniroute', provider: 'gemini', data: { is_active: 0 }, source: 'provider_connections' }),
    ]);
    expect(alerts[0]?.code).toBe('INACTIVE');
    expect(alerts[0]?.severity).toBe('P3');
  });

  it('healthy row raises nothing and P1 sorts before P2/P3', () => {
    expect(buildProviderAlerts([base({ data: {} })])).toHaveLength(0);
    const alerts = buildProviderAlerts([
      base({ provider: 'zz', data: { is_active: 0 } }),
      base({ provider: 'aa', data: { errorCode: 401 } }),
      base({ provider: 'mm', data: { errorCode: 429 } }),
    ]);
    expect(alerts.map((a) => a.severity)).toEqual(['P1', 'P2', 'P3']);
  });
});
