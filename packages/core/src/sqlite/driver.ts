/**
 * packages/core/src/sqlite/driver.ts
 *
 * SqliteDriver interface — abstracts the SQLite library so adapters do not
 * directly import better-sqlite3 (enables unit-test mocking and future
 * library swaps without touching adapter code).
 *
 * Design notes:
 *  - All methods are synchronous (better-sqlite3 is sync by design).
 *  - `pragma` returns the raw value; callers cast as needed.
 *  - `backup` copies to a destination path atomically using the SQLite
 *    online backup API (safe while the DB is open and being written).
 *  - `transaction` wraps a function in BEGIN IMMEDIATE / COMMIT / ROLLBACK.
 */

export interface SqliteStatement {
  /** Execute and return rows as plain objects. */
  all(...params: unknown[]): unknown[];
  /** Execute and return first row or undefined. */
  get(...params: unknown[]): unknown;
  /** Execute DML (INSERT/UPDATE/DELETE); returns info object. */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDriver {
  /**
   * Execute arbitrary SQL (DDL, PRAGMA, multi-statement).
   * Not for parameterized queries — use prepare() instead.
   */
  exec(sql: string): void;

  /** Prepare a parameterized statement. */
  prepare(sql: string): SqliteStatement;

  /**
   * Run a function inside BEGIN IMMEDIATE … COMMIT.
   * Rolls back automatically on throw.
   * Returns whatever the function returns.
   */
  transaction<T>(fn: () => T): T;

  /**
   * Execute a PRAGMA and return the scalar value (string | number | null).
   * Example: pragma('journal_mode') → 'wal'
   */
  pragma(name: string): string | number | null;

  /**
   * Copy the current database to `destPath` using the SQLite Online Backup API.
   * Safe to call while the DB is open and actively written to.
   */
  backup(destPath: string): void;

  /** Close the database connection. */
  close(): void;
}

/**
 * Factory function signature — adapters receive this to open a DB.
 * Separating open from the class makes it easy to inject a mock in tests.
 */
export type OpenSqliteDriver = (
  filePath: string,
  options?: {
    readOnly?: boolean;
    busyTimeoutMs?: number;
    allowLiveDbWrite?: boolean;
    restrictToDir?: string;
  }
) => SqliteDriver;

