/**
 * packages/mcp-server/src/pagination.ts
 *
 * Cursor-based pagination helper for MCP tools (Condition C1 & AT-89).
 * Ensures:
 *  - Ceiling limits (default 50, maximum 200)
 *  - Next cursor emitted whenever results exceed limit
 *  - Zero silent truncations
 */

export interface PaginationOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface PaginatedResult<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function paginateArray<T>(
  items: T[],
  options: PaginationOptions = {}
): PaginatedResult<T> {
  const total = items.length;

  // 1. Resolve limit between 1 and MAX_PAGE_LIMIT
  let limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (limit <= 0) limit = DEFAULT_PAGE_LIMIT;
  if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;

  // 2. Decode cursor to offset
  let offset = 0;
  if (options.cursor) {
    try {
      const decoded = Buffer.from(options.cursor, 'base64').toString('utf8');
      const parsed = parseInt(decoded, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    } catch {
      offset = 0;
    }
  }

  // 3. Slice page
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;

  // 4. Determine next_cursor
  const next_cursor = nextOffset < total
    ? Buffer.from(String(nextOffset)).toString('base64')
    : null;

  return {
    items: pageItems,
    next_cursor,
    total,
    limit,
    offset,
  };
}
