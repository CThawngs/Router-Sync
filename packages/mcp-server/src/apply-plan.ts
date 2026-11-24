/**
 * packages/mcp-server/src/apply-plan.ts
 *
 * Controlled MCP `apply_plan` Tool (C45-WP4, Phục vụ: S3, S4, S9).
 *
 * Enforces the mandatory 8-Gate Fail-Closed Pipeline:
 *  1. Emergency Freeze (`WRITE_FROZEN`)
 *  2. Plan Lookup & Canonical `planHash` Re-Computation (`PLAN_NOT_FOUND` / `PLAN_HASH_MISMATCH`, including `harnessActions[*].configPath`)
 *  3. Standing Consent / Single-Use Daemon `approvalToken` + `'off'` Veto + C45 §3.2 Auto-Safe Check
 *  4. Sandbox `os.tmpdir()` Deep Realpath Guard (`SANDBOX_OUTSIDE_TMPDIR` / `FORBIDDEN_RUNTIME_FILE`)
 *  5. Pre-Flight Target Actions, Diff, WP2 Harness Guards & Invariants `I1..I8` (`TARGET_NOT_FOUND` / `NO_PLANNED_CHANGES` / `UNKEYED_PROVIDER` / `DEFAULT_SLOT_PROTECTED` / `INVARIANT_VIOLATION`)
 *  6. Atomic Write Cycle (`snapshot/.bak -> write -> read-back + I4 -> unconditional auto-rollback`)
 *  7. HMAC-Signed `apply-history.json` Receipt Persistence
 *  8. Dual Sanitized Notification (`inbox.json` + `sendActionableWebhook` with `source: 'mcp.apply_plan'`)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { NineRouterAdapter } from '@routersync/adapter-9router';
import { OmniRouteAdapter } from '@routersync/adapter-omniroute';
import type {
  ComboDefinition,
  ModelInfo,
  Plan,
  RouterAdapter,
  Snapshot,
} from '@routersync/adapter-sdk';
import {
  ConsentValidationError,
  appendApplyReceipt,
  applyPlanSafe,
  rollbackRouterSnapshot,
  withEmptyReadBackAdapter,
  assertControlledWriteSandbox,
  atomicWriteFileSync,
  authorizeTargetWrite,
  computeCanonicalTickPlanHash as coreComputeCanonicalTickPlanHash,
  getConfiguredRouterDbPath,
  isPathInsideDir,
  locateRouterDb,
  parseTargetScope,
  planCombos,
  readFreezeState,
  readStandingConsent,
  resolveDeepCanonicalPath,
  saveSnapshot,
  sendActionableWebhook,
  validateInvariants,
  verifyAndConsumePersistentApprovalToken,
  verifyPersistentApprovalToken,
  type ComboRule,
  type ParsedTargetScope,
} from '@routersync/core';
import {
  applyHarnessPlanActionsSafe,
  restoreHarnessBackupBytes,
  validateHarnessPlanActionsPreFlight,
  type HarnessPlanActionInput,
} from './harness-apply.js';
import { sanitizeObject } from './sanitize.js';
import {
  latestFileIn,
  readJsonFile,
  resolveStatePaths,
  type InboxFile,
  type InboxItem,
  type StatePaths,
  type TickCatalogFile,
} from './state.js';

interface TickRouterActionShape {
  targetType?: string;
  router: string;
  comboName: string;
  provider: string;
  modelId: string;
  fullStep?: string;
  action: 'ADD_MODEL' | 'ENABLE_MODEL' | 'REMOVE_MODEL' | string;
  reason?: string;
}

interface TickHarnessActionShape {
  targetType?: string;
  harnessId: string;
  configPath: string;
  providerId: string;
  modelId: string;
  action: 'ADD_MODEL' | 'REMOVE_MODEL' | string;
  reason?: string;
}

interface StoredPlanDocument {
  version?: number;
  mode?: string;
  planHash?: string;
  routerActions?: TickRouterActionShape[];
  harnessActions?: TickHarnessActionShape[];
}

interface RouterConfigEntry {
  id?: string;
  adapter?: string;
  baseUrl?: string;
  db?: { path?: string };
}

interface ComboConfigEntry {
  id?: string;
  name?: string;
  freeOnly?: boolean;
  minSteps?: number;
  models?: string[];
}

interface ParsedRouterSyncYaml {
  routers?: RouterConfigEntry[];
  combos?: ComboConfigEntry[];
  adopt?: string[];
  webhook?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
}

interface L2CacheFile {
  models?: Record<
    string,
    {
      price?: number | null;
      source?: string;
      isZeroPriceHidden?: boolean;
    }
  >;
}

export interface RegisterApplyPlanContext {
  configPath?: string | undefined;
}

function mcpJsonResponse(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(sanitizeObject(payload), null, 2) }],
  };
}

export function computeCanonicalTickPlanHash(plan: StoredPlanDocument): string | null {
  return coreComputeCanonicalTickPlanHash({
    routerActions: plan.routerActions,
    harnessActions: plan.harnessActions,
  });
}

function resolvePlanFileOnDisk(
  paths: StatePaths,
  requestedPlanFile?: string | undefined
): { ok: true; filePath: string } | { ok: false; errorCode: string; message: string } {
  const candidateDirs = [paths.statePlansDir, paths.plansDir];

  if (requestedPlanFile && requestedPlanFile.trim().length > 0) {
    const cleanRel = requestedPlanFile.trim();
    if (path.isAbsolute(cleanRel) || cleanRel.includes('..')) {
      return {
        ok: false,
        errorCode: 'PLAN_NOT_FOUND',
        message: 'planFile must be a relative filename inside the managed plans directory.',
      };
    }
    for (const dir of candidateDirs) {
      const candidate = path.resolve(dir, cleanRel);
      const canonDir = resolveDeepCanonicalPath(dir);
      const canonCandidate = resolveDeepCanonicalPath(candidate);
      if (!isPathInsideDir(canonCandidate, canonDir)) {
        return {
          ok: false,
          errorCode: 'PLAN_NOT_FOUND',
          message: 'planFile resolved outside the managed plans directory.',
        };
      }
      if (fs.existsSync(candidate)) {
        return { ok: true, filePath: candidate };
      }
    }
    return {
      ok: false,
      errorCode: 'PLAN_NOT_FOUND',
      message: `Plan file '${cleanRel}' was not found in plans directory.`,
    };
  }

  const defaults = [
    paths.tickPlan,
    path.join(paths.plansDir, 'tick-plan.json'),
    latestFileIn(paths.statePlansDir, '.json'),
    latestFileIn(paths.plansDir, '.json'),
  ];
  for (const candidate of defaults) {
    if (candidate && fs.existsSync(candidate)) {
      return { ok: true, filePath: candidate };
    }
  }

  return {
    ok: false,
    errorCode: 'PLAN_NOT_FOUND',
    message: 'No generated plan file found in plans directory.',
  };
}

function loadConfigForMcpApply(
  paths: StatePaths,
  explicitConfigPath?: string | undefined
): { config: ParsedRouterSyncYaml; configDir: string } {
  const candidates = [
    explicitConfigPath,
    process.env['ROUTERSYNC_CONFIG'],
    path.join(paths.configDir, 'routersync.yaml'),
    path.join(paths.configDir, 'config.yaml'),
    path.join(process.cwd(), 'routersync.yaml'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const resolved = path.resolve(c);
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = (parseYaml(raw) ?? {}) as ParsedRouterSyncYaml;
      return { config: parsed, configDir: path.dirname(resolved) };
    }
  }
  return { config: {}, configDir: paths.configDir };
}

function appendInboxNotification(inboxPath: string, item: InboxItem): void {
  let existingItems: InboxItem[] = [];
  if (fs.existsSync(inboxPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as InboxFile;
      if (Array.isArray(parsed.items)) {
        existingItems = parsed.items;
      }
    } catch {
      existingItems = [];
    }
  }
  const nextItems = [item, ...existingItems].slice(0, 200);
  atomicWriteFileSync(
    inboxPath,
    `${JSON.stringify({ updatedAt: item.timestamp ?? new Date().toISOString(), items: nextItems }, null, 2)}\n`
  );
}

export function registerApplyPlanTool(
  server: McpServer,
  context: RegisterApplyPlanContext = {}
): void {
  server.tool(
    'apply_plan',
    'Applies an explicitly authorized subset of targets from a pre-computed plan file after verifying freeze state, SHA-256 planHash binding, standing consent or single-use daemon approvalToken, sandbox path guards, I1..I8 invariants, and post-write read-back with automatic rollback',
    {
      planHash: z
        .string()
        .min(16)
        .max(128)
        .describe('Expected SHA-256 planHash matching the plan file payload'),
      targets: z
        .array(z.string().min(3).max(200))
        .min(1)
        .max(32)
        .describe('Explicit canonical targets to apply (router:<id>/<combo> or harness:<id>)'),
      planFile: z
        .string()
        .max(260)
        .optional()
        .describe('Optional plan filename inside plansDir (defaults to tick-plan.json)'),
      approvalToken: z
        .string()
        .max(256)
        .optional()
        .describe('Optional single-use HMAC approval token (<64hex>.<64hex>) issued by daemon'),
      injectReadBackFault: z
        .boolean()
        .optional()
        .describe('Test-only post-write read-back fault injection (active ONLY under VITEST=true)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const nowIso = new Date().toISOString();

      // ---------------------------------------------------------------------
      // Gate 1: Emergency Freeze Check (blocks ALL writes, even with valid consent & token!)
      // ---------------------------------------------------------------------
      const freeze = readFreezeState(paths.stateDir);
      if (freeze.frozen) {
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: 'WRITE_FROZEN',
            reason: freeze.reason,
            message: 'Write rejected: system is in emergency FROZEN state.',
          },
          true
        );
      }

      // ---------------------------------------------------------------------
      // Gate 2: Plan Lookup & Canonical SHA-256 `planHash` Re-Computation
      // ---------------------------------------------------------------------
      const resolvedPlan = resolvePlanFileOnDisk(paths, args.planFile);
      if (!resolvedPlan.ok) {
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: resolvedPlan.errorCode,
            message: resolvedPlan.message,
          },
          true
        );
      }

      const planRead = readJsonFile<StoredPlanDocument>(resolvedPlan.filePath);
      if (!planRead.ok) {
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: 'PLAN_NOT_FOUND',
            message: `Unable to read plan file (${planRead.reason}).`,
          },
          true
        );
      }

      const planDoc = planRead.value;
      const computedPlanHash = computeCanonicalTickPlanHash(planDoc);
      if (
        !computedPlanHash ||
        typeof planDoc.planHash !== 'string' ||
        computedPlanHash !== planDoc.planHash ||
        args.planHash.trim() !== computedPlanHash
      ) {
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: 'PLAN_HASH_MISMATCH',
            message:
              'Plan hash mismatch: plan payload was modified or does not match the requested planHash.',
          },
          true
        );
      }

      // ---------------------------------------------------------------------
      // Gate 3: Target Grammar, Standing Consent / Daemon Approval Token, & `'off'` Veto
      // ---------------------------------------------------------------------
      const parsedTargets: ParsedTargetScope[] = [];
      try {
        for (const rawTarget of args.targets) {
          parsedTargets.push(parseTargetScope(rawTarget));
        }
      } catch (err) {
        if (err instanceof ConsentValidationError) {
          return mcpJsonResponse(
            { applied: false, errorCode: err.code, message: err.message },
            true
          );
        }
        return mcpJsonResponse(
          { applied: false, errorCode: 'INVALID_TARGET_SYNTAX', message: String(err) },
          true
        );
      }

      const consentState = readStandingConsent(paths.stateDir);
      if (consentState.present && !consentState.valid) {
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: consentState.errorCode ?? 'CONSENT_HMAC_INVALID',
            message: 'Standing consent file failed HMAC or schema integrity check.',
          },
          true
        );
      }

      // Explicit `'off'` veto applies unconditionally (even when approvalToken is supplied)
      for (const pt of parsedTargets) {
        const explicitEntry = consentState.targets.find((e) => e.target === pt.target);
        if (explicitEntry?.level === 'off') {
          return mcpJsonResponse(
            {
              applied: false,
              errorCode: 'TARGET_CONSENT_OFF',
              target: pt.target,
              message: `Target '${pt.target}' is explicitly set to 'off'.`,
            },
            true
          );
        }
      }

      let authorizedVia: 'standing-consent' | 'approval-token' = 'standing-consent';
      const targetAppliedLevels = new Map<string, 'propose' | 'auto-safe'>();
      const trimmedApprovalToken =
        args.approvalToken !== undefined && args.approvalToken.trim().length > 0
          ? args.approvalToken.trim()
          : undefined;

      if (trimmedApprovalToken) {
        // Pre-verify token non-destructively at Gate 3 so pre-flight target/invariant/diff
        // rejections at Gates 4 & 5 do NOT burn a single-use token prematurely (F3).
        const tokPreview = verifyPersistentApprovalToken(
          paths.stateDir,
          trimmedApprovalToken,
          computedPlanHash,
          parsedTargets.map((p) => p.target)
        );
        if (!tokPreview.valid) {
          return mcpJsonResponse(
            {
              applied: false,
              errorCode: 'INVALID_APPROVAL_TOKEN',
              reason: tokPreview.reason ?? 'invalid_signature',
              message: `Approval token rejected (${tokPreview.reason ?? 'invalid_signature'}).`,
            },
            true
          );
        }
        authorizedVia = 'approval-token';
        for (const pt of parsedTargets) {
          targetAppliedLevels.set(pt.target, 'propose');
        }
      } else {
        for (const pt of parsedTargets) {
          const auth = authorizeTargetWrite(paths.stateDir, pt.target);
          if (!auth.authorized) {
            return mcpJsonResponse(
              {
                applied: false,
                errorCode: auth.errorCode,
                target: pt.target,
                message: auth.message,
              },
              true
            );
          }
          targetAppliedLevels.set(pt.target, auth.level);
        }
      }

      // ---------------------------------------------------------------------
      // Gate 4 & Gate 5: Sandbox Path Guard + Target Action/Diff + Invariants `I1..I8`
      // ---------------------------------------------------------------------
      const { config, configDir } = loadConfigForMcpApply(paths, context.configPath);
      const l2Read = readJsonFile<L2CacheFile>(paths.l2Cache);
      const l2Models = l2Read.ok && l2Read.value.models ? l2Read.value.models : {};
      const tickCatRead = readJsonFile<TickCatalogFile>(paths.tickCatalog);
      const tickProviders = tickCatRead.ok && tickCatRead.value.providers ? tickCatRead.value.providers : {};

      interface PreparedRouterExecution {
        scope: ParsedTargetScope;
        adapterName: '9router' | 'omniroute';
        dbPath: string;
        adapter: RouterAdapter;
        postCombo: ComboDefinition;
        catalog: ModelInfo[];
        singlePlan: Plan;
      }

      interface PreparedHarnessExecution {
        scope: ParsedTargetScope;
        harnessId: string;
        configPath: string;
        preBytes: Buffer;
        actions: HarnessPlanActionInput[];
      }

      const preparedRouters: PreparedRouterExecution[] = [];
      const preparedHarnesses: PreparedHarnessExecution[] = [];

      const allowLiveRouter = process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] === '1';

      try {
        for (const pt of parsedTargets) {
          if (pt.targetKind === 'router') {
            const routerId = pt.routerId!;
            const comboName = pt.comboName!;

            const routerCfg = (config.routers ?? []).find(
              (r) => r.id === routerId || r.adapter === routerId
            );
            const adapterName: '9router' | 'omniroute' =
              routerCfg?.adapter === 'omniroute' || routerId === 'omniroute'
                ? 'omniroute'
                : '9router';

            // F3: Reject requested router target with zero matching plan actions BEFORE DB write or receipt!
            const matchingActions = (planDoc.routerActions ?? []).filter(
              (a) =>
                a.comboName === comboName &&
                (a.router === routerId || a.router === adapterName) &&
                (a.action === 'ADD_MODEL' ||
                  a.action === 'ENABLE_MODEL' ||
                  a.action === 'REMOVE_MODEL')
            );
            if (matchingActions.length === 0) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'TARGET_NOT_FOUND',
                  target: pt.target,
                  message: `No actionable router plan entries found for '${pt.target}'.`,
                },
                true
              );
            }

            const configuredDb = routerCfg?.db?.path
              ? path.resolve(configDir, routerCfg.db.path)
              : getConfiguredRouterDbPath(adapterName) ?? locateRouterDb(adapterName);

            assertControlledWriteSandbox(configuredDb, 'router-db');

            const adapter: RouterAdapter =
              adapterName === 'omniroute'
                ? new OmniRouteAdapter({
                    dbPath: configuredDb,
                    isolated: !allowLiveRouter,
                  })
                : new NineRouterAdapter({
                    dbPath: configuredDb,
                    isolated: !allowLiveRouter,
                    stateDir: paths.stateDir,
                  });

            const liveCombos = await adapter.readCombos();
            const currentCombo = liveCombos.find(
              (c) => c.name === comboName || c.id === comboName
            );
            if (!currentCombo) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'TARGET_NOT_FOUND',
                  target: pt.target,
                  message: `Router combo '${comboName}' not found in '${routerId}'.`,
                },
                true
              );
            }

            let nextModels = [...currentCombo.models];
            for (const act of matchingActions) {
              const step = act.fullStep ?? `${act.provider}/${act.modelId}`;
              if (act.action === 'REMOVE_MODEL') {
                nextModels = nextModels.filter((m) => m !== step);
              } else if (act.action === 'ADD_MODEL' || act.action === 'ENABLE_MODEL') {
                if (!nextModels.includes(step)) {
                  nextModels.push(step);
                }
              }
            }

            // F3: Reject zero effective model diff so no-op applies cannot forge §3.2 promotion receipts!
            if (
              nextModels.length === currentCombo.models.length &&
              nextModels.every((m, idx) => m === currentCombo.models[idx])
            ) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'NO_PLANNED_CHANGES',
                  target: pt.target,
                  message: `Planned router actions for '${pt.target}' produce zero effective model changes.`,
                },
                true
              );
            }

            const comboCfg = (config.combos ?? []).find(
              (c) => c.name === comboName || c.id === comboName
            );
            const freeOnly = Boolean(currentCombo.freeOnly || comboCfg?.freeOnly);
            const minSteps = comboCfg?.minSteps ?? currentCombo.minSteps ?? 2;

            const postCombo: ComboDefinition = {
              ...currentCombo,
              managed: true,
              freeOnly,
              minSteps,
              models: nextModels,
            };

            // Build catalog for I1..I8 evaluation
            const dbCatalog = await adapter.readCatalog().catch(() => [] as ModelInfo[]);
            const catalogMap = new Map<string, ModelInfo>();
            for (const item of dbCatalog) {
              catalogMap.set(item.id, item);
            }

            const candidateSteps = new Set<string>([
              ...currentCombo.models,
              ...nextModels,
            ]);
            for (const [provPrefix, snap] of Object.entries(tickProviders)) {
              for (const id of snap.ids ?? []) {
                candidateSteps.add(`${provPrefix}/${id}`);
              }
            }

            for (const step of candidateSteps) {
              const slashIdx = step.indexOf('/');
              const provider = slashIdx > 0 ? step.slice(0, slashIdx) : 'unknown';
              const l2Entry = l2Models[step];
              let pricing: ModelInfo['pricing'];
              if (l2Entry && typeof l2Entry.price === 'number') {
                if (l2Entry.price === 0 && l2Entry.source === 'both' && !l2Entry.isZeroPriceHidden) {
                  pricing = { promptCostPerToken: 0, completionCostPerToken: 0 };
                } else if (l2Entry.price > 0) {
                  pricing = {
                    promptCostPerToken: l2Entry.price,
                    completionCostPerToken: l2Entry.price,
                  };
                }
              } else if (!freeOnly) {
                pricing = { promptCostPerToken: 0, completionCostPerToken: 0 };
              }

              const existingInfo = catalogMap.get(step);
              catalogMap.set(step, {
                id: step,
                name: existingInfo?.name ?? step,
                provider: existingInfo?.provider ?? provider,
                status: existingInfo?.status ?? 'active',
                ...(pricing ? { pricing } : existingInfo?.pricing ? { pricing: existingInfo.pricing } : {}),
              });
            }

            const catalogList = [...catalogMap.values()];
            const singlePlan: Plan = {
              id: `plan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
              target: adapterName,
              timestamp: nowIso,
              additions: [],
              modifications: [postCombo],
              deletions: [],
              reasons: {
                [postCombo.id]: `Controlled apply_plan (${computedPlanHash})`,
              },
            };

            const invResult = validateInvariants({
              combos: [postCombo],
              catalog: catalogList,
              plan: singlePlan,
              adoptedCombos: [currentCombo.id, currentCombo.name],
              writeSequence: ['providers', 'models', 'combos', 'defaultSlots'],
            });

            if (!invResult.valid) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'INVARIANT_VIOLATION',
                  target: pt.target,
                  violations: invResult.violations,
                  message: invResult.violations
                    .filter((v) => v.severity === 'error')
                    .map((v) => `[${v.code}] ${v.message}`)
                    .join('; '),
                },
                true
              );
            }

            preparedRouters.push({
              scope: pt,
              adapterName,
              dbPath: configuredDb,
              adapter,
              postCombo,
              catalog: catalogList,
              singlePlan,
            });
          } else {
            const harnessId = pt.harnessId!;
            const matchingHarnessActions = (planDoc.harnessActions ?? []).filter(
              (a) => a.harnessId === harnessId && (a.action === 'ADD_MODEL' || a.action === 'REMOVE_MODEL')
            );
            const configPath = matchingHarnessActions[0]?.configPath?.trim();
            if (!configPath) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'TARGET_NOT_FOUND',
                  target: pt.target,
                  message: `No harness plan actions with configPath found for '${pt.target}'.`,
                },
                true
              );
            }

            // F2: Enforce consistent canonical configPath across all matching actions for this harness
            const expectedCanonCfg = resolveDeepCanonicalPath(configPath);
            const foldCase = process.platform === 'win32' || process.platform === 'darwin';
            const normExpectedCfg = foldCase ? expectedCanonCfg.toLowerCase() : expectedCanonCfg;
            for (const act of matchingHarnessActions) {
              const rawActCfg = typeof act.configPath === 'string' ? act.configPath.trim() : '';
              if (!rawActCfg) {
                return mcpJsonResponse(
                  {
                    applied: false,
                    errorCode: 'INVALID_PLAN_CONFIG_PATH',
                    target: pt.target,
                    message: `Missing configPath in harness plan action for '${pt.target}'.`,
                  },
                  true
                );
              }
              const actCanon = resolveDeepCanonicalPath(rawActCfg);
              const normActCanon = foldCase ? actCanon.toLowerCase() : actCanon;
              if (normActCanon !== normExpectedCfg) {
                return mcpJsonResponse(
                  {
                    applied: false,
                    errorCode: 'INVALID_PLAN_CONFIG_PATH',
                    target: pt.target,
                    message: `Inconsistent configPath across harness plan actions for '${pt.target}'.`,
                  },
                  true
                );
              }
            }

            assertControlledWriteSandbox(configPath, 'harness-config');
            const resolvedCfg = path.resolve(configPath);
            if (!fs.existsSync(resolvedCfg)) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: 'TARGET_NOT_FOUND',
                  target: pt.target,
                  message: `Harness config file not found for '${pt.target}'.`,
                },
                true
              );
            }

            const mappedActions: HarnessPlanActionInput[] = matchingHarnessActions.map((a) => ({
              harnessId: a.harnessId,
              configPath: resolvedCfg,
              providerId: a.providerId,
              modelId: a.modelId,
              action: a.action as 'ADD_MODEL' | 'REMOVE_MODEL',
            }));

            // F4: Enforce WP2 keyed-provider, default-slot protection, & non-zero diff BEFORE write/token consumption!
            const hPreFlight = validateHarnessPlanActionsPreFlight({
              harnessId,
              configPath: resolvedCfg,
              actions: mappedActions,
            });
            if (!hPreFlight.ok) {
              return mcpJsonResponse(
                {
                  applied: false,
                  errorCode: hPreFlight.errorCode,
                  target: pt.target,
                  message: hPreFlight.message,
                },
                true
              );
            }

            preparedHarnesses.push({
              scope: pt,
              harnessId,
              configPath: resolvedCfg,
              preBytes: fs.readFileSync(resolvedCfg),
              actions: mappedActions,
            });
          }
        }
      } catch (err) {
        if (err instanceof ConsentValidationError) {
          return mcpJsonResponse(
            { applied: false, errorCode: err.code, message: err.message },
            true
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isLiveDbViolation = /live router|sandbox|tmpdir/i.test(msg);
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: isLiveDbViolation ? 'SANDBOX_OUTSIDE_TMPDIR' : 'INTERNAL_ERROR',
            message: msg,
          },
          true
        );
      }

      // Atomically consume single-use approvalToken right before Gate 6 writes
      if (trimmedApprovalToken) {
        const tokConsume = verifyAndConsumePersistentApprovalToken(
          paths.stateDir,
          trimmedApprovalToken,
          computedPlanHash,
          parsedTargets.map((p) => p.target)
        );
        if (!tokConsume.valid) {
          return mcpJsonResponse(
            {
              applied: false,
              errorCode: 'INVALID_APPROVAL_TOKEN',
              reason: tokConsume.reason ?? 'invalid_signature',
              message: `Approval token rejected (${tokConsume.reason ?? 'invalid_signature'}).`,
            },
            true
          );
        }
      }

      // ---------------------------------------------------------------------
      // Gate 6: Atomic Write + Read-Back + I4 Idempotency + Auto-Rollback
      // ---------------------------------------------------------------------
      const injectFault = args.injectReadBackFault === true && process.env['VITEST'] === 'true';
      const succeededRouterRollbacks: Array<{ adapter: RouterAdapter; snapshot: Snapshot }> = [];
      const succeededHarnessRollbacks: Array<{ configPath: string; preBytes: Buffer }> = [];
      const targetOutcomes: Array<{
        target: string;
        appliedAtLevel: 'propose' | 'auto-safe';
        success: boolean;
        readBackVerified: boolean;
        readBackLevel: string;
        rolledBack: boolean;
        snapshotOrBackupRef: string;
        error?: string | undefined;
      }> = [];

      let anyFailed = false;

      for (const rExec of preparedRouters) {
        const preSnapshot = await rExec.adapter.createSnapshot();
        saveSnapshot(preSnapshot);

        // When fault injection is enabled in VITEST, corrupt readCombos() on post-write read-back
        // so `applyPlanSafe` in `packages/core/src/applier/index.ts` executes its real rollback path!
        const effectiveAdapter: RouterAdapter = injectFault
          ? withEmptyReadBackAdapter(rExec.adapter)
          : rExec.adapter;

        const applyRes = await applyPlanSafe(effectiveAdapter, rExec.singlePlan, { dryRun: false });

        let i4Verified = applyRes.success && applyRes.readBackVerified;
        let rolledBack = Boolean(applyRes.rollbackExecuted);
        let errText = applyRes.error;

        if (i4Verified) {
          // Verify I4 idempotency: immediate re-plan produces 0 diff
          const reRead = await rExec.adapter.readCombos();
          const matchedReadBack = reRead.filter(
            (c) => c.id === rExec.postCombo.id || c.name === rExec.postCombo.name
          );
          const validStrategies = new Set([
            'priority',
            'fallback',
            'weighted',
            'round-robin',
            'least-used',
            'random',
            'cost-optimized',
            'strict-random',
          ]);
          const ruleStrategy = validStrategies.has(rExec.postCombo.strategy ?? '')
            ? (rExec.postCombo.strategy as ComboRule['strategy'])
            : 'fallback';
          const i4Rule: ComboRule = {
            comboId: rExec.postCombo.id,
            name: rExec.postCombo.name,
            strategy: ruleStrategy,
            minSteps: rExec.postCombo.minSteps ?? 2,
            maxSteps: Math.max(rExec.postCombo.models.length, rExec.postCombo.minSteps ?? 2),
            freeOnly: Boolean(rExec.postCombo.freeOnly),
            requiredCapabilities: [],
            pinnedModels: [...rExec.postCombo.models],
            excludedModels: [],
          };
          const normalizedReadBack = matchedReadBack.map((c) => ({
            ...c,
            strategy: validStrategies.has(c.strategy ?? '') ? c.strategy : ruleStrategy,
          }));
          const residual = planCombos(normalizedReadBack, rExec.catalog, [i4Rule], {
            target: rExec.adapterName,
            adopt: [{ name: rExec.postCombo.id, mode: 'full' }],
          });
          if (
            residual.additions.length > 0 ||
            residual.modifications.length > 0 ||
            residual.deletions.length > 0
          ) {
            i4Verified = false;
            rolledBack = await rollbackRouterSnapshot(rExec.adapter, preSnapshot);
            errText = 'Invariant I4 idempotency check failed after router write.';
          } else {
            succeededRouterRollbacks.push({ adapter: rExec.adapter, snapshot: preSnapshot });
          }
        } else {
          anyFailed = true;
        }

        if (!i4Verified) {
          anyFailed = true;
        }

        targetOutcomes.push({
          target: rExec.scope.target,
          appliedAtLevel: targetAppliedLevels.get(rExec.scope.target) ?? 'propose',
          success: i4Verified,
          readBackVerified: i4Verified,
          readBackLevel: applyRes.canonicalReadBackLevel ?? applyRes.readBackLevel ?? 'db-only',
          rolledBack,
          snapshotOrBackupRef: preSnapshot.id,
          error: errText,
        });
      }

      for (const hExec of preparedHarnesses) {
        const hRes = applyHarnessPlanActionsSafe({
          harnessId: hExec.harnessId,
          configPath: hExec.configPath,
          actions: hExec.actions,
          injectReadBackFault: injectFault,
        });

        if (hRes.success && hRes.readBackVerified) {
          succeededHarnessRollbacks.push({
            configPath: hExec.configPath,
            preBytes: hExec.preBytes,
          });
        } else {
          anyFailed = true;
        }

        targetOutcomes.push({
          target: hExec.scope.target,
          appliedAtLevel: targetAppliedLevels.get(hExec.scope.target) ?? 'propose',
          success: hRes.success,
          readBackVerified: hRes.readBackVerified,
          readBackLevel: 'file-byte-verified',
          rolledBack: hRes.rolledBack,
          snapshotOrBackupRef: path.basename(hRes.backupPath),
          error: hRes.error,
        });
      }

      // All-or-nothing rollback across multi-target batch if any target failed
      if (anyFailed) {
        for (const rRb of succeededRouterRollbacks) {
          await rollbackRouterSnapshot(rRb.adapter, rRb.snapshot);
        }
        for (const hRb of succeededHarnessRollbacks) {
          try {
            restoreHarnessBackupBytes(hRb.configPath, hRb.preBytes);
          } catch {
            // ignore
          }
        }
        for (const outcome of targetOutcomes) {
          if (outcome.success) {
            outcome.success = false;
            outcome.readBackVerified = false;
            outcome.rolledBack = true;
          }
        }
      }

      // ---------------------------------------------------------------------
      // Gate 7: Persist HMAC-Signed Apply History Receipts
      // ---------------------------------------------------------------------
      const receipts = targetOutcomes.map((o) =>
        appendApplyReceipt(paths.stateDir, {
          target: o.target,
          planHash: computedPlanHash,
          appliedAt: nowIso,
          appliedAtLevel: o.appliedAtLevel,
          authorizedVia,
          success: o.success,
          readBackVerified: o.readBackVerified,
          readBackLevel: o.readBackLevel,
          rolledBack: o.rolledBack,
          snapshotOrBackupRef: o.snapshotOrBackupRef,
        })
      );

      // ---------------------------------------------------------------------
      // Gate 8: Dual Sanitized Notification (`inbox.json` + Outbound Webhook)
      // ---------------------------------------------------------------------
      const tag = anyFailed ? '[AUTO-ROLLBACK]' : '[PLAN-APPLIED]';
      const targetListText = targetOutcomes.map((o) => o.target).join(', ');
      appendInboxNotification(paths.inbox, {
        id: `mcp-apply-${computedPlanHash}-${Date.now()}`,
        title: `${tag} MCP apply_plan (${computedPlanHash})`,
        type: anyFailed ? 'warning' : 'info',
        timestamp: nowIso,
        body: anyFailed
          ? `Rolled back plan ${computedPlanHash} across [${targetListText}] after verification failure.`
          : `Verified and applied plan ${computedPlanHash} across [${targetListText}].`,
        label: anyFailed ? 'AUTO-ROLLBACK' : 'PLAN-APPLIED',
        proposed_by: { kind: 'system', source: 'mcp.apply_plan' },
      });

      const webhookUrl =
        process.env['ROUTERSYNC_WEBHOOK_URL']?.trim() ||
        (config.webhook && config.webhook.enabled !== false ? config.webhook.url : undefined);

      const webhookResult = await sendActionableWebhook({
        url: webhookUrl,
        source: 'mcp.apply_plan',
        timestamp: nowIso,
        inboxAdded: 1,
        changedProviders: parsedTargets.map((t) => t.routerId ?? t.harnessId ?? 'target'),
        alerts: targetOutcomes.map((o) => ({
          kind: o.rolledBack ? 'auto_rollback' : 'plan_applied',
          providerOrRouter: o.target,
          code: o.rolledBack ? 'AUTO_ROLLBACK' : 'PLAN_APPLIED',
          message: o.rolledBack
            ? `${tag} ${o.target} rolled back (${o.error ?? 'verification failed'})`
            : `${tag} ${o.target} verified (${o.readBackLevel})`,
        })),
        timeoutMs: config.webhook?.timeoutMs,
      });

      if (anyFailed) {
        const allRolledBack = targetOutcomes.every((o) => o.rolledBack);
        return mcpJsonResponse(
          {
            applied: false,
            errorCode: 'READ_BACK_ROLLBACK',
            rolledBack: allRolledBack,
            planHash: computedPlanHash,
            targets: targetOutcomes,
            receiptIds: receipts.map((r) => r.receiptId),
            webhookDelivery: webhookResult,
          },
          true
        );
      }

      return mcpJsonResponse({
        applied: true,
        rolledBack: false,
        planHash: computedPlanHash,
        authorizedVia,
        targets: targetOutcomes,
        receiptIds: receipts.map((r) => r.receiptId),
        webhookDelivery: webhookResult,
      });
    }
  );
}
