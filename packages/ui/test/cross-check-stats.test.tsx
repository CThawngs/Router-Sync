import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MockApi } from '../src/api/mock';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { HealthScreen } from '../src/screens/HealthScreen';
import { setLanguage } from '../src/i18n';

describe('Cross-check Stats & Localization Consistency (Debt D4, D5)', () => {
  const api = new MockApi();

  it('asserts mockApi getProviders modelsCount sum strictly equals getOverview trackedModels count (412)', async () => {
    const overview = await api.getOverview();
    const providers = await api.getProviders();

    const sumProviderModels = providers.reduce((acc, p) => acc + p.modelsCount, 0);

    expect(sumProviderModels).toBe(412);
    expect(overview.trackedModels.count).toBe(412);
    expect(sumProviderModels).toBe(overview.trackedModels.count);
  });

  it('asserts the models view-model status distribution matches 7 healthy out of 11 models', async () => {
    const models = await api.getModels();
    expect(models).toHaveLength(11);

    const healthy = models.filter((m) => m.status === 'healthy' || m.status === 'new');
    const degraded = models.filter((m) => m.status === 'degraded');
    const gone = models.filter((m) => m.status === 'due_removal');
    const paused = models.filter((m) => m.status === 'paused');

    expect(healthy).toHaveLength(7);
    expect(degraded).toHaveLength(1);
    expect(gone).toHaveLength(1);
    expect(paused).toHaveLength(2);

    expect(healthy.map((m) => m.id)).toEqual([
      'kite-code-3',
      'acme-coder-2',
      'lumen-flash-2',
      'acme-chat-3',
      'lumen-dense-1',
      'kite-lite-2',
      'zeta-mini',
    ]);
  });

  it('renders 7 / 11 healthy models metric in HealthScreen', async () => {
    render(<HealthScreen />);
    // HealthScreen loads its view-model asynchronously, so wait for the metric.
    await waitFor(() => {
      expect(screen.getByText('7 / 11')).toBeDefined();
    });
  });

  it('renders localized scoreExpl and where in ModelsScreen in both vi and en', async () => {
    // Set to vi
    setLanguage('vi');
    const { unmount } = render(<ModelsScreen />);

    // kite-code-3 is selected by default (first model of the loaded list)
    await waitFor(() => {
      expect(screen.getAllByText(/Lập trình: 96 · Độ trễ: 420ms · 4 nguồn/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/coding-fast \(vị trí 1\), smart-cascade \(vị trí 1\)/i)).toBeDefined();
    unmount();

    // Switch to en
    setLanguage('en');
    render(<ModelsScreen />);

    await waitFor(() => {
      expect(screen.getAllByText(/Coding: 96 · Latency: 420ms · 4 sources/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/coding-fast \(pos 1\), smart-cascade \(pos 1\)/i)).toBeDefined();

    // Reset back to vi
    setLanguage('vi');
  });
});
