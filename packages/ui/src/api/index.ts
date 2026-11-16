import React, { createContext, useContext } from 'react';
import { ApiClient } from './client';
import { MockApi } from './mock';
import { HttpApi } from './http';

export * from './types';
export * from './client';
export * from './mock';
export * from './http';

/**
 * R16-1 (AT-144): pick the API client.
 *
 * `import.meta.env` MUST be written exactly like that: the `vite:define`
 * plugin of Vite only replaces the literal `import.meta.env` expression, so
 * an optional-chained `import.meta` never reaches the bundle and `VITE_API`
 * never arrives — the UI silently fell back to `MockApi` even while the S1
 * daemon was running and serving real numbers.
 *
 * The read happens inside a function on purpose: it keeps the value dynamic
 * for tests (`vi.stubEnv('VITE_API', 'http')`) while the production bundle
 * still gets the inlined literal.
 */
function isHttpApiMode(): boolean {
  const metaEnv = import.meta.env;
  return metaEnv.VITE_API === 'http';
}

/**
 * Builds the API client for the current environment. Exported so a test can
 * assert the choice directly (AT-144) instead of reading a module-level
 * constant captured at import time.
 */
export function createApiClient(): ApiClient {
  return isHttpApiMode() ? new HttpApi() : new MockApi();
}

const defaultApi: ApiClient = createApiClient();
const ApiContext = createContext<ApiClient>(defaultApi);

export function useApi(): ApiClient {
  return useContext(ApiContext);
}

export const ApiProvider = ApiContext.Provider;
export { defaultApi };
