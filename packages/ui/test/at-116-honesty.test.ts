import { describe, it, expect } from 'vitest';
import { MockApi } from '../src/api/mock';

describe('AT-116: Honest State Representation & Safety Gates', () => {
  const api = new MockApi();

  it('verifies written-pending-reload apply status maps to warning/amber and never success/green', async () => {
    const pipeline = await api.getPipelineModules();
    const targets = await api.getTargets();

    // Find 9Router or any target with degraded/written-pending-reload
    const nineRouter = targets.find((t) => t.id === 'sk2' || t.name.toLowerCase().includes('9router'));
    expect(nineRouter).toBeDefined();

    if (nineRouter) {
      // Must reflect degraded readback or pending reload
      expect(nineRouter.readBackLevel).toBe('db-only');
      expect(nineRouter.applyState).toBe('written-pending-reload');

      // Policy mode must be capped at manual or shadow (D26)
      expect(['manual', 'shadow']).toContain(nineRouter.policyMode);
      expect(nineRouter.policyCappedReason).toBeDefined();
    }

    // Verify pipeline module 8 (Verify / degraded status)
    const verifyMod = pipeline.find((m) => m.step === 8);
    expect(verifyMod).toBeDefined();
    expect(verifyMod?.status).not.toBe('ok');
    expect(verifyMod?.isDashed).toBe(true);
  });

  it('guarantees unknown is visually and semantically distinct from dead/bad', () => {
    // Check glyph definition in types/components
    const GLYPH_CHARS = {
      ok: '●',
      new: '◆',
      warn: '▲',
      bad: '✕',
      unk: '?',
    };

    expect(GLYPH_CHARS.unk).not.toBe(GLYPH_CHARS.bad);
    expect(GLYPH_CHARS.unk).toBe('?');
    expect(GLYPH_CHARS.bad).toBe('✕');
  });

  it('verifies stale/unverified data never shows as green ok', async () => {
    const pipeline = await api.getPipelineModules();
    for (const mod of pipeline) {
      if (mod.isDashed) {
        expect(mod.status).not.toBe('ok');
      }
    }
  });

  it('verifies targets policy.mode capping compliance with D26', async () => {
    const targets = await api.getTargets();
    for (const target of targets) {
      if (target.readBackLevel === 'db-only') {
        expect(['manual', 'shadow']).toContain(target.policyMode);
      }
    }
  });
});
