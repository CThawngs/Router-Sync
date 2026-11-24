/**
 * packages/cli/src/litellm/yaml-cst.ts
 *
 * C45 WP5 Lossless LiteLLM YAML CST/AST Inspection & Span Surgery (Phục vụ: S4).
 *
 * Uses `yaml@2.9.1` (`parseDocument(..., { keepSourceTokens: true })`) +
 * `applySpanReplacements` (`../apps/lossless-edit.js`) so:
 *  - Unmanaged `model_list` entries, `#` comments (header, section, inline),
 *    `general_settings` (`master_key`), `litellm_settings`, `environment_variables`,
 *    and CRLF vs LF line endings stay 100% byte-for-byte identical.
 *  - Plaintext API keys are strictly forbidden (`LITELLM_PLAINTEXT_SECRET_FORBIDDEN`).
 *  - Re-planning on synced output yields `changed: false` (`I4` idempotency).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  applySpanReplacements,
  detectNewline,
  type SpanEdit,
} from '../apps/lossless-edit.js';

export type LiteLLMAdapterErrorCode =
  | 'LITELLM_PLAINTEXT_SECRET_FORBIDDEN'
  | 'HARNESS_WRITE_OUTSIDE_SANDBOX'
  | 'LITELLM_CONFIG_INVALID'
  | 'LITELLM_BACKUP_MISSING'
  | 'LITELLM_PLAN_HASH_MISMATCH'
  | 'LITELLM_READBACK_FAILED';

export class LiteLLMAdapterError extends Error {
  public readonly code: LiteLLMAdapterErrorCode;

  constructor(code: LiteLLMAdapterErrorCode, message: string) {
    super(message);
    this.name = 'LiteLLMAdapterError';
    this.code = code;
  }
}

const ENV_REF_OS_ENVIRON_RE = /^os\.environ\/[A-Z][A-Z0-9_]{1,127}$/;
const ENV_REF_BRACE_RE = /^\$\{[A-Z][A-Z0-9_]{1,127}\}$/;

export function isValidLiteLLMEnvKeyRef(value: string): boolean {
  const trimmed = value.trim();
  return ENV_REF_OS_ENVIRON_RE.test(trimmed) || ENV_REF_BRACE_RE.test(trimmed);
}

export function assertValidLiteLLMApiKeyRef(value: unknown, contextLabel: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'string' || !isValidLiteLLMEnvKeyRef(value)) {
    throw new LiteLLMAdapterError(
      'LITELLM_PLAINTEXT_SECRET_FORBIDDEN',
      `Plaintext or malformed api_key forbidden on ${contextLabel}. Only os.environ/ENV_VAR or \${ENV_VAR} references are allowed.`
    );
  }
}

export interface LiteLLMDeploymentSummary {
  index: number;
  modelName: string;
  targetModel: string;
  provider: string;
  apiBase: string | null;
  apiKeyEnvRef: string | null;
  isEnvReference: boolean;
}

export interface LiteLLMCredentialPool {
  modelName: string;
  deploymentCount: number;
  keyRefs: string[];
}

export interface LiteLLMInspectionResult {
  configPath: string;
  deployments: LiteLLMDeploymentSummary[];
  credentialPools: LiteLLMCredentialPool[];
  routerSettings: {
    routingStrategy: string | null;
    numRetries: number | null;
    fallbacks: Array<Record<string, string[]>>;
    contextWindowFallbacks: Array<Record<string, string[]>>;
  };
  hasGeneralSettings: boolean;
  hasLitellmSettings: boolean;
}

export interface LiteLLMSyncStepInput {
  step: string;                         // "<provider>/<modelId>"
  modelName?: string | undefined;       // defaults to <comboAlias> for index 0, <comboAlias>-fb<i> for index > 0
  apiKeyRef?: string | undefined;       // MUST match os.environ/UPPER_CASE or ${UPPER_CASE} if set
  apiBase?: string | undefined;
}

export interface LiteLLMSyncPlanInput {
  configPath: string;
  rawYaml?: string | undefined;
  comboAlias: string;
  steps: readonly (string | LiteLLMSyncStepInput)[];
  routingStrategy?: 'fallbacks' | 'simple-shuffle' | 'least-busy' | undefined;
}

export interface PlannedLiteLLMManagedDeployment {
  modelName: string;
  targetModel: string;
  provider: string;
  apiKeyRef: string | null;
  apiBase: string | null;
}

export interface LiteLLMSyncPlanResult {
  configPath: string;
  comboAlias: string;
  changed: boolean;
  diffHunks: number;
  planHash: string;
  managedDeployments: PlannedLiteLLMManagedDeployment[];
  fallbackTargets: string[];
  effectiveRoutingStrategy: string | null;
  plannedYaml: string;
}

function formatYamlScalar(value: string): string {
  if (
    value === '' ||
    /^\s|\s$/.test(value) ||
    /^(?:true|false|null|~|yes|no|on|off)$/i.test(value) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#|\n|\r/.test(value) ||
    value.endsWith(':')
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function extractProviderPrefix(modelStr: string): string {
  const idx = modelStr.indexOf('/');
  return idx > 0 ? modelStr.slice(0, idx).toLowerCase() : 'unknown';
}

function defaultEnvRefForProvider(provider: string): string {
  const sanitized = provider
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = sanitized && /^[A-Z]/.test(sanitized) ? sanitized : `PROVIDER_${sanitized || 'KEY'}`;
  return `os.environ/${prefix}_API_KEY`;
}

function sanitizeKeyDisplayRef(rawApiKey: unknown): { ref: string | null; isEnv: boolean } {
  if (typeof rawApiKey !== 'string' || rawApiKey.trim() === '') {
    return { ref: null, isEnv: false };
  }
  const trimmed = rawApiKey.trim();
  if (isValidLiteLLMEnvKeyRef(trimmed)) {
    return { ref: trimmed, isEnv: true };
  }
  return { ref: '[REDACTED_NON_ENV_KEY]', isEnv: false };
}

function parseFallbacksList(seqNode: unknown): Array<Record<string, string[]>> {
  if (!isSeq(seqNode)) return [];
  const out: Array<Record<string, string[]>> = [];
  for (const item of seqNode.items) {
    if (!isMap(item)) continue;
    const rec: Record<string, string[]> = {};
    for (const pair of item.items) {
      if (!isScalar(pair.key)) continue;
      const alias = String(pair.key.value ?? '').trim();
      if (!alias) continue;
      const targets: string[] = [];
      if (isSeq(pair.value)) {
        for (const t of pair.value.items) {
          if (isScalar(t) && t.value !== null && t.value !== undefined) {
            targets.push(String(t.value));
          }
        }
      }
      rec[alias] = targets;
    }
    if (Object.keys(rec).length > 0) {
      out.push(rec);
    }
  }
  return out;
}

export function inspectLiteLLMMyamlText(
  rawYaml: string,
  configPath: string
): LiteLLMInspectionResult {
  const doc = parseDocument(rawYaml, { keepSourceTokens: true, logLevel: 'silent' });
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `Invalid LiteLLM YAML in ${configPath}: ${doc.errors[0]?.message ?? 'root must be a YAML map'}`
    );
  }

  const root = isMap(doc.contents) ? doc.contents : null;
  const deployments: LiteLLMDeploymentSummary[] = [];
  const poolTracker = new Map<string, string[]>();

  const modelListNode = root?.get('model_list', true);
  if (isSeq(modelListNode)) {
    modelListNode.items.forEach((item, idx) => {
      if (!isMap(item)) return;
      const modelName = String(item.get('model_name') ?? '').trim();
      const paramsNode = item.get('litellm_params', true);
      const paramsMap = isMap(paramsNode) ? paramsNode : null;
      const targetModel = paramsMap ? String(paramsMap.get('model') ?? '').trim() : '';
      const rawApiBase = paramsMap?.get('api_base');
      const apiBase =
        typeof rawApiBase === 'string' && rawApiBase.trim() !== '' ? rawApiBase.trim() : null;
      const rawApiKey = paramsMap?.get('api_key');
      const keyInfo = sanitizeKeyDisplayRef(rawApiKey);

      deployments.push({
        index: idx,
        modelName,
        targetModel,
        provider: extractProviderPrefix(targetModel),
        apiBase,
        apiKeyEnvRef: keyInfo.ref,
        isEnvReference: keyInfo.isEnv,
      });

      if (modelName) {
        const list = poolTracker.get(modelName) ?? [];
        if (keyInfo.ref) list.push(keyInfo.ref);
        poolTracker.set(modelName, list);
      }
    });
  }

  const credentialPools: LiteLLMCredentialPool[] = [];
  for (const [modelName, keyRefs] of poolTracker.entries()) {
    const count = deployments.filter((d) => d.modelName === modelName).length;
    if (count >= 2) {
      credentialPools.push({
        modelName,
        deploymentCount: count,
        keyRefs,
      });
    }
  }

  const routerNode = root?.get('router_settings', true);
  const routerMap = isMap(routerNode) ? routerNode : null;
  const rawStrategy = routerMap?.get('routing_strategy');
  const rawRetries = routerMap?.get('num_retries');

  return {
    configPath,
    deployments,
    credentialPools,
    routerSettings: {
      routingStrategy: typeof rawStrategy === 'string' ? rawStrategy : null,
      numRetries: typeof rawRetries === 'number' ? rawRetries : null,
      fallbacks: parseFallbacksList(routerMap?.get('fallbacks', true)),
      contextWindowFallbacks: parseFallbacksList(routerMap?.get('context_window_fallbacks', true)),
    },
    hasGeneralSettings: Boolean(root?.has('general_settings')),
    hasLitellmSettings: Boolean(root?.has('litellm_settings')),
  };
}

export function inspectLiteLLMConfig(configPath: string): LiteLLMInspectionResult {
  const rawYaml = fs.readFileSync(configPath, 'utf8');
  return inspectLiteLLMMyamlText(rawYaml, configPath);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isManagedComboModelName(modelName: string, comboAlias: string): boolean {
  if (modelName === comboAlias) return true;
  const fbRe = new RegExp(`^${escapeRegExp(comboAlias)}-fb\\d+$`);
  return fbRe.test(modelName);
}

/**
 * Computes the exact `[lineStart, lineEnd]` character span in `text` for a
 * block sequence item (`- ...`), stopping at the end of that item's own lines
 * so preceding standalone `#` comments and following blank lines / `#` comments
 * remain completely outside the span.
 */
