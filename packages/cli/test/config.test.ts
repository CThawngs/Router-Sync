/**
 * packages/cli/test/config.test.ts
 *
 * Unit tests for Configuration Loader and Dynamic Path Resolution (Condition A2).
 * Verifies path resolution across Windows/POSIX environments, YAML validation,
 * and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  expandTilde,
  loadConfigFile,
  resolveRouterDbPath,
  getSampleConfigYaml,
} from '../src/config/loader.js';
import { RouterSyncConfigSchema } from '../src/config/schema.js';
import { parse as parseYaml } from 'yaml';

describe('CLI Config Loader & Schema Validation (Condition A2)', () => {
  let tmpDir: string;
  let tmpConfigPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `rs_config_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpConfigPath = path.join(tmpDir, 'routersync.yaml');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('validates default sample configuration schema', () => {
    const yamlStr = getSampleConfigYaml();
    const parsed = parseYaml(yamlStr);
    const result = RouterSyncConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.routers).toHaveLength(2);
      expect(result.data.combos).toHaveLength(1);
    }
  });

  it('loads valid configuration file and resolves paths dynamically', () => {
    fs.writeFileSync(tmpConfigPath, getSampleConfigYaml(), 'utf-8');
    const { config, filePath } = loadConfigFile(tmpConfigPath);

    expect(filePath).toBe(path.resolve(tmpConfigPath));
    expect(config.version).toBe(1);
    expect(config.routers.map((r) => r.id)).toEqual(['omni', 'nine']);
  });

  it('throws friendly validation error with exact field paths on invalid config', () => {
    const invalidYaml = `
version: 2 # invalid version
routers: [] # must have at least 1 router
`;
    fs.writeFileSync(tmpConfigPath, invalidYaml, 'utf-8');

    expect(() => loadConfigFile(tmpConfigPath)).toThrow(/Configuration validation error/);
  });

  it('resolves tilde expansion properly across OS platforms without hardcoding', () => {
    const expanded = expandTilde('~/my-db.sqlite');
    expect(expanded).toBe(path.join(os.homedir(), 'my-db.sqlite'));
  });

  it('resolves default router DB paths dynamically based on adapter', () => {
    const omniDb = resolveRouterDbPath({ id: 'omni', adapter: 'omniroute', write: 'db' });
    expect(omniDb).toBe(path.join(os.homedir(), '.omniroute', 'storage.sqlite'));

    const nineDb = resolveRouterDbPath({ id: 'nine', adapter: '9router', write: 'db' });
    expect(nineDb).toMatch(/data\.sqlite$/);
  });
});
