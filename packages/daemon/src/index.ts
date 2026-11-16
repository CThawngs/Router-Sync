/**
 * packages/daemon/src/index.ts
 *
 * Main entry point for @routersync/daemon (S1 Read-Only Slice).
 */

export * from './types.js';
export * from './server.js';
export * from './security/network.js';
export * from './security/sanitize.js';
export * from './probe/reachability.js';
export * from './db/reader.js';
export * from './handlers/health.js';
export * from './loop/index.js';
export * from './capability.js';
export * from './single-instance.js';
export * from './scheduler.js';
export * from './fence.js';
export * from './jobs.js';
export * from './security/approval-token.js';
export { handleApprove } from './handlers/approval.js';
export { setPendingPlanForTesting, handlePendingChanges, handleHistoryChanges } from './handlers/changes.js';

// CLI direct execution
const isMain = process.argv[1]?.replace(/\\/g, '/').includes('packages/daemon');
if (isMain) {
  const portArgIdx = process.argv.indexOf('--port');
  const portArg = portArgIdx !== -1 ? process.argv[portArgIdx + 1] : undefined;
  const port = portArg ? parseInt(portArg, 10) : 3128;

  import('./server.js').then(({ startDaemonServer }) => {
    startDaemonServer({ port }).then(({ port, host }) => {
      process.stdout.write(`[routersync-daemon] Listening on http://${host}:${port} (read-only slice S1)\n`);
    }).catch((err) => {
      process.stderr.write(`[routersync-daemon] Startup failure: ${err}\n`);
      process.exit(1);
    });
  });
}
