/**
 * packages/cli/src/commands/agents.ts
 *
 * Implements agent model discovery, dry-run diffing, atomic backup, apply,
 * readback verification, and rollback for Hermes Agent and DeepSeek Harness (DSH).
 * Supports CLI options including --agent and --provider for targeted updates.
 * Zero-token agent configuration management (Rule §28.1, AGENT-WRITE-01).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { parse as parseYaml } from 'yaml';
import {
  getGrantFilePath,
  validateGrantFile,
  checkGrantScope,
  resolveGrantSecret,
  ApplyGrant,
} from '../maintain/grant.js';

export type SupportedAgent = 'hermes' | 'dsh';
export const SUPPORTED_AGENTS: SupportedAgent[] = ['hermes', 'dsh'];

export interface AgentDiscoveryResult {
  agent: SupportedAgent;
  path: string;
  format: 'yaml' | 'json';
  verified: boolean;
  exists: boolean;
}

export interface AgentDryRunResult {
  agent: SupportedAgent;
  provider: string;
  wouldAdd: number;
  wouldRemove: number;
  otherLinesChanged: number;
  updatedContent: string;
  originalContent: string;
  configPath: string;
}

export interface AgentApplyResult {
  agent: SupportedAgent;
  provider: string;
  added: number;
  removed: number;
  backupPath: string;
  shaBefore: string;
  shaAfter: string;
  configPath: string;
  originalContent: string;
}

export interface AgentReadbackResult {
  agent: SupportedAgent;
  parseOk: boolean;
}

export interface AgentRollbackResult {
  agent: SupportedAgent;
  shaEqualsBefore: boolean;
}

export interface AgentsCliOptions {
  agent?: string | undefined;
  provider?: string | undefined;
  models?: string | undefined;
  home?: string | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
  grant?: string | undefined;
  backup?: string | undefined;
  dryRun?: boolean | undefined;
  apply?: boolean | undefined;
  rollback?: boolean | undefined;
  roundtrip?: boolean | undefined;
  json?: boolean | undefined;
}

/**
 * Computes 16-character hex hash of content string.
 */
export function hash16(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Resolves standard configuration file path for given agent harness.
 */
export function getAgentConfigPath(agent: SupportedAgent, customHome?: string): string {
  const home = customHome || process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
  if (agent === 'hermes') {
    const yamlPath = path.join(home, '.hermes', 'config.yaml');
    if (fs.existsSync(yamlPath)) return yamlPath;
    const jsonPath = path.join(home, '.hermes', 'mcp_config.json');
    if (fs.existsSync(jsonPath)) return jsonPath;
    return yamlPath;
  }
  if (agent === 'dsh') {
    const profilePath = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    if (fs.existsSync(profilePath)) return profilePath;
    const fallbackPath = path.join(home, '.dsh', 'cordis.patch.yml');
    if (fs.existsSync(fallbackPath)) return fallbackPath;
    return profilePath;
  }
  throw new Error(`Unsupported agent harness: ${agent}`);
}

/**
 * Discovers and validates configuration file for given agent.
 */
export function discoverAgentConfig(agent: SupportedAgent, customHome?: string): AgentDiscoveryResult {
  const configPath = getAgentConfigPath(agent, customHome);
  const exists = fs.existsSync(configPath);
  let verified = false;
  const ext = path.extname(configPath).toLowerCase();
  const format: 'yaml' | 'json' = ext === '.json' ? 'json' : 'yaml';

  if (exists) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      if (format === 'yaml') {
        const parsed = parseYaml(raw);
        verified = typeof parsed === 'object' && parsed !== null;
      } else {
        const parsed = JSON.parse(raw);
        verified = typeof parsed === 'object' && parsed !== null;
      }
    } catch {
      verified = false;
    }
  }

  return { agent, path: configPath, format, verified, exists };
}

/**
 * Checks whether a line belongs to model definition block in YAML.
 */
