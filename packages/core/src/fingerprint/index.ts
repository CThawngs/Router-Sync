/**
 * packages/core/src/fingerprint/index.ts
 *
 * Schema fingerprinter for RouterSync adapters (AT-97, decision 2026-10-14-03).
 *
 * Strategy: structural comparison against an allowlist of required columns.
 *  - Missing required column → SchemaError (refuse write).
 *  - Required column with wrong type → SchemaError (refuse write).
 *  - Extra column (NOT NULL, no default) not in our INSERT list → SchemaError.
 *  - Extra column with default or nullable → log warning only, allow.
 *  - Router version outside known range → ReadOnlyMode error.
 *  - SHA-256 hash of required columns logged for audit, never for comparison.
 */

import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../sqlite/driver.js';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface ColumnSpec {
  name: string;
  /** SQLite affinity: TEXT | INTEGER | REAL | BLOB | NUMERIC */
  type: string;
  /** If true, must appear in our INSERT statement (cannot be unknown NOT NULL no-default) */
  required: boolean;
}

export interface TableSpec {
  tableName: string;
  requiredColumns: ColumnSpec[];
  optionalColumns?: ColumnSpec[];
}

export interface FingerprintResult {
  ok: boolean;
  /** SHA-256 of the required column signatures — for log only, not for decision. */
  logHash: string;
  /** List of detected schema issues. Empty when ok === true. */
  issues: SchemaIssue[];
  /** Columns present in DB not in our allowlist (informational). */
  extraColumns: Array<{ table: string; column: string; notNullNoDefault: boolean }>;
}

export interface SchemaIssue {
  severity: 'error' | 'warning';
  table: string;
  column?: string;
  message: string;
}

export class SchemaError extends Error {
  constructor(
    public readonly issues: SchemaIssue[],
    public readonly logHash: string
  ) {
    super(
      `[routersync] Schema mismatch — refusing write to protect data integrity.\n` +
      issues.map((i) => `  [${i.severity.toUpperCase()}] ${i.table}${i.column ? `.${i.column}` : ''}: ${i.message}`).join('\n')
    );
    this.name = 'SchemaError';
  }
}

export class ReadOnlyVersionError extends Error {
  constructor(
    public readonly routerName: string,
    public readonly detectedVersion: string,
    public readonly knownRange: string
  ) {
    super(
      `[routersync] Router "${routerName}" version "${detectedVersion}" is outside ` +
      `the known-safe range "${knownRange}". Switching to read-only mode. ` +
      `Update RouterSync to add support for this version.`
    );
    this.name = 'ReadOnlyVersionError';
  }
}

// --------------------------------------------------------------------------
// PRAGMA table_info row shape (SQLite spec)
// --------------------------------------------------------------------------

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;  // 1 = NOT NULL constraint
  dflt_value: string | null;
  pk: number;       // 1 if part of PK
}

// --------------------------------------------------------------------------
// Core fingerprinter
// --------------------------------------------------------------------------

/**
 * Read the actual schema from a live (or copy) database and compare against
 * the provided table specs. Returns a FingerprintResult.
 *
 * @param db        An open SqliteDriver (read-only is fine).
 * @param tableSpecs The allowlist of tables and required columns.
 */
export function fingerprint(
  db: SqliteDriver,
  tableSpecs: TableSpec[]
): FingerprintResult {
  const issues: SchemaIssue[] = [];
  const extraColumns: FingerprintResult['extraColumns'] = [];
  const hashParts: string[] = [];

  for (const spec of tableSpecs) {
    const rows = db
      .prepare(`PRAGMA table_info(${JSON.stringify(spec.tableName)})`)
      .all() as PragmaTableInfoRow[];

    if (rows.length === 0) {
      issues.push({
        severity: 'error',
        table: spec.tableName,
        message: `Table "${spec.tableName}" does not exist in DB.`,
      });
      continue;
    }

    // Build actual column map: name → {type, notNull, hasDefault}
    const actualMap = new Map<string, { type: string; notNull: boolean; hasDefault: boolean }>();
    for (const row of rows) {
      actualMap.set(row.name.toLowerCase(), {
        type: row.type.toUpperCase(),
        notNull: row.notnull === 1,
        hasDefault: row.dflt_value !== null,
      });
    }

    // Check required columns
    for (const col of spec.requiredColumns) {
      const actual = actualMap.get(col.name.toLowerCase());
      hashParts.push(`${spec.tableName}:${col.name}:${col.type}`);

      if (!actual) {
        issues.push({
          severity: 'error',
          table: spec.tableName,
          column: col.name,
          message: `Required column "${col.name}" is missing.`,
        });
        continue;
      }

      // Type affinity check (SQLite is flexible, so we compare affinities)
      const expectedAffinity = toAffinity(col.type);
      const actualAffinity = toAffinity(actual.type);
      if (expectedAffinity !== actualAffinity) {
        issues.push({
          severity: 'error',
          table: spec.tableName,
          column: col.name,
          message: `Column "${col.name}" has type "${actual.type}" (affinity: ${actualAffinity}), expected "${col.type}" (affinity: ${expectedAffinity}).`,
        });
      }
    }

    // Check extra columns that are NOT NULL with no default — we cannot
    // INSERT a row without knowing what to put there.
    const requiredNames = new Set(spec.requiredColumns.map((c) => c.name.toLowerCase()));
    const optionalNames = new Set((spec.optionalColumns ?? []).map((c) => c.name.toLowerCase()));

    for (const [colName, info] of actualMap) {
      if (!requiredNames.has(colName)) {
        if (optionalNames.has(colName)) {
          // Known optional column (e.g. tool_filter_regex in OmniRoute v3.8.50) — recognized, no warning
          continue;
        }

        const dangerous = info.notNull && !info.hasDefault;
        extraColumns.push({
          table: spec.tableName,
          column: colName,
          notNullNoDefault: dangerous,
        });
        if (dangerous) {
          issues.push({
            severity: 'error',
            table: spec.tableName,
            column: colName,
            message:
              `Extra column "${colName}" is NOT NULL with no default — ` +
              `RouterSync does not know what value to insert. ` +
              `Update the adapter's INSERT statement or the schema spec.`,
          });
        } else {
          issues.push({
            severity: 'warning',
            table: spec.tableName,
            column: colName,
            message: `Extra column "${colName}" found (nullable or has default) — ignored, not a write blocker.`,
          });
        }
      }
    }
  }

  const logHash = createHash('sha256').update(hashParts.sort().join('|')).digest('hex').slice(0, 16);
  const hasErrors = issues.some((i) => i.severity === 'error');

  return { ok: !hasErrors, logHash, issues, extraColumns };
}

/**
 * Same as `fingerprint()` but throws SchemaError if any errors are found.
 * Call this before any write operation.
 */
export function assertFingerprint(db: SqliteDriver, tableSpecs: TableSpec[]): void {
  const result = fingerprint(db, tableSpecs);
  if (!result.ok) {
    throw new SchemaError(result.issues.filter((i) => i.severity === 'error'), result.logHash);
  }
  // Log warnings to stderr (non-blocking)
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  for (const w of warnings) {
    process.stderr.write(`[routersync] SCHEMA WARNING ${w.table}${w.column ? `.${w.column}` : ''}: ${w.message}\n`);
  }
}

// --------------------------------------------------------------------------
// SQLite affinity rules (simplified, per SQLite spec §3.1)
// --------------------------------------------------------------------------

function toAffinity(declaredType: string): string {
  const t = declaredType.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}
