/**
 * packages/cli/src/litellm/adapter.ts
 *
 * C45 WP5 Lossless LiteLLM Config Write Adapter (Phục vụ: S4):
 *  1. Strict symlink/junction-safe `os.tmpdir()` sandbox enforcement (`HARNESS_WRITE_OUTSIDE_SANDBOX`)
 *     using `resolveDeepCanonicalPath` + `isPathInsideDir` unless
 *     `ROUTERSYNC_ALLOW_UNSAFE_LIVE_HARNESS_WRITE=1` is set in WP9.
 *  2. Unconditional refusal on OpenMausBot runtime-owned `bots.json` & `routines.json`.
 *  3. Atomic `.routersync.bak` backup -> atomic temp+rename write -> full CST/semantic
 *     read-back verification -> automatic byte-for-byte rollback on any mismatch or fault.
 *  4. Manual `rollbackLiteLLMConfig(configPath)` restoring byte-for-byte from `.routersync.bak`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { isPathInsideDir, resolveDeepCanonicalPath } from '@routersync/core';
import {
  assertHarnessWriteSandboxAllowed,
  assertOpenMausBotSafeFile,
  isInsideRealHomeOutsideSandbox,
} from '../apps/write-adapter.js';
import {
  inspectLiteLLMMyamlText,
  LiteLLMAdapterError,
  planLiteLLMConfigSync,
  type LiteLLMSyncPlanInput,
  type PlannedLiteLLMManagedDeployment,
} from './yaml-cst.js';

export interface LiteLLMSyncApplyInput extends LiteLLMSyncPlanInput {
  backupPath?: string | undefined;
  expectedPlanHash?: string | undefined;
  injectReadBackFault?: boolean | ((writtenText: string) => void) | undefined;
}

export interface LiteLLMSyncApplyResult {
  applied: boolean;
  changed: boolean;
  rolledBack: boolean;
  configPath: string;
  backupPath: string;
  planHash: string;
  preSha256: string;
  postSha256: string;
  managedDeployments: PlannedLiteLLMManagedDeployment[];
  fallbackTargets: string[];
  errorCode?: string | undefined;
  error?: string | undefined;
}

export interface LiteLLMRollbackResult {
  rolledBack: boolean;
  configPath: string;
  backupPath: string;
  restoredSha256: string;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function atomicWriteBytes(targetPath: string, payload: Buffer | string): void {
  const lstat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (lstat?.isSymbolicLink()) {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      `Refusing atomic write over symbolic link target: ${targetPath}`
    );
  }
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.routersync-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  assertLiteLLMWriteSandboxAllowed(tmpPath);
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Enforces C45 WP5 §3.2 sandbox isolation:
 *  - Always blocks OpenMausBot `bots.json` and `routines.json` (both lexical & symlink-resolved).
 *  - Rejects direct symbolic-link file targets to prevent link-replacement side effects.
 *  - Unless `ROUTERSYNC_ALLOW_UNSAFE_LIVE_HARNESS_WRITE === '1'` (WP9 owner gate),
 *    requires `resolveDeepCanonicalPath(targetPath)` to reside strictly inside
 *    `resolveDeepCanonicalPath(os.tmpdir())` (`isPathInsideDir`) and outside real `os.homedir()`.
 */
export function assertLiteLLMWriteSandboxAllowed(targetPath: string): void {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      'LiteLLM write target path is empty.'
    );
  }

  try {
    assertOpenMausBotSafeFile(targetPath);
  } catch (err) {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      err instanceof Error ? err.message : String(err)
    );
  }

  const deepTarget = resolveDeepCanonicalPath(targetPath);
  const deepBase = path.basename(deepTarget).toLowerCase();
  if (deepBase === 'bots.json' || deepBase === 'routines.json') {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      `Refusing to touch OpenMausBot runtime-owned file '${deepBase}'.`
    );
  }

  if (process.env['ROUTERSYNC_ALLOW_UNSAFE_LIVE_HARNESS_WRITE'] === '1') {
    return;
  }

  try {
    assertHarnessWriteSandboxAllowed(targetPath);
  } catch (err) {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      err instanceof Error ? err.message : String(err)
    );
  }

  const deepTmp = resolveDeepCanonicalPath(os.tmpdir());
  if (!isPathInsideDir(deepTarget, deepTmp) || isInsideRealHomeOutsideSandbox(targetPath)) {
    throw new LiteLLMAdapterError(
      'HARNESS_WRITE_OUTSIDE_SANDBOX',
      `Sandbox guard blocked LiteLLM config write outside os.tmpdir(): ${targetPath}`
    );
  }
}

