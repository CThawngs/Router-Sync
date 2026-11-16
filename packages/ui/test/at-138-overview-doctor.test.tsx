import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import { HealthScreen } from '../src/screens/HealthScreen';
import { t } from '../src/i18n';
import type { DoctorReportViewModel, HealthSummaryViewModel, SystemOverview } from '../src/api/types';

/**
 * AT-138 (R14): the overview and the doctor table are pure functions of their
 * view-models. Nothing on these screens may invent a number, a badge or a
 * "verified" claim that the daemon did not measure.
 */

/** Fixture A — shape of GET /api/v1/overview in the S1 daemon. */
const OVERVIEW_FIXTURE: SystemOverview = {
  meta: {
    source: 'unavailable',
    reason: 'all_routers_down',
    generatedAt: '2026-10-19T07:14:21.817Z',
  },
  routers: { upCount: 0, probedCount: 2 },
  trackedModels: { count: 1 },
  billableRequestsToday: { code: 'by_design_zero_inference' },
  lastCheck: { code: 'router_disconnected', lastCheckAt: '2026-10-19T07:14:21.817Z' },
};

/** Fixture B — shape of GET /api/v1/doctor in the S1 daemon. */
const DOCTOR_FIXTURE: DoctorReportViewModel = {
  meta: {
    source: 'live',
    generatedAt: '2026-10-19T07:14:03.758Z',
  },
  overallStatus: 'error',
  conditions: [
    {
      id: 'c1',
      condKey: 'c_at100_node',
      state: 'pass',
      code: 'node_runtime_ok',
      params: { current: '24.18.0', required: '>=22.12.0' },
    },
    {
      id: 'c2',
      condKey: 'c_at101_config',
      state: 'pass',
      code: 'config_readable',
      params: { file: 'routersync.yaml' },
    },
    {
      id: 'c3',
      condKey: 'c_at97_db_file',
      state: 'pass',
      code: 'db_file_readable',
      params: { file: 'rs_fixture_omni.sqlite', size: 12288 },
    },
    {
      id: 'c4',
      condKey: 'c_at97_fingerprint',
      state: 'pass',
      code: 'schema_fingerprint_ok',
      params: { tables: 1 },
    },
    {
      id: 'c5',
      condKey: 'c_at107_snapshot',
      state: 'not_checked',
      reason: 'no_snapshot_yet',
      code: 'snapshot_none_yet',
      params: { snapshots: 0 },
    },
    {
      id: 'c6',
      condKey: 'c_at95_doctor',
      state: 'fail',
      code: 'routers_unreachable',
      params: { omniroute: 'down', ninerouter: 'down' },
    },
    {
      id: 'c7',
      condKey: 'c_at110_syncloop',
      state: 'not_checked',
      reason: 'needs_p3a',
      code: 'deferred_to_p3a',
    },
    {
      id: 'c8',
      condKey: 'c_at111_fastloop',
      state: 'not_checked',
      reason: 'needs_p3a',
      code: 'deferred_to_p3a',
    },
    {
      id: 'c9',
      condKey: 'c_at94_mcp_ro',
      state: 'not_checked',
      reason: 'needs_p3a',
      code: 'deferred_to_p3a',
    },
  ],
};

const renderOverview = (overview: SystemOverview) =>
  render(
    <OverviewScreen
      overview={overview}
      pipelineModules={[]}
      onNavigate={vi.fn()}
      onToggleFirstRun={vi.fn()}
      onOpenAgentDrawer={vi.fn()}
    />
  );

const renderDoctor = () =>
  render(
    <HealthScreen
      doctor={DOCTOR_FIXTURE}
      health={{ doctorConditions: [], recentAlerts: [] } as HealthSummaryViewModel}
      models={[]}
    />
  );