function getSeqItemLineSpan(text: string, itemNode: YAMLMap): { start: number; end: number; indent: string } {
  const range = itemNode.range;
  if (!range) {
    throw new LiteLLMAdapterError('LITELLM_CONFIG_INVALID', 'YAML sequence item missing range tuple.');
  }

  // Walk back from itemNode.range[0] across spaces and `-` to the start of its line
  let dashPos = range[0];
  while (dashPos > 0 && (text.charCodeAt(dashPos - 1) === 32 || text.charCodeAt(dashPos - 1) === 9)) {
    dashPos -= 1;
  }
  if (dashPos > 0 && text.charCodeAt(dashPos - 1) === 45 /* '-' */) {
    dashPos -= 1;
  }
  let lineStart = dashPos;
  while (lineStart > 0 && (text.charCodeAt(lineStart - 1) === 32 || text.charCodeAt(lineStart - 1) === 9)) {
    lineStart -= 1;
  }
  const indent = text.slice(lineStart, dashPos);

  // `range[1]` is the end of the item's value; extend through any inline comment on that same line + 1 newline
  let end = range[1];
  if (end > lineStart && text.charCodeAt(end - 1) === 10 /* '\n' */) {
    // `range[1]` already stopped right after a newline; check if `range[1]` included trailing blank/comment lines
    // Walk back to the end of the last actual scalar value inside itemNode so we never swallow next item's comments!
    let lastValueEnd = range[0];
    const walkEnd = (node: unknown): void => {
      if (isMap(node)) {
        for (const p of node.items) {
          walkEnd(p.key);
          walkEnd(p.value);
        }
      } else if (isSeq(node)) {
        for (const child of node.items) walkEnd(child);
      } else if (isScalar(node) && node.range) {
        if (node.range[1] > lastValueEnd) lastValueEnd = node.range[1];
      }
    };
    walkEnd(itemNode);
    end = lastValueEnd;
  }

  while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) {
    end += 1;
  }
  if (end < text.length && text.charCodeAt(end) === 13) end += 1;
  if (end < text.length && text.charCodeAt(end) === 10) end += 1;

  return { start: lineStart, end, indent };
}

