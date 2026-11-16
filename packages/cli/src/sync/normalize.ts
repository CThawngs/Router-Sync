/**
 * packages/cli/src/sync/normalize.ts
 *
 * Pure namespace normalizer for `routersync sync` (ROUND 56 rule R6,
 * ADR-PROVIDER-SYNC-01 §2).
 *
 * A model identifier reaches RouterSync in three shapes and all three must
 * collapse onto the same comparison key before any removal decision is made:
 *
 *   1. combo step     `nvidia/deepseek-ai/deepseek-v4.1-flash`
 *   2. provider form  `deepseek-ai/deepseek-v4.1-flash`
 *   3. catalog key    `nvidia:deepseek-ai/deepseek-v4.1-flash`
 *
 * STRICTLY PURE: no I/O, no mutation of inputs, deterministic output.
 */

/** Routing/quantisation variants that are not part of the model identity. */
const VARIANT_SUFFIXES = [
  ':free',
  ':nitro',
  ':extended',
  ':thinking',
  ':online',
  ':beta',
] as const;

export interface ComboStep {
  /** Original string as stored in the combo row. */
  readonly raw: string;
  /** Provider namespace, lower-cased. Empty when the step has no slash. */
  readonly prefix: string;
  /** Model part after the provider namespace, original casing. */
  readonly model: string;
  /** Cross-form comparison key: `<prefix>/<normalized-model>`. */
  readonly key: string;
}

export interface SplitStep {
  readonly prefix: string;
  readonly model: string;
}

/**
 * Splits `prefix/rest` at the FIRST slash. `rest` keeps its own slashes
 * (`nvidia/deepseek-ai/model` -> prefix `nvidia`, model `deepseek-ai/model`).
 */
export function splitStep(step: string): SplitStep {
  const trimmed = step.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return { prefix: '', model: trimmed };
  return {
    prefix: trimmed.slice(0, slash).toLowerCase(),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * Reduces a model name to its identity across provider namespaces.
 *
 * Handles: case, surrounding whitespace, Google's `models/` prefix,
 * Cloudflare's `@cf/` namespace, and OpenRouter routing variants.
 */
export function normalizeModelName(raw: string): string {
  let out = raw.trim().toLowerCase();

  if (out.startsWith('models/')) out = out.slice('models/'.length);
  while (out.startsWith('@cf/')) out = out.slice('@cf/'.length);

  for (const suffix of VARIANT_SUFFIXES) {
    if (out.endsWith(suffix) && out.length > suffix.length) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }

  return out;
}

/** Builds the comparison key for one namespace + model pair. */
export function comparisonKey(prefix: string, model: string): string {
  return `${prefix.trim().toLowerCase()}/${normalizeModelName(model)}`;
}

/** Parses a combo step into its three representation forms. */
export function parseComboStep(step: string): ComboStep {
  const { prefix, model } = splitStep(step);
  return { raw: step, prefix, model, key: comparisonKey(prefix, model) };
}

/**
 * Builds the catalog-key form (`provider:model`) used by
 * `%APPDATA%\9router\model-catalog.json`.
 */
export function catalogKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${normalizeModelName(model)}`;
}

/** Comparison key for a model id returned by a provider's live list. */
export function liveKey(prefix: string, liveModelId: string): string {
  return comparisonKey(prefix, liveModelId);
}

/** True when a live list contains the model referenced by `step`. */
export function stepExistsIn(step: ComboStep, liveKeys: ReadonlySet<string>): boolean {
  return liveKeys.has(step.key);
}
