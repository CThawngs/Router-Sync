import { defineConfig } from 'vitest/config';

// C14 P1.6: vitest 2.1.3 only types `maxForks` on the ROOT test config.
// Project-level `poolOptions.forks` accepts only isolate/singleFork, so the
// fork cap must live here, not in vitest.workspace.ts.
const isCI = process.env['CI'] === 'true' || process.env['CI'] === '1';
const localMaxForks = Number(process.env['RS_TEST_WORKERS'] ?? 2);

export default defineConfig({
  test: {
    hookTimeout: 30000,
    testTimeout: 30000,
    pool: 'forks',
    ...(isCI ? {} : { poolOptions: { forks: { maxForks: localMaxForks, minForks: 1 } } }),
  },
});