function renderManagedDeploymentYaml(
  dep: PlannedLiteLLMManagedDeployment,
  indent: string,
  nl: string
): string {
  const lines: string[] = [
    `${indent}- model_name: ${formatYamlScalar(dep.modelName)}`,
    `${indent}  litellm_params:`,
    `${indent}    model: ${formatYamlScalar(dep.targetModel)}`,
  ];
  if (dep.apiKeyRef) {
    lines.push(`${indent}    api_key: ${dep.apiKeyRef}`);
  }
  if (dep.apiBase) {
    lines.push(`${indent}    api_base: ${formatYamlScalar(dep.apiBase)}`);
  }
  return lines.join(nl) + nl;
}

export function planLiteLLMConfigSync(input: LiteLLMSyncPlanInput): LiteLLMSyncPlanResult {
  const comboAlias = input.comboAlias.trim();
  if (!comboAlias || !/^[A-Za-z0-9._-]+$/.test(comboAlias)) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `Invalid comboAlias "${input.comboAlias}"; use alphanumeric, '.', '_', or '-'.`
    );
  }
  if (input.steps.length < 2) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `LiteLLM combo "${comboAlias}" requires at least 2 steps (Invariant I3).`
    );
  }

  // 1. Validate EVERY input step for forbidden plaintext secrets BEFORE reading/writing disk
  const normalizedInputs: LiteLLMSyncStepInput[] = input.steps.map((raw, idx) => {
    const obj: LiteLLMSyncStepInput = typeof raw === 'string' ? { step: raw } : raw;
    assertValidLiteLLMApiKeyRef(obj.apiKeyRef, `step[${idx}] (${obj.step})`);
    return obj;
  });

  const rawYaml = input.rawYaml ?? fs.readFileSync(input.configPath, 'utf8');
  const nl = detectNewline(rawYaml);
  const doc = parseDocument(rawYaml, { keepSourceTokens: true, logLevel: 'silent' });
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `Invalid LiteLLM YAML in ${input.configPath}: ${doc.errors[0]?.message ?? 'root must be a YAML map'}`
    );
  }

  const root = doc.contents;
  const inspected = inspectLiteLLMMyamlText(rawYaml, input.configPath);

  // Map existing safe api_key / api_base values by (modelName) and by (provider)
  const existingByModelName = new Map<string, LiteLLMDeploymentSummary>();
  const existingKeyByProvider = new Map<string, string>();
  for (const dep of inspected.deployments) {
    if (!existingByModelName.has(dep.modelName)) {
      existingByModelName.set(dep.modelName, dep);
    }
    if (dep.isEnvReference && dep.apiKeyEnvRef && !existingKeyByProvider.has(dep.provider)) {
      existingKeyByProvider.set(dep.provider, dep.apiKeyEnvRef);
    }
  }

  const managedDeployments: PlannedLiteLLMManagedDeployment[] = normalizedInputs.map((stepObj, idx) => {
    const targetModel = stepObj.step.trim();
    const provider = extractProviderPrefix(targetModel);
    const modelName =
      stepObj.modelName?.trim() || (idx === 0 ? comboAlias : `${comboAlias}-fb${idx}`);

    const prevSlot = existingByModelName.get(modelName);
    const resolvedKeyRef =
      stepObj.apiKeyRef?.trim() ??
      (prevSlot?.provider === provider && prevSlot.isEnvReference ? prevSlot.apiKeyEnvRef : null) ??
      existingKeyByProvider.get(provider) ??
      defaultEnvRefForProvider(provider);

    assertValidLiteLLMApiKeyRef(resolvedKeyRef, `${modelName} (${targetModel})`);

    const resolvedApiBase =
      stepObj.apiBase !== undefined
        ? stepObj.apiBase.trim() || null
        : prevSlot && prevSlot.provider === provider
          ? prevSlot.apiBase
          : null;

    return {
      modelName,
      targetModel,
      provider,
      apiKeyRef: resolvedKeyRef,
      apiBase: resolvedApiBase,
    };
  });

  const fallbackTargets = managedDeployments.slice(1).map((d) => d.modelName);
  const desiredPoolStrategy =
    input.routingStrategy && input.routingStrategy !== 'fallbacks'
      ? input.routingStrategy
      : null;

  // Check I4 idempotency against current state before building span edits
  const currentManaged = inspected.deployments.filter((d) =>
    isManagedComboModelName(d.modelName, comboAlias)
  );
  const managedListIdentical =
    currentManaged.length === managedDeployments.length &&
    currentManaged.every((cur, idx) => {
      const want = managedDeployments[idx]!;
      return (
        cur.modelName === want.modelName &&
        cur.targetModel === want.targetModel &&
        cur.apiKeyEnvRef === want.apiKeyRef &&
        cur.apiBase === want.apiBase
      );
    });

  const currentFallbackObj = inspected.routerSettings.fallbacks.find((f) =>
    Object.prototype.hasOwnProperty.call(f, comboAlias)
  );
  const currentFallbackTargets = currentFallbackObj?.[comboAlias] ?? null;
  const fallbacksIdentical =
    currentFallbackTargets !== null &&
    currentFallbackTargets.length === fallbackTargets.length &&
    currentFallbackTargets.every((t, i) => t === fallbackTargets[i]);

  const strategyIdentical =
    desiredPoolStrategy === null ||
    inspected.routerSettings.routingStrategy === desiredPoolStrategy;

  const planHash = sha256Hex(
    JSON.stringify({
      comboAlias,
      managedDeployments,
      fallbackTargets,
      desiredPoolStrategy,
    })
  );

  if (managedListIdentical && fallbacksIdentical && strategyIdentical) {
    return {
      configPath: input.configPath,
      comboAlias,
      changed: false,
      diffHunks: 0,
      planHash,
      managedDeployments,
      fallbackTargets,
      effectiveRoutingStrategy: inspected.routerSettings.routingStrategy,
      plannedYaml: rawYaml,
    };
  }

  // Build surgical CST/AST span edits
  const edits: SpanEdit[] = [];

  // 1. `model_list` span surgery
  const modelListNode = root.get('model_list', true);
  if (isSeq(modelListNode) && modelListNode.items.length > 0) {
    const managedItemSpans: Array<{ start: number; end: number; indent: string }> = [];
    let lastItemSpan: { start: number; end: number; indent: string } | null = null;

    for (const item of modelListNode.items) {
      if (!isMap(item)) continue;
      const span = getSeqItemLineSpan(rawYaml, item);
      lastItemSpan = span;
      const mName = String(item.get('model_name') ?? '').trim();
      if (isManagedComboModelName(mName, comboAlias)) {
        managedItemSpans.push(span);
      }
    }

    if (!managedListIdentical) {
      if (managedItemSpans.length > 0) {
        const firstSpan = managedItemSpans[0]!;
        const renderedManaged = managedDeployments
          .map((d) => renderManagedDeploymentYaml(d, firstSpan.indent, nl))
          .join('');
        edits.push({
          start: firstSpan.start,
          end: firstSpan.end,
          replacement: renderedManaged,
        });
        for (let i = 1; i < managedItemSpans.length; i += 1) {
          edits.push({
            start: managedItemSpans[i]!.start,
            end: managedItemSpans[i]!.end,
            replacement: '',
          });
        }
      } else if (lastItemSpan) {
        const renderedManaged = managedDeployments
          .map((d) => renderManagedDeploymentYaml(d, lastItemSpan.indent, nl))
          .join('');
        edits.push({
          start: lastItemSpan.end,
          end: lastItemSpan.end,
          replacement: renderedManaged,
        });
      }
    }
  } else {
    const renderedManaged = managedDeployments
      .map((d) => renderManagedDeploymentYaml(d, '  ', nl))
      .join('');
    const block = `${rawYaml.endsWith('\n') ? '' : nl}model_list:${nl}${renderedManaged}`;
    edits.push({
      start: rawYaml.length,
      end: rawYaml.length,
      replacement: block,
    });
  }

  // 2. `router_settings` span surgery (`fallbacks` & optional `routing_strategy`)
  const routerPair = root.items.find(
    (p) => isScalar(p.key) && String(p.key.value) === 'router_settings'
  );
  const renderedFallbackLine = (indent: string): string =>
    `${indent}- ${formatYamlScalar(comboAlias)}: [${fallbackTargets.map((f) => JSON.stringify(f)).join(', ')}]${nl}`;

  if (routerPair && isMap(routerPair.value)) {
    const routerMap = routerPair.value;

    if (!strategyIdentical && desiredPoolStrategy !== null) {
      const stratNode = routerMap.get('routing_strategy', true);
      if (isScalar(stratNode) && stratNode.range) {
        edits.push({
          start: stratNode.range[0],
          end: stratNode.range[1],
          replacement: desiredPoolStrategy,
        });
      }
    }

    if (!fallbacksIdentical) {
      const fallbacksNode = routerMap.get('fallbacks', true);
      if (isSeq(fallbacksNode) && fallbacksNode.items.length > 0) {
        let matchedSpan: { start: number; end: number; indent: string } | null = null;
        let lastFbSpan: { start: number; end: number; indent: string } | null = null;
        for (const fbItem of fallbacksNode.items) {
          if (!isMap(fbItem)) continue;
          const span = getSeqItemLineSpan(rawYaml, fbItem);
          lastFbSpan = span;
          if (fbItem.has(comboAlias)) {
            matchedSpan = span;
          }
        }
        if (matchedSpan) {
          edits.push({
            start: matchedSpan.start,
            end: matchedSpan.end,
            replacement: renderedFallbackLine(matchedSpan.indent),
          });
        } else if (lastFbSpan) {
          edits.push({
            start: lastFbSpan.end,
            end: lastFbSpan.end,
            replacement: renderedFallbackLine(lastFbSpan.indent),
          });
        }
      } else if (routerMap.range) {
        const routerSpanEnd = getSeqOrMapInsertOffset(rawYaml, routerMap);
        const block = `  fallbacks:${nl}${renderedFallbackLine('    ')}`;
        edits.push({
          start: routerSpanEnd,
          end: routerSpanEnd,
          replacement: block,
        });
      }
    }
  } else {
    const strat = desiredPoolStrategy ?? 'simple-shuffle';
    const routerBlock = [
      `${rawYaml.endsWith('\n') ? '' : nl}router_settings:`,
      `  routing_strategy: ${strat}`,
      `  num_retries: 2`,
      `  fallbacks:`,
      `    - ${formatYamlScalar(comboAlias)}: [${fallbackTargets.map((f) => JSON.stringify(f)).join(', ')}]`,
      '',
    ].join(nl);
    edits.push({
      start: rawYaml.length,
      end: rawYaml.length,
      replacement: routerBlock,
    });
  }

  const plannedYaml = applySpanReplacements(rawYaml, edits);
  const verifyDoc = parseDocument(plannedYaml, { keepSourceTokens: true, logLevel: 'silent' });
  if (verifyDoc.errors.length > 0) {
    throw new LiteLLMAdapterError(
      'LITELLM_CONFIG_INVALID',
      `Planned LiteLLM YAML failed validation: ${verifyDoc.errors[0]?.message}`
    );
  }

  return {
    configPath: input.configPath,
    comboAlias,
    changed: plannedYaml !== rawYaml,
    diffHunks: edits.length,
    planHash,
    managedDeployments,
    fallbackTargets,
    effectiveRoutingStrategy: desiredPoolStrategy ?? inspected.routerSettings.routingStrategy,
    plannedYaml,
  };
}

function getSeqOrMapInsertOffset(text: string, mapNode: YAMLMap): number {
  let lastPos = mapNode.range ? mapNode.range[0] : text.length;
  for (const p of mapNode.items) {
    const valRange = (p.value as { range?: [number, number, number] } | undefined)?.range;
    if (valRange && valRange[1] > lastPos) {
      lastPos = valRange[1];
    }
  }
  while (lastPos < text.length && text.charCodeAt(lastPos) !== 10 && text.charCodeAt(lastPos) !== 13) {
    lastPos += 1;
  }
  if (lastPos < text.length && text.charCodeAt(lastPos) === 13) lastPos += 1;
  if (lastPos < text.length && text.charCodeAt(lastPos) === 10) lastPos += 1;
  return lastPos;
}
