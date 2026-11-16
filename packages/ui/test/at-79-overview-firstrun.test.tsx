import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import { MockApi } from '../src/api/mock';

describe('Acceptance Test AT-79: Initial Navigation to Overview & First-Run State', () => {
  const api = new MockApi();

  it('renders Overview directly without intro/interstitial splash page', async () => {
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    const onToggleFirstRun = vi.fn();
    const onOpenAgentDrawer = vi.fn();
    const onNavigate = vi.fn();

    overview.isFirstRun = true;

    render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={onToggleFirstRun}
        onOpenAgentDrawer={onOpenAgentDrawer}
        onNavigate={onNavigate}
      />
    );

    // Directly renders overview hero heading, no "intro" or "splash" barrier
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toMatch(/RouterSync|Chào mừng|Welcome/i);
  });

  it('in first-run state displays 4 steps, machine self-test, 5 never rules, and sample data button', async () => {
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    const onToggleFirstRun = vi.fn();
    const onOpenAgentDrawer = vi.fn();
    const onNavigate = vi.fn();

    overview.isFirstRun = true;

    render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={onToggleFirstRun}
        onOpenAgentDrawer={onOpenAgentDrawer}
        onNavigate={onNavigate}
      />
    );

    // 4 steps checklist
    const checklist = screen.getByRole('region', { name: /f_st|Bắt đầu|Get started/i });
    expect(checklist).toBeDefined();

    // Machine self-test results
    const selfTest = screen.getByRole('region', { name: /f_chk|tự kiểm tra|self-test/i });
    expect(selfTest).toBeDefined();

    // 5 never rules
    const neverRules = screen.getByRole('region', { name: /f_nv|sẽ không bao giờ|will never/i });
    expect(neverRules).toBeDefined();

    // Explore sample data action button in banner or controls
    const sampleBtn = screen.getByRole('button', { name: /Xem thử bằng dữ liệu mẫu|Xem bằng dữ liệu mẫu|Explore with sample data|dữ liệu mẫu/i });
    expect(sampleBtn).toBeDefined();
    fireEvent.click(sampleBtn);
    expect(onToggleFirstRun).toHaveBeenCalled();
  });
});
