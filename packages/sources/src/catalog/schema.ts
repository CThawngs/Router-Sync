/**
 * packages/sources/src/catalog/schema.ts
 *
 * DDL & Types for the RouterSync Model Catalog SQLite Store (Phase 3a / P1-DEBT-03 / SPEC §23.2).
 */

export const CATALOG_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS catalog_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lastSyncAt TEXT,
  error TEXT,
  credentialRef TEXT
);

CREATE TABLE IF NOT EXISTS catalog_models (
  id TEXT NOT NULL,
  providerId TEXT NOT NULL,
  name TEXT NOT NULL,
  rawId TEXT NOT NULL,
  contextWindow INTEGER,
  pricing TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  consecutiveMissing INTEGER NOT NULL DEFAULT 0,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  PRIMARY KEY (providerId, id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_models_provider ON catalog_models(providerId);
CREATE INDEX IF NOT EXISTS idx_catalog_models_status ON catalog_models(status);
`;

export interface CatalogProviderRecord {
  id: string;
  name: string;
  kind: string;
  endpoint?: string | undefined;
  status: 'active' | 'error' | 'disabled';
  lastSyncAt?: string | undefined;
  error?: string | undefined;
  credentialRef?: string | undefined;
}

export interface CatalogModelRecord {
  id: string;
  providerId: string;
  name: string;
  rawId: string;
  contextWindow?: number | undefined;
  pricing?: string | undefined;
  status: 'active' | 'grace_period' | 'absent';
  consecutiveMissing: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
