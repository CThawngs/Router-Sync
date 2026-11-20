import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// C14 P1.6: vitest only types `maxForks` on the ROOT test config.
// Project-level `poolOptions.forks` accepts only isolate/singleFork, so the
// fork cap must live here, not in a project config.
const isCI = process.env['CI'] === 'true' || process.env['CI'] === '1';
const localMaxForks = Number(process.env['RS_TEST_WORKERS'] ?? 2);

// C20 X2: the RAM gate in tools/agent/heavy.mjs only protects a command when the
// agent uses the wrapped script name, so the test pool can cap itself here too.
//
// Measured on the owner's machine (C20, record `c20-x2-abba-workers2`, 4 ABBA
// samples per arm, `vitest run --project packages`): 2 workers took a median
// 116.8 s against 63.7 s uncapped, i.e. 1.83x slower, and per-arm peak RSS was
// not sampled. X2.2 keeps a cap only when free RAM drops clearly AND wall time
// stays within 1.5x, so the automatic RAM cap is NOT enabled by default.
// Enforcement stays with the gate, which already blocks heavy commands below its
// threshold. `RS_TEST_WORKERS=<n>` forces a worker count for experiments.
const forcedWorkers = Number(process.env['RS_TEST_WORKERS'] ?? 0);
const capped = forcedWorkers > 0;
const maxWorkers = capped ? forcedWorkers : 0;

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

export default defineConfig({
  resolve: { alias },
  test: {
    hookTimeout: 30000,
    testTimeout: 30000,
    pool: 'forks',
    ...(capped ? { maxWorkers, minWorkers: 1 } : isCI ? {} : { maxWorkers: localMaxForks, minWorkers: 1 }),
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'root-tools',
          // C27 E0: hookTimeout was unset, so projects ran the vitest default
          // of 10000 ms and the `Hook timed out` failures recurred. Keep the
          // previously configured value for both projects.
          hookTimeout: 30000,
          include: ['test/**/*.{test,spec}.{js,mjs,ts}'],
          // node:test suites run under `node --test`; vitest cannot host them.
          exclude: ['**/node_modules/**', 'test/e2e/**', '**/*.node.test.mjs'],
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
          // C27 E0: same fix as root-tools — effective 10000 -> 30000.
          hookTimeout: 30000,
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