describe('AT-138: overview + doctor are pure functions of their view-models', () => {
  describe('OverviewScreen', () => {
    it('renders the routers tile as upCount/probedCount from the view-model', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(screen.getByTestId('metric-routers-value').textContent).toBe('0/2');
    });

    it('renders the tracked model count from the view-model', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(screen.getByTestId('metric-models-value').textContent).toBe('1');
      expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the translated billable-requests code from the view-model', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(screen.getByTestId('metric-requests-value').textContent).toBe(t('by_design_zero_inference'));
      expect(screen.getByText(t('by_design_zero_inference'))).toBeDefined();
    });

    it('renders the translated last-check code from the view-model', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(screen.getByTestId('metric-lastcheck-value').textContent).toBe(t('router_disconnected'));
      expect(screen.getByText(t('router_disconnected'))).toBeDefined();
    });

    it('no longer renders the removed activeProviders tile value', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(document.body.textContent).not.toContain('activeProviders');
      const tiles = screen.getAllByTestId('metric-tile');
      expect(tiles.map((tile) => tile.textContent).join(' ')).not.toContain('4/6');
    });

    it('shows the empty states instead of prototype todo and event content', () => {
      renderOverview(OVERVIEW_FIXTURE);

      expect(screen.getByText(t('r14_overview_no_todo'))).toBeDefined();
      expect(screen.getByText(t('r14_overview_no_events'))).toBeDefined();
      expect(document.body.textContent).not.toContain(t('d_td1'));
      expect(document.body.textContent).not.toContain(t('d_td2'));
      expect(document.body.textContent).not.toContain(t('d_e3'));
      expect(document.body.textContent).not.toContain('acme-coder-2');
    });

    it('renders "—" in every metric tile when the view-model measures nothing', () => {
      const emptyOverview = {
        meta: OVERVIEW_FIXTURE.meta,
        billableRequestsToday: {},
        lastCheck: {},
      } as unknown as SystemOverview;

      renderOverview(emptyOverview);

      expect(screen.getByTestId('metric-routers-value').textContent).toBe('—');
      expect(screen.getByTestId('metric-models-value').textContent).toBe('—');
      expect(screen.getByTestId('metric-requests-value').textContent).toBe('—');
      expect(screen.getByTestId('metric-lastcheck-value').textContent).toBe('—');
    });

    it('flags sample data with the sample badge', () => {
      const sampleOverview: SystemOverview = {
        ...OVERVIEW_FIXTURE,
        meta: { source: 'sample', generatedAt: '2026-10-19T07:14:21.817Z' },
      };

      renderOverview(sampleOverview);

      const badge = screen.getByTestId('sample-badge');
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain(t('r14_sample_badge'));
    });
  });

  describe('HealthScreen doctor table', () => {
    it('renders one row per condition of the doctor report', () => {
      const { container } = renderDoctor();

      expect(container.querySelectorAll('[data-testid^="doctor-row-"]').length).toBe(9);
    });

    it('never paints a not-checked condition red', () => {
      renderDoctor();

      for (const id of ['c5', 'c7', 'c8', 'c9']) {
        const badge = screen.getByTestId(`doctor-state-${id}`);
        expect(badge.style.border).toContain('dashed');
        expect(badge.style.color).not.toBe('var(--cor-i)');
        expect(badge.style.background).not.toBe('var(--cor-t)');
      }
    });

    it('paints a failed condition red', () => {
      renderDoctor();

      const badge = screen.getByTestId('doctor-state-c6');
      expect(badge.style.color).toBe('var(--cor-i)');
      expect(badge.style.background).toBe('var(--cor-t)');
    });

    it('renders the overall doctor status from the view-model', () => {
      renderDoctor();

      // R18-5.1: the overall status enum goes through the catalog now.
    expect(screen.getByTestId('doctor-overall').textContent).toContain(t('r18_overall_error'));
    expect(screen.getByTestId('doctor-overall').textContent).not.toContain('error');
    });

    it('never claims a fake doctor result', () => {
      renderDoctor();

      expect(document.body.textContent).not.toContain('9/9');
      expect(document.body.textContent).not.toContain('orbit bị lỗi khóa');
    });
  });
});
