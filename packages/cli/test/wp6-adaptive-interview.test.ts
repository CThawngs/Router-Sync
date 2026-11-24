/**
 * packages/cli/test/wp6-adaptive-interview.test.ts
 *
 * C45 WP6 Red-First CLI Test Suite — Additive ProfileSchema Expansion,
 * Backward-Compatible `'auto'` Rejection, Non-Destructive Sandbox `profile.yaml`
 * Persistence, and CLI `profile interview --adaptive` (Phục vụ: S5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateProfile } from '../src/profile/schema.js';
import {
  INTERVIEW_QUESTIONS,
  saveAdaptiveProfileYaml,
} from '../src/profile/interview.js';
import { runProfileCommand } from '../src/commands/profile.js';

describe('C45 WP6 CLI — ProfileSchema Additive Expansion & Sandbox Persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp6-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves INTERVIEW_QUESTIONS length 12 and rejects automationLevel="auto" while accepting off, auto-safe consentNote, long-context, and assumptions[]', () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(12);
    expect(() => validateProfile({ automationLevel: 'auto' })).toThrow();

    const offProfile = validateProfile({
      automationLevel: 'off',
      budget: 'paid',
      priority: ['long-context', 'speed'],
    });
    expect(offProfile.automationLevel).toBe('off');
    expect(offProfile.budget).toBe('paid');
    expect(offProfile.priority).toContain('context');
    expect(offProfile.harnesses).toEqual([]);
    expect(offProfile.routers).toEqual([]);
    expect(offProfile.keyedProviders).toEqual([]);

    const autoSafeProfile = validateProfile({
      automationLevel: 'auto-safe',
    });
    expect(autoSafeProfile.consentNote).toMatch(/propose.*verified read-back/i);
  });

  it('writes assumptions[] and non-destructive merge cleanly to sandbox profile.yaml via CLI profile interview --adaptive and blocks outside-tmpdir/runtime files', async () => {
    const profilePath = path.join(tmpDir, 'profile.yaml');

    // Step 1: initial vague user run in sandbox
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await runProfileCommand({
        subcommand: 'interview',
        adaptive: true,
        path: profilePath,
        answers: JSON.stringify({
          purpose: 'idk',
          harnesses: 'not sure',
          routers: 'not sure',
          keyedProviders: 'idk',
          budget: 'not sure',
          priority: 'idk',
          automationLevel: 'auto-safe',
          scanCycle: 'idk',
        }),
        write: true,
        json: true,
      });
    } finally {
      console.log = origLog;
    }

    const firstResult = JSON.parse(logs.pop()!) as {
      questionCountAsked: number;
      profile: {
        harnesses: string[];
        routers: string[];
        keyedProviders: string[];
        assumptions: Array<{ field: string }>;
        consentNote?: string;
      };
    };
    expect(firstResult.questionCountAsked).toBeLessThanOrEqual(12);
    expect(firstResult.profile.harnesses).toEqual([]);
    expect(firstResult.profile.routers).toEqual([]);
    expect(firstResult.profile.keyedProviders).toEqual([]);
    expect(firstResult.profile.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(firstResult.profile.consentNote).toMatch(/propose/i);

    // Step 2: seed existing favorites/allowList/denyList and run non-destructive merge
    saveAdaptiveProfileYaml(
      profilePath,
      {
        purpose: 'coding',
        harnesses: 'Hermes, OpenCode',
        routers: '9Router',
        keyedProviders: 'Gemini, Groq',
        favorites: 'gemini/gemini-2.5-pro',
        blockList: 'openai/gpt-4o-mini-tts',
      }
    );

    saveAdaptiveProfileYaml(
      profilePath,
      {
        scanCycle: 'weekly',
      },
      { mergeExisting: true }
    );

    const onDisk = parseYaml(fs.readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk['scanCycle']).toBe('weekly');
    expect(onDisk['harnesses']).toEqual(['hermes', 'opencode']);
    expect(onDisk['routers']).toEqual(['9router']);
    expect(onDisk['keyedProviders']).toEqual(['gemini', 'groq']);
    expect(onDisk['favorites']).toEqual(['gemini/gemini-2.5-pro']);
    expect(onDisk['denyList']).toEqual(['openai/gpt-4o-mini-tts']);

    // Step 3: block outside-tmpdir and bots.json/routines.json writes
    const fsRoot = path.parse(fs.realpathSync.native(os.tmpdir())).root;
    const outsideProfile = path.join(fsRoot, 'routersync-unsafe-profile-outside-tmpdir.yaml');
    expect(() => saveAdaptiveProfileYaml(outsideProfile, { purpose: 'coding' })).toThrow();
    expect(fs.existsSync(outsideProfile)).toBe(false);
    expect(() => saveAdaptiveProfileYaml(path.join(tmpDir, 'bots.json'), { purpose: 'coding' })).toThrow();
  });
});
