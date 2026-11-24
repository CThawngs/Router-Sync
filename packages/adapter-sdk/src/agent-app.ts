/**
 * packages/adapter-sdk/src/agent-app.ts
 *
 * Read-only inspection contract (`AgentAppAdapter`) + C45-WP2 Direction A
 * Harness Write Adapter contract (`HarnessWriteAdapter`, Phục vụ: S3) for agent
 * harnesses (Hermes Agent, OpenMausBot, OpenCode, DSH Desktop, and report-only
 * harnesses).
 *
 * Certainty tiers (docs/adapters/agent-apps.md):
 *   A — value read from an explicit field in the app's config.
 *   B — value inferred from a related field (e.g. a key name, a provider map).
 *   C — cannot be verified; the field is reported as 'UNKNOWN'.
 *
 * A secret value never crosses this contract. Providers expose only
 * `baseUrlPresent` / `keyPresent`, never the URL or the key.
 */

export type AgentAppFormat = 'json' | 'yaml' | 'toml' | 'sqlite' | 'unknown';

/** Tri-state: true / false / 'UNKNOWN' (tier C — cannot be verified). */
export type AgentAppValue = boolean | 'UNKNOWN';

export type AgentAppCertainty = 'A' | 'B' | 'C';

export type AgentAppProviderKind = 'router' | 'direct' | 'unknown';

export type AgentAppRouterRef = '9router' | 'omniroute' | 'UNKNOWN';

export interface AgentAppProvider {
  /** Provider identifier as the app names it. */
  id: string;
  /** 'router' when the provider points at 9Router/OmniRoute. */
  kind: AgentAppProviderKind;
  /** Whether a base URL field exists. The value is never reported. */
  baseUrlPresent: boolean;
  /** Whether a key material field exists. The value is never reported. */
  keyPresent: boolean;
}

export interface AgentAppModel {
  provider: string;
  id: string;
  /** Apps rarely store a per-model enable flag; absence is 'UNKNOWN', not false. */
  enabled: AgentAppValue;
}

export interface AgentAppInspection {
  app: string;
  /** Raw path. Mask with `maskHomePath` before writing it to a log or report. */
  configPath: string;
  format: AgentAppFormat;
  /** Always true on `AgentAppAdapter.inspect()`: inspection never writes. */
  readOnly: true;
  providers: AgentAppProvider[];
  models: AgentAppModel[];
  /** Active model id, `provider/model`, or 'UNKNOWN'. */
  activeModel: string | 'UNKNOWN';
  /** Router this app points at, when the config makes it explicit. */
  routerRef: AgentAppRouterRef;
  /** Weakest certainty among the reported values (A best, C worst). */
  certainty: AgentAppCertainty;
  /** Human-readable notes: masking applied, fields missing, tier-C fallbacks. */
  warnings: string[];
}

export interface AgentAppInspectOptions {
  /** Explicit config file, overriding the app's default location. */
  configPath?: string | undefined;
  /** Override for the user home directory (tests use a temp dir). */
  homeDir?: string | undefined;
  /** Files larger than this are rejected instead of parsed. Default 4 MiB. */
  maxBytes?: number | undefined;
}

export interface AgentAppAdapter {
  readonly app: string;
  readonly format: AgentAppFormat;
  /** Default config path for this app under `homeDir`. */
  defaultConfigPath(homeDir: string): string;
  /** Read the app's config and normalize it. Never writes. */
  inspect(options?: AgentAppInspectOptions): Promise<AgentAppInspection>;
}

/** Reason an inspection could not produce a result. */
export type AgentAppInspectErrorCode = 'ENOENT' | 'PARSE' | 'TOO_LARGE' | 'UNSUPPORTED';

// ---------------------------------------------------------------------------
// C45-WP2 Direction A Harness Write Adapter Contract (Phục vụ: S3)
// ---------------------------------------------------------------------------

export type HarnessDirectionAMode = 'write-adapter' | 'report-only' | 'CHƯA-XÁC-MINH';

export interface HarnessProviderCatalog {
  liveModels: string[];
  deprecatedModels: string[];
}

export type HarnessCatalogInput = Record<string, HarnessProviderCatalog>;

export interface HarnessModelAddition {
  provider: string;
  model: string;
}

export interface HarnessModelRemoval {
  provider: string;
  model: string;
  reason: string;
}

export interface HarnessDefaultSlotWarning {
  slot: string;
  currentModel: string;
  suggestion: string;
}

export interface HarnessModelPlan {
  app: string;
  configPath: string;
  directionAMode: HarnessDirectionAMode;
  editable: boolean;
  targetProviders: string[];
  additions: HarnessModelAddition[];
  removals: HarnessModelRemoval[];
  defaultSlotWarnings: HarnessDefaultSlotWarning[];
  guidance: string[];
  planHash: string;
  reloadRequired: boolean;
  runningProcesses: string[];
}

export interface HarnessApplyResult {
  app: string;
  configPath: string;
  backupPath: string;
  applied: boolean;
  rolledBack: boolean;
  readBackVerified: boolean;
  reloadRequired: boolean;
  runningProcesses: string[];
  planHash: string;
  preSha256: string;
  postSha256: string;
  message: string;
}

export interface HarnessRollbackResult {
  app: string;
  configPath: string;
  backupPath: string;
  restored: boolean;
  byteIdenticalToPreApply: boolean;
  postSha256: string;
}

export interface HarnessPlanOptions {
  configPath?: string | undefined;
  homeDir?: string | undefined;
  catalog: HarnessCatalogInput;
  processRunner?: (() => string[]) | undefined;
}

export interface HarnessApplyOptions extends HarnessPlanOptions {
  expectedPlanHash?: string | undefined;
  backupPath?: string | undefined;
  injectReadBackFault?: boolean | ((content: string) => void) | undefined;
}

export interface HarnessRollbackOptions {
  configPath: string;
  backupPath?: string | undefined;
  expectedPreSha256?: string | undefined;
}

export interface HarnessWriteAdapter {
  readonly app: string;
  readonly directionAMode: HarnessDirectionAMode;
  plan(options: HarnessPlanOptions): Promise<HarnessModelPlan>;
  apply(options: HarnessApplyOptions): Promise<HarnessApplyResult>;
  rollback(options: HarnessRollbackOptions): Promise<HarnessRollbackResult>;
}

/**
 * Replaces the user's home directory with `<HOME>` so a path can be logged.
 * Both separators are handled because configs quote paths in either style.
 */
export function maskHomePath(target: string, homeDir: string): string {
  const forms = [homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\//g, '\\')].filter(Boolean);
  let out = target;
  for (const form of forms) {
    out = out.split(form).join('<HOME>');
  }
  return out;
}