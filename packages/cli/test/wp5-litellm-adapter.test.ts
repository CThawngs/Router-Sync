/**
 * packages/cli/test/wp5-litellm-adapter.test.ts
 *
 * C45 WP5 Red-First Test Suite — Lossless LiteLLM YAML CST Config Adapter,
 * Secret Safety Guard, Sandbox & Symlink/Junction Guard, Atomic Backup/Read-Back/Auto-Rollback,
 * and CLI `routersync litellm` Subcommands (Phục vụ: S4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inspectLiteLLMConfig,
  planLiteLLMConfigSync,
  applyLiteLLMConfigSync,
  rollbackLiteLLMConfig,
  LiteLLMAdapterError,
} from '../src/litellm/index.js';
import { runLiteLLMCommand } from '../src/commands/litellm.js';

const REALISTIC_LITELLM_YAML = [
  '# Top-level operator header comment — DO NOT STRIP',
  'model_list:',
  '  # Unmanaged local embedding deployment (must stay byte-identical)',
  '  - model_name: internal-embed',
  '    litellm_params:',
  '      model: openai/text-embedding-3-small',
  '      api_key: os.environ/OPENAI_API_KEY # inline key comment',
  '      api_base: https://api.openai.example.com/v1',
  '',
  '  # Multi-key Groq credential pool (must stay byte-identical)',
  '  - model_name: groq-pool',
  '    litellm_params:',
  '      model: groq/llama-3.3-70b-versatile',
  '      api_key: os.environ/GROQ_API_KEY_1',
  '  - model_name: groq-pool',
  '    litellm_params:',
  '      model: groq/llama-3.3-70b-versatile',
  '      api_key: os.environ/GROQ_API_KEY_2',
  '',
  '  # Managed RouterSync primary alias',
  '  - model_name: routersync-coding',
  '    litellm_params:',
  '      model: anthropic/claude-3-5-sonnet-old',
  '      api_key: os.environ/ANTHROPIC_API_KEY',
  '      api_base: https://gateway.anthropic.example.com/v1',
  '',
  '# Router failover & pool settings comment',
  'router_settings:',
  '  routing_strategy: simple-shuffle # keep shuffle for multi-key pools',
  '  num_retries: 2',
  '  fallbacks:',
  '    - keep-other-combo: ["groq-pool"]',
  '    - routersync-coding: ["groq-pool"]',
  '  context_window_fallbacks:',
  '    - keep-other-combo: ["groq-pool"]',
  '',
  '# Master key & telemetry settings — NEVER CLOBBER',
  'general_settings:',
  '  master_key: os.environ/LITELLM_MASTER_KEY',
  '  database_url: os.environ/DATABASE_URL',
  '',
  'litellm_settings:',
  '  drop_params: true # keep drop_params comment',
  '  set_verbose: false',
  '',
].join('\n');

describe('C45 WP5 — Lossless LiteLLM YAML CST Adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp56-litellm-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inspects multi-key pools and env references strictly read-only without reading actual env secrets', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, REALISTIC_LITELLM_YAML, 'utf8');

    const inspected = inspectLiteLLMConfig(configPath);
    expect(inspected.deployments).toHaveLength(4);
    expect(inspected.credentialPools).toEqual([
      {
        modelName: 'groq-pool',
        deploymentCount: 2,
        keyRefs: ['os.environ/GROQ_API_KEY_1', 'os.environ/GROQ_API_KEY_2'],
      },
    ]);
    expect(inspected.routerSettings.routingStrategy).toBe('simple-shuffle');
    expect(inspected.hasGeneralSettings).toBe(true);
    expect(inspected.hasLitellmSettings).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual(['config.yaml']);
  });

  it('preserves comments, unmanaged model_list entries, os.environ refs, api_base, general_settings & litellm_settings byte-for-byte + I4 idempotency', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, REALISTIC_LITELLM_YAML, 'utf8');

    const plan1 = planLiteLLMConfigSync({
      configPath,
      comboAlias: 'routersync-coding',
      steps: [
        {
          step: 'anthropic/claude-sonnet-4-5',
          apiKeyRef: 'os.environ/ANTHROPIC_API_KEY',
        },
        {
          step: 'groq/llama-3.3-70b-versatile',
          apiKeyRef: 'os.environ/GROQ_API_KEY_1',
        },
        {
          step: 'gemini/gemini-2.5-pro',
          apiKeyRef: 'os.environ/GEMINI_API_KEY',
        },
      ],
    });

    expect(plan1.changed).toBe(true);

    // Every comment and unmanaged block must remain byte-for-byte present
    expect(plan1.plannedYaml).toContain('# Top-level operator header comment — DO NOT STRIP');
    expect(plan1.plannedYaml).toContain('# Unmanaged local embedding deployment (must stay byte-identical)');
    expect(plan1.plannedYaml).toContain('api_key: os.environ/OPENAI_API_KEY # inline key comment');
    expect(plan1.plannedYaml).toContain('# Multi-key Groq credential pool (must stay byte-identical)');
    expect(plan1.plannedYaml).toContain('# Master key & telemetry settings — NEVER CLOBBER');
    expect(plan1.plannedYaml).toContain('master_key: os.environ/LITELLM_MASTER_KEY');
    expect(plan1.plannedYaml).toContain('drop_params: true # keep drop_params comment');
    expect(plan1.plannedYaml).toContain('- keep-other-combo: ["groq-pool"]');
    // Preserves existing api_base on primary managed entry when not overridden
    expect(plan1.plannedYaml).toContain('api_base: https://gateway.anthropic.example.com/v1');

    // Apply to sandbox file and verify I4 idempotency on second plan
    const applyRes = applyLiteLLMConfigSync({
      configPath,
      comboAlias: 'routersync-coding',
      steps: [
        { step: 'anthropic/claude-sonnet-4-5', apiKeyRef: 'os.environ/ANTHROPIC_API_KEY' },
        { step: 'groq/llama-3.3-70b-versatile', apiKeyRef: 'os.environ/GROQ_API_KEY_1' },
        { step: 'gemini/gemini-2.5-pro', apiKeyRef: 'os.environ/GEMINI_API_KEY' },
      ],
      expectedPlanHash: plan1.planHash,
    });
    expect(applyRes.applied).toBe(true);
    expect(applyRes.rolledBack).toBe(false);
    expect(fs.existsSync(`${configPath}.routersync.bak`)).toBe(true);

    const plan2 = planLiteLLMConfigSync({
      configPath,
      comboAlias: 'routersync-coding',
      steps: [
        { step: 'anthropic/claude-sonnet-4-5', apiKeyRef: 'os.environ/ANTHROPIC_API_KEY' },
        { step: 'groq/llama-3.3-70b-versatile', apiKeyRef: 'os.environ/GROQ_API_KEY_1' },
        { step: 'gemini/gemini-2.5-pro', apiKeyRef: 'os.environ/GEMINI_API_KEY' },
      ],
    });
    expect(plan2.changed).toBe(false);
    expect(plan2.plannedYaml).toBe(fs.readFileSync(configPath, 'utf8'));
  });

  it('rejects any plaintext API key literal with LITELLM_PLAINTEXT_SECRET_FORBIDDEN before touching disk', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, REALISTIC_LITELLM_YAML, 'utf8');
    const beforeBytes = fs.readFileSync(configPath);
    const forbiddenKey = ['sk', 'live', 'plaintext1234567890abcdef'].join('-');

    expect(() =>
      planLiteLLMConfigSync({
        configPath,
        comboAlias: 'routersync-coding',
        steps: [
          { step: 'openai/gpt-4o', apiKeyRef: forbiddenKey },
          { step: 'groq/llama-3.3-70b-versatile', apiKeyRef: 'os.environ/GROQ_API_KEY_1' },
        ],
      })
    ).toThrowError(LiteLLMAdapterError);

    try {
      applyLiteLLMConfigSync({
        configPath,
        comboAlias: 'routersync-coding',
        steps: [
          { step: 'openai/gpt-4o', apiKeyRef: forbiddenKey },
          { step: 'groq/llama-3.3-70b-versatile', apiKeyRef: 'os.environ/GROQ_API_KEY_1' },
        ],
      });
      expect.unreachable('Should have rejected plaintext key');
    } catch (err) {
      expect(err).toBeInstanceOf(LiteLLMAdapterError);
      expect((err as LiteLLMAdapterError).code).toBe('LITELLM_PLAINTEXT_SECRET_FORBIDDEN');
    }

    expect(Buffer.compare(fs.readFileSync(configPath), beforeBytes)).toBe(0);
    expect(fs.existsSync(`${configPath}.routersync.bak`)).toBe(false);
  });

  it('rejects direct paths, directory junctions/symlinks escaping os.tmpdir(), backup escapes, and bots.json/routines.json with HARNESS_WRITE_OUTSIDE_SANDBOX', () => {
    const fsRoot = path.parse(fs.realpathSync.native(os.tmpdir())).root;
    const outsidePath = path.join(fsRoot, 'routersync-unsafe-litellm-outside-tmpdir.yaml');

    const validSteps = [
      { step: 'openai/gpt-4o', apiKeyRef: 'os.environ/OPENAI_API_KEY' },
      { step: 'groq/llama-3.3-70b-versatile', apiKeyRef: 'os.environ/GROQ_API_KEY_1' },
    ];

    // 1. Direct path outside os.tmpdir() (immune to cwd/homedir inside os.tmpdir())
    try {
      applyLiteLLMConfigSync({
        configPath: outsidePath,
        comboAlias: 'routersync-coding',
        steps: validSteps,
      });
      expect.unreachable('Should have blocked direct path outside os.tmpdir()');
    } catch (err) {
      expect(err).toBeInstanceOf(LiteLLMAdapterError);
      expect((err as LiteLLMAdapterError).code).toBe('HARNESS_WRITE_OUTSIDE_SANDBOX');
    }
    expect(fs.existsSync(outsidePath)).toBe(false);

    // 2. Directory junction / symlink inside os.tmpdir() escaping to fsRoot (both configPath and backupPath)
    const escapeLinkDir = path.join(tmpDir, 'escape-link');
    let linkCreated = false;
    try {
      fs.symlinkSync(fsRoot, escapeLinkDir, process.platform === 'win32' ? 'junction' : 'dir');
      linkCreated = true;
    } catch {
      linkCreated = false;
    }

    if (linkCreated) {
      const escapedTarget = path.join(escapeLinkDir, 'routersync-escaped-litellm-do-not-write.yaml');
      try {
        applyLiteLLMConfigSync({
          configPath: escapedTarget,
          comboAlias: 'routersync-coding',
          steps: validSteps,
        });
        expect.unreachable('Should have blocked symlink/junction target escaping os.tmpdir()');
      } catch (err) {
        expect(err).toBeInstanceOf(LiteLLMAdapterError);
        expect((err as LiteLLMAdapterError).code).toBe('HARNESS_WRITE_OUTSIDE_SANDBOX');
      }
      expect(fs.existsSync(escapedTarget)).toBe(false);

      const safeConfig = path.join(tmpDir, 'safe-config.yaml');
      fs.writeFileSync(safeConfig, REALISTIC_LITELLM_YAML, 'utf8');
      const escapedBackup = path.join(escapeLinkDir, 'routersync-escaped-litellm.bak');
      try {
        applyLiteLLMConfigSync({
          configPath: safeConfig,
          backupPath: escapedBackup,
          comboAlias: 'routersync-coding',
          steps: validSteps,
        });
        expect.unreachable('Should have blocked symlink/junction backupPath escaping os.tmpdir()');
      } catch (err) {
        expect(err).toBeInstanceOf(LiteLLMAdapterError);
        expect((err as LiteLLMAdapterError).code).toBe('HARNESS_WRITE_OUTSIDE_SANDBOX');
      }
      expect(fs.existsSync(escapedBackup)).toBe(false);
    }

    // 3. Unconditional refusal on OpenMausBot runtime-owned bots.json & routines.json even inside tmpDir
    for (const forbiddenName of ['bots.json', 'routines.json']) {
      const forbiddenPath = path.join(tmpDir, forbiddenName);
      try {
        applyLiteLLMConfigSync({
          configPath: forbiddenPath,
          comboAlias: 'routersync-coding',
          steps: validSteps,
        });
        expect.unreachable(`Should have blocked ${forbiddenName}`);
      } catch (err) {
        expect(err).toBeInstanceOf(LiteLLMAdapterError);
        expect((err as LiteLLMAdapterError).code).toBe('HARNESS_WRITE_OUTSIDE_SANDBOX');
      }
    }
  });

  it('restores config byte-for-byte from .routersync.bak on injectReadBackFault and supports manual rollback', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, REALISTIC_LITELLM_YAML, 'utf8');
    const originalBytes = fs.readFileSync(configPath);

    const faultRes = applyLiteLLMConfigSync({
      configPath,
      comboAlias: 'routersync-coding',
      steps: [
        { step: 'anthropic/claude-sonnet-4-5', apiKeyRef: 'os.environ/ANTHROPIC_API_KEY' },
        { step: 'gemini/gemini-2.5-pro', apiKeyRef: 'os.environ/GEMINI_API_KEY' },
      ],
      injectReadBackFault: true,
    });

    expect(faultRes.applied).toBe(false);
    expect(faultRes.rolledBack).toBe(true);
    expect(Buffer.compare(fs.readFileSync(configPath), originalBytes)).toBe(0);

    // Now apply cleanly, verify mutation, then rollback byte-for-byte via CLI command
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      runLiteLLMCommand({
        subcommand: 'apply',
        config: configPath,
        combo: 'routersync-coding',
        models: 'anthropic/claude-sonnet-4-5,gemini/gemini-2.5-pro',
        strategy: 'fallbacks',
        json: true,
      });
      const applyJson = JSON.parse(logs.pop()!) as { applied: boolean };
      expect(applyJson.applied).toBe(true);
      expect(fs.readFileSync(configPath, 'utf8')).toContain('claude-sonnet-4-5');

      runLiteLLMCommand({
        subcommand: 'rollback',
        config: configPath,
        json: true,
      });
      const rbJson = JSON.parse(logs.pop()!) as { rolledBack: boolean };
      expect(rbJson.rolledBack).toBe(true);
      expect(Buffer.compare(fs.readFileSync(configPath), originalBytes)).toBe(0);
    } finally {
      console.log = origLog;
    }

    // Direct API rollback check as well
    applyLiteLLMConfigSync({
      configPath,
      comboAlias: 'routersync-coding',
      steps: [
        { step: 'anthropic/claude-sonnet-4-5', apiKeyRef: 'os.environ/ANTHROPIC_API_KEY' },
        { step: 'gemini/gemini-2.5-pro', apiKeyRef: 'os.environ/GEMINI_API_KEY' },
      ],
    });
    const manualRb = rollbackLiteLLMConfig(configPath);
    expect(manualRb.rolledBack).toBe(true);
    expect(Buffer.compare(fs.readFileSync(configPath), originalBytes)).toBe(0);
  });
});
