/**
 * packages/cli/src/config/schema.ts
 *
 * Zod schema for routersync.yaml configuration (Condition A2, Spec §7).
 */

import { z } from 'zod';

export const RouterConfigSchema = z.object({
  id: z.string().min(1),
  adapter: z.enum(['omniroute', '9router']),
  baseUrl: z.string().url().optional(),
  validated: z.boolean().default(false),
  auth: z
    .object({
      apiKeyEnv: z.string().optional(),
    })
    .optional(),
  write: z.enum(['api', 'cli', 'db']).default('db'),
  /**
   * AT-113: explicit isolation flag. When true, the adapter never probes the
   * router HTTP serving path (fully isolated copy: tests, lab sandboxes).
   * Setting only db.path keeps probing enabled.
   */
  isolated: z.boolean().default(false),
  /**
   * Owner brief 2026-10-15 §4a: serving-path wait ceiling in ms. Default in
   * the adapter is 60000 (>= 60 s) — Gate L / AT-111 measured 9Router
   * serving-path reflection at 19.7–31.2 s (n=3). Lower only with owner
   * approval: a shorter ceiling marks correct live writes STALE and rolls
   * them back wrongly.
   */
  servingWaitMs: z.number().int().min(0).optional(),
  db: z
    .object({
      path: z.string().optional(),
    })
    .optional(),
  reload: z
    .object({
      type: z.enum(['none', 'command', 'api']),
      command: z.string().optional(),
    })
    .optional(),
});

export const SourcesConfigSchema = z
  .object({
    providers: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    aggregators: z.array(z.string()).default(['openrouter', 'litellm']),
    community_registry: z.boolean().default(true),
    news_signals: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  })
  .default({
    providers: { enabled: true },
    aggregators: ['openrouter', 'litellm'],
    community_registry: true,
    news_signals: { enabled: false },
  });

export const PolicyConfigSchema = z
  .object({
    mode: z.enum(['manual', 'shadow', 'auto-low-risk', 'auto']).default('manual'),
    schedule: z
      .object({
        sync: z.string().default('every 1h'),
        health: z.string().default('every 2m'),
      })
      .default({ sync: 'every 1h', health: 'every 2m' }),
    quarantine: z
      .object({
        consecutive_failures: z.number().default(3),
        not_found_confirmations: z.number().default(2),
        recheck_after: z.string().default('30m'),
      })
      .default({
        consecutive_failures: 3,
        not_found_confirmations: 2,
        recheck_after: '30m',
      }),
  })
  .default({
    mode: 'manual',
    schedule: { sync: 'every 1h', health: 'every 2m' },
    quarantine: { consecutive_failures: 3, not_found_confirmations: 2, recheck_after: '30m' },
  });

export const AutoMaintainSpecSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(z.string()).optional(),
  match: z.string().optional(),
  maxAdds: z.number().int().min(1).default(3),
});

export const ComboSpecSchema = z.object({
  name: z.string().min(1),
  role: z.string().default('custom'),
  routers: z.array(z.string()).min(1),
  size: z.number().int().min(1).default(3),
  constraints: z
    .object({
      minContext: z.number().optional(),
      toolUse: z.enum(['required', 'preferred', 'optional']).optional(),
      freeOnly: z.boolean().default(false),
      jsonSchema: z.enum(['required', 'preferred', 'optional']).optional(),
    })
    .default({ freeOnly: false }),
  pin: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  autoMaintain: z.union([z.boolean(), AutoMaintainSpecSchema]).default(false),
});

export const AdoptSpecSchema = z.object({
  router: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(['guard', 'full']).default('guard'),
});

/**
 * M2-02: Optional declarative outbound webhook section.
 * URL scheme/credential/port checks run in `validateWebhookUrl` so rejected URLs
 * produce structured `rejected_url` metadata rather than crashing config load.
 */
export const WebhookConfigSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().optional(),
  timeoutMs: z.number().optional(),
});

/**
 * C45-WP7 (`Phục vụ: S6`): Optional schedule ladder preferences.
 */
