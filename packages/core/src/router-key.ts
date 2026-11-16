/**
 * packages/core/src/router-key.ts
 *
 * Centralized, pure resolution of router API key environment variables
 * following the Least Privilege principle (SPEC §31 / G0-5 / Decision 2026-10-14-04).
 *
 * Fixed candidate hierarchy:
 *  - 9Router:
 *      1. NINEROUTER_CLIENT_KEY  (client)
 *      2. NINE_ROUTER_CLIENT_KEY (client)
 *      3. NINEROUTER_ADMIN_KEY   (elevated)
 *      4. NINEROUTER_API_KEY     (elevated)
 *      5. NINE_ROUTER_API_KEY    (elevated)
 *  - OmniRoute:
 *      1. OMNIROUTE_CLIENT_KEY   (client)
 *      2. OMNIROUTE_ADMIN_KEY    (elevated)
 *      3. OMNIROUTE_API_KEY      (elevated)
 *
 * Invariant: Never logs, stores, or returns raw secret values. Only returns the variable name and scope.
 */

export type RouterKeyScope = 'client' | 'elevated';

export interface ResolvedRouterKey {
  name: string;
  scope: RouterKeyScope;
}

export interface ResolveRouterKeyOptions {
  /** If provided, restricts resolution strictly to the requested scope. */
  scope?: RouterKeyScope;
}

export const ROUTER_KEY_CANDIDATES: Record<string, Array<{ name: string; scope: RouterKeyScope }>> = {
  '9router': [
    { name: 'NINEROUTER_CLIENT_KEY', scope: 'client' },
    { name: 'NINE_ROUTER_CLIENT_KEY', scope: 'client' },
    { name: 'NINEROUTER_ADMIN_KEY', scope: 'elevated' },
    { name: 'NINEROUTER_API_KEY', scope: 'elevated' },
    { name: 'NINE_ROUTER_API_KEY', scope: 'elevated' },
  ],
  'omniroute': [
    { name: 'OMNIROUTE_CLIENT_KEY', scope: 'client' },
    { name: 'OMNIROUTE_ADMIN_KEY', scope: 'elevated' },
    { name: 'OMNIROUTE_API_KEY', scope: 'elevated' },
  ],
};

function normalizeAdapterId(adapterId: string): string {
  const norm = adapterId.toLowerCase().replace(/[-_]/g, '');
  if (norm === '9router' || norm.includes('nine')) return '9router';
  if (norm.includes('omni')) return 'omniroute';
  return adapterId.toLowerCase();
}

/**
 * Pure function to resolve the active router API key environment variable name and scope.
 * Prioritizes client keys over elevated keys unless a specific scope is requested.
 *
 * @param adapterId Adapter identifier (e.g. '9router', 'omniroute', 'nine', 'omni')
 * @param env Environment variables dictionary (defaults to process.env)
 * @param options Optional scope filter
 * @returns {ResolvedRouterKey | null} The resolved variable name and scope, or null if unset.
 */
export function resolveRouterKey(
  adapterId: string,
  env: Record<string, string | undefined> = process.env,
  options?: ResolveRouterKeyOptions
): ResolvedRouterKey | null {
  const normalizedId = normalizeAdapterId(adapterId);
  const candidates = ROUTER_KEY_CANDIDATES[normalizedId];
  if (!candidates) return null;

  for (const candidate of candidates) {
    if (options?.scope && candidate.scope !== options.scope) {
      continue;
    }
    const val = env[candidate.name];
    if (typeof val === 'string' && val.trim().length > 0) {
      return {
        name: candidate.name,
        scope: candidate.scope,
      };
    }
  }

  return null;
}
