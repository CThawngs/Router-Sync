/**
 * packages/ui/src/utils/routerLabel.ts
 *
 * R19-3.1: a router is shown to the reader under its PRODUCT name.
 *
 * The daemon speaks ids (`omniroute`, `9router`); the reader knows products
 * (`OmniRoute`, `9Router`). The R18 audit printed the raw id in the Overview
 * banner ("omniroute, 9router chưa phản hồi"), which is a machine token, not
 * a name.
 *
 * The table is a CATALOG, not a guess: `r19_router_label_<id>`. An id that is
 * not in the table is printed exactly as it arrived — a name is never invented
 * for a router nobody described.
 */

import { hasTranslation, t } from '../i18n';

/** Prefix of the catalog key that carries the product name of a router id. */
export const ROUTER_LABEL_KEY_PREFIX = 'r19_router_label_';

/**
 * The product name of a router id, or the id itself when the catalog has no
 * entry for it.
 */
export function routerLabel(routerId: string): string {
  const key = `${ROUTER_LABEL_KEY_PREFIX}${routerId}`;
  if (hasTranslation(key)) return t(key);
  return routerId;
}
