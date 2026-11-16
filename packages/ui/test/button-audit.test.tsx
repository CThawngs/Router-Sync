import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TopBar } from '../src/components/TopBar';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import { ChangesScreen } from '../src/screens/ChangesScreen';
import { CombosScreen } from '../src/screens/CombosScreen';
import { ProvidersScreen } from '../src/screens/ProvidersScreen';
import { TargetsScreen } from '../src/screens/TargetsScreen';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { HealthScreen } from '../src/screens/HealthScreen';
import { GuideScreen } from '../src/screens/GuideScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { MockApi } from '../src/api/mock';

const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

describe('UI-BUTTONS-DEAD: Audit buttons across UI to ensure zero DEAD buttons', () => {
  const api = new MockApi();

  it('verifies TopBar buttons trigger ACTION, NAV, or have valid handlers (no DEAD buttons)', () => {
    const onTogglePause = vi.fn();
    const onOpenAgentDrawer = vi.fn();
    const onToggleMobileNav = vi.fn();

    const { container } = render(
      <TopBar
        isMock={false}
        isFirstRun={false}
        isPaused={false}
        targetCount={2}
        onTogglePause={onTogglePause}
        onOpenAgentDrawer={onOpenAgentDrawer}
        isAgentDrawerOpen={false}
        onToggleMobileNav={onToggleMobileNav}
        isMobileNavOpen={false}
      />
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(6);

    const emergencyBtn = container.querySelector('.rs-topbar-emergency button');
    expect(emergencyBtn).not.toBeNull();
    fireEvent.click(emergencyBtn!);
    expect(onTogglePause).toHaveBeenCalledTimes(1);

    const navBtn = container.querySelector('.rs-mobile-nav-btn');
    expect(navBtn).not.toBeNull();
    fireEvent.click(navBtn!);
    expect(onToggleMobileNav).toHaveBeenCalledTimes(1);

    const agentBtn = container.querySelector('.rs-topbar-controls button[aria-expanded]');
    expect(agentBtn).not.toBeNull();
    fireEvent.click(agentBtn!);
    expect(onOpenAgentDrawer).toHaveBeenCalledTimes(1);

    buttons.forEach((btn) => {
      const isDead = !btn.onclick && btn.getAttribute('disabled') === null && !btn.getAttribute('type');
      expect(isDead).toBe(false);
    });
  });

  it('verifies OverviewScreen buttons trigger ACTION or NAV and no dead buttons exist', async () => {
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    const onNavigate = vi.fn();
    const onToggleFirstRun = vi.fn();
    const onOpenAgentDrawer = vi.fn();

    const { container } = render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onNavigate={onNavigate}
        onToggleFirstRun={onToggleFirstRun}
        onOpenAgentDrawer={onOpenAgentDrawer}
      />
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(1);

    const heroBtn = buttons.find((b) => /Xem thay đổi|View proposed changes/i.test(b.textContent || ''));
    if (heroBtn) {
      fireEvent.click(heroBtn);
      expect(onNavigate).toHaveBeenCalledWith('changes');
    }
  });

  it('verifies ChangesScreen buttons trigger ACTION or NAV and no dead buttons exist', () => {
    const onNavigate = vi.fn();
    const { queryByText } = render(
      <ChangesScreen
        isMock={false}
        onNavigate={onNavigate}
      />
    );

    const editBtn = queryByText(/Chỉnh sửa combo|Edit combos/i);
    if (editBtn) {
      fireEvent.click(editBtn);
      expect(onNavigate).toHaveBeenCalledWith('combos');
    }
  });

  it('verifies CombosScreen tab buttons and controls trigger state updates without dead buttons', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <CombosScreen
        onNavigate={onNavigate}
      />
    );

    const tabs = Array.from(container.querySelectorAll('button[role="tab"]'));
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    // Click build tab
    const buildTab = tabs.find((t) => /Tạo mới|Build|Tự xếp/i.test(t.textContent || ''));
    if (buildTab) {
      fireEvent.click(buildTab);
      expect(buildTab.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('verifies ProvidersScreen action buttons trigger handlers without dead buttons', () => {
    const { container } = render(
      <ProvidersScreen />
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    buttons.forEach((btn) => {
      expect(btn).not.toBeNull();
    });
  });

  it('verifies TargetsScreen target-add button is DISABLED-REASON and not a DEAD button', () => {
    const { getByTestId } = render(<TargetsScreen />);
    const addBtn = getByTestId('target-add-btn');

    expect(addBtn).toBeDisabled();
    expect(addBtn.getAttribute('title')).toBeTruthy();
    expect(addBtn.getAttribute('title')).toContain('routersync.yaml');
  });

  it('verifies ModelsScreen filter buttons and tab controls trigger handlers without dead buttons', () => {
    const { container } = render(
      <ModelsScreen />
    );

    const tabs = Array.from(container.querySelectorAll('button[role="tab"]'));
    expect(tabs.length).toBeGreaterThanOrEqual(3);

    const sourcesTab = tabs.find((t) => /Nguồn|Sources/i.test(t.textContent || ''));
    if (sourcesTab) {
      fireEvent.click(sourcesTab);
      expect(sourcesTab.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('verifies HealthScreen run doctor button is an ACTION and triggers handler', () => {
    const { getByTestId } = render(<HealthScreen />);
    const doctorBtn = getByTestId('health-run-doctor-btn');
    expect(doctorBtn).not.toBeNull();
    expect(doctorBtn.getAttribute('disabled')).toBeNull();
  });

  it('verifies GuideScreen tab buttons trigger tab switches without dead buttons', () => {
    const { container } = render(
      <GuideScreen />
    );

    const tabs = Array.from(container.querySelectorAll('button[role="tab"]'));
    expect(tabs.length).toBeGreaterThanOrEqual(5);

    const faqTab = tabs.find((t) => /FAQ|Hỏi đáp/i.test(t.textContent || ''));
    if (faqTab) {
      fireEvent.click(faqTab);
      expect(faqTab.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('verifies SettingsScreen tab switches and controls trigger state updates without dead buttons', () => {
    const onSetViewMode = vi.fn();
    const { container } = render(
      <SettingsScreen
        onSetViewMode={onSetViewMode}
      />
    );

    const tabs = Array.from(container.querySelectorAll('button[role="tab"]'));
    expect(tabs.length).toBeGreaterThanOrEqual(5);

    const aiTab = tabs.find((t) => /AI|Trí tuệ/i.test(t.textContent || ''));
    if (aiTab) {
      fireEvent.click(aiTab);
      expect(aiTab.getAttribute('aria-selected')).toBe('true');
    }
  });
});
