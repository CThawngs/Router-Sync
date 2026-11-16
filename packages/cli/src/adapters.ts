/**
 * packages/cli/src/adapters.ts
 *
 * Instantiates adapter instances based on RouterSync configuration.
 */

import { OmniRouteAdapter } from '@routersync/adapter-omniroute';
import { NineRouterAdapter } from '@routersync/adapter-9router';
import type { RouterAdapter } from '@routersync/adapter-sdk';
import { resolveRouterKey, type RouterKeyScope } from '@routersync/core';
import type { RouterConfig } from './config/schema.js';
import { resolveRouterDbPath } from './config/loader.js';

export interface RouterReadBackInfo {
  level: 'full' | 'existence-only' | 'db-only (degraded)';
  reason: string;
  keyName?: string;
  keyScope?: RouterKeyScope;
}

export function getRouterReadBackInfo(router: RouterConfig): RouterReadBackInfo {
  if (router.adapter === 'omniroute') {
    const adminKey = resolveRouterKey('omniroute', process.env, { scope: 'elevated' });
    if (adminKey) {
      return {
        level: 'full',
        reason: `Admin API key configured (GET /api/combos) [${adminKey.name}, elevated]`,
        keyName: adminKey.name,
        keyScope: adminKey.scope,
      };
    }
    const clientKey = resolveRouterKey('omniroute', process.env, { scope: 'client' });
    if (clientKey) {
      return {
        level: 'existence-only',
        reason: `Client API key configured (GET /v1/models) [${clientKey.name}]`,
        keyName: clientKey.name,
        keyScope: clientKey.scope,
      };
    }
    return {
      level: 'db-only (degraded)',
      reason: 'No API key configured. Set OMNIROUTE_ADMIN_KEY/OMNIROUTE_API_KEY for full or OMNIROUTE_CLIENT_KEY for existence-only read-back.',
    };
  }

  if (router.adapter === '9router') {
    const resolved = resolveRouterKey('9router', process.env);
    if (resolved) {
      const isElevated = resolved.scope === 'elevated';
      return {
        level: 'existence-only',
        reason: `${isElevated ? 'Elevated' : 'Client'} API key configured for read-back [${resolved.name}${isElevated ? ', elevated' : ''}]`,
        keyName: resolved.name,
        keyScope: resolved.scope,
      };
    }
    return {
      level: 'db-only (degraded)',
      reason: 'No client key configured. 9Router API requires browser session or NINEROUTER_CLIENT_KEY for /v1/models.',
    };
  }

  return { level: 'db-only (degraded)', reason: 'Unknown adapter' };
}

export function createAdapterForRouter(router: RouterConfig, stateDir?: string): RouterAdapter {
  const dbPath = resolveRouterDbPath(router);

  if (router.adapter === 'omniroute') {
    const adminResolved = resolveRouterKey('omniroute', process.env, { scope: 'elevated' });
    const clientResolved = resolveRouterKey('omniroute', process.env, { scope: 'client' });
    const adminKey = adminResolved ? process.env[adminResolved.name] : undefined;
    const clientKey = clientResolved ? process.env[clientResolved.name] : undefined;
    return new OmniRouteAdapter({
      dbPath,
      healthUrl: router.baseUrl ? `${router.baseUrl}/api/health` : undefined,
      apiBaseUrl: router.baseUrl,
      apiKey: adminKey ?? clientKey,
      adminApiKey: adminKey,
      clientApiKey: clientKey,
    });
  }

  if (router.adapter === '9router') {
    const resolved = resolveRouterKey('9router', process.env);
    const clientKey = resolved ? process.env[resolved.name] : undefined;
    return new NineRouterAdapter({
      dbPath,
      healthUrl: router.baseUrl ? `${router.baseUrl}/api/health` : undefined,
      modelsUrl: router.baseUrl ? `${router.baseUrl}/v1/models` : undefined,
      isolated: router.isolated,
      servingWaitMs: router.servingWaitMs,
      apiKey: clientKey,
      stateDir,
    });
  }

  throw new Error(`Unsupported router adapter: ${(router as { adapter: string }).adapter}`);
}
