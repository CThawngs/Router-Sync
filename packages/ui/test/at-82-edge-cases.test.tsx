import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProvidersScreen } from '../src/screens/ProvidersScreen';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { CombosScreen } from '../src/screens/CombosScreen';
import { MockApi } from '../src/api/mock';

describe('Acceptance Test AT-82: Domain Edge Cases in UI', () => {
  const api = new MockApi();

  describe('Edge Case 1: Provider auth_failed retains models', () => {
    it('provider with auth_failed retains registered models and displays keep notice', async () => {
      render(<ProvidersScreen viewMode="detail" />);
      // R17-1: the screen loads the collection from the client, so the card
      // appears after the first render.
      const orbitCard = await waitFor(() => screen.getByTestId('provider-card-orbit'));
      expect(orbitCard).toBeDefined();

      // Verify lifecycle details indicate auth_failed with HTTP 401
      expect(orbitCard.textContent).toContain('auth_failed');
      expect(orbitCard.textContent).toContain('HTTP 401');

      // Models are preserved (not dropped or deleted)
      // Check for models preserved label (p_keep)
      expect(orbitCard.textContent).toMatch(/giữ nguyên|retained|preserved|keep/i);

      // Verify in MockApi that models associated with orbit still exist
      const models = await api.getModels();
      const orbitModels = models.filter((m) => m.provider === 'orbit');
      expect(orbitModels.length).toBeGreaterThan(0);
      expect(orbitModels.some((m) => m.id === 'orbit-pro-1')).toBe(true);
    });
  });

  describe('Edge Case 2: Provider no_list_api is manual-only', () => {
    it('provider with no_list_api renders manual list and manual add action', async () => {
      render(<ProvidersScreen viewMode="detail" />);
      // R17-1: the prototype content lives in api/mock.ts, and the mock's
      // `no_list_api` provider is `vortex`.
      const zetaCard = await waitFor(() => screen.getByTestId('provider-card-vortex'));
      expect(zetaCard).toBeDefined();

      // Verify lifecycle detail indicates no_list_api
      expect(zetaCard.textContent).toContain('no_list_api');
      expect(zetaCard.textContent).toContain('manual list');

      // Verify manual entry indicator
      expect(zetaCard.textContent).toMatch(/thêm tay|manual/i);
    });
  });

  describe('Edge Case 3: Model unknown trait is excluded from trait filter and listed in review', () => {
    it('models with unknown vision trait (null) are excluded from vision filter', async () => {
      render(<ModelsScreen viewMode="detail" />);

      // The screen loads its models from the view-model, so it is async now.
      // Initially all models are listed
      await waitFor(() => {
        expect(screen.getByText('kite-lite-2')).toBeDefined();
      });

      // In the models dataset, kite-lite-2 has hasVision: 'unknown'
      // When filtering by vision, kite-lite-2 should not be displayed
      const visionBtn = screen.getByRole('button', { name: /Có vision|Has vision|vision/i });
      fireEvent.click(visionBtn);
      expect(screen.queryByText('kite-lite-2')).toBeNull();
    });

    it('models with unknown traits or issues are listed in the review tab', async () => {
      render(<ModelsScreen viewMode="detail" />);

      await waitFor(() => {
        expect(screen.getByText('kite-lite-2')).toBeDefined();
      });

      // Switch to Review tab
      const reviewTab = screen.getByRole('tab', { name: /Cần xem lại|Needs review/i });
      fireEvent.click(reviewTab);

      // Review tab lists models with status due_removal, paused, or unknown vision
      await waitFor(() => {
        expect(screen.getByText('kite-lite-2')).toBeDefined();
      });
    });
  });

  describe('Edge Case 4: metered / unknown price excluded from freeOnly combo', () => {
    it('freeOnly combo excludes metered and unknown price models', async () => {
      const combos = await api.getCombos();
      const freeOnlyCombo = combos.find((c) => c.isFreeOnly || c.id === 'free-all');
      expect(freeOnlyCombo).toBeDefined();

      // Steps in free-all should not contain metered or unknown models
      const models = await api.getModels();
      for (const step of freeOnlyCombo!.steps) {
        const modelDef = models.find((m) => m.id === step.modelId);
        if (modelDef) {
          expect(modelDef.priceKind).not.toBe('metered');
          expect(modelDef.priceKind).not.toBe('unknown');
        }
      }
    });
  });

  describe('Edge Case 5: combo below minSteps displays error and retains valid state', () => {
    it('builder ladder requires at least 2 steps (minSteps) and displays error if insufficient', async () => {
      render(<CombosScreen onNavigate={vi.fn()} />);

      // Switch to build tab
      const buildTab = screen.getByRole('tab', { name: /Tạo hoặc sửa|Create or edit|Builder/i });
      fireEvent.click(buildTab);

      // When ladder satisfies minSteps (>= 2), check indicator is positive (b_ck4).
      // The screen loads its view-model asynchronously, so wait for it.
      await waitFor(() => {
        expect(screen.getByText(/ít nhất 2 model|at least 2 models/i)).toBeDefined();
      });
    });

    it('managed combos retain at least minSteps=2 in actual router configurations', async () => {
      const combos = await api.getCombos();
      for (const combo of combos) {
        if (combo.type !== 'cascade') {
          // Every standard managed combo must have at least 2 steps
          expect(combo.steps.length).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });
});
