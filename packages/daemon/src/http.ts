/**
 * packages/daemon/src/http.ts
 *
 * HTTP entrypoint for daemon (B4): loopback-only, no CORS for foreign Origin,
 * OPTIONS without CORS headers, 401 missing/invalid token, 403 foreign Origin.
 * Re-exports server so callers can import from http.js or server.js.
 */
export * from './server.js';
export * from './security/network.js';
