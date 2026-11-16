import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverviewScreen, getMetricValueStyle } from '../src/screens/OverviewScreen';
import { MockApi } from '../src/api/mock';
import { setLanguage } from '../src/i18n';

describe('OverviewScreen Component (CP1)', () => {
  const api = new MockApi();

  it('renders OverviewScreen in running state with all primary sections', async () => {
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    const onToggleFirstRun = vi.fn();
    const onOpenAgentDrawer = vi.fn();
    const onNavigate = vi.fn();

    // Ensure running state
    overview.isFirstRun = false;

    render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={onToggleFirstRun}
        onOpenAgentDrawer={onOpenAgentDrawer}
        onNavigate={onNavigate}
      />
    );

    // Hero section
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();

    // 4 metric tiles
    const tiles = screen.getAllByTestId('metric-tile');
    expect(tiles.length).toBe(4);

    // Todos section
    expect(screen.getByRole('region', { name: /d_todo|Việc cần bạn làm|Things to do/i })).toBeDefined();

    // Events section
    expect(screen.getByRole('region', { name: /d_ev|RouterSync vừa làm gì|Recent events/i })).toBeDefined();

    // 5 steps section
    expect(screen.getByRole('region', { name: /d_how|RouterSync hoạt động thế nào|How RouterSync works/i })).toBeDefined();

    // Verify hero action navigation
    const heroBtn = screen.getByRole('button', { name: /Xem thay đổi đề xuất|View proposed changes/i });
    fireEvent.click(heroBtn);
    expect(onNavigate).toHaveBeenCalledWith('changes');
  });

  it('renders OverviewScreen in first-run state with setup checklist and safety cards', async () => {
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    const onToggleFirstRun = vi.fn();
    const onOpenAgentDrawer = vi.fn();
    const onNavigate = vi.fn();

    // Ensure first-run state
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

    // 4 checklist steps
    expect(screen.getByRole('region', { name: /f_st|Bắt đầu|Get started/i })).toBeDefined();

    // System inspection card
    expect(screen.getByRole('region', { name: /f_chk|tự kiểm tra|self-test/i })).toBeDefined();

    // "Will never" safety card
    expect(screen.getByRole('region', { name: /f_nv|sẽ không bao giờ|will never/i })).toBeDefined();

    // AI agent card
    expect(screen.getByRole('region', { name: /f_ao|agent AI/i })).toBeDefined();

    // Start setup button in hero
    const startBtn = screen.getByRole('button', { name: /Bắt đầu thiết lập|Start setup/i });
    fireEvent.click(startBtn);
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('D1: render Overview in EN mode contains zero Vietnamese diacritics in todo and event sections', async () => {
    setLanguage('en');
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    overview.isFirstRun = false;

    const { container } = render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={vi.fn()}
        onOpenAgentDrawer={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    const todoCard = container.querySelector('#todo-t');
    const evCard = container.querySelector('#ev-t');

    expect(todoCard).not.toBeNull();
    expect(evCard).not.toBeNull();

    // Regex matching Vietnamese accented/diacritic characters
    const vnDiacriticsRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

    expect(vnDiacriticsRegex.test(todoCard?.textContent || '')).toBe(false);
    expect(vnDiacriticsRegex.test(evCard?.textContent || '')).toBe(false);
  });

  it('D1: render Overview in VI mode contains proper Vietnamese text in todo and event sections', async () => {
    setLanguage('vi');
    const overview = await api.getOverview();
    const pipeline = await api.getPipelineModules();
    overview.isFirstRun = false;

    const { container } = render(
      <OverviewScreen
        overview={overview}
        pipelineModules={pipeline}
        onToggleFirstRun={vi.fn()}
        onOpenAgentDrawer={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    const todoCard = container.querySelector('#todo-t');
    const evCard = container.querySelector('#ev-t');

    const vnDiacriticsRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

    expect(vnDiacriticsRegex.test(todoCard?.textContent || '')).toBe(true);
    expect(vnDiacriticsRegex.test(evCard?.textContent || '')).toBe(true);
  });

  describe('UI-OBS-4: value tile typography scaling', () => {
    it('getMetricValueStyle scales text values down and keeps short numbers large', () => {
      // Short numbers and ratios
      expect(getMetricValueStyle('61').fontSize).toBe('clamp(32px, 3.2vw, 36px)');
      expect(getMetricValueStyle('61').fontWeight).toBe(800);
      expect(getMetricValueStyle('1/2').fontSize).toBe('clamp(32px, 3.2vw, 36px)');
      expect(getMetricValueStyle('—').fontSize).toBe('clamp(32px, 3.2vw, 36px)');
      expect(getMetricValueStyle('0').fontSize).toBe('clamp(32px, 3.2vw, 36px)');

      // Longer descriptive sentences / text labels
      const zeroInferenceStyle = getMetricValueStyle(
        'Không gọi endpoint tính phí (thiết kế zero-inference)'
      );
      expect(zeroInferenceStyle.fontSize).toBe('20px');
      expect(zeroInferenceStyle.fontWeight).toBe(700);
      expect(zeroInferenceStyle.lineHeight).toBe(1.25);
      expect(zeroInferenceStyle.wordBreak).toBe('break-word');

      const daemonRunningStyle = getMetricValueStyle('Daemon đang chạy bình thường');
      expect(daemonRunningStyle.fontSize).toBe('20px');
      expect(daemonRunningStyle.fontWeight).toBe(700);

      const enZeroInferenceStyle = getMetricValueStyle(
        'No billable endpoints called (zero-inference design)'
      );
      expect(enZeroInferenceStyle.fontSize).toBe('20px');
      expect(enZeroInferenceStyle.fontWeight).toBe(700);
    });

    it('renders text values with 20px font-size and numeric values with clamp font-size in OverviewScreen DOM', async () => {
      const overview = await api.getOverview();
      const pipeline = await api.getPipelineModules();
      overview.isFirstRun = false;
      // Configure billableRequestsToday and lastCheck to text values
      overview.billableRequestsToday = {
        code: 'by_design_zero_inference',
      };
      overview.lastCheck = {
        code: 'daemon_running',
      };
      overview.trackedModels = {
        count: 42,
      };

      render(
        <OverviewScreen
          overview={overview}
          pipelineModules={pipeline}
          onToggleFirstRun={vi.fn()}
          onOpenAgentDrawer={vi.fn()}
          onNavigate={vi.fn()}
        />
      );

      const requestsVal = screen.getByTestId('metric-requests-value');
      const lastCheckVal = screen.getByTestId('metric-lastcheck-value');
      const modelsVal = screen.getByTestId('metric-models-value');

      expect(requestsVal.style.fontSize).toBe('20px');
      expect(requestsVal.style.fontWeight).toBe('700');
      expect(lastCheckVal.style.fontSize).toBe('20px');
      expect(lastCheckVal.style.fontWeight).toBe('700');
      expect(modelsVal.style.fontSize).toBe('clamp(32px, 3.2vw, 36px)');
      expect(modelsVal.style.fontWeight).toBe('800');
    });
  });
});

