/**
 * packages/cli/test/profile.test.ts
 *
 * Unit tests for routersync profile:
 * - Profile schema & defaults (P1-P3, C1-C5)
 * - Native router strategy mapping (9Router sequential, OmniRoute Policy §12 matrix)
 * - Profile loading, saving, and combo rule resolution
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  userProfileSchema,
  createDefaultProfile,
} from '../src/profile/schema.js';
import {
  loadProfile,
  writeProfile,
  resolveComboRule,
  resolveRouterNativeStrategy,
  formatProfileSummary,
} from '../src/profile/manager.js';

describe('User Profile Schema & Defaults (P1-P3 & C1-C5)', () => {
  it('creates valid default profile with neutral defaults', () => {
    const prof = createDefaultProfile();
    expect(prof.version).toBe(1);
    expect(prof.general.workload).toBe('coding');
    expect(prof.general.costPreference).toBe('free-only');
    expect(prof.general.preferredProviders).toContain('gemini');
    expect(prof.combos).toHaveLength(1);
    expect(prof.combos[0]?.targetCombo).toBe('all');
    expect(prof.combos[0]?.minSteps).toBe(2);
    expect(prof.combos[0]?.enableInterleaving).toBe(true);
    expect(prof.combos[0]?.freeOnly).toBe(true);
  });

  it('validates custom profile configuration correctly', () => {
    const parsed = userProfileSchema.parse({
      name: 'test-profile',
      general: {
        workload: 'reasoning',
        costPreference: 'budget',
        preferredProviders: ['groq', 'nvidia'],
        excludedProviders: ['bad-provider'],
      },
      combos: [
        {
          targetCombo: 'fast-chat',
          strategy: 'round-robin',
          minSteps: 3,
          enableInterleaving: false,
          freeOnly: true,
        },
      ],
    });

    expect(parsed.name).toBe('test-profile');
    expect(parsed.general.workload).toBe('reasoning');
    expect(parsed.general.costPreference).toBe('budget');
    expect(parsed.combos[0]?.minSteps).toBe(3);
    expect(parsed.combos[0]?.strategy).toBe('round-robin');
  });

  it('rejects minSteps < 2 (enforcing Invariant I3)', () => {
    expect(() =>
      userProfileSchema.parse({
        combos: [
          {
            targetCombo: 'invalid',
            minSteps: 1,
          },
        ],
      })
    ).toThrow();
  });
});

describe('Router Strategy Mapping (Policy §12 Matrix vs 9Router Sequential)', () => {
  it('maps strategy correctly to 9Router sequential and OmniRoute matrix', () => {
    const prof = createDefaultProfile();

    // Default fallback
    expect(resolveRouterNativeStrategy(prof, 'test-combo', '9router')).toBe('fallback');
    expect(resolveRouterNativeStrategy(prof, 'test-combo', 'omniroute')).toBe('priority');

    // Custom combo with round-robin
    prof.combos.push({
      targetCombo: 'round-robin-combo',
      strategy: 'round-robin',
      minSteps: 2,
      enableInterleaving: true,
      freeOnly: true,
    });

    expect(resolveRouterNativeStrategy(prof, 'round-robin-combo', '9router')).toBe('round-robin');
    expect(resolveRouterNativeStrategy(prof, 'round-robin-combo', 'omniroute')).toBe('round-robin');
  });

  it('resolves specific combo rules before fallback "all"', () => {
    const prof = createDefaultProfile();
    prof.combos.unshift({
      targetCombo: 'heavy-coding',
      strategy: 'priority-matrix',
      minSteps: 5,
      enableInterleaving: true,
      freeOnly: false,
    });

    const rule = resolveComboRule(prof, 'heavy-coding');
    expect(rule.targetCombo).toBe('heavy-coding');
    expect(rule.minSteps).toBe(5);
    expect(rule.freeOnly).toBe(false);

    const genericRule = resolveComboRule(prof, 'unknown-combo');
    expect(genericRule.targetCombo).toBe('all');
    expect(genericRule.minSteps).toBe(2);
  });
});

describe('Profile Persistence & Formatting', () => {
  it('writes and loads profile to/from disk cleanly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-prof-test-'));
    const testPath = path.join(tmpDir, 'profile.yaml');

    try {
      const prof = createDefaultProfile();
      prof.name = 'persisted-test';
      prof.general.workload = 'agent';

      writeProfile(prof, testPath);
      expect(fs.existsSync(testPath)).toBe(true);

      const { profile: loaded, isNew } = loadProfile(testPath);
      expect(isNew).toBe(false);
      expect(loaded.name).toBe('persisted-test');
      expect(loaded.general.workload).toBe('agent');

      const summary = formatProfileSummary(loaded, testPath);
      expect(summary).toContain('ROUTERSYNC USER PROFILE: persisted-test');
      expect(summary).toContain('P1 Workload:           agent');
      expect(summary).toContain('Policy §12 Matrix');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