export function isModelRelatedLine(line: string): boolean {
  return /^\s*(- id:|- name:|name:|id:|models:|contextWindow:|maxTokens:|input:|reasoningEfforts:|- text|- image|off:|low:|medium:|high:|xhigh:|max:)/.test(
    line
  );
}

/**
 * Counts lines modified outside model definition blocks.
 */
export function countOtherLinesChanged(original: string, updated: string): number {
  const origLines = original.split(/\r?\n/);
  const updatedLines = updated.split(/\r?\n/);

  let oi = 0;
  let ui = 0;
  let other = 0;

  while (oi < origLines.length && ui < updatedLines.length) {
    if (origLines[oi] === updatedLines[ui]) {
      oi++;
      ui++;
    } else {
      let foundMatchInUpdated = -1;
      for (let k = ui + 1; k < Math.min(ui + 30, updatedLines.length); k++) {
        if (updatedLines[k] === origLines[oi]) {
          foundMatchInUpdated = k;
          break;
        }
      }

      if (foundMatchInUpdated !== -1) {
        for (let j = ui; j < foundMatchInUpdated; j++) {
          if (!isModelRelatedLine(updatedLines[j] ?? '')) {
            other++;
          }
        }
        ui = foundMatchInUpdated;
      } else {
        let foundMatchInOrig = -1;
        for (let k = oi + 1; k < Math.min(oi + 30, origLines.length); k++) {
          if (origLines[k] === updatedLines[ui]) {
            foundMatchInOrig = k;
            break;
          }
        }
        if (foundMatchInOrig !== -1) {
          for (let j = oi; j < foundMatchInOrig; j++) {
            if (!isModelRelatedLine(origLines[j] ?? '')) {
              other++;
            }
          }
          oi = foundMatchInOrig;
        } else {
          other++;
          oi++;
          ui++;
        }
      }
    }
  }

  while (oi < origLines.length) {
    const l = origLines[oi];
    if (l !== undefined && l.trim() !== '' && !isModelRelatedLine(l)) other++;
    oi++;
  }
  while (ui < updatedLines.length) {
    const l = updatedLines[ui];
    if (l !== undefined && l.trim() !== '' && !isModelRelatedLine(l)) other++;
    ui++;
  }

  return other;
}

/**
 * Builds updated file content for Hermes Agent config.yaml with model entries.
 */
