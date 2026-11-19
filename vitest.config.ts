import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableMemoryBytes } from './tools/agent/low-resource.mjs';

// C14 P1.6: vitest only types `maxForks` on the ROOT test config.
// Project-level `poolOptions.forks` accepts only isolate/singleFork, so the
// fork cap must live here, not in a project config.
const isCI = process.env['CI'] === 'true' || process.env['CI'] === '1';
const localMaxForks = Number(process.env['RS_TEST_WORKERS'] ?? 2);

// C20 X2: the RAM gate in tools/agent/heavy.mjs only protects a command when the
// agent uses the wrapped script name. `pnpm exec vitest run ...` skips it, so the
// test runner caps itself here instead. The limit matches the gate's threshold
// family and uses the same available-memory function (single definition).
const LOW_MEMORY_BYTES = 3 * 1024 ** 3;
const forcedWorkers = Number(process.env['RS_TEST_WORKERS'] ?? 0);
const workersFromRam = availableMemoryBytes() < LOW_MEMORY_BYTES ? 2 : 0;
const maxWorkers = forcedWorkers > 0 ? forcedWorkers : workersFromRam;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  '@routersync/adapter-sdk': path.resolve(dirname, 'packages/adapter-sdk/src/index.ts'),
  '@routersync/core/readonly': path.resolve(dirname, 'packages/core/src/readonly.ts'),
  '@routersync/core': path.resolve(dirname, 'packages/core/src/index.ts'),
  '@routersync/sources': path.resolve(dirname, 'packages/sources/src/index.ts'),
  '@routersync/adapter-omniroute': path.resolve(dirname, 'packages/adapter-omniroute/src/index.ts'),
  '@routersync/adapter-9router': path.resolve(dirname, 'packages/adapter-9router/src/index.ts'),
  '@routersync/daemon': path.resolve(dirname, 'packages/daemon/src/index.ts'),
};

const setup = path.resolve(dirname, 'test/harness/state-dir-setup.ts');
const externalSqlite = { deps: { external: ['node:sqlite'] } };

// `RS_TEST_WORKERS=off` disables every cap, which is how the C20 ABBA comparison
// measures the uncapped baseline on the same machine.
const capDisabled = String(process.env['RS_TEST_WORKERS'] ?? '').toLowerCase() === 'off';
const capped = maxWorkers > 0 && !capDisabled;

export default defineConfig({
  resolve: { alias },
  test: {
    hookTimeout: 30000,
    testTimeout: 30000,
    pool: 'forks',
    ...(capped ? { maxWorkers, minWorkers: 1 } : {}),
    ...(!isCI && !capped ? { poolOptions: { forks: { maxForks: localMaxForks, minForks: 1 } } } : {}),
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'root-tools',
          include: ['test/**/*.{test,spec}.{js,mjs,ts}'],
          exclude: ['**/node_modules/**', 'test/e2e/**'],
          environment: 'node',
          testTimeout: 20000,
          setupFiles: [setup],
          server: externalSqlite,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.{test,spec}.{js,mjs,ts}'],
          environment: 'node',
          testTimeout: 20000,
          setupFiles: [setup],
          exclude: ['**/node_modules/**', 'packages/ui/test/**'],
          server: externalSqlite,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'ui',
          include: ['packages/ui/test/**/*.{test,spec}.{js,mjs,ts,tsx}'],
          environment: 'jsdom',
          globals: true,
          setupFiles: [path.resolve(dirname, 'packages/ui/test/setup.ts')],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.{test,spec}.{js,mjs,ts}'],
          environment: 'node',
          testTimeout: 600000,
          hookTimeout: 600000,
        },
      },
    ],
  },
});