/**
 * packages/daemon/src/handlers/unsupported.ts
 *
 * Handler for endpoints scheduled for Phase 3a / Phase 4.
 * Returns envelope with meta.source = 'unavailable' and reason = 'needs_p3a'.
 * Structured code response without free-form localized sentences (D1).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../security/network.js';

export function handleUnsupportedSlice(
  _req: IncomingMessage,
  res: ServerResponse,
  resourceName: string
): void {
  sendJson(res, 200, {
    meta: {
      source: 'unavailable',
      reason: 'needs_p3a',
      generatedAt: new Date().toISOString(),
    },
    code: 'slice_s1_deferred_to_p3a',
    resource: resourceName.toLowerCase(),
    data: [],
  });
}
