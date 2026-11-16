import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { ProvidersScreen } from '../src/screens/ProvidersScreen';
import { TargetsScreen } from '../src/screens/TargetsScreen';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { HealthScreen } from '../src/screens/HealthScreen';
import { GuideScreen } from '../src/screens/GuideScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { SetupWizardScreen } from '../src/screens/SetupWizardScreen';
import { MockApi } from '../src/api/mock';

describe('CP3 Screens Suite', () => {
  describe('ProvidersScreen', () => {
    it('renders all 6 provider cards, summary chips, and toggles add provider panel', async () => {
      render(<ProvidersScreen viewMode="detail" />);

      // Verify screen rendered
      expect(screen.getByTestId('providers-screen')).toBeDefined();

      // R17-1: the six cards are the ones the view-model carries. The
      // prototype content lives in api/mock.ts, so the card list follows it.
      await waitFor(() => {
        expect(screen.getByTestId('provider-card-acme')).toBeDefined();
      });
      expect(screen.getByTestId('provider-card-lumen')).toBeDefined();
      expect(screen.getByTestId('provider-card-apex')).toBeDefined();
      expect(screen.getByTestId('provider-card-zenith')).toBeDefined();
      expect(screen.getByTestId('provider-card-orbit')).toBeDefined();
      expect(screen.getByTestId('provider-card-vortex')).toBeDefined();

      // Check key error on orbit
      expect(screen.getAllByText(/orbit/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/401/i).length).toBeGreaterThan(0);

      // Check quota on lumen (the value comes from the view-model now)
      expect(screen.getByTestId('provider-quota-used').textContent).toBe('620');
      expect(screen.getByTestId('provider-quota-limit').textContent).toBe('1000');

      // Toggle Add provider panel
      const addBtn = screen.getByRole('button', { name: /Thêm nhà cung cấp/i });
      fireEvent.click(addBtn);

      expect(screen.getByTestId('add-provider-panel')).toBeDefined();
      expect(screen.getByText(/OpenRouter/i)).toBeDefined();

      // Check key check button
      const checkKeyBtn = screen.getByRole('button', { name: /Kiểm tra khóa/i });
      fireEvent.click(checkKeyBtn);
      expect(screen.getAllByText(/Khóa hợp lệ/i).length).toBeGreaterThan(0);
    });
  });

  describe('TargetsScreen (with AT-116 and D26 compliance)', () => {
    it('renders the targets of the view-model with honest read-back and apply states', async () => {
      const api = new MockApi();
      render(<TargetsScreen viewMode="detail" api={api} />);

      expect(screen.getByTestId('targets-screen')).toBeDefined();

      // One card per target of the view-model (R14-1).
      await waitFor(() => {
        expect(screen.getByTestId('target-card-omniroute')).toBeDefined();
      });
      expect(screen.getByTestId('target-card-9router')).toBeDefined();
      expect(screen.getByTestId('target-card-opencode')).toBeDefined();

      // AT-116 & Decision D26 verification on 9Router:
      const nineCard = screen.getByTestId('target-card-9router');
      expect(nineCard).toBeDefined();

      // The read-back chip carries the readBackLevel of the view-model.
      // R16-3.1: the level is shown ONCE — the translated label replaces the
      // duplicated raw token, the machine level stays in data-level.
      const dbOnlyIndicator = within(nineCard).getByTestId('readback-chip');
      expect(dbOnlyIndicator.getAttribute('data-level')).toBe('db-only');
      expect(dbOnlyIndicator.textContent).toBe('chỉ đọc DB');

      // The apply chip carries the applyState of the view-model.
      const pendingReloadIndicator = within(nineCard).getByTestId('apply-chip');
      expect(pendingReloadIndicator.getAttribute('data-apply-state')).toBe('written-pending-reload');
      expect(pendingReloadIndicator.textContent).toContain('written-pending-reload');

      // Must display D26 limitation callout (from the view-model)
      const d26Card = screen.getByTestId('policy-cap-callout');
      expect(d26Card.textContent).toContain('D26');
      expect(d26Card.textContent).toContain('policy.mode');

      // R14-1: daemon S1 is read-only — there is no preview/live switch to lie about.
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });
  });

  describe('ModelsScreen', () => {
    it('renders 11 models, supports filters, selects detail card, and switches tabs', async () => {
      render(<ModelsScreen viewMode="detail" />);

      expect(screen.getByTestId('models-screen')).toBeDefined();
      expect(screen.getByTestId('models-tab-list')).toBeDefined();

      // 11 models should be loaded (from the view-model, asynchronously)
      await waitFor(() => {
        expect(screen.getByTestId('model-row-kite-code-3')).toBeDefined();
      });
      expect(screen.getByTestId('model-row-acme-coder-2')).toBeDefined();
      expect(screen.getByTestId('model-row-lumen-flash-2')).toBeDefined();

      // Select another model row
      fireEvent.click(screen.getByTestId('model-row-acme-coder-2'));
      const detailCard = screen.getByTestId('model-detail-card');
      expect(detailCard.textContent).toContain('acme-coder-2');

      // Filter by vision
      const visionFilterBtn = screen.getByRole('button', { name: /Có vision/i });
      fireEvent.click(visionFilterBtn);

      // Switch to Sources tab
      const sourcesTab = screen.getByRole('tab', { name: /Nguồn gốc và điểm/i });
      fireEvent.click(sourcesTab);
      expect(screen.getByTestId('models-tab-sources')).toBeDefined();
      expect(screen.getByText('L1')).toBeDefined();
      expect(screen.getByText('L6')).toBeDefined();
      // R14: the aggregate score is not in the view-model, so the screen shows "—"
      // instead of the prototype's fabricated "90".
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('90')).toBeNull();

      // Switch to Review queue tab
      const reviewTab = screen.getByRole('tab', { name: /Cần xem lại/i });
      fireEvent.click(reviewTab);
      expect(screen.getByTestId('models-tab-review')).toBeDefined();
      expect(screen.getByText('acme-coder-2-0912')).toBeDefined();
      expect(screen.getByText('kite-lite-2')).toBeDefined();
    });
  });

  describe('HealthScreen', () => {
    it('renders top metric cards, 3 budgets, probe ladder, sparklines, and 9 doctor checks', async () => {
      render(<HealthScreen viewMode="detail" />);

      expect(screen.getByTestId('health-screen')).toBeDefined();

      // 4 top metrics — the health summary and the model list now load
      // asynchronously from the API client.
      await waitFor(() => expect(screen.getByText('$0.00')).toBeDefined());
      expect(screen.getByText('7 / 11')).toBeDefined();
      // R14: the safety mode renders the raw view-model token ('manual'),
      // not the hardcoded Vietnamese label ('Thủ công').
      expect(screen.getByText('manual')).toBeDefined();

      // Probe ladder with Rule R12 warning
      expect(screen.getByText('P-0')).toBeDefined();
      expect(screen.getByText('P-1')).toBeDefined();
      expect(screen.getByText(/Model tính theo token không bao giờ bị gọi/i)).toBeDefined();

      // Sparklines present
      await waitFor(() =>
        expect(screen.getAllByRole('img', { name: /Nhịp kiểm tra/i }).length).toBeGreaterThanOrEqual(5)
      );

      // Doctor section with 9 conditions
      await waitFor(() => {
        const doctorSection = screen.getByTestId('doctor-section');
        expect(doctorSection).toBeDefined();
        expect(doctorSection.textContent).toContain('9');
      });

      // Run doctor button
      const doctorBtn = screen.getByRole('button', { name: /Chạy kiểm tra máy/i });
      await act(async () => {
        fireEvent.click(doctorBtn);
      });
      expect(doctorBtn).toBeDefined();
    });
  });

  describe('GuideScreen', () => {
    it('renders and allows tab switching across Start, Concepts, FAQ, Troubleshooting, Commands', () => {
      const handleOpenSetup = vi.fn();
      render(<GuideScreen onOpenSetup={handleOpenSetup} />);

      expect(screen.getByTestId('guide-screen')).toBeDefined();
      expect(screen.getByTestId('guide-tab-start')).toBeDefined();

      // Concepts tab
      const conceptsTab = screen.getByRole('tab', { name: /Khái niệm/i });
      fireEvent.click(conceptsTab);
      expect(screen.getByTestId('guide-tab-concepts')).toBeDefined();
      expect(screen.getByText(/Nhà cung cấp \(provider\)/i)).toBeDefined();

      // FAQ tab
      const faqTab = screen.getByRole('tab', { name: /Hỏi đáp/i });
      fireEvent.click(faqTab);
      expect(screen.getByTestId('guide-tab-faq')).toBeDefined();

      // Troubleshooting tab
      const troubleTab = screen.getByRole('tab', { name: /Xử lý lỗi/i });
      fireEvent.click(troubleTab);
      expect(screen.getByTestId('guide-tab-trouble')).toBeDefined();

      // Commands tab
      const cheatTab = screen.getByRole('tab', { name: /Lệnh và MCP/i });
      fireEvent.click(cheatTab);
      expect(screen.getByTestId('guide-tab-cheat')).toBeDefined();
      expect(screen.getByText('routersync init')).toBeDefined();
      expect(screen.getByText('routersync rollback')).toBeDefined();
    });
  });

  describe('SettingsScreen', () => {
    it('renders General, Safety, AI & MCP tabs with adjustable limits and hard rules', async () => {
      const handleSetViewMode = vi.fn();
      render(<SettingsScreen onSetViewMode={handleSetViewMode} />);

      expect(screen.getByTestId('settings-screen')).toBeDefined();
      expect(screen.getByTestId('settings-tab-general')).toBeDefined();

      // Switch to Safety tab. R17-2: the values now come from the view-model,
      // so they arrive after the first await.
      const safetyTab = screen.getByRole('tab', { name: /An toàn/i });
      fireEvent.click(safetyTab);
      expect(screen.getByTestId('settings-tab-safety')).toBeDefined();
      await waitFor(() => {
        expect(screen.getByText(/3 \/ 7/)).toBeDefined();
      });
      expect(screen.getByText(/50%/)).toBeDefined();

      // Switch to AI & MCP tab
      const aiTab = screen.getByRole('tab', { name: /AI và MCP/i });
      fireEvent.click(aiTab);
      expect(screen.getByTestId('settings-tab-ai')).toBeDefined();
      expect(screen.getByText('Claude Code')).toBeDefined();
      expect(screen.getByText('OpenCode')).toBeDefined();
    });
  });

  describe('SetupWizardScreen', () => {
    it('walks through the 4 steps of first-time setup and finishes', async () => {
      const handleFinish = vi.fn();
      const handleSkip = vi.fn();
      render(<SetupWizardScreen onFinish={handleFinish} onSkip={handleSkip} />);

      expect(screen.getByTestId('setup-wizard-screen')).toBeDefined();
      expect(screen.getByTestId('wizard-step-1')).toBeDefined();

      // Check key
      const checkBtn = screen.getByRole('button', { name: /Kiểm tra khóa/i });
      fireEvent.click(checkBtn);
      // R18-4 (AT-154): "Key is valid, found 86 models" is an illustrated claim
      // and only paints for sample content. The preview arrives asynchronously,
      // so wait for it instead of asserting on the first frame.
      await waitFor(() => {
        expect(screen.getByText(/Khóa hợp lệ/i)).toBeDefined();
      });

      // Continue to step 2
      const nextBtn1 = screen.getByRole('button', { name: /Tiếp tục/i });
      fireEvent.click(nextBtn1);
      expect(screen.getByTestId('wizard-step-2')).toBeDefined();

      // Continue to step 3
      const nextBtn2 = screen.getByRole('button', { name: /Tiếp tục/i });
      fireEvent.click(nextBtn2);
      expect(screen.getByTestId('wizard-step-3')).toBeDefined();

      // Continue to step 4
      const nextBtn3 = screen.getByRole('button', { name: /Tiếp tục/i });
      fireEvent.click(nextBtn3);
      expect(screen.getByTestId('wizard-step-4')).toBeDefined();
      // R17-2: the preview numbers arrive from the view-model.
      await waitFor(() => {
        expect(screen.getByText('86')).toBeDefined();
      });

      // Finish button
      const finishBtn = screen.getByRole('button', { name: /Vào Tổng quan/i });
      fireEvent.click(finishBtn);
      expect(handleFinish).toHaveBeenCalled();
    });
  });
});
