/**
 * packages/mcp-server/src/server.ts
 *
 * RouterSync Read-Only MCP Server (Condition C1, Spec §13.2).
 * Provides 24 strictly read-only inspection, diagnostic, and query tools.
 * ZERO write tools permitted.
 *
 * Every tool reads a real source: a router adapter, a state file the daemon
 * writes, the documentation tree, or a runtime Zod schema. When the source is
 * absent the tool reports the absence. No tool invents a healthy value, a fixed
 * conclusion, or a sample item.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { OmniRouteAdapter } from '@routersync/adapter-omniroute';
import { NineRouterAdapter } from '@routersync/adapter-9router';
import {
  ComboDefinitionSchema,
  INTERVIEW_QUESTIONS,
  ModelCapabilitiesSchema,
  PlanSchema,
  hasWrittenEvidence,
  planCombos,
  validateInvariants,
  setConfiguredRouterDbPaths,
  getConfiguredRouterDbPath,
  resolveConfiguredDbPaths,
  locateRouterDb,
  readRouterModelState,
  classifyModelTier,
  buildProviderModelUniverse,
  type ComboDefinition,
  type ModelInfo,
  type TieredModelEntry,
  type ProviderModelUniverse,
} from '@routersync/core';
import { paginateArray } from './pagination.js';
import { sanitizeObject, sanitizeUntrustedString } from './sanitize.js';
import { searchDocs } from './docs.js';
import { describeZod } from './schema-reflect.js';
import {
  ageMinutes,
  describeReadFailure,
  diffIds,
  latestFileIn,
  readJsonFile,
  resolveStatePaths,
  statFile,
  type InboxFile,
  type InboxItem,
  type TickCatalogFile,
  type TickStatusFile,
  type VerifyRecord,
  type VerifyStatusFile,
} from './state.js';

export const READ_ONLY_TOOL_NAMES = [
  'detect_routers',
  'get_config',
  'validate_config',
  'list_models',
  'list_model_tiers',
  'list_combos',
  'status',
  'plan',
  'sync_plan',
  'diff',
  'health',
  'discover',
  'scan_completeness',
  'research_queue',
  'research_evidence',
  'schedule_status',
  'autopilot_status',
  'search_docs',
  'inbox_list',
  'verify_requests',
  'get_item',
  'list_traits',
  'list_strategies',
  'get_schema',
  'profile_interview',
] as const;

// W5 propose tools removed in C4f: they echoed payloads without storing anything
// and inflated the public tool count from 24 to 28. Read-only surface keeps 24.

export type ReadOnlyToolName = typeof READ_ONLY_TOOL_NAMES[number];

export interface ServerOptions {
  configPath?: string | undefined;
  mockCombos?: ComboDefinition[] | undefined;
  mockCatalog?: ModelInfo[] | undefined;
}

interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Invariants this server can evaluate from combos plus catalog alone.
 * I4 needs a second identical apply, I5 needs a plan, and I8 needs a write
 * sequence, so those three are reported as not evaluated rather than assumed.
 */
const INVARIANTS_WITH_COMBOS_ONLY = ['I1', 'I2', 'I3', 'I6', 'I7'] as const;
const INVARIANTS_NEEDING_MORE_STATE = ['I4', 'I5', 'I8'] as const;

function respond(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(sanitizeObject(payload), null, 2) }] };
}

