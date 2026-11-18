import { defineWorkspace } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const alias = {
  '@routersync/adapter-sdk': path.resolve(__dirname, 'packages/adapter-sdk/src/index.ts'),
  '@routersync/core/readonly': path.resolve(__dirname, 'packages/core/src/readonly.ts'),
  '@routersync/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
  '@routersync/sources': path.resolve(__dirname, 'packages/sources/src/index.ts'),
  '@routersync/adapter-omniroute': path.resolve(__dirname, 'packages/adapter-omniroute/src/index.ts'),
  '@routersync/adapter-9router': path.resolve(__dirname, 'packages/adapter-9router/src/index.ts'),
  '@routersync/daemon': path.resolve(__dirname, 'packages/daemon/src/index.ts'),
};

// N1: Limit concurrent test workers on local dev machines.
// In CI (CI=true) vitest manages its own concurrency.
// RS_TEST_WORKERS overrides. Default local cap: 2 forks.
const isCI = process.env['CI'] === 'true' || process.env['CI'] === '1';
const localMaxForks = Number(process.env['RS_TEST_WORKERS'] ?? 2);
const forkPool = isCI ? undefined : { forks: { maxForks: localMaxForks, minForks: 1 } };

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'root-tools',
      include: ['test/**/*.{test,spec}.{js,mjs,ts}'],
      exclude: ['**/node_modules/**', 'test/e2e/**'],
      environment: 'node',
      testTimeout: 20000,
      setupFiles: [path.resolve(__dirname, 'test/harness/state-dir-setup.ts')],
      pool: 'forks',
      poolOptions: forkPool,
      server: {
        deps: {
          external: ['node:sqlite'],
        },
      },
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'packages',
      include: ['packages/*/test/**/*.{test,spec}.{js,mjs,ts}'],
      environment: 'node',
      testTimeout: 20000,
      setupFiles: [path.resolve(__dirname, 'test/harness/state-dir-setup.ts')],
      // UI tests run in their own jsdom project below (ADR-UI-01).
      exclude: ['**/node_modules/**', 'packages/ui/test/**'],
      pool: 'forks',
      poolOptions: forkPool,
      server: {
        deps: {
          external: ['node:sqlite'],
        },
      },
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'ui',
      include: ['packages/ui/test/**/*.{test,spec}.{js,mjs,ts,tsx}'],
      environment: 'jsdom',
      globals: true,
      setupFiles: [path.resolve(__dirname, 'packages/ui/test/setup.ts')],
      // R16: the UI tests render the real application (daemon -> HttpApi ->
      // screen) and a real render takes longer than the 5 s default. The
      // single-project run of the UI package uses the root config, which
      // already allows 30 s; the workspace project needs the same budget.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  },
  {
    resolve: { alias },
    test: {
      // End-to-end: packs the packages, installs them with npm into a temp
      // project and drives the installed binaries. Slow, so it is NOT part of
      // `pnpm test`; run it with `pnpm e2e`.\n      name: 'e2e',
      name: 'e2e',
      include: ['test/e2e/**/*.{test,spec}.{js,mjs,ts}'],
      environment: 'node',
      testTimeout: 600000,
      hookTimeout: 600000,
    },
  },
]);
