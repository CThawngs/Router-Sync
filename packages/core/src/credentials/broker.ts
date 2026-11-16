/**
 * packages/core/src/credentials/broker.ts
 *
 * Secure Credential Broker (Phase 3a / P1-DEBT-02 / SPEC §31).
 *
 * Resolves credential references ({ env: 'VAR_NAME' }) strictly from environment
 * variables at runtime. Never logs, writes, or persists raw credentials.
 */

import { z } from 'zod';

export const CredentialReferenceSchema = z.object({
  env: z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name format'),
});

export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;

export interface CredentialResolution {
  /** The masked value suitable for display, logs, or UI (e.g. "sk-a1...c3d4" or "***") */
  masked: string;
  /** The environment variable name providing the secret */
  sourceEnv: string;
  /** Raw secret, strictly memory-only (RAM) */
  raw: string;
}

export class CredentialBroker {
  private readonly envMap: Record<string, string | undefined>;

  constructor(customEnv?: Record<string, string | undefined>) {
    this.envMap = customEnv ?? process.env;
  }

  /**
   * Resolves a credential reference or string format ({env: 'VAR'} or 'env:VAR').
   */
  resolve(ref: CredentialReference | string): CredentialResolution | undefined {
    let envVarName: string | undefined;

    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      if (trimmed.startsWith('env:')) {
        envVarName = trimmed.slice(4).trim();
      } else if (trimmed.startsWith('${') && trimmed.endsWith('}')) {
        envVarName = trimmed.slice(2, -1).trim();
      } else if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
        envVarName = trimmed;
      }
    } else if (ref && typeof ref === 'object' && typeof ref.env === 'string') {
      envVarName = ref.env.trim();
    }

    if (!envVarName) {
      return undefined;
    }

    const raw = this.envMap[envVarName]?.trim();
    if (!raw) {
      return undefined;
    }

    return {
      sourceEnv: envVarName,
      raw,
      masked: CredentialBroker.mask(raw),
    };
  }

  /**
   * Safely masks a sensitive secret string.
   */
  static mask(secret: string): string {
    if (!secret) return '***';
    const len = secret.length;
    if (len <= 8) {
      return '***';
    }
    const prefix = secret.slice(0, 4);
    const suffix = secret.slice(-4);
    return `${prefix}...${suffix}`;
  }
}