export function createRouterSyncMcpServer(options: ServerOptions = {}): McpServer {
  // C4o/O2: install configured router DB paths at MCP server startup
  let parsedConfig: { routers?: Array<{ adapter?: string; baseUrl?: string; db?: { path?: string } }> } | undefined;
  try {
    const paths = resolveStatePaths();
    const candidates = [
      options.configPath,
      path.join(paths.configDir, 'routersync.yaml'),
      path.join(paths.configDir, 'config.yaml'),
      path.join(process.cwd(), 'routersync.yaml'),
      path.join(process.cwd(), 'config.yaml'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        const raw = fs.readFileSync(c, 'utf8');
        const parsed = parseYaml(raw) as { routers?: Array<{ adapter?: string; baseUrl?: string; db?: { path?: string } }> };
        parsedConfig = parsed;
        const configDir = path.dirname(path.resolve(c));
        const { paths: forCore, duplicateAdapter } = resolveConfiguredDbPaths(parsed, configDir);
        if (!duplicateAdapter && Object.keys(forCore).length > 0) {
          setConfiguredRouterDbPaths(forCore, { source: 'config' });
        }
        break;
      }
    }
  } catch {
    // ignore
  }

  const server = new McpServer({
    name: 'routersync-mcp',
    version: '0.1.0',
  });

  const omniCfg = parsedConfig?.routers?.find((r) => r.adapter === 'omniroute');
  const nineCfg = parsedConfig?.routers?.find((r) => r.adapter === '9router');

  const omniBaseUrl = omniCfg?.baseUrl?.replace(/\/+$/, '') ?? null;
  const nineBaseUrl = nineCfg?.baseUrl?.replace(/\/+$/, '') ?? null;

  const omniHealthUrl = omniBaseUrl ? `${omniBaseUrl}/api/health` : null;
  const nineHealthUrl = nineBaseUrl ? `${nineBaseUrl}/api/health` : null;

  const omniDb = getConfiguredRouterDbPath('omniroute');
  const nineDb = getConfiguredRouterDbPath('9router');
  const omniAdapter = new OmniRouteAdapter({
    dbPath: omniDb,
    apiBaseUrl: omniBaseUrl ?? undefined,
    healthUrl: omniHealthUrl ?? undefined,
  });
  const nineAdapter = new NineRouterAdapter({
    dbPath: nineDb,
    apiBaseUrl: nineBaseUrl ?? undefined,
    healthUrl: nineHealthUrl ?? undefined,
  });

  async function getAllCombos(): Promise<ComboDefinition[]> {
    if (options.mockCombos) return options.mockCombos;
    const omniCombos = await omniAdapter.readCombos().catch(() => [] as ComboDefinition[]);
    const nineCombos = await nineAdapter.readCombos().catch(() => [] as ComboDefinition[]);
    return [...omniCombos, ...nineCombos];
  }

  async function getAllCatalog(): Promise<ModelInfo[]> {
    if (options.mockCatalog) return options.mockCatalog;
    const omniCat = await omniAdapter.readCatalog().catch(() => [] as ModelInfo[]);
    const nineCat = await nineAdapter.readCatalog().catch(() => [] as ModelInfo[]);
    return [...omniCat, ...nineCat];
  }

  function configCandidates(explicit?: string): string[] {
    const paths = resolveStatePaths();
    const list = [
      explicit,
      options.configPath,
      path.join(paths.configDir, 'routersync.yaml'),
      path.join(process.cwd(), 'routersync.yaml'),
    ];
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of list) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
    return candidates;
  }

  // 1. detect_routers
  server.tool(
    'detect_routers',
    'Scans local system for active LLM routers (OmniRoute, 9Router) via HTTP probes and database file detection',
    {},
    async () => {
      const omniHealth = await omniAdapter
        .checkHealth()
        .catch((error: unknown) => ({ ok: false, status: 'down' as const, timestamp: '', message: String(error) }));
      const nineHealth = await nineAdapter
        .checkHealth()
        .catch((error: unknown) => ({ ok: false, status: 'down' as const, timestamp: '', message: String(error) }));

      const omniDbPath = locateRouterDb('omniroute');
      const nineDbPath = locateRouterDb('9router');

      const detected = [
        {
          router: 'omniroute',
          healthUrl: omniHealthUrl,
          adapterOk: omniHealth.ok,
          adapterStatus: omniHealth.status,
          adapterMessage: omniHealth.message ?? null,
          databasePath: omniDbPath,
          databasePresent: fs.existsSync(omniDbPath),
        },
        {
          router: '9router',
          healthUrl: nineHealthUrl,
          adapterOk: nineHealth.ok,
          adapterStatus: nineHealth.status,
          adapterMessage: nineHealth.message ?? null,
          databasePath: nineDbPath,
          databasePresent: fs.existsSync(nineDbPath),
        },
      ];

      return respond({
        detected,
        totalDetected: detected.filter((entry) => entry.adapterOk || entry.databasePresent).length,
        probesAreZeroToken: true,
      });
    }
  );

  // 2. get_config
  server.tool(
    'get_config',
    'Returns the currently active routersync.yaml configuration with all secrets and API keys strictly redacted',
    {
      configPath: z.string().optional().describe('Optional explicit path to routersync.yaml'),
    },
    async (args) => {
      const candidates = configCandidates(args.configPath);
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      if (!found) {
        return respond({
          found: false,
          checkedPaths: candidates,
          message: 'No routersync.yaml exists in any checked location',
        });
      }
      const raw = fs.readFileSync(found, 'utf8');
      return respond({
        found: true,
        path: found,
        bytes: raw.length,
        content: sanitizeUntrustedString(raw, 4000),
      });
    }
  );

  // 3. validate_config
  server.tool(
    'validate_config',
    'Parses a routersync.yaml file, checks its structure against the domain schemas, and evaluates the invariants that need only combos and a catalog',
    {
      configPath: z.string().optional().describe('Path to the config file to validate'),
    },
    async (args) => {
      const candidates = configCandidates(args.configPath);
      const target = candidates.find((candidate) => fs.existsSync(candidate));
      if (!target) {
        return respond({
          valid: false,
          status: 'FILE_NOT_FOUND',
          checkedPaths: candidates,
          invariantsEvaluated: [],
          invariantsNotEvaluated: [...INVARIANTS_NEEDING_MORE_STATE],
        });
      }

      let document: unknown;
      try {
        document = parseYaml(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        return respond({
          valid: false,
          status: 'PARSE_ERROR',
          configPath: target,
          error: error instanceof Error ? error.message : String(error),
          invariantsEvaluated: [],
          invariantsNotEvaluated: [...INVARIANTS_NEEDING_MORE_STATE],
        });
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      const configCombos: ComboDefinition[] = [];

      if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        errors.push('ROOT_NOT_OBJECT');
      } else {
        const record = document as Record<string, unknown>;
        const knownKeys = new Set(['version', 'routers', 'combos', 'adopt']);

        if ('version' in record && typeof record['version'] !== 'number') {
          errors.push('version: EXPECTED_NUMBER');
        }
        if ('routers' in record && !Array.isArray(record['routers'])) {
          errors.push('routers: EXPECTED_ARRAY');
        }
        if ('adopt' in record && !Array.isArray(record['adopt'])) {
          errors.push('adopt: EXPECTED_ARRAY');
        }

        const rawCombos = record['combos'];
        if (rawCombos !== undefined) {
          if (!Array.isArray(rawCombos)) {
            errors.push('combos: EXPECTED_ARRAY');
          } else {
            rawCombos.forEach((entry, index) => {
              const parsed = ComboDefinitionSchema.safeParse(entry);
              if (parsed.success) {
                configCombos.push(parsed.data);
                return;
              }
              const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'combo'}: ${issue.message}`);
              errors.push(`combos[${index}]: ${issues.join('; ')}`);
            });
          }
        }

        for (const key of Object.keys(record)) {
          if (!knownKeys.has(key)) warnings.push(`unknown top-level key: ${key}`);
        }
      }

      let invariantViolations: unknown[] = [];
      let invariantsEvaluated: string[] = [];
      if (configCombos.length > 0) {
        const catalog = await getAllCatalog();
        const result = validateInvariants({ combos: configCombos, catalog });
        invariantViolations = result.violations;
        invariantsEvaluated = [...INVARIANTS_WITH_COMBOS_ONLY];
      }

      const hasInvariantError = invariantViolations.some(
        (violation) => (violation as { severity?: string }).severity === 'error'
      );

      return respond({
        valid: errors.length === 0 && !hasInvariantError,
        status: errors.length === 0 && !hasInvariantError ? 'VALID' : 'INVALID',
        configPath: target,
        combosParsed: configCombos.length,
        errors,
        warnings,
        invariantsEvaluated,
        invariantsNotEvaluated: [...INVARIANTS_NEEDING_MORE_STATE],
        invariantViolations,
      });
    }
  );

  // 4. list_models
  server.tool(
    'list_models',
    'Lists normalized LLM models available across routers with cursor-based pagination and trait metadata',
    {
      cursor: z.string().optional().describe('Cursor token for pagination'),
      limit: z.number().optional().describe('Items per page (default 50, maximum 200)'),
      provider: z.string().optional().describe('Filter by provider name'),
    },
    async (args) => {
      let catalog = await getAllCatalog();
      if (args.provider) {
        const wanted = args.provider.toLowerCase();
        catalog = catalog.filter((model) => model.provider.toLowerCase() === wanted);
      }
      const page = paginateArray(catalog, { cursor: args.cursor, limit: args.limit });
      return respond(page);
    }
  );

  // 4b. list_model_tiers (3-Tier Universe: R3)
  server.tool(
    'list_model_tiers',
    'Lists models organized into Tier A (active in router/combos), Tier B (known/disabled/deprecated), Tier C (discovered in public sources/catalog), and UNKNOWN',
    {
      provider: z.string().optional().describe('Filter by provider name (e.g. gemini, openrouter)'),
      tier: z.enum(['A', 'B', 'C', 'UNKNOWN']).optional().describe('Filter by model tier (A, B, C, or UNKNOWN)'),
      router: z.string().optional().describe('Filter by router id'),
    },
    async (args) => {
      const combos = await getAllCombos();
      const catalog = await getAllCatalog();

      const activeComboModelIds = new Set<string>();
      for (const cb of combos) {
        for (const m of cb.models) {
          activeComboModelIds.add(m);
        }
      }

      const targetRouter = args.router ?? '9router';
      const routerState = readRouterModelState(targetRouter, { comboModels: activeComboModelIds });

      const providerEntries = new Map<string, TieredModelEntry[]>();

      for (const model of catalog) {
        const prov = (model.provider || 'unknown').toLowerCase();
        if (args.provider && prov !== args.provider.toLowerCase()) continue;

        if (!providerEntries.has(prov)) {
          providerEntries.set(prov, []);
        }

        const isDeadOrQuarantined = model.status === 'dead' || model.status === 'quarantined';
        const classification = routerState.classify(prov, model.id);
        let tier = classification.tier;
        if (isDeadOrQuarantined) {
          tier = 'B';
        } else if (tier === 'UNKNOWN' && (classification.inCombo || model.status === 'active')) {
          tier = 'A';
        }

        const entry: TieredModelEntry = {
          modelId: model.id,
          provider: prov,
          tier,
          inCombo: classification.inCombo,
          reason: classification.reason,
          capabilities: model.capabilities as Record<string, string | number | boolean> | undefined,
          source: 'router_catalog',
        };

        providerEntries.get(prov)!.push(entry);
      }

      const universes: ProviderModelUniverse[] = Array.from(providerEntries.entries()).map(
        ([prov, entries]) => {
          const universe = buildProviderModelUniverse(prov, entries);
          if (args.tier) {
            return {
              ...universe,
              tiers: {
                A: args.tier === 'A' ? universe.tiers.A : [],
                B: args.tier === 'B' ? universe.tiers.B : [],
                C: args.tier === 'C' ? universe.tiers.C : [],
                UNKNOWN: args.tier === 'UNKNOWN' ? (universe.tiers.UNKNOWN ?? []) : [],
              },
            };
          }
          return universe;
        }
      );

      const totalCounts = universes.reduce(
        (acc, u) => ({
          A: acc.A + u.counts.A,
          B: acc.B + u.counts.B,
          C: acc.C + u.counts.C,
          UNKNOWN: acc.UNKNOWN + (u.counts.UNKNOWN ?? 0),
          total: acc.total + u.counts.total,
        }),
        { A: 0, B: 0, C: 0, UNKNOWN: 0, total: 0 }
      );

      return respond({
        universes,
        totalCounts,
      });
    }
  );

  // 5. list_combos
  server.tool(
    'list_combos',
    'Lists model routing combos across configured routers with pagination and strategy details',
    {
      cursor: z.string().optional().describe('Cursor token for pagination'),
      limit: z.number().optional().describe('Items per page (default 50, maximum 200)'),
    },
    async (args) => {
      const combos = await getAllCombos();
      const page = paginateArray(combos, { cursor: args.cursor, limit: args.limit });
      return respond(page);
    }
  );

  // 6. status
  server.tool(
    'status',
    'Reports router synchronization status with apply states derived from write evidence and read-back verification levels',
    {},
    async () => {
      const paths = resolveStatePaths();
      const combos = await getAllCombos();
      const catalog = await getAllCatalog();

      // R19-2 (DECISIONS 2026-10-18-01): an apply state describes a WRITE, so
      // it may only be published when there is EVIDENCE of that write. The
      // check is READ-ONLY (it never creates a file or a directory).
      const omniWritten = hasWrittenEvidence('omniroute');
      const nineWritten = hasWrittenEvidence('9router');
      const applyStates: Record<string, string> = {
        omniroute: omniWritten ? 'written-pending-reload' : 'unwritten',
        '9router': nineWritten ? 'written-pending-reload' : 'unwritten',
      };
      const pendingReloadRouters = Object.entries(applyStates)
        .filter(([, state]) => state === 'written-pending-reload')
        .map(([router]) => router);

      const tickStatus = readJsonFile<TickStatusFile>(paths.tickStatus);
      const catalogSnapshot = readJsonFile<TickCatalogFile>(paths.tickCatalog);
      const invariants = validateInvariants({ combos, catalog });

      const healthChecks = [
        { name: 'combosReadable', ok: combos.length > 0, detail: `${combos.length} combos` },
        { name: 'catalogReadable', ok: catalog.length > 0, detail: `${catalog.length} models` },
        {
          name: 'invariantsEvaluated',
          ok: invariants.valid,
          detail: `${invariants.violations.length} violation(s)`,
        },
        {
          name: 'tickStatusPresent',
          ok: tickStatus.ok,
          detail: tickStatus.ok ? tickStatus.filePath : describeReadFailure(tickStatus).reason,
        },
        {
          name: 'catalogSnapshotPresent',
          ok: catalogSnapshot.ok,
          detail: catalogSnapshot.ok
            ? Object.keys(catalogSnapshot.value.providers ?? {}).length + ' providers'
            : describeReadFailure(catalogSnapshot).reason,
        },
      ];

      return respond({
        healthy: healthChecks.every((check) => check.ok),
        healthChecks,
        totalRouters: [omniAdapter, nineAdapter].length,
        totalCombos: combos.length,
        totalModels: catalog.length,
        applyStates,
        pendingReloadRouters,
        invariants: {
          evaluated: [...INVARIANTS_WITH_COMBOS_ONLY],
          notEvaluated: [...INVARIANTS_NEEDING_MORE_STATE],
          valid: invariants.valid,
          violations: invariants.violations,
        },
        lastTick: tickStatus.ok
          ? {
              timestamp: tickStatus.value.timestamp ?? null,
              mode: tickStatus.value.mode ?? null,
              ageMinutes: ageMinutes(tickStatus.value.timestamp),
              requests: tickStatus.value.requests ?? 0,
              paidRequests: tickStatus.value.paidRequests ?? 0,
              tokens: tickStatus.value.tokens ?? 0,
              llmCalls: tickStatus.value.llmCalls ?? 0,
            }
          : { available: false, reason: describeReadFailure(tickStatus).reason },
        stateDir: paths.stateDir,
      });
    }
  );

  // 7. plan
  server.tool(
    'plan',
    'Calculates a deterministic synchronization plan without modifying live routers (pure dry-run)',
    {},
    async () => {
      const currentCombos = await getAllCombos();
      const catalog = await getAllCatalog();
      const plan = planCombos(currentCombos, catalog, [], { target: 'dry-run-plan' });
      return respond({
        plan,
        summary: {
          additions: plan.additions.length,
          modifications: plan.modifications.length,
          deletions: plan.deletions.length,
        },
      });
    }
  );

  // 8. search_docs
  server.tool(
    'search_docs',
    'Searches the Markdown documentation tree (docs/**/*.md and README.md) and returns file, line, and snippet for each literal match',
    {
      query: z.string().describe('Literal text to search for (case-insensitive)'),
      limit: z.number().optional().describe('Maximum hits to return (default 40)'),
    },
    async (args) => {
      const result = searchDocs({ query: args.query, maxHits: args.limit ?? 40 });
      return respond(result);
    }
  );

  // Labels that never need human research: already scanned-as-healthy,
  // quota-limited, or already confirmed-dead (unless they carry an L3 notice).
  // ĐÃ-XÁC-NHẬN-NGỪNG is intentionally NOT excluded: it stays researchable.
  const NON_RESEARCH_LABELS = new Set([
    'CHƯA-QUÉT', 'QUOTA', 'QUOTA-NO-LIST', 'ĐÃ-XÁC-NHẬN-CÒN',
  ]);

  function shouldResearch(record: VerifyRecord): boolean {
    const label = String(record.label ?? '');
    if (NON_RESEARCH_LABELS.has(label) && !(record.l3?.hasNotice === true)) return false;
    const absent = record.l1?.exists === false;
    const noticed = record.l3?.hasNotice === true;
    return absent || noticed;
  }

  function inboxActive(items: InboxItem[], includeHandled: boolean): InboxItem[] {
    const nowMs = Date.now();
    return items.filter((item) => {
      if (!includeHandled) {
        if (item.status === 'acknowledged') return false;
        if (item.status === 'snoozed' && item.snoozeUntil) {
          const snoozeMs = Date.parse(item.snoozeUntil);
          if (Number.isFinite(snoozeMs) && snoozeMs > nowMs) return false;
        }
      }
      return true;
    });
  }

  // 9. inbox_list
  server.tool(
    'inbox_list',
    'Lists notification items from the daemon inbox file. Defaults to active items only (not acknowledged, not currently snoozed). Use includeHandled to see everything.',
    {
      cursor: z.string().optional().describe('Cursor token for pagination'),
      limit: z.number().optional().describe('Items per page (default 50, maximum 200)'),
      includeHandled: z.boolean().optional().describe('Include acknowledged and still-snoozed items (default false)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const inbox = readJsonFile<InboxFile>(paths.inbox);
      const allItems: InboxItem[] = inbox.ok ? [...(inbox.value.items ?? [])] : [];

      // System-sourced event (Spec §33.3 / B8 + F1 tick inbox). Published only
      // when a snapshot proves a write happened, so an empty machine reports an
      // empty inbox instead of a reassuring placeholder.
      if (hasWrittenEvidence('9router')) {
        allItems.unshift({
          id: 'sys-pending-reload-9router',
          title: '9Router: apply state = written-pending-reload',
          type: 'warning',
          timestamp: new Date().toISOString(),
          body: 'A 9Router write is proven by a snapshot and has not been confirmed by a reload read-back yet.',
          proposed_by: { kind: 'system' },
        });
      }

      const active = inboxActive(allItems, args.includeHandled === true);
      const page = paginateArray(active, { cursor: args.cursor, limit: args.limit });
      return respond({
        ...page,
        source: inbox.ok
          ? { path: inbox.filePath, bytes: inbox.bytes, updatedAt: inbox.value.updatedAt ?? null }
          : describeReadFailure(inbox),
      });
    }
  );

  // 10. verify_requests
  server.tool(
    'verify_requests',
    'Returns up to 10 models from the verification ledger that still need human or web research, with the URLs the scan recorded',
    {
      limit: z.number().optional().describe('Maximum items to return (default 10)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const ledger = readJsonFile<VerifyStatusFile>(paths.verifyStatus);
      if (!ledger.ok) {
        return respond({ available: false, source: describeReadFailure(ledger), items: [] });
      }

      const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
      const records = ledger.value.records ?? [];

      // A record needs research when absent or carrying an L3 notice. CHƯA-QUÉT
      // and QUOTA labels are excluded. ĐÃ-XÁC-NHẬN-NGỪNG is intentionally
      // included and sorted first by severity, then newest verifiedAt.
      const SEVERITY_ORDER: Record<string, number> = {
        'ĐÃ-XÁC-NHẬN-NGỪNG': 0,
        'SẮP-NGỪNG': 1,
        'NGHI-NGỪNG': 2,
      };
      const needsResearch = records
        .filter(shouldResearch)
        .sort((a, b) => {
          const sa = SEVERITY_ORDER[a.label] ?? 99;
          const sb = SEVERITY_ORDER[b.label] ?? 99;
          if (sa !== sb) return sa - sb;
          const ta = Date.parse(a.verifiedAt ?? '0');
          const tb = Date.parse(b.verifiedAt ?? '0');
          return tb - ta; // newest first
        });

      const items = needsResearch.slice(0, limit).map((record) => ({
        id: record.id,
        prefix: record.prefix,
        label: record.label,
        question: record.l1?.exists === false
          ? 'Is this model still served by the provider?'
          : record.l3?.hasNotice === true
            ? 'Is this model reaching its announced shutdown date?'
            : 'Why was this model flagged for research?',
        suggestedUrls: [record.l2?.url, record.l3?.url, 'https://openrouter.ai/models', 'https://models.dev'].filter(
          (url): url is string => typeof url === 'string' && url.length > 0
        ),
        verifiedAt: record.verifiedAt ?? null,
      }));

      return respond({
        available: true,
        source: { path: ledger.filePath, timestamp: ledger.value.timestamp ?? null },
        totalNeedingResearch: needsResearch.length,
        items,
      });
    }
  );

  // 11. get_item
  server.tool(
    'get_item',
    'Retrieves details for a specific model, combo, or inbox item by identifier',
    {
      id: z.string().describe('Unique item identifier'),
      type: z.enum(['model', 'combo', 'inbox']).describe('Type of item'),
    },
    async (args) => {
      if (args.type === 'combo') {
        const combos = await getAllCombos();
        const found = combos.find((combo) => combo.id === args.id || combo.name === args.id);
        return respond(found ?? { found: false, id: args.id, type: 'combo' });
      }

      if (args.type === 'model') {
        const catalog = await getAllCatalog();
        const found = catalog.find((model) => model.id === args.id);
        return respond(found ?? { found: false, id: args.id, type: 'model' });
      }

      const paths = resolveStatePaths();
      const inbox = readJsonFile<InboxFile>(paths.inbox);
      const items: InboxItem[] = inbox.ok ? (inbox.value.items ?? []) : [];
      const found = items.find((item) => item.id === args.id);
      if (!found) {
        return respond({
          found: false,
          id: args.id,
          type: 'inbox',
          source: inbox.ok ? { path: inbox.filePath } : describeReadFailure(inbox),
        });
      }
      return respond({ found: true, id: args.id, type: 'inbox', item: found });
    }
  );

  // 12. list_traits
  server.tool(
    'list_traits',
    'Lists the capability flags declared by the ModelCapabilitiesSchema in @routersync/core, reflected from the live schema',
    {},
    async () => {
      const reflected = describeZod(ModelCapabilitiesSchema);
      const properties = reflected.properties ?? {};
      const traits = Object.entries(properties).map(([name, field]) => ({
        name,
        type: field.type,
        optional: field.optional === true,
      }));
      return respond({
        source: '@routersync/core ModelCapabilitiesSchema',
        traitCount: traits.length,
        traits,
      });
    }
  );

  // 13. list_strategies
  server.tool(
    'list_strategies',
    'Lists the routing strategies currently used by live combos, with the combos that use each one',
    {},
    async () => {
      const combos = await getAllCombos();
      const byStrategy = new Map<string, { strategy: string; combos: string[] }>();

      for (const combo of combos) {
        const strategy = combo.strategy ?? 'unspecified';
        const entry = byStrategy.get(strategy) ?? { strategy, combos: [] };
        entry.combos.push(combo.name);
        byStrategy.set(strategy, entry);
      }

      const strategies = [...byStrategy.values()]
        .map((entry) => ({ ...entry, comboCount: entry.combos.length }))
        .sort((a, b) => b.comboCount - a.comboCount);

      return respond({
        source: 'strategy field of each readable combo',
        comboCount: combos.length,
        strategies,
      });
    }
  );

  // 14. get_schema
  server.tool(
    'get_schema',
    'Returns the runtime Zod schema for a combo or a plan, and the structural contract validate_config actually enforces for a config file',
    {
      target: z.enum(['config', 'combo', 'plan']).optional().describe('Target schema name'),
    },
    async (args) => {
      const target = args.target ?? 'config';

      if (target === 'combo') {
        return respond({
          target,
          source: 'ComboDefinitionSchema',
          reflected: describeZod(ComboDefinitionSchema),
        });
      }

      if (target === 'plan') {
        return respond({
          target,
          source: 'PlanSchema',
          reflected: describeZod(PlanSchema),
        });
      }

      return respond({
        target,
        source: 'validate_config structural checks',
        note: 'This build has no config Zod schema; validate_config checks these keys and parses combos with ComboDefinitionSchema.',
        properties: {
          version: { type: 'number' },
          routers: { type: 'array' },
          combos: { type: 'array', items: describeZod(ComboDefinitionSchema) },
          adopt: { type: 'array' },
        },
      });
    }
  );

  // 15. sync_plan
  server.tool(
    'sync_plan',
    'Reconciles every managed combo against the live catalog and reports the step-level changes a sync would need, without writing',
    {},
    async () => {
      const combos = await getAllCombos();
      const catalog = await getAllCatalog();
      const liveIds = new Set(catalog.map((model) => model.id));

      const rows = combos
        .filter((combo) => combo.managed)
        .map((combo) => {
          const missing = combo.models.filter((modelId) => !liveIds.has(modelId));
          const minSteps = combo.minSteps ?? 2;
          // I3 is about the steps that survive the sync, not the ones on paper:
          // a five-step combo that loses four models ends up below minSteps.
          const remainingSteps = combo.models.length - missing.length;
          return {
            comboId: combo.id,
            name: combo.name,
            steps: combo.models.length,
            remainingSteps,
            minSteps,
            missingFromCatalog: missing,
            belowMinSteps: remainingSteps < minSteps,
            needsChange: missing.length > 0 || remainingSteps < minSteps,
          };
        });

      return respond({
        target: 'live-catalog',
        managedCombos: rows.length,
        combosNeedingChange: rows.filter((row) => row.needsChange).length,
        rows,
        note: 'Dry-run only: this reports what a sync would change.',
      });
    }
  );

  // 16. diff
  server.tool(
    'diff',
    'Compares the last daemon catalog snapshot with the live catalog and reports added and lost model ids per provider',
    {},
    async () => {
      const paths = resolveStatePaths();
      const snapshot = readJsonFile<TickCatalogFile>(paths.tickCatalog);
      if (!snapshot.ok) {
        return respond({ available: false, source: describeReadFailure(snapshot), providers: [] });
      }

      const catalog = await getAllCatalog();
      const liveByPrefix = new Map<string, string[]>();
      for (const model of catalog) {
        const prefix = model.provider;
        const bucket = liveByPrefix.get(prefix) ?? [];
        bucket.push(model.id);
        liveByPrefix.set(prefix, bucket);
      }

      const providers = Object.values(snapshot.value.providers ?? {}).map((provider) => {
        const scanned = provider.ids ?? [];
        const current = liveByPrefix.get(provider.prefix) ?? [];
        const difference = diffIds(scanned, current);
        return {
          prefix: provider.prefix,
          router: provider.router,
          scannedIds: scanned.length,
          liveIds: current.length,
          added: difference.added,
          lost: difference.lost,
        };
      });

      return respond({
        available: true,
        source: {
          path: snapshot.filePath,
          updatedAt: snapshot.value.updatedAt ?? null,
          ageMinutes: ageMinutes(snapshot.value.updatedAt),
        },
        providers,
      });
    }
  );

  // 17. health
  server.tool(
    'health',
    'Aggregates catalog, invariant, tick-status and verification-ledger checks into one read-only health report',
    {},
    async () => {
      const paths = resolveStatePaths();
      const combos = await getAllCombos();
      const catalog = await getAllCatalog();
      const tickStatus = readJsonFile<TickStatusFile>(paths.tickStatus);
      const ledger = readJsonFile<VerifyStatusFile>(paths.verifyStatus);
      const invariants = validateInvariants({ combos, catalog });

      const checks = [
        { name: 'combosReadable', ok: combos.length > 0, detail: `${combos.length} combos` },
        { name: 'catalogReadable', ok: catalog.length > 0, detail: `${catalog.length} models` },
        { name: 'invariantsValid', ok: invariants.valid, detail: `${invariants.violations.length} violation(s)` },
        {
          name: 'tickStatusPresent',
          ok: tickStatus.ok,
          detail: tickStatus.ok ? `${ageMinutes(tickStatus.value.timestamp) ?? '?'} min old` : describeReadFailure(tickStatus).reason,
        },
        {
          name: 'verificationLedgerPresent',
          ok: ledger.ok,
          detail: ledger.ok ? `${ledger.value.records?.length ?? 0} records` : describeReadFailure(ledger).reason,
        },
      ];

      return respond({
        ok: checks.every((check) => check.ok),
        checks,
        zeroTokens: true,
        labels: ledger.ok ? (ledger.value.labels ?? {}) : null,
        accounting: ledger.ok ? (ledger.value.accounting ?? null) : null,
      });
    }
  );

  // 18. discover
  server.tool(
    'discover',
    'Finds catalog models that no combo references, and separates the ones with zero recorded price',
    {
      limit: z.number().optional().describe('Maximum candidates to return (default 50)'),
    },
    async (args) => {
      const combos = await getAllCombos();
      const catalog = await getAllCatalog();
      const referenced = new Set<string>();
      for (const combo of combos) {
        for (const modelId of combo.models) referenced.add(modelId);
      }

      const unreferenced = catalog.filter((model) => !referenced.has(model.id));
      const isFree = (model: ModelInfo): boolean => {
        const pricing = model.pricing;
        if (!pricing) return false;
        return (
          (pricing.promptCostPerToken ?? 0) === 0 && (pricing.completionCostPerToken ?? 0) === 0
        );
      };

      const freeCandidates = unreferenced.filter(isFree);
      const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

      return respond({
        catalogSize: catalog.length,
        referencedByCombos: referenced.size,
        unreferenced: unreferenced.length,
        freeCandidates: freeCandidates.length,
        candidates: unreferenced.slice(0, limit).map((model) => ({
          id: model.id,
          provider: model.provider,
          zeroPrice: isFree(model),
          status: model.status ?? null,
        })),
        truncated: unreferenced.length > limit,
      });
    }
  );

  // 19. scan_completeness
  server.tool(
    'scan_completeness',
    'Reports per-provider scan completeness from the daemon catalog snapshot joined with the last tick status codes',
    {},
    async () => {
      const paths = resolveStatePaths();
      const snapshot = readJsonFile<TickCatalogFile>(paths.tickCatalog);
      if (!snapshot.ok) {
        return respond({ available: false, source: describeReadFailure(snapshot), providers: [] });
      }

      const tickStatus = readJsonFile<TickStatusFile>(paths.tickStatus);
      const statusByPrefix = new Map<string, NonNullable<TickStatusFile['providers']>[number]>();
      if (tickStatus.ok) {
        for (const provider of tickStatus.value.providers ?? []) {
          statusByPrefix.set(provider.prefix, provider);
        }
      }

      const providers = Object.values(snapshot.value.providers ?? {}).map((provider) => {
        const tick = statusByPrefix.get(provider.prefix);
        const httpStatus = tick?.status ?? null;
        let verdict: string;
        if (httpStatus === null) verdict = 'NO_TICK_STATUS';
        else if (httpStatus >= 200 && httpStatus < 300) verdict = 'COMPLETE';
        else if (httpStatus === 0) verdict = 'SKIPPED';
        else verdict = 'UPSTREAM_ERROR';

        return {
          prefix: provider.prefix,
          router: provider.router,
          ids: (provider.ids ?? []).length,
          contentHash: provider.contentHash ?? provider.hash ?? null,
          lastTickLabel: tick?.label ?? null,
          lastTickStatus: httpStatus,
          changedSincePreviousTick: tick?.changed ?? null,
          verdict,
        };
      });

      const counts = providers.reduce<Record<string, number>>((accumulator, provider) => {
        accumulator[provider.verdict] = (accumulator[provider.verdict] ?? 0) + 1;
        return accumulator;
      }, {});

      return respond({
        available: true,
        source: {
          catalog: snapshot.filePath,
          catalogUpdatedAt: snapshot.value.updatedAt ?? null,
          tickStatus: tickStatus.ok ? tickStatus.filePath : describeReadFailure(tickStatus).reason,
        },
        providerCount: providers.length,
        verdicts: counts,
        providers,
      });
    }
  );

  // 20. research_queue
  server.tool(
    'research_queue',
    'Reports the models the verification ledger still needs researched, grouped by the evidence that is missing',
    {
      cursor: z.string().optional().describe('Cursor token for pagination'),
      limit: z.number().optional().describe('Items per page (default 50, maximum 200)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const ledger = readJsonFile<VerifyStatusFile>(paths.verifyStatus);
      if (!ledger.ok) {
        return respond({ available: false, source: describeReadFailure(ledger), items: [], total: 0 });
      }

      const SEVERITY_ORDER: Record<string, number> = {
        'ĐÃ-XÁC-NHẬN-NGỪNG': 0,
        'SẮP-NGỪNG': 1,
        'NGHI-NGỪNG': 2,
      };
      const queue = (ledger.value.records ?? [])
        .filter(shouldResearch)
        .sort((a, b) => {
          const sa = SEVERITY_ORDER[a.label] ?? 99;
          const sb = SEVERITY_ORDER[b.label] ?? 99;
          if (sa !== sb) return sa - sb;
          const ta = Date.parse(a.verifiedAt ?? '0');
          const tb = Date.parse(b.verifiedAt ?? '0');
          return tb - ta;
        })
        .map((record) => {
          const missing: string[] = [];
          if (record.l1?.exists === false) missing.push('L1_ABSENT');
          if (record.l3?.hasNotice === true) missing.push('L3_NOTICE');
          return {
            id: record.id,
            prefix: record.prefix,
            label: record.label,
            missing,
            verifiedAt: record.verifiedAt ?? null,
          };
        });

      const page = paginateArray(queue, { cursor: args.cursor, limit: args.limit });
      return respond({
        available: true,
        source: { path: ledger.filePath, timestamp: ledger.value.timestamp ?? null },
        ...page,
      });
    }
  );

  // 21. research_evidence
  server.tool(
    'research_evidence',
    'Returns the recorded L1/L2/L3 evidence for one model from the verification ledger',
    {
      model: z.string().describe('Model id, or a unique suffix of it'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const ledger = readJsonFile<VerifyStatusFile>(paths.verifyStatus);
      if (!ledger.ok) {
        return respond({ available: false, source: describeReadFailure(ledger), found: false });
      }

      const records = ledger.value.records ?? [];
      const exact = records.find((record) => record.id === args.model);
      const suffixed = exact ?? records.find((record) => record.id.endsWith(`/${args.model}`));
      const record: VerifyRecord | undefined = suffixed;

      if (!record) {
        return respond({
          available: true,
          found: false,
          model: args.model,
          source: { path: ledger.filePath, timestamp: ledger.value.timestamp ?? null },
        });
      }

      return respond({
        available: true,
        found: true,
        model: args.model,
        record: {
          id: record.id,
          prefix: record.prefix,
          label: record.label,
          l1: record.l1 ?? null,
          l2: record.l2 ?? null,
          l3: record.l3 ?? null,
          flags: record.flags ?? [],
          verifiedAt: record.verifiedAt ?? null,
        },
      });
    }
  );

  // 22. schedule_status
  server.tool(
    'schedule_status',
    'Reports the last daemon tick, the age of its log, and the newest autopilot plan file on disk',
    {},
    async () => {
      const paths = resolveStatePaths();
      const tickStatus = readJsonFile<TickStatusFile>(paths.tickStatus);
      const logStat = statFile(paths.tickLog);
      const newestPlan = latestFileIn(paths.plansDir, '.json');

      return respond({
        stateDir: paths.stateDir,
        plansDir: paths.plansDir,
        lastTick: tickStatus.ok
          ? {
              timestamp: tickStatus.value.timestamp ?? null,
              ageMinutes: ageMinutes(tickStatus.value.timestamp),
              mode: tickStatus.value.mode ?? null,
              effectiveMode: tickStatus.value.effectiveMode ?? null,
            }
          : { available: false, reason: describeReadFailure(tickStatus).reason },
        tickLog: logStat,
        newestPlanFile: newestPlan === null ? null : path.basename(newestPlan),
        newestPlanAgeMinutes: newestPlan === null ? null : ageMinutes(statFile(newestPlan).modifiedAt),
      });
    }
  );

  // 23. autopilot_status
  server.tool(
    'autopilot_status',
    'Reads the autopilot policy file and the newest generated plan, reporting the mode that is actually configured',
    {},
    async () => {
      const paths = resolveStatePaths();
      const policyStat = statFile(paths.autopilotPolicy);

      let mode: string | null = null;
      let policyError: string | null = null;
      if (policyStat.exists) {
        try {
          const parsed = parseYaml(fs.readFileSync(paths.autopilotPolicy, 'utf8')) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const value = (parsed as Record<string, unknown>)['autonomy'];
            mode = typeof value === 'string' ? value : null;
          }
        } catch (error) {
          policyError = error instanceof Error ? error.message : String(error);
        }
      }

      const newestPlan = latestFileIn(paths.plansDir, '.json');
      let planSummary: Record<string, unknown> | null = null;
      if (newestPlan !== null) {
        const planRead = readJsonFile<Record<string, unknown>>(newestPlan);
        planSummary = planRead.ok
          ? {
              file: path.basename(newestPlan),
              generatedAt: planRead.value['generatedAt'] ?? null,
              planHash: planRead.value['planHash'] ?? null,
              blocked: planRead.value['blocked'] ?? null,
            }
          : { file: path.basename(newestPlan), reason: describeReadFailure(planRead).reason };
      }

      return respond({
        policyPath: paths.autopilotPolicy,
        policyPresent: policyStat.exists,
        policyBytes: policyStat.bytes ?? null,
        mode,
        policyError,
        plansDir: paths.plansDir,
        newestPlan: planSummary,
      });
    }
  );

  // 24. profile_interview
  server.tool(
    'profile_interview',
    'Returns the profile interview questions shared with the CLI, plus any answers already recorded in profile.yaml',
    {},
    async () => {
      const paths = resolveStatePaths();
      const exists = fs.existsSync(paths.profile);

      let answers: Record<string, unknown> | null = null;
      let profileError: string | null = null;
      if (exists) {
        try {
          const parsed = parseYaml(fs.readFileSync(paths.profile, 'utf8')) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            answers = parsed as Record<string, unknown>;
          }
        } catch (error) {
          profileError = error instanceof Error ? error.message : String(error);
        }
      }

      const answeredIds = answers === null ? [] : Object.keys(answers);
      const pending = INTERVIEW_QUESTIONS.filter((question) => !answeredIds.includes(question.id));

      return respond({
        questionCount: INTERVIEW_QUESTIONS.length,
        questions: INTERVIEW_QUESTIONS.map((question) => ({
          id: question.id,
          prompt: question.prompt,
          default: question.default,
          hint: question.hint,
        })),
        profilePath: paths.profile,
        profilePresent: exists,
        profileBytes: exists ? statFile(paths.profile).bytes ?? null : null,
        answers,
        pendingQuestionIds: pending.map((question) => question.id),
        profileError,
      });
    }
  );

  return server;
}
