import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { DemoChip } from '../src/components/Badge';
import { MockApi } from '../src/api/mock';

describe('UI-SW: Dev Switcher Relocation & Guard', () => {
  const mockApi = new MockApi();

  it('UI-SW-01: verifies dev switcher button is removed from Overview hero', async () => {
    const overviewRunning = await mockApi.getOverview();
    const pipeline = await mockApi.getPipelineModules();

    // 1. Running state
    const { unmount } = render(
      <OverviewScreen
        overview={{ ...overviewRunning, isFirstRun: false }}
        pipelineModules={pipeline}
        onNavigate={() => {}}
        onToggleFirstRun={() => {}}
        onOpenAgentDrawer={() => {}}
      />,
    );

    // Assert hero does NOT contain any switcher button
    expect(screen.queryByTestId('dev-toggle-first-run')).toBeNull();
    expect(screen.queryByText(/Chuyển sang: Tổng quan lần đầu/i)).toBeNull();
    expect(screen.queryByText(/Switch to: First-time setup/i)).toBeNull();
    unmount();

    // 2. First-run state
    render(
      <OverviewScreen
        overview={{ ...overviewRunning, isFirstRun: true }}
        pipelineModules={pipeline}
        onNavigate={() => {}}
        onToggleFirstRun={() => {}}
        onOpenAgentDrawer={() => {}}
      />,
    );
    expect(screen.queryByTestId('dev-toggle-first-run')).toBeNull();
    expect(screen.queryByText(/Chuyển sang: Tổng quan đang chạy/i)).toBeNull();
    expect(screen.queryByText(/Switch to: Running overview/i)).toBeNull();
  });

  it('UI-SW-02: verifies switcher is only present when isMock is true and absent when false', () => {
    // TopBar DemoChip menu
    const onToggleMock = vi.fn();
    const { rerender } = render(
      <DemoChip onToggleFirstRun={onToggleMock} isFirstRun={false} />,
    );

    // Dropdown toggle trigger should exist when onToggleFirstRun provided
    const trigger = screen.getByRole('button', { name: /dữ liệu mẫu|sample data/i });
    expect(trigger).toBeDefined();

    // Settings screen rerun first-time setup
    rerender(
      <SettingsScreen
        viewMode="simple"
        onSetViewMode={() => {}}
        onOpenSetup={() => {}}
        onOpenGuide={() => {}}
        isMock={true}
        onToggleFirstRun={onToggleMock}
      />,
    );
    expect(screen.getByTestId('settings-reset-first-run')).toBeDefined();

    // When isMock is false, reset first-run MUST NOT be rendered
    rerender(
      <SettingsScreen
        viewMode="simple"
        onSetViewMode={() => {}}
        onOpenSetup={() => {}}
        onOpenGuide={() => {}}
        isMock={false}
      />,
    );
    expect(screen.queryByTestId('settings-reset-first-run')).toBeNull();
  });
});
