/**
 * packages/cli/test/tick-c4s-tiers-and-errors.test.ts
 *
 * Tests for Round C4s:
 *  - S2.1: Tier-Aware proposal generation in tick:
 *      * Tier A (active in router/combo) is SKIPPED (no ADD_MODEL or ENABLE_MODEL proposal)
 *      * Tier B (known/disabled in router) produces ENABLE_MODEL proposal (targetTier: A)
 *      * Tier C (unconfigured in router) produces ADD_MODEL proposal (targetTier: A)
 *  - S2.2: Tier C models NEVER produce REMOVE_MODEL proposals when absent
 *  - S2.3: Error suppression in tick:
 *      * 429 QUOTA
 *      * 401/403 AUTH_ERROR
 *      * 5xx TRANSIENT
 *      * timeout TRANSIENT
 *      * incomplete-pagination TRANSIENT
 *      * redirect-blocked TRANSIENT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const hoisted = vi.hoisted(() => ({
  mockComboData: [] as Array<{ id: string; name: string; models: string[] }>,
}));

vi.mock('@routersync/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@routersync/daemon')>();
  return {
    ...actual,
    readRouterCombos: () => ({
      ok: true,
      exists: true,
      dbPath: 'mocked',
      data: hoisted.mockComboData,
    }),
  };
});

vi.mock('../src/config/loader.js', () => ({
  loadConfigFile: () => ({
    config: { version: 1, routers: [], combos: [], adopt: [] },
    filePath: 'mocked-config.yaml',
  }),
}));

vi.mock('../src/commands/sync/sync-plan.js', () => ({
  buildViews: async () => [
    {
      name: '9router',
      targets: [
        { id: 'testprov', label: 'testprov', prefix: 'testprov', baseUrl: 'https://testprov.example.com/v1', apiKey: 'test-key', keySource: 'none' },
      ],
      combos: [],
    },
  ],
  printTargets: () => {},
}));

import {
  runTickCommand,
  resolveModelTier,
  loadRouterDisabledModels,
  type TickInboxItem,
} from '../src/commands/tick.js';
import type { RouterModelState } from '@routersync/core';

describe('C4s S2: Tier-Aware Proposal Generation and Error Suppression in tick', () => {
  let tmpDir: string;
  const nowMs = 1763110000000;
  let orig9Db: string | undefined;
  let origOmniDb: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c4s-tick-'));
    orig9Db = process.env['ROUTERSYNC_9ROUTER_DB'];
    origOmniDb = process.env['ROUTERSYNC_OMNIROUTE_DB'];
    // U4: Hermetic tests point router DB env vars to non-existent fixture paths
    process.env['ROUTERSYNC_9ROUTER_DB'] = path.join(tmpDir, 'nonexistent-9router.sqlite');
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpDir, 'nonexistent-omniroute.sqlite');
  });

  afterEach(() => {
    if (orig9Db !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = orig9Db;
    else delete process.env['ROUTERSYNC_9ROUTER_DB'];
    if (origOmniDb !== undefined) process.env['ROUTERSYNC_OMNIROUTE_DB'] = origOmniDb;
    else delete process.env['ROUTERSYNC_OMNIROUTE_DB'];

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('resolveModelTier logic', () => {
    it('correctly classifies models into Tier A, B, and C', () => {
      const usedSteps = new Set<string>(['testprov/active-combo-model', 'testprov/standalone-active']);
      const disabledModels = new Set<string>(['testprov/disabled-model', 'testprov/disabled-standalone']);

      // Tier B: in disabled list (takes precedence over combo or active status)
      expect(resolveModelTier('testprov', 'disabled-model', usedSteps, disabledModels)).toBe('B');
      expect(resolveModelTier('testprov', 'disabled-standalone', usedSteps, disabledModels)).toBe('B');

      // U2: alias mapping (google <-> gemini)
      const googleDisabled = new Set<string>(['gemini/gemini-2.5-pro']);
      expect(resolveModelTier('google', 'gemini-2.5-pro', usedSteps, googleDisabled)).toBe('B');

      // Tier A: in usedSteps / combos and not disabled
      expect(resolveModelTier('testprov', 'active-combo-model', usedSteps, disabledModels)).toBe('A');

      // Tier C: not in usedSteps and not disabled (unconfigured in router)
      expect(resolveModelTier('testprov', 'unconfigured-model', usedSteps, disabledModels)).toBe('C');
    });

    it('loadRouterDisabledModels returns a valid Set without throwing', () => {
      const disabled = loadRouterDisabledModels();
      expect(disabled instanceof Set).toBe(true);
    });
  });

  describe('Tier-Aware Proposals on newly added models', () => {
    it('skips Tier A models, proposes ENABLE_MODEL for Tier B, and proposes ADD_MODEL for Tier C', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      const inboxPath = path.join(tmpDir, 'inbox.json');

      hoisted.mockComboData = [
        {
          id: 'combo-1',
          name: 'combo-1',
          models: ['testprov/tier-a-model'],
        },
        {
          id: 'combo-2',
          name: 'combo-2',
          models: ['testprov/baseline-model'],
        },
      ];

      // Previous catalog had baseline
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['baseline-model'],
                absenceCounts: {},
                firstAbsentAt: {},
                hash: 'h-prev',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Provider now returns:
      // - baseline-model (unchanged)
      // - tier-a-model (active in combo -> Tier A, should be SKIPPED)
      // - tier-b-model (in disabledModels -> Tier B, should propose ENABLE_MODEL)
      // - tier-c-model (unconfigured -> Tier C, should propose ADD_MODEL)
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'baseline-model' },
              { id: 'tier-a-model' },
              { id: 'tier-b-model' },
              { id: 'tier-c-model' },
            ],
          }),
          { status: 200 }
        );
      };

      const disabledMock = new Set<string>(['testprov/tier-b-model']);

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        disabledModels: disabledMock,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // 1. Tier A model: MUST BE SKIPPED (no proposal for tier-a-model)
      const tierAItems = items.filter((it) => it.body.includes('tier-a-model'));
      expect(tierAItems).toHaveLength(0);

      // 2. Tier B model: MUST propose ENABLE_MODEL
      const tierBItems = items.filter((it) => it.body.includes('tier-b-model'));
      expect(tierBItems.length).toBeGreaterThan(0);
      for (const item of tierBItems) {
        expect(item.action).toBe('ENABLE_MODEL');
        expect(item.label).toBe('ENABLE-CANDIDATE');
      }

      // 3. Tier C model: MUST propose ADD_MODEL
      const tierCItems = items.filter((it) => it.body.includes('tier-c-model'));
      expect(tierCItems.length).toBeGreaterThan(0);
      for (const item of tierCItems) {
        expect(item.action).toBe('ADD_MODEL');
        expect(item.label).toBe('NEW-CANDIDATE');
      }
    });

    it('C4t T2.1/T2.2: evaluates models on first scan when prevIds is empty and creates grouped proposals with modelIds', async () => {
      const inboxPath = path.join(tmpDir, 'inbox.json');

      hoisted.mockComboData = [
        {
          id: 'combo-1',
          name: 'combo-1',
          models: ['testprov/active-in-combo'],
        },
      ];

      // NO catalog file exists beforehand (first scan baseline)
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'active-in-combo' },    // Tier A (in combo) -> skipped
              { id: 'disabled-in-router' },  // Tier B (disabled) -> ENABLE_MODEL
              { id: 'new-catalog-model-1' }, // Tier C (unconfigured) -> ADD_MODEL
              { id: 'new-catalog-model-2' }, // Tier C (unconfigured) -> ADD_MODEL
            ],
          }),
          { status: 200 }
        );
      };

      const disabledMock = new Set<string>(['testprov/disabled-in-router']);

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        disabledModels: disabledMock,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // Tier A should be skipped
      const tierA = items.filter((it) => it.body.includes('active-in-combo'));
      expect(tierA).toHaveLength(0);

      // Tier B: ENABLE_MODEL grouped proposal with modelIds
      const tierB = items.find((it) => it.action === 'ENABLE_MODEL');
      expect(tierB).toBeDefined();
      expect(tierB?.modelIds).toEqual(['disabled-in-router']);
      expect(tierB?.label).toBe('ENABLE-CANDIDATE');

      // Tier C: ADD_MODEL grouped proposal with modelIds
      const tierC = items.find((it) => it.action === 'ADD_MODEL');
      expect(tierC).toBeDefined();
      expect(tierC?.modelIds).toEqual(['new-catalog-model-1', 'new-catalog-model-2']);
      expect(tierC?.label).toBe('NEW-CANDIDATE');
    });

    it('U3: OmniRoute models outside combos remain UNKNOWN and do NOT generate ADD_MODEL proposals', async () => {
      const inboxPath = path.join(tmpDir, 'inbox.json');

      hoisted.mockComboData = [
        {
          id: 'combo-1',
          name: 'combo-1',
          models: ['testprov/combo-active-model'],
        },
      ];

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'combo-active-model' },     // Tier A (in combo) -> skipped
              { id: 'outside-combo-model' },    // UNKNOWN in OmniRoute -> skipped, NO proposal
            ],
          }),
          { status: 200 }
        );
      };

      // Mock OmniRoute router state
      const omniState = {
        router: 'omniroute',
        enabledModels: new Set<string>(['testprov/combo-active-model']),
        disabledModels: new Set<string>(),
        comboModels: new Set<string>(['testprov/combo-active-model']),
        customModels: new Set<string>(),
        catalogModels: new Set<string>(),
        classify: (prov: string, id: string) => {
          if (id === 'combo-active-model') {
            return { tier: 'A' as const, inCombo: true, inconsistent: false };
          }
          return { tier: 'UNKNOWN' as const, inCombo: false, inconsistent: false };
        },
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        routerState: omniState,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // UNKNOWN model must NOT generate ADD_MODEL or ENABLE_MODEL proposal
      const outsideProposal = items.filter((it) => it.body.includes('outside-combo-model'));
      expect(outsideProposal).toHaveLength(0);
      expect(items).toHaveLength(0);
    });

    it('V5(a): custom enabled model outside combos is classified as Tier A and does NOT generate proposals', async () => {
      const inboxPath = path.join(tmpDir, 'inbox.json');

      hoisted.mockComboData = [
        {
          id: 'combo-1',
          name: 'combo-1',
          models: ['testprov/combo-model'],
        },
      ];

      // Provider returns:
      // - combo-model (Tier A in combo)
      // - custom-enabled-model (custom model, enabled in router, but NOT in any combo)
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'combo-model' },
              { id: 'custom-enabled-model' },
            ],
          }),
          { status: 200 }
        );
      };

      // 9Router state with custom-enabled-model in customModels and enabledModels, NOT in comboModels or disabledModels
      const nineState: RouterModelState = {
        router: '9router',
        enabledModels: new Set<string>(['testprov/combo-model', 'testprov/custom-enabled-model']),
        disabledModels: new Set<string>(),
        comboModels: new Set<string>(['testprov/combo-model']),
        customModels: new Set<string>(['testprov/custom-enabled-model']),
        catalogModels: new Set<string>(),
        classify: (prov: string, id: string) => {
          if (id === 'combo-model') {
            return { tier: 'A', inCombo: true, inconsistent: false, reason: 'Active in combo' };
          }
          if (id === 'custom-enabled-model') {
            return { tier: 'A', inCombo: false, inconsistent: false, reason: 'Active/enabled custom model in router' };
          }
          return { tier: 'C', inCombo: false, inconsistent: false, reason: 'Unconfigured in router' };
        },
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        routerState: nineState,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // Custom enabled model outside combo MUST NOT generate ADD_MODEL or ENABLE_MODEL proposal
      const customProposal = items.filter((it) => it.body.includes('custom-enabled-model'));
      expect(customProposal).toHaveLength(0);
      expect(items).toHaveLength(0);
    });

    it('V5(b): same model id on two providers, disabled on provider X: provider Y is NOT classified as B', async () => {
      const inboxPath = path.join(tmpDir, 'inbox.json');

      // Shared model ID 'shared-flagship-1' exists on both prov-x and prov-y
      const disabledModels = new Set<string>(['prov-x/shared-flagship-1']);
      const usedSteps = new Set<string>();

      // Direct classifier checks:
      // prov-x has disabled model -> Tier B
      expect(resolveModelTier('prov-x', 'shared-flagship-1', usedSteps, disabledModels)).toBe('B');
      // prov-y has same model ID, but is NOT disabled on prov-y -> Tier C (not B)
      expect(resolveModelTier('prov-y', 'shared-flagship-1', usedSteps, disabledModels)).toBe('C');

      // Full tick execution check with provider testprov (unaffected by prov-x disable)
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            data: [{ id: 'shared-flagship-1' }],
          }),
          { status: 200 }
        );
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        disabledModels,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // testprov (prefix used by mock buildViews) with model shared-flagship-1
      // MUST produce ADD_MODEL (Tier C), NEVER ENABLE_MODEL (Tier B)
      const enableProposal = items.filter((it) => it.action === 'ENABLE_MODEL');
      expect(enableProposal).toHaveLength(0);

      const addProposal = items.find((it) => it.action === 'ADD_MODEL');
      expect(addProposal).toBeDefined();
      expect(addProposal?.modelIds).toContain('shared-flagship-1');
    });
  });

  describe('Prevent REMOVE_MODEL proposals on Tier C models', () => {
    it('prevents REMOVE_MODEL on Tier C models and only proposes REMOVE_MODEL for Tier A/B models', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      const inboxPath = path.join(tmpDir, 'inbox.json');

      hoisted.mockComboData = [
        {
          id: 'combo-1',
          name: 'combo-1',
          models: ['testprov/active-combo-model'],
        },
      ];

      // Previous catalog had:
      // - active-combo-model (Tier A, in combo)
      // - external-only-model (Tier C, not in combo, not in router disabled)
      // external-only-model absent for 3 cycles and >24h (qualifies for ABSENT-STABLE if unsupported gateway)
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['active-combo-model', 'external-only-model'],
                absenceCounts: {
                  'active-combo-model': 2,
                  'external-only-model': 3,
                },
                firstAbsentAt: {
                  'active-combo-model': new Date(nowMs - 2 * 86400000).toISOString(),
                  'external-only-model': new Date(nowMs - 2 * 86400000).toISOString(),
                },
                hash: 'h-prev',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Now provider returns other models: both models are absent and deadConfirmed
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ data: [{ id: 'other-model-running' }] }), { status: 200 });
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
        graceCycles: 2,
        maxShrinkRatio: 1.0,
      });

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // Tier C model MUST NOT generate REMOVE_MODEL proposal
      const tierCRemoval = items.filter(
        (it) => it.action === 'REMOVE_MODEL' && it.body.includes('external-only-model')
      );
      expect(tierCRemoval).toHaveLength(0);

      // Tier C model MUST be tracked in absentNotInCombo in status.json
      const statusJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf8'));
      expect(statusJson.absentNotInCombo?.testprov).toContain('testprov/external-only-model');

      // Tier A model (in combo) DOES generate REMOVE_MODEL proposal
      const tierARemoval = items.filter(
        (it) => it.action === 'REMOVE_MODEL' && it.body.includes('active-combo-model')
      );
      expect(tierARemoval.length).toBeGreaterThan(0);
      expect(tierARemoval[0]?.action).toBe('REMOVE_MODEL');
    });
  });

  describe('Error Suppression in tick', () => {
    it('suppresses errors and sets QUOTA for HTTP 429 without dropping catalog', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['model-1', 'model-2'],
                absenceCounts: {},
                hash: 'h-prev',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const mockFetch: typeof fetch = async () => new Response('Too Many Requests', { status: 429 });

      const summary = await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      expect(summary.changedProviders).toBe(0);
      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('QUOTA');
      expect(catState.providers.testprov.lastStatus).toBe(429);
      // Preserved ids
      expect(catState.providers.testprov.ids).toEqual(['model-1', 'model-2']);
      // Backoff is set
      expect(catState.providers.testprov.backoffUntilMs).toBeGreaterThan(nowMs);
    });

    it('suppresses errors, sets AUTH_ERROR, and generates warning alert for HTTP 401/403', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      const inboxPath = path.join(tmpDir, 'inbox.json');

      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['model-1'],
                absenceCounts: {},
                hash: 'h-prev',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const mockFetch: typeof fetch = async () => new Response('Forbidden', { status: 403 });

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('AUTH_ERROR');
      expect(catState.providers.testprov.lastStatus).toBe(403);
      expect(catState.providers.testprov.ids).toEqual(['model-1']);

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];
      const authAlert = items.find((i) => i.label === 'AUTH_ERROR');
      expect(authAlert).toBeDefined();
      expect(authAlert?.type).toBe('warning');
    });

    it('U5: suppresses errors and sets AUTH_ERROR for HTTP 401 with inbox invariance', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      const inboxPath = path.join(tmpDir, 'inbox.json');

      // Pre-existing proposal in inbox
      const preExistingItem: TickInboxItem = {
        id: 'existing-proposal-1',
        title: 'Existing item to preserve',
        type: 'proposal',
        timestamp: new Date(nowMs - 5000).toISOString(),
        body: 'Pre-existing item that must remain invariant',
        action: 'ADD_MODEL',
        targetTier: 'A',
        label: 'NEW-CANDIDATE',
        provider: 'testprov',
        modelIds: ['existing-model'],
      };
      fs.writeFileSync(inboxPath, JSON.stringify([preExistingItem], null, 2), 'utf8');

      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['model-1'],
                absenceCounts: {},
                hash: 'h-prev',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const mockFetch: typeof fetch = async () => new Response('Unauthorized', { status: 401 });

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('AUTH_ERROR');
      expect(catState.providers.testprov.lastStatus).toBe(401);
      expect(catState.providers.testprov.ids).toEqual(['model-1']);

      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items: TickInboxItem[] = Array.isArray(inbox) ? inbox : inbox.items ?? [];

      // Existing item preserved (inbox invariance)
      const preserved = items.find((i) => i.id === 'existing-proposal-1');
      expect(preserved).toBeDefined();

      // Auth error alert generated
      const authAlert = items.find((i) => i.label === 'AUTH_ERROR');
      expect(authAlert).toBeDefined();
      expect(authAlert?.type).toBe('warning');
    });

    it('suppresses errors and sets TRANSIENT for HTTP 500/502/503', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['m1'],
                absenceCounts: {},
                hash: 'h1',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const mockFetch: typeof fetch = async () => new Response('Internal Server Error', { status: 500 });

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('TRANSIENT');
      expect(catState.providers.testprov.lastStatus).toBe(500);
      expect(catState.providers.testprov.ids).toEqual(['m1']);
    });

    it('suppresses errors and sets TRANSIENT for network timeouts (HTTP 408 / connection error)', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['m1'],
                absenceCounts: {},
                hash: 'h1',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const mockFetch: typeof fetch = async () => new Response('Request Timeout', { status: 408 });

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('TRANSIENT');
      expect(catState.providers.testprov.lastStatus).toBe(408);
      expect(catState.providers.testprov.ids).toEqual(['m1']);
    });

    it('suppresses errors and sets skipReason incomplete-pagination on incomplete payload', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['m1'],
                absenceCounts: {},
                hash: 'h1',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Provider returns truncated payload
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }], has_more: true }), { status: 200 });
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('TRANSIENT');
      expect(catState.providers.testprov.ids).toEqual(['m1']);
    });

    it('suppresses errors and sets skipReason redirect-blocked on cross-origin redirects', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      fs.writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(nowMs).toISOString(),
            providers: {
              testprov: {
                prefix: 'testprov',
                router: '9router',
                ids: ['m1'],
                absenceCounts: {},
                hash: 'h1',
                updatedAt: new Date(nowMs).toISOString(),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Redirect to external untrusted host
      const mockFetch: typeof fetch = async () => {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://evil-redirect.com/models' },
        });
      };

      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: mockFetch,
        nowMs: nowMs + 1000,
        mode: 'propose',
      });

      const catState = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      expect(catState.providers.testprov.lastLabel).toBe('TRANSIENT');
      expect(catState.providers.testprov.skipReason).toBe('redirect-blocked');
      expect(catState.providers.testprov.ids).toEqual(['m1']);
    });

    it('V5(c): inbox invariance across 429, 5xx, 408, incomplete payload, and redirect errors', async () => {
      const catalogPath = path.join(tmpDir, 'tick-catalog.json');
      const inboxPath = path.join(tmpDir, 'inbox.json');

      const initialInboxItem: TickInboxItem = {
        id: 'initial-proposal-preserve-invariant',
        title: 'Preserved proposal',
        type: 'proposal',
        timestamp: new Date(nowMs - 10000).toISOString(),
        body: 'Must remain completely unchanged across all suppressed errors',
        action: 'ADD_MODEL',
        targetTier: 'A',
        label: 'NEW-CANDIDATE',
        provider: 'testprov',
        modelIds: ['some-model'],
        proposed_by: { kind: 'system', source: 'tick' },
      };

      const seedCatalog = () => {
        fs.writeFileSync(
          catalogPath,
          JSON.stringify(
            {
              version: 1,
              updatedAt: new Date(nowMs).toISOString(),
              providers: {
                testprov: {
                  prefix: 'testprov',
                  router: '9router',
                  ids: ['m1'],
                  absenceCounts: {},
                  hash: 'h-init',
                  updatedAt: new Date(nowMs).toISOString(),
                },
              },
            },
            null,
            2
          ),
          'utf8'
        );
      };

      // 1. HTTP 429 (QUOTA)
      fs.writeFileSync(inboxPath, JSON.stringify([initialInboxItem], null, 2), 'utf8');
      seedCatalog();
      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: async () => new Response('Too Many Requests', { status: 429 }),
        nowMs: nowMs + 1000,
        mode: 'propose',
      });
      let inboxAfter = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inboxAfter).toEqual([initialInboxItem]);

      // 2. HTTP 500 (TRANSIENT)
      fs.writeFileSync(inboxPath, JSON.stringify([initialInboxItem], null, 2), 'utf8');
      seedCatalog();
      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: async () => new Response('Internal Server Error', { status: 500 }),
        nowMs: nowMs + 2000,
        mode: 'propose',
      });
      inboxAfter = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inboxAfter).toEqual([initialInboxItem]);

      // 3. HTTP 408 (TRANSIENT timeout)
      fs.writeFileSync(inboxPath, JSON.stringify([initialInboxItem], null, 2), 'utf8');
      seedCatalog();
      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: async () => new Response('Request Timeout', { status: 408 }),
        nowMs: nowMs + 3000,
        mode: 'propose',
      });
      inboxAfter = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inboxAfter).toEqual([initialInboxItem]);

      // 4. Incomplete pagination (TRANSIENT)
      fs.writeFileSync(inboxPath, JSON.stringify([initialInboxItem], null, 2), 'utf8');
      seedCatalog();
      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'm1' }], has_more: true }), { status: 200 }),
        nowMs: nowMs + 4000,
        mode: 'propose',
      });
      inboxAfter = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inboxAfter).toEqual([initialInboxItem]);

      // 5. Redirect blocked (TRANSIENT)
      fs.writeFileSync(inboxPath, JSON.stringify([initialInboxItem], null, 2), 'utf8');
      seedCatalog();
      await runTickCommand({
        stateDir: tmpDir,
        fetchFn: async () => new Response(null, { status: 301, headers: { location: 'https://external-blocked.example.com' } }),
        nowMs: nowMs + 5000,
        mode: 'propose',
      });
      inboxAfter = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inboxAfter).toEqual([initialInboxItem]);
    });
  });
});
