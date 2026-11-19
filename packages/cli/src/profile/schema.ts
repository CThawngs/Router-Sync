/**
 * packages/cli/src/profile/schema.ts
 *
 * Zod validation schema and default factory for RouterSync User Profile.
 */

import { z } from 'zod';
import type { UserProfile } from './types.js';

export const generalPreferencesSchema = z.object({
  workload: z.enum(['coding', 'reasoning', 'general-chat', 'agent']).default('coding'),
  costPreference: z.enum(['free-only', 'budget', 'performance-first']).default('free-only'),
  preferredProviders: z.array(z.string()).default(['gemini', 'groq', 'nvidia', 'oc', 'sambanova']),
  excludedProviders: z.array(z.string()).default([]),
});

export const comboProfileRuleSchema = z.object({
  targetCombo: z.string().default('all'),
  strategy: z.enum(['fallback', 'round-robin', 'priority-matrix']).default('fallback'),
  minSteps: z.number().int().min(2).default(2),
  enableInterleaving: z.boolean().default(true),
  freeOnly: z.boolean().default(true),
});

export const routerStrategyMappingSchema = z.object({
  nineRouter: z.enum(['fallback', 'round-robin']).default('fallback'),
  omniRoute: z.enum(['priority', 'weighted', 'round-robin']).default('priority'),
});

export const userProfileSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default('default-profile'),
  updatedAt: z.string().default(() => new Date().toISOString()),
  general: generalPreferencesSchema.default({
    workload: 'coding',
    costPreference: 'free-only',
    preferredProviders: ['gemini', 'groq', 'nvidia', 'oc', 'sambanova'],
    excludedProviders: [],
  }),
  combos: z.array(comboProfileRuleSchema).default([
    {
      targetCombo: 'all',
      strategy: 'fallback',
      minSteps: 2,
      enableInterleaving: true,
      freeOnly: true,
    },
  ]),
  strategyMapping: z.record(z.string(), routerStrategyMappingSchema).default({
    fallback: {
      nineRouter: 'fallback',
      omniRoute: 'priority',
    },
    'round-robin': {
      nineRouter: 'round-robin',
      omniRoute: 'round-robin',
    },
    'priority-matrix': {
      nineRouter: 'fallback',
      omniRoute: 'priority',
    },
  }),
});

export function createDefaultProfile(): UserProfile {
  return userProfileSchema.parse({});
}

/** W2 profile.yaml schema (flat, neutral). Old userProfileSchema kept for compat. */

export const ProfileSchema = z.object({
  purpose: z.string().default('general coding'),
  priority: z
    .array(z.enum(['quality', 'speed', 'price', 'context']))
    .default(['quality', 'speed', 'price', 'context']),
  freeOnly: z.boolean().default(true),
  preferredProviders: z.array(z.string()).default([]),
  dislikedProviders: z.array(z.string()).default([]),
  favorites: z.array(z.string()).default([]),
  keepHead: z.number({ error: 'keepHead: phải là số nguyên ≥ 0' }).int('keepHead: phải là số nguyên ≥ 0').min(0, 'keepHead: phải là số nguyên ≥ 0').default(0),
  allowList: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  automationLevel: z.enum(['observe', 'propose', 'auto-safe'], { error: () => ({ message: 'automationLevel: phải là một trong observe, propose, auto-safe' }) }).default('observe'),
  quotaLimit: z.union([z.number(), z.string()]).default(0),
  scanCycle: z.enum(['hourly', 'daily', 'weekly', 'manual']).default('daily'),
  timezone: z
    .string()
    .refine((tz) => { try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; } }, 'timezone phải là múi giờ IANA hợp lệ (ví dụ: Asia/Ho_Chi_Minh)')
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Ho_Chi_Minh'),
  schedule: z.union([z.string(), z.record(z.string(), z.unknown())]).default('manual'),
});

export const ProfileSchemaWithChecks = ProfileSchema.superRefine((v, ctx) => {
  for (const field of ['favorites', 'allowList', 'denyList'] as const) {
    const arr = v[field];
    if (new Set(arr).size !== arr.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `trùng lặp trong ${field} (mỗi model/provider chỉ 1 lần)`,
      });
    }
  }
});

export type Profile = z.infer<typeof ProfileSchema>;

export const DEFAULT_PROFILE: Profile = ProfileSchema.parse({});

export function validateProfile(data: unknown): Profile {
  return ProfileSchemaWithChecks.parse(data);
}