export function buildHermesModelContent(
  originalContent: string,
  modelIds: string[]
): { updatedContent: string; wouldAdd: number; wouldRemove: number } {
  const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
  const existingMatches = new Set(
    [...originalContent.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
  );

  const toAdd = modelIds.filter((id) => !existingMatches.has(id));
  if (toAdd.length === 0) {
    return { updatedContent: originalContent, wouldAdd: 0, wouldRemove: 0 };
  }

  // Check if `models:` key already exists under `model:`
  const hasModelsKey = /^\s*models:\r?$/m.test(originalContent);
  let updatedContent = originalContent;

  if (hasModelsKey) {
    const modelEntries = toAdd
      .map((id) => `    - id: ${id}${eol}      name: ${id}`)
      .join(eol) + eol;
    updatedContent = originalContent.replace(
      /^(\s*models:\r?\n)/m,
      `$1${modelEntries}`
    );
  } else {
    const modelBlock =
      `  models:${eol}` +
      toAdd.map((id) => `    - id: ${id}${eol}      name: ${id}`).join(eol) +
      eol;
    updatedContent = originalContent.replace(
      /^(model:\r?\n)/m,
      `$1${modelBlock}`
    );
  }

  return {
    updatedContent,
    wouldAdd: toAdd.length,
    wouldRemove: 0,
  };
}

/**
 * Builds updated file content for DSH cordis.patch.yml under nine-router provider.
 */
export function buildDshModelContent(
  originalContent: string,
  modelIds: string[],
  providerName = 'nine-router'
): { updatedContent: string; wouldAdd: number; wouldRemove: number } {
  const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';

  // Find provider block
  const providerPattern = new RegExp(`(${providerName}:[\\s\\S]*?models:\\r?\\n)`);
  if (!providerPattern.test(originalContent)) {
    // If exact provider name not found, try fallback '9router'
    if (providerName !== '9router' && originalContent.includes('9router:')) {
      return buildDshModelContent(originalContent, modelIds, '9router');
    }
  }

  const existingMatches = new Set(
    [...originalContent.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
  );
  const toAdd = modelIds.filter((id) => !existingMatches.has(id));
  if (toAdd.length === 0) {
    return { updatedContent: originalContent, wouldAdd: 0, wouldRemove: 0 };
  }

  const entries = toAdd
    .map((id) => `          - id: ${id}${eol}            name: ${id}`)
    .join(eol) + eol;

  let updatedContent = originalContent;
  if (providerPattern.test(originalContent)) {
    updatedContent = originalContent.replace(
      providerPattern,
      `$1${entries}`
    );
  } else if (/(\s*models:\r?\n)/.test(originalContent)) {
    updatedContent = originalContent.replace(
      /(\s*models:\r?\n)/,
      `$1${entries}`
    );
  }

  return {
    updatedContent,
    wouldAdd: toAdd.length,
    wouldRemove: 0,
  };
}

/**
 * Performs dry-run calculation on target agent configuration file.
 */
export function dryRunAgentModelUpdate(
  agent: SupportedAgent,
  options: {
    customHome?: string | undefined;
    configPath?: string | undefined;
    provider?: string | undefined;
    models?: string[] | undefined;
  } = {}
): AgentDryRunResult {
  const targetPath = options.configPath || getAgentConfigPath(agent, options.customHome);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Config file for agent '${agent}' not found at: ${targetPath}`);
  }

  const originalContent = fs.readFileSync(targetPath, 'utf8');
  const modelIds = options.models && options.models.length > 0 ? options.models : ['test-3'];

  let updatedContent = originalContent;
  let wouldAdd = 0;
  let wouldRemove = 0;
  let provider = options.provider;

  if (agent === 'hermes') {
    provider = provider || '9router';
    const res = buildHermesModelContent(originalContent, modelIds);
    updatedContent = res.updatedContent;
    wouldAdd = res.wouldAdd;
    wouldRemove = res.wouldRemove;
  } else {
    provider = provider || 'nine-router';
    const res = buildDshModelContent(originalContent, modelIds, provider);
    updatedContent = res.updatedContent;
    wouldAdd = res.wouldAdd;
    wouldRemove = res.wouldRemove;
  }

  const otherLinesChanged = countOtherLinesChanged(originalContent, updatedContent);

  return {
    agent,
    provider,
    wouldAdd,
    wouldRemove,
    otherLinesChanged,
    updatedContent,
    originalContent,
    configPath: targetPath,
  };
}

/**
 * Checks authorization to modify agent configuration files.
 */
export function checkAgentWriteAuthorization(options: {
  agent: SupportedAgent;
  stateDir?: string | undefined;
  grantId?: string | undefined;
  allowTestBypass?: boolean | undefined;
}): { authorized: boolean; reason?: string; grant?: ApplyGrant } {
  // L3(b): env alone never authorizes production. Bypass needs injected flag.
  const isTestBypass =
    options.allowTestBypass === true &&
    process.env.VITEST === 'true' &&
    process.env['ROUTERSYNC_TEST_CONFIRM'] === '1' &&
    process.env['ROUTERSYNC_TEST_FAST'] === '1';

  if (isTestBypass) {
    return { authorized: true };
  }

  const grantPath = getGrantFilePath(options.stateDir);
  if (fs.existsSync(grantPath)) {
    // S0: same real-key gate as maintain apply.
    const grantSecret = resolveGrantSecret();
    const grantCheck = validateGrantFile(grantPath, grantSecret);
    if (!grantCheck.valid) {
      return { authorized: false, reason: grantCheck.reason };
    }
    if (options.grantId && grantCheck.grant.id !== options.grantId) {
      return { authorized: false, reason: 'grant-invalid' };
    }
    const scopeCheck = checkGrantScope(grantCheck.grant, [], [options.agent]);
    if (scopeCheck.valid) {
      return { authorized: true, grant: grantCheck.grant };
    }
    return { authorized: false, reason: 'grant-scope' };
  }

  // C3t T0e: TTY alone never authorizes. Without a grant, a TTY caller must
  // still type `chay`; the sync gate reports confirm-required and the caller
  // prompts. A bare PTY (IDE terminal) cannot pass silently.
  if (process.stdin.isTTY) {
    return { authorized: false, reason: 'confirm-required' };
  }

  return { authorized: false, reason: 'no-tty' };
}

/**
 * Applies model configuration to target agent with backup and hash tracking.
 */
export async function applyAgentModelUpdate(
  agent: SupportedAgent,
  options: {
    customHome?: string | undefined;
    configPath?: string | undefined;
    provider?: string | undefined;
    models?: string[] | undefined;
    stateDir?: string | undefined;
    grantId?: string | undefined;
    /** Injectable prompt for flow tests; defaults to readline TTY prompt. */
    promptFn?: ((question: string) => Promise<string>) | undefined;
  } = {}
): Promise<AgentApplyResult> {
  const auth = checkAgentWriteAuthorization({
    agent,
    stateDir: options.stateDir,
    grantId: options.grantId,
  });

  if (!auth.authorized && auth.reason === 'confirm-required') {
    // C3t T0e: TTY write without grant needs the typed word `chay`
    // (same prompt as maintain promptForConfirmation).
    const question = `Xác nhận ghi cấu hình agent '${agent}'? Nhập 'chay' để tiếp tục: `;
    const word = options.promptFn
      ? await options.promptFn(question)
      : await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(question, (a) => {
            rl.close();
            resolve(a.trim());
          });
        });
    if (word !== 'chay') {
      console.error(`AGENT-REFUSED reason=confirm-aborted`);
      throw new Error(`Write not authorized for agent '${agent}': confirm-required`);
    }
    auth.authorized = true;
  }

  if (!auth.authorized) {
    console.error(`AGENT-REFUSED reason=${auth.reason || 'no-tty'}`);
    throw new Error(`Write not authorized for agent '${agent}': ${auth.reason}`);
  }

  const dryResult = dryRunAgentModelUpdate(agent, options);
  const targetPath = dryResult.configPath;
  const originalContent = dryResult.originalContent;
  const updatedContent = dryResult.updatedContent;

  const shaBefore = hash16(originalContent);
  const shaAfter = hash16(updatedContent);

  if (shaBefore === shaAfter) {
    throw new Error(`Agent '${agent}' configuration update produced identical content (no-op).`);
  }

  // Create atomic backup alongside configuration
  const backupDir = path.dirname(targetPath);
  const randSuffix = crypto.randomBytes(4).toString('hex');
  const backupFileName = `${path.basename(targetPath)}.bak.${Date.now()}.${randSuffix}`;
  const backupPath = path.join(backupDir, backupFileName);

  fs.writeFileSync(backupPath, originalContent, 'utf8');
  fs.writeFileSync(targetPath, updatedContent, 'utf8');

  return {
    agent,
    provider: dryResult.provider,
    added: dryResult.wouldAdd,
    removed: dryResult.wouldRemove,
    backupPath,
    shaBefore,
    shaAfter,
    configPath: targetPath,
    originalContent,
  };
}

/**
 * Verifies that written agent configuration parses validly.
 */
export function readbackAgentConfig(
  agent: SupportedAgent,
  configPath: string
): AgentReadbackResult {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const ext = path.extname(configPath).toLowerCase();
    if (ext === '.json') {
      const parsed = JSON.parse(raw);
      return { agent, parseOk: typeof parsed === 'object' && parsed !== null };
    }
    const parsed = parseYaml(raw);
    return { agent, parseOk: typeof parsed === 'object' && parsed !== null };
  } catch {
    return { agent, parseOk: false };
  }
}

/**
 * Restores original content from backup or memory string.
 */
export function rollbackAgentModelUpdate(
  agent: SupportedAgent,
  options: {
    configPath: string;
    backupPath?: string | undefined;
    originalContent?: string | undefined;
  }
): AgentRollbackResult {
  let contentToRestore = options.originalContent;
  if (!contentToRestore && options.backupPath && fs.existsSync(options.backupPath)) {
    contentToRestore = fs.readFileSync(options.backupPath, 'utf8');
  }

  if (!contentToRestore) {
    throw new Error(`Cannot rollback agent '${agent}': backup content missing.`);
  }

  const shaBefore = hash16(contentToRestore);
  fs.writeFileSync(options.configPath, contentToRestore, 'utf8');

  const restored = fs.readFileSync(options.configPath, 'utf8');
  const shaRestored = hash16(restored);
  const shaEqualsBefore = shaRestored === shaBefore;

  if (options.backupPath && fs.existsSync(options.backupPath)) {
    try {
      fs.unlinkSync(options.backupPath);
    } catch {
      // ignore unlink failure
    }
  }

  return { agent, shaEqualsBefore };
}

/**
 * Handler for `routersync agents discover` CLI command.
 */
export async function runAgentsDiscoverCommand(options: AgentsCliOptions): Promise<void> {
  const agents: SupportedAgent[] = options.agent && options.agent !== 'all'
    ? (options.agent.split(',').map((s) => s.trim()) as SupportedAgent[])
    : SUPPORTED_AGENTS;

  const results: AgentDiscoveryResult[] = [];
  for (const a of agents) {
    if (!SUPPORTED_AGENTS.includes(a)) continue;
    const res = discoverAgentConfig(a, options.home);
    results.push(res);
    console.log(
      `AGENT-CONFIG agent=${res.agent} path=${res.path} format=${res.format} verified=${res.verified ? 'yes' : 'no'}`
    );
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

/**
 * Handler for `routersync agents dry-run` CLI command.
 */
export async function runAgentsDryRunCommand(options: AgentsCliOptions): Promise<void> {
  const agents: SupportedAgent[] = options.agent && options.agent !== 'all'
    ? (options.agent.split(',').map((s) => s.trim()) as SupportedAgent[])
    : SUPPORTED_AGENTS;

  const modelList = options.models ? options.models.split(',').map((s) => s.trim()) : ['test-3'];
  const results: AgentDryRunResult[] = [];

  for (const a of agents) {
    if (!SUPPORTED_AGENTS.includes(a)) continue;
    const res = dryRunAgentModelUpdate(a, {
      customHome: options.home,
      configPath: options.configPath,
      provider: options.provider,
      models: modelList,
    });
    results.push(res);
    console.log(
      `AGENT-DRYRUN agent=${res.agent} provider=${res.provider} would_add=${res.wouldAdd} would_remove=${res.wouldRemove} other_lines_changed=${res.otherLinesChanged}`
    );
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

/**
 * Handler for `routersync agents apply` CLI command.
 */
export async function runAgentsApplyCommand(options: AgentsCliOptions): Promise<void> {
  const agents: SupportedAgent[] = options.agent && options.agent !== 'all'
    ? (options.agent.split(',').map((s) => s.trim()) as SupportedAgent[])
    : SUPPORTED_AGENTS;

  const modelList = options.models ? options.models.split(',').map((s) => s.trim()) : ['test-3'];

  for (const a of agents) {
    if (!SUPPORTED_AGENTS.includes(a)) continue;
    const applyRes = await applyAgentModelUpdate(a, {
      customHome: options.home,
      configPath: options.configPath,
      provider: options.provider,
      models: modelList,
      stateDir: options.stateDir,
      grantId: options.grant,
    });

    console.log(
      `AGENT-APPLY agent=${applyRes.agent} provider=${applyRes.provider} added=${applyRes.added} removed=${applyRes.removed} backup=${applyRes.backupPath} sha_before=${applyRes.shaBefore} sha_after=${applyRes.shaAfter}`
    );

    const readRes = readbackAgentConfig(a, applyRes.configPath);
    console.log(`AGENT-READBACK agent=${readRes.agent} parse_ok=${readRes.parseOk ? 'yes' : 'no'}`);
  }
}

/**
 * Handler for `routersync agents rollback` CLI command.
 */
export async function runAgentsRollbackCommand(options: AgentsCliOptions): Promise<void> {
  const agents: SupportedAgent[] = options.agent && options.agent !== 'all'
    ? (options.agent.split(',').map((s) => s.trim()) as SupportedAgent[])
    : SUPPORTED_AGENTS;

  for (const a of agents) {
    if (!SUPPORTED_AGENTS.includes(a)) continue;
    const configPath = options.configPath || getAgentConfigPath(a, options.home);
    const rbRes = rollbackAgentModelUpdate(a, {
      configPath,
      backupPath: options.backup,
    });
    console.log(`AGENT-ROLLBACK agent=${rbRes.agent} sha_equals_before=${rbRes.shaEqualsBefore ? 'yes' : 'no'}`);
  }
}

/**
 * Handler for unified `routersync agents update` CLI command.
 * Supports --dry-run, --apply, --rollback, and --roundtrip.
 */
export async function runAgentsUpdateCommand(options: AgentsCliOptions): Promise<void> {
  if (options.dryRun) {
    await runAgentsDryRunCommand(options);
    return;
  }

  const agents: SupportedAgent[] = options.agent && options.agent !== 'all'
    ? (options.agent.split(',').map((s) => s.trim()) as SupportedAgent[])
    : SUPPORTED_AGENTS;

  const modelList = options.models ? options.models.split(',').map((s) => s.trim()) : ['test-3'];

  // If roundtrip requested (or default if no explicit flag specified)
  const isRoundtrip = options.roundtrip || (!options.apply && !options.rollback);

  if (isRoundtrip) {
    for (const a of agents) {
      if (!SUPPORTED_AGENTS.includes(a)) continue;
      try {
        const applyRes = await applyAgentModelUpdate(a, {
          customHome: options.home,
          configPath: options.configPath,
          provider: options.provider,
          models: modelList,
          stateDir: options.stateDir,
          grantId: options.grant,
        });

        console.log(
          `AGENT-APPLY agent=${applyRes.agent} provider=${applyRes.provider} added=${applyRes.added} removed=${applyRes.removed} backup=${applyRes.backupPath} sha_before=${applyRes.shaBefore} sha_after=${applyRes.shaAfter}`
        );

        const readRes = readbackAgentConfig(a, applyRes.configPath);
        console.log(`AGENT-READBACK agent=${readRes.agent} parse_ok=${readRes.parseOk ? 'yes' : 'no'}`);

        const rollbackRes = rollbackAgentModelUpdate(a, {
          configPath: applyRes.configPath,
          backupPath: applyRes.backupPath,
          originalContent: applyRes.originalContent,
        });
        console.log(
          `AGENT-ROLLBACK agent=${rollbackRes.agent} sha_equals_before=${rollbackRes.shaEqualsBefore ? 'yes' : 'no'}`
        );

        // Re-apply to reach final applied state and verify equality
        const finalApplyRes = await applyAgentModelUpdate(a, {
          customHome: options.home,
          configPath: options.configPath,
          provider: options.provider,
          models: modelList,
          stateDir: options.stateDir,
          grantId: options.grant,
        });
        const equalsApplied = finalApplyRes.shaAfter === applyRes.shaAfter ? 'yes' : 'no';
        console.log(
          `AGENT-FINAL agent=${finalApplyRes.agent} provider=${finalApplyRes.provider} sha=${finalApplyRes.shaAfter} equals_applied=${equalsApplied}`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`AGENT-SKIPPED agent=${a} reason=${msg}`);
      }
    }
    return;
  }

  if (options.apply) {
    await runAgentsApplyCommand(options);
    return;
  }

  if (options.rollback) {
    await runAgentsRollbackCommand(options);
  }
}