export const ScheduleConfigSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
  tickOnMcpStartup: z.boolean().default(false),
  preferredLinuxScheduler: z.enum(['auto', 'systemd', 'cron']).default('auto'),
});

/**
 * C45-WP8 (`Phục vụ: S7`): Optional Tier-1 research session budget settings.
 */
export const ResearchConfigSchema = z.object({
  maxWeeklyResearchSessions: z.number().int().min(0).max(1000).default(5),
});

/**
 * C50-K1 (`Phục vụ: S9, S10`): Optional custom prefixes and env-var secret declarations
 * for `routersync field-report` two-stage secret filtering.
 */
export const FieldReportConfigSchema = z.object({
  extraSecretPrefixes: z.array(z.string().min(2)).optional(),
  extraSecretEnvVars: z.array(z.string().min(1)).optional(),
});

export const RouterSyncConfigSchema = z
  .object({
    version: z.literal(1),
    routers: z.array(RouterConfigSchema).min(1),
    sources: SourcesConfigSchema,
    policy: PolicyConfigSchema,
    combos: z.array(ComboSpecSchema).default([]),
    adopt: z.array(AdoptSpecSchema).default([]),
    /**
     * ROUND 56: combos the owner never wants `sync` to touch. Matched by
     * exact combo name; an excluded combo is reported and left unchanged.
     */
    exclude: z.array(z.string()).default([]),
    /**
     * R57 §C: canonical provider names exempt from the R2 step-match floor.
     * Use for providers whose live list intentionally strips variant suffixes
     * (e.g. node-a strips `-free` from every model name), causing a structurally
     * low step-match rate that does not indicate namespace drift.
     * All other R2 checks (two scans, catalog floor) still apply.
     */
    'trust-low-match': z.array(z.string()).default([]),
    /**
     * M2-02: Optional outbound webhook configuration for actionable alerts.
     */
    webhook: WebhookConfigSchema.optional(),
    /**
     * C45-WP7: Optional schedule ladder preferences.
     */
    schedule: ScheduleConfigSchema.optional(),
    /**
     * C45-WP8: Optional weekly Tier-1 research session cap (default 5).
     */
    research: ResearchConfigSchema.optional(),
    /**
     * C50-K1: Optional extra secret prefixes and secret env var names for field-report.
     */
    fieldReport: FieldReportConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const seenAdapters = new Set<string>();
    for (const r of data.routers) {
      if (seenAdapters.has(r.adapter)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routers'],
          message: `Multiple routers with the same adapter "${r.adapter}" are not supported. Each router in config.yaml must use a distinct adapter (e.g. one "9router" and one "omniroute").`,
        });
        break;
      }
      seenAdapters.add(r.adapter);
    }

    if (data.policy.mode !== 'manual' && data.policy.mode !== 'shadow') {
      const unvalidated = data.routers.filter((r) => !r.validated);
      if (unvalidated.length > 0) {
        const ids = unvalidated.map((r) => r.id).join(', ');
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['policy', 'mode'],
          message: `Security Violation (Condition G0-7): Cannot set policy.mode to "${data.policy.mode}" because router(s) [${ids}] are unvalidated against live instances (REAL evidence required). Only "manual" or "shadow" mode is permitted for unvalidated adapters.`,
        });
      }
    }
    if (
      data.routers.some((r) => r.adapter === '9router') &&
      data.policy.mode !== 'manual' &&
      data.policy.mode !== 'shadow'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policy', 'mode'],
        message:
          `Security Violation (D26 / Spec §33.3): 9Router serving-path reflection is unconfirmed ` +
          `(Gate L finding: rows written with kind='custom' never appear on GET /v1/models; kind=null ` +
          `reflects within ~20s — COPY, Windows). policy.mode for configs containing a 9Router is ` +
          `capped at "manual" or "shadow" until the project owner confirms otherwise.`,
      });
    }
  });

export type RouterSyncConfig = z.infer<typeof RouterSyncConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type ComboSpec = z.infer<typeof ComboSpecSchema>;
export type AdoptSpec = z.infer<typeof AdoptSpecSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;
export type FieldReportConfig = z.infer<typeof FieldReportConfigSchema>;
