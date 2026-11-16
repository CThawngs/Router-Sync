import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import { setViewMode } from '../src/theme/viewMode';
import { MockApi } from '../src/api/mock';

describe('Acceptance Test AT-80: View Mode Terminology & State Preservation', () => {
  const api = new MockApi();

  beforeEach(() => {
    localStorage.clear();
  });

  it('in simple mode hides the technical 8-module pipeline and internal terms', async () => {
    setViewMode('simple');
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    overview.isFirstRun = false;

    render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={vi.fn()}
        onOpenAgentDrawer={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    // Pipeline region should NOT be in the DOM in simple mode
    const pipelineRegion = screen.queryByRole('region', { name: /d_pipe|8 module|pipeline/i });
    expect(pipelineRegion).toBeNull();
  });

  it('in detail mode reveals the full 8-module technical pipeline without losing state', async () => {
    setViewMode('detail');
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    overview.isFirstRun = false;

    const { rerender } = render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={vi.fn()}
        onOpenAgentDrawer={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    // In detail mode, the 8-module pipeline region is present
    const pipelineRegion = screen.getByRole('region', { name: /d_pipe|8 module|pipeline/i });
    expect(pipelineRegion).toBeDefined();

    // Verify all 8 modules are rendered
    const moduleItems = pipelineRegion.querySelectorAll('[data-testid^="pipeline-module-"]');
    expect(moduleItems.length).toBe(8);

    // Switch back to simple mode - metrics and overview state remain intact
    setViewMode('simple');
    rerender(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={vi.fn()}
        onOpenAgentDrawer={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    const tiles = screen.getAllByTestId('metric-tile');
    expect(tiles.length).toBe(4);
    expect(screen.queryByRole('region', { name: /d_pipe|8 module|pipeline/i })).toBeNull();
  });
});