function snapshotTopLevelSectionJson(rawYaml: string, key: string): string {
  const doc = parseDocument(rawYaml, { keepSourceTokens: true, logLevel: 'silent' });
  if (!isMap(doc.contents)) return 'null';
  const node = doc.contents.get(key, true);
  if (!node) return 'null';
  const toJsVal = typeof (node as { toJS?: (d: unknown) => unknown }).toJS === 'function'
    ? (node as { toJS: (d: unknown) => unknown }).toJS(doc)
    : node;
  return JSON.stringify(toJsVal);
}

export function applyLiteLLMConfigSync(input: LiteLLMSyncApplyInput): LiteLLMSyncApplyResult {
  // 1. Validate plaintext secret guard on input steps BEFORE checking filesystem or writing backup
  for (let i = 0; i < input.steps.length; i += 1) {
    const s = input.steps[i]!;
    if (typeof s !== 'string' && s.apiKeyRef !== undefined) {
      if (!/^(?:os\.environ\/[A-Z][A-Z0-9_]{1,127}|\$\{[A-Z][A-Z0-9_]{1,127}\})$/.test(s.apiKeyRef.trim())) {
        throw new LiteLLMAdapterError(
          'LITELLM_PLAINTEXT_SECRET_FORBIDDEN',
          `Plaintext api_key forbidden on step[${i}] (${s.step}).`
        );
      }
    }
  }

  // 2. Enforce strict os.tmpdir() & symlink/junction sandbox guard BEFORE touching disk
  const configPath = path.resolve(input.configPath);
  const backupPath = path.resolve(input.backupPath ?? `${configPath}.routersync.bak`);
  assertLiteLLMWriteSandboxAllowed(configPath);
  assertLiteLLMWriteSandboxAllowed(backupPath);

  if (!fs.existsSync(configPath)) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `LiteLLM config file does not exist: ${configPath}`
    );
  }

  const preBytes = fs.readFileSync(configPath);
  const preSha256 = sha256Hex(preBytes);
  const preText = preBytes.toString('utf8');
  const preInspected = inspectLiteLLMMyamlText(preText, configPath);
  const preGeneralJson = snapshotTopLevelSectionJson(preText, 'general_settings');
  const preLitellmJson = snapshotTopLevelSectionJson(preText, 'litellm_settings');

  const plan = planLiteLLMConfigSync({
    ...input,
    configPath,
    rawYaml: preText,
  });

  if (input.expectedPlanHash && input.expectedPlanHash !== plan.planHash) {
    throw new LiteLLMAdapterError(
      'LITELLM_PLAN_HASH_MISMATCH',
      `Plan hash mismatch: expected ${input.expectedPlanHash}, computed ${plan.planHash}`
    );
  }

  // 3. Atomic `.routersync.bak` snapshot BEFORE mutating target file
  atomicWriteBytes(backupPath, preBytes);

  // 4. Atomic write of planned YAML bytes
  if (plan.changed) {
    atomicWriteBytes(configPath, plan.plannedYaml);
  }

  // 5. Mandatory post-write read-back verification + auto-rollback on mismatch/fault
  try {
    if (typeof input.injectReadBackFault === 'function') {
      input.injectReadBackFault(plan.plannedYaml);
    } else if (input.injectReadBackFault === true) {
      throw new Error('Injected post-write LiteLLM read-back fault');
    }

    const postBytes = fs.readFileSync(configPath);
    const postText = postBytes.toString('utf8');
    const postDoc = parseDocument(postText, { keepSourceTokens: true, logLevel: 'silent' });
    if (postDoc.errors.length > 0 || !isMap(postDoc.contents)) {
      throw new Error(`Post-write YAML parse error: ${postDoc.errors[0]?.message ?? 'invalid root'}`);
    }

    const postInspected = inspectLiteLLMMyamlText(postText, configPath);

    // Verify every planned managed deployment & preserved os.environ key reference
    for (const expectedDep of plan.managedDeployments) {
      const actual = postInspected.deployments.find(
        (d) => d.modelName === expectedDep.modelName && d.targetModel === expectedDep.targetModel
      );
      if (!actual) {
        throw new Error(
          `Read-back missing planned deployment ${expectedDep.modelName} -> ${expectedDep.targetModel}`
        );
      }
      if (actual.apiKeyEnvRef !== expectedDep.apiKeyRef) {
        throw new Error(
          `Read-back api_key reference mismatch on ${expectedDep.modelName}: expected ${expectedDep.apiKeyRef}, got ${actual.apiKeyEnvRef}`
        );
      }
    }

    // Verify fallback chain on router_settings.fallbacks
    const fbObj = postInspected.routerSettings.fallbacks.find((f) =>
      Object.prototype.hasOwnProperty.call(f, plan.comboAlias)
    );
    const actualFb = fbObj?.[plan.comboAlias] ?? [];
    if (
      actualFb.length !== plan.fallbackTargets.length ||
      actualFb.some((t, idx) => t !== plan.fallbackTargets[idx])
    ) {
      throw new Error(
        `Read-back fallbacks mismatch for ${plan.comboAlias}: expected [${plan.fallbackTargets.join(', ')}], got [${actualFb.join(', ')}]`
      );
    }

    // Verify unmanaged deployments count and general_settings / litellm_settings integrity
    const preUnmanaged = preInspected.deployments.filter(
      (d) => d.modelName !== plan.comboAlias && !new RegExp(`^${plan.comboAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-fb\\d+$`).test(d.modelName)
    );
    const postUnmanaged = postInspected.deployments.filter(
      (d) => d.modelName !== plan.comboAlias && !new RegExp(`^${plan.comboAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-fb\\d+$`).test(d.modelName)
    );
    if (JSON.stringify(postUnmanaged) !== JSON.stringify(preUnmanaged)) {
      throw new Error('Read-back detected unexpected mutation in unmanaged model_list entries');
    }

    if (snapshotTopLevelSectionJson(postText, 'general_settings') !== preGeneralJson) {
      throw new Error('Read-back detected unexpected mutation in general_settings');
    }
    if (snapshotTopLevelSectionJson(postText, 'litellm_settings') !== preLitellmJson) {
      throw new Error('Read-back detected unexpected mutation in litellm_settings');
    }

    return {
      applied: true,
      changed: plan.changed,
      rolledBack: false,
      configPath,
      backupPath,
      planHash: plan.planHash,
      preSha256,
      postSha256: sha256Hex(postBytes),
      managedDeployments: plan.managedDeployments,
      fallbackTargets: plan.fallbackTargets,
    };
  } catch (err) {
    // Immediate byte-for-byte auto-rollback from `.routersync.bak`
    const bakBytes = fs.readFileSync(backupPath);
    atomicWriteBytes(configPath, bakBytes);
    const restoredBytes = fs.readFileSync(configPath);
    return {
      applied: false,
      changed: false,
      rolledBack: true,
      configPath,
      backupPath,
      planHash: plan.planHash,
      preSha256,
      postSha256: sha256Hex(restoredBytes),
      managedDeployments: plan.managedDeployments,
      fallbackTargets: plan.fallbackTargets,
      errorCode: 'LITELLM_READBACK_FAILED',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rollbackLiteLLMConfig(
  configPath: string,
  backupPath?: string
): LiteLLMRollbackResult {
  const resolvedConfig = path.resolve(configPath);
  const resolvedBackup = path.resolve(backupPath ?? `${resolvedConfig}.routersync.bak`);
  assertLiteLLMWriteSandboxAllowed(resolvedConfig);
  assertLiteLLMWriteSandboxAllowed(resolvedBackup);

  if (!fs.existsSync(resolvedBackup)) {
    throw new LiteLLMAdapterError(
      'LITELLM_BACKUP_MISSING',
      `Backup file does not exist: ${resolvedBackup}`
    );
  }

  const backupBytes = fs.readFileSync(resolvedBackup);
  const expectedSha = sha256Hex(backupBytes);
  atomicWriteBytes(resolvedConfig, backupBytes);

  const restoredBytes = fs.readFileSync(resolvedConfig);
  const restoredSha256 = sha256Hex(restoredBytes);
  if (restoredSha256 !== expectedSha) {
    throw new LiteLLMAdapterError(
      'LITELLM_READBACK_FAILED',
      `Rollback SHA-256 verification failed for ${resolvedConfig}`
    );
  }

  // Verify restored YAML parses cleanly
  inspectLiteLLMMyamlText(restoredBytes.toString('utf8'), resolvedConfig);

  return {
    rolledBack: true,
    configPath: resolvedConfig,
    backupPath: resolvedBackup,
    restoredSha256,
  };
}
