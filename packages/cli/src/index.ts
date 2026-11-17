#!/usr/bin/env node
/**
 * packages/cli/src/index.ts
 *
 * RouterSync CLI entry point.
 */

import { Command } from 'commander';
import { readFileSync, realpathSync } from 'node:fs';
try { (process.stdout as any).setDefaultEncoding?.('utf8'); } catch { /* ignore */ }
import { enforceNodeVersion } from './node-check.js';
import { runInitCommand } from './commands/init.js';
import { runScanCommand } from './commands/scan.js';
import { runPlanCommand } from './commands/plan.js';
import { runApplyCommand } from './commands/apply.js';
import { runRollbackCommand } from './commands/rollback.js';
import { runStatusCommand } from './commands/status.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runMcpInstallCommand } from './commands/mcp-install.js';
import { runResearchCommand } from './commands/research.js';
import { runConfirmAbsentCommand } from './commands/confirm-absent.js';
import { runDiffCommand } from './commands/diff.js';
import {
  runMcpServeHttpCommand,
  runMcpPairCommand,
  runMcpRevokeCommand,
  runMcpListCommand,
} from './commands/mcp-http.js';
import { runDaemonCommand, runDaemonPauseCommand, runDaemonResumeCommand } from './commands/daemon.js';
import { runDaemonLogExport } from './commands/daemon-log.js';
import { runScheduleCommand } from './commands/schedule.js';
import { runTickCommand } from './commands/tick.js';
import {
  runTrackOnceCommand,
  runTrackWatchCommand,
  runTrackStatusCommand,
  runTrackAutostartCommand,
} from './commands/track.js';
import {
  runMaintainPlanCommand,
  runMaintainApplyCommand,
  runMaintainAuthorizeCommand,
  runMaintainGrantStatusCommand,
  runMaintainRevokeGrantCommand,
  runMaintainCreateCommand,
  runMaintainSecretSelftestCommand,
} from './commands/maintain.js';
import {
  runSyncCommand,
  runUndoCommand,
  runSyncStatusCommand,
} from './commands/sync/index.js';
import { runRankCommand } from './commands/rank.js';
import { runHealthCommand } from './commands/health.js';
import { runSimCommand } from './commands/sim.js';
import { runStorageInspectCommand } from './commands/storage.js';
import { runDiscoverCommand } from './commands/discover.js';
import { runAutopilotPlanCommand } from './commands/autopilot.js';
import { runProfileCommand } from './commands/profile.js';
import { runExportLiteLLMCommand } from './commands/export.js';
import {
  runAgentsDiscoverCommand,
  runAgentsDryRunCommand,
  runAgentsApplyCommand,
  runAgentsRollbackCommand,
  runAgentsUpdateCommand,
} from './commands/agents.js';
import { runAppsInspectCommand } from './commands/apps.js';
import { runAppsDriftCommand } from './commands/drift.js';
import { installConfiguredRouterDbPaths } from './config/loader.js';

// Enforce Node.js >= 22.0.0 on startup (Condition A7 / AT-100)
enforceNodeVersion();

/** Version string taken from the package manifest so it never drifts. */
function readPackageVersion(): string {
  try {
    const manifest = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('routersync')
    .description('Keeps model lists and combos in sync across LLM routers and agent harnesses')
    .version(readPackageVersion());

  // C4o/O2: unified CLI hook to install configured router DB paths before any command runs
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.opts() as { config?: string; configPath?: string };
    const isAgents = actionCommand.name() === 'agents' || actionCommand.parent?.name() === 'agents';
    const cfg = actionCommand.name() === 'rank' || isAgents
      ? undefined // rank's -c is ranking.yaml, agents' -c is agent config, not routersync.yaml
      : (opts.configPath ?? opts.config);
    installConfiguredRouterDbPaths(cfg);
  });

  // init command
  program
    .command('init')
    .description('Initialize a default routersync.yaml configuration file')
    .option('-p, --path <path>', 'Destination path for the configuration file')
    .option('-f, --force', 'Overwrite existing configuration file')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { path?: string; force?: boolean; json?: boolean }) => {
      await runInitCommand(opts);
    });

  // scan command
  program
    .command('scan')
    .description('Scan configured routers for health and active model combos')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--json', 'Output result in JSON format')
    .option('--completeness', 'Two-round completeness scan (zero-token model-list probes)')
    .option('--parity', 'One snapshot, compare CLI scan vs daemon scan job per pair')
    .option('--per-node [targets]', 'Three per-node key scans >=60s apart for custom nodes (comma-separated router:node list)')
    .option('--delta', 'So catalog trong cache: cũ (mới nhất tốt) vs mới theo cặp + anomaly log (C3q Q1)')
    .option('--catalog-dir <dir>', 'Catalog directory (thí nghiệm trên bản sao)')
    .option('--scan-gap-ms <ms>', 'Required gap between scan rounds in ms (default 60000)', '60000')
    .action(async (opts: { configPath?: string; json?: boolean; completeness?: boolean; parity?: boolean; perNode?: boolean | string; delta?: boolean; catalogDir?: string; scanGapMs?: string }) => {
      const { scanGapMs, ...rest } = opts;
      const scanOpts: Parameters<typeof runScanCommand>[0] = { ...rest };
      if (scanGapMs !== undefined) scanOpts.scanGapMs = Number(scanGapMs);
      await runScanCommand(scanOpts);
    });

  // plan command
  program
    .command('plan')
    .description('Compute deterministic combo changes without writing to routers')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { configPath?: string; json?: boolean }) => {
      await runPlanCommand(opts);
    });

  // apply command
  program
    .command('apply')
    .description('Apply calculated plan to routers (dry-run by default; requires --write)')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--write', 'Execute live changes (requires interactive TTY confirmation)')
    .option('--yes', 'Prohibited by security policy — will be rejected')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { configPath?: string; write?: boolean; yes?: boolean; json?: boolean }) => {
      await runApplyCommand(opts);
    });

  // rollback command
  program
    .command('rollback [snapshotId]')
    .description('Rollback router state to a persisted snapshot (logical row-level restore). DRY-RUN by default; --write requires interactive TTY + confirmation')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--write', 'Perform the REAL restore (requires interactive TTY and confirmation; default is dry-run)')
    .option('--json', 'Output result in JSON format')
    .action(async (snapshotId: string | undefined, opts: { configPath?: string; write?: boolean; json?: boolean }) => {
      await runRollbackCommand({ ...opts, snapshotId });
    });

  // status command
  program
    .command('status')
    .description('Display status, health, and read-back levels for all routers')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { configPath?: string; json?: boolean }) => {
      await runStatusCommand(opts);
    });

  // doctor command (Condition C4 & AT-95)
  program
    .command('doctor')
    .description('Diagnose harness configuration and circular dependencies')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--hermes <path>', 'Path to hermes config.json')
    .option('--dsh <path>', 'Path to dsh config.yml')
    .option('--json', 'Output result in JSON format')
    .option('--out <file>', 'Write report text to file (UTF-8)')
    .action(async (opts: { configPath?: string; hermes?: string; dsh?: string; json?: boolean; out?: string }) => {
      await runDoctorCommand({
        configPath: opts.configPath,
        hermesConfigPath: opts.hermes,
        dshConfigPath: opts.dsh,
        json: opts.json,
        out: opts.out,
      });
    });

  // mcp command group (Condition C2 & AT-94)
  const mcpCmd = program
    .command('mcp')
    .description('Manage MCP server integrations');

  mcpCmd
    .command('install')
    .description('Install read-only RouterSync MCP server into harness (Hermes, DSH, Claude Code, Cursor, Codex)')
    .requiredOption('--client <client>', 'Harness client type (claude-code | cursor | codex | hermes | dsh)')
    .option('--print', 'Print harness configuration snippet without modifying files')
    .option('--write', 'Execute live file modification (requires interactive TTY confirmation)')
    .option('--yes', 'Rejected flag')
    .option('--file <path>', 'Custom path to harness configuration file')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { client: string; print?: boolean; write?: boolean; yes?: boolean; file?: string; json?: boolean }) => {
      await runMcpInstallCommand({
        client: opts.client,
        print: opts.print,
        write: opts.write,
        targetFile: opts.file,
        json: opts.json,
      });
    });

  mcpCmd
    .command('serve-http')
    .description('Start loopback HTTP MCP server on 127.0.0.1')
    .option('-p, --port <port>', 'Port to bind to (default: 3128)', '3128')
    .action(async (opts: { port?: string }) => {
      await runMcpServeHttpCommand({ port: opts.port });
    });

  mcpCmd
    .command('pair')
    .description('Generate single-use 5-minute pairing code for client authentication')
    .option('--client <name>', 'Client name identifier')
    .action((opts: { client?: string }) => {
      runMcpPairCommand({ client: opts.client });
    });

  mcpCmd
    .command('revoke <id>')
    .description('Revoke active MCP authentication token by id')
    .action((id: string) => {
      runMcpRevokeCommand(id);
    });

  mcpCmd
    .command('selftest')
    .description('Run stdio MCP selftest with raw JSON-RPC (--raw)')
    .option('--raw', 'Print raw JSON-RPC frames')
    .action(async (opts: { raw?: boolean }) => {
      if (opts.raw) await (await import('./commands/mcp-selftest.js')).runMcpSelftestRaw();
      else console.log('mcp selftest requires --raw');
    });

  mcpCmd
    .command('list')
    .description('List registered MCP tokens and their status')
    .action(() => {
      runMcpListCommand();
    });

  const researchCmd = program
    .command('research')
    .description('W3 deterministic research (LLM/paid-search NOT RUN by default)');
  researchCmd
    .command('run')
    .description('Run deterministic sources once')
    .option('--once', 'Run once')
    .option('--out <path>', 'Write output to file')
    .action(async (opts: { once?: boolean; out?: string }) => { await runResearchCommand({ subcommand: 'run', once: opts.once, out: opts.out }); });
  researchCmd.command('status').action(async () => { await runResearchCommand({ subcommand: 'status' }); });
  researchCmd.command('queue').action(async () => { await runResearchCommand({ subcommand: 'queue' }); });
  researchCmd.command('evidence <model>').action(async (model: string) => { await runResearchCommand({ subcommand: 'evidence', model }); });
  researchCmd.command('price-confirm').action(async () => { await runResearchCommand({ subcommand: 'price-confirm' }); });
  researchCmd
    .command('submit [file]')
    .description('Submit research evidence JSON (validated, untrusted, zero router writes)')
    .action(async (file?: string) => { await runResearchCommand({ subcommand: 'submit', file }); });

  // inbox command (Round C4c A8): list, ack, snooze items
  const inboxCmd = program
    .command('inbox')
    .description('Manage notification and proposal inbox');
  inboxCmd
    .command('list')
    .description('List pending inbox items')
    .action(async () => {
      const { runInboxCommand } = await import('./commands/inbox.js');
      await runInboxCommand({ action: 'list' });
    });
  inboxCmd
    .command('ack <id>')
    .description('Acknowledge an inbox item')
    .action(async (id: string) => {
      const { runInboxCommand } = await import('./commands/inbox.js');
      await runInboxCommand({ action: 'ack', id });
    });
  inboxCmd
    .command('snooze <id>')
    .description('Snooze an inbox item for N days')
    .option('--days <days>', 'Number of days to snooze', '7')
    .action(async (id: string, opts: { days: string }) => {
      const { runInboxCommand } = await import('./commands/inbox.js');
      await runInboxCommand({ action: 'snooze', id, days: Number(opts.days) || 7 });
    });

  // diff command (D3 C3d): catalog diff
  program
    .command('diff')
    .description('Diff scan catalogs (NEW / GONE-UNCONFIRMED, no removal proposals)')
    .option('--catalog-dir <dir>', 'Catalog directory')
    .action(async (opts: { catalogDir?: string }) => {
      await runDiffCommand({ catalogDir: opts.catalogDir });
    });

  // dead-models (G1 C3g): 0 token, từ tập id STEP-EXISTS
  program
    .command('dead-models')
    .description('List ABSENT-UNCONFIRMED ids from health STEP-EXISTS set')
    .option('--payload-keys <prefix>', 'Print catalog payload field names for one provider prefix from cache')
    .option('--live-price <prefix>', 'Fetch live prices for one provider and print price evaluation')
    .option('--id <model>', 'Filter evaluation or live price to specific model ID(s) comma-separated')
    .action(async (opts: { payloadKeys?: string; livePrice?: string; id?: string }) => {
      await (await import('./commands/dead-models.js')).runDeadModelsCommand({
        payloadKeys: opts.payloadKeys,
        livePrice: opts.livePrice,
        id: opts.id,
      });
    });

  // confirm-absent command (D1b C3d): probe-only, read-only
  program
    .command('confirm-absent')
    .description('Probe model-existence without writes (--probe-only)')
    .option('-c, --config-path <path>', 'Path to routersync.yaml configuration')
    .option('--probe-only', 'Probe-only mode (never writes routers)')
    .option('--prefix <prefix>', 'Limit to one prefix')
    .option('--ids <ids>', 'Probe danh sách id mất/hong (phân tách bằng dấu phẩy, tối đa 30), cách nhau >=1s (C3q Q1)')
    .action(async (opts: { configPath?: string; probeOnly?: boolean; prefix?: string; ids?: string }) => {
      await runConfirmAbsentCommand({ ...opts, ids: opts.ids ? opts.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined });
    });

  // daemon command (S1 Read-Only Slice)
  const daemonCmd = program
    .command('daemon')
    .description('Run the RouterSync local daemon (S1 read-only slice)')
    .option('-p, --port <port>', 'Port to bind to (default: 3128)', '3128')
    .option('-c, --config <path>', 'Custom path to configuration file (routersync.yaml)')
    .option('-u, --profile <path>', 'Custom path to user profile (profile.yaml)')
    .option('--interval <minutes>', 'Override scheduler interval in minutes (default: profile schedule, else 15)')
    .option('--mode <mode>', 'Daemon S1 read-only mode (default: observe; use tick/schedule for propose)')
    .option('--once', 'Run one scan tick then exit (no port, no scheduler loop)')
    .option('--json', 'Output startup result in JSON format')
    .action(async (opts: { port?: string; config?: string; profile?: string; interval?: string; mode?: string; once?: boolean; json?: boolean }) => {
      await runDaemonCommand(opts);
    });

  daemonCmd
    .command('pause')
    .description('Pause daemon scheduler (file-backed)')
    .action(async () => {
      await runDaemonPauseCommand();
    });

  daemonCmd
    .command('resume')
    .description('Resume daemon scheduler')
    .action(async () => {
      await runDaemonResumeCommand();
    });

  const daemonLogCmd = daemonCmd
    .command('log')
    .description('Print or export daemon job log (jobs.jsonl)');

  daemonLogCmd
    .command('export')
    .description('Export daemon job log to stdout or file (-o)')
    .option('--out <file>', 'Write log to file instead of stdout')
    .option('--json', 'Output in JSON format')
    .action(async (opts: { out?: string; json?: boolean }) => {
      await runDaemonLogExport(opts);
    });

  // tick command (F1 C4a: single idempotent zero-token tick)
  program
    .command('tick')
    .description('Run a single zero-token catalog & inbox tick (idempotent, file-locked)')
    .option('-c, --config <path>', 'Custom path to configuration file (routersync.yaml)')
    .option('--mode <mode>', 'Autonomy mode: observe | propose (default: propose)', 'propose')
    .option('--grace-cycles <n>', 'Grace cycles before marking missing model DEAD (default: 2)', '2')
    .option('--max-shrink-ratio <ratio>', 'Maximum allowed catalog shrink ratio before shrink-guard blocks (default: 0.3)', '0.3')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--toast', 'Emit console toast summary when new inbox proposals are created')
    .option('--webhook-url <url>', 'Optional webhook URL for new proposal notifications')
    .option('--json', 'Output tick summary in JSON format')
    .action(
      async (opts: {
        config?: string;
        mode?: string;
        graceCycles?: string;
        maxShrinkRatio?: string;
        stateDir?: string;
        toast?: boolean;
        webhookUrl?: string;
        json?: boolean;
      }) => {
        await runTickCommand({
          configPath: opts.config,
          mode: opts.mode,
          graceCycles: opts.graceCycles,
          maxShrinkRatio: opts.maxShrinkRatio,
          stateDir: opts.stateDir,
          toast: opts.toast,
          webhookUrl: opts.webhookUrl,
          json: opts.json,
        });
      }
    );

  // schedule command (W4 / F1 C4a: install | status | uninstall | --dry-run)
  program
    .command('schedule [action]')
    .description('Manage OS schedule for routersync tick (install | status | uninstall | --dry-run)')
    .option('-c, --config <path>', 'Custom path to configuration file (routersync.yaml)')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--interval-minutes <n>', 'Scan interval in minutes (default 15)')
    .option('--mode <mode>', 'Autonomy mode for scheduled tick (default propose)', 'propose')
    .option('--dry-run', 'Print schedule artifacts for all 3 OSes without installing')
    .option('--json', 'Output artifacts or status in JSON format')
    .action(
      async (
        action: string | undefined,
        opts: {
          config?: string;
          stateDir?: string;
          intervalMinutes?: string;
          mode?: string;
          dryRun?: boolean;
          json?: boolean;
        }
      ) => {
        await runScheduleCommand({ action, ...opts });
      }
    );

  // verify command (Round C4b F3b: multi-layer verification & accounting)
  program
    .command('verify')
    .description('Verify models across 3 layers (L1/L2/L3), assign 6 labels, output accounting line')
    .option('-c, --config <path>', 'Custom path to configuration file (routersync.yaml)')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--mock-3layer', 'Run verification against 3-layer mock sources (6 canonical test cases)')
    .option('--json', 'Output verify summary in JSON format')
    .action(
      async (opts: { config?: string; stateDir?: string; mock3layer?: boolean; mock3Layer?: boolean; json?: boolean }) => {
        await (await import('./commands/verify.js')).runVerifyCommand({
          configPath: opts.config,
          stateDir: opts.stateDir,
          mock3Layer: opts.mock3layer || opts.mock3Layer,
          json: opts.json,
        });
      }
    );

  // track command group (Condition TRACK-01 / Zero-Token Tracking)
  const trackCmd = program
    .command('track')
    .description('Zero-token model tracking across providers');

  trackCmd
    .command('once')
    .description('Perform a single model tracking scan across configured providers')
    .option('--providers-file <path>', 'Path to providers JSON configuration file')
    .option('--discover', 'Auto-discover providers from router database')
    .option('--router <router>', 'Router source to discover from (catalog, 9router, omniroute)')
    .option('--plan', 'Compute auto-maintenance plan after tracking')
    .option('--enrich', 'Enrich model metadata (pricing, free status) via zero-token GET')
    .option('--json', 'Output scan result in JSON format')
    .action(async (opts: { providersFile?: string; discover?: boolean; router?: string; plan?: boolean; enrich?: boolean; json?: boolean }) => {
      await runTrackOnceCommand(opts);
    });

  trackCmd
    .command('watch')
    .description('Continuously monitor model list changes at configured interval')
    .option('--providers-file <path>', 'Path to providers JSON configuration file')
    .option('--interval-sec <seconds>', 'Scan interval in seconds (minimum 300s)', '300')
    .option('--max-runs <count>', 'Maximum number of scan iterations')
    .option('--json', 'Output each scan result in single-line JSON format')
    .action(async (opts: { providersFile?: string; intervalSec?: string; maxRuns?: string; json?: boolean }) => {
      await runTrackWatchCommand(opts);
    });

  trackCmd
    .command('status')
    .description('Display latest model tracking status across configured providers')
    .option('--providers-file <path>', 'Path to providers JSON configuration file')
    .option('--json', 'Output status in JSON format')
    .action(async (opts: { providersFile?: string; json?: boolean }) => {
      await runTrackStatusCommand(opts);
    });

  trackCmd
    .command('autostart')
    .description('Print or setup system autostart configuration for model tracker daemon')
    .option('--print', 'Print autostart service configuration instructions without modifying system')
    .action((opts: { print?: boolean }) => {
      runTrackAutostartCommand(opts);
    });

  // maintain command group (Model Auto-Maintenance / Condition D26)
  const maintainCmd = program
    .command('maintain')
    .description('Zero-token model auto-maintenance and health planner');

  maintainCmd
    .command('plan')
    .description('Generate zero-token auto-maintenance plan for router combos (simulation/dry-run only)')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--router <router>', 'Target router ID')
    .option('--json', 'Output plan in JSON format')
    .action(async (opts: { config?: string; router?: string; json?: boolean }) => {
      await runMaintainPlanCommand({
        configPath: opts.config,
        router: opts.router,
        json: opts.json,
      });
    });

  maintainCmd
    .command('apply')
    .description('Apply auto-maintenance plan to target combo (restricted to test-<n> combos)')
    .option('--only <combo>', 'Target test combo name to apply (strictly matching ^test-\\d+$)')
    .option('--plan-hash <hash>', 'Exact plan hash computed by maintain plan')
    .option('--agents <agents>', 'Target agents scope validation')
    .option('-y, --yes', 'Bypass confirmation prompt (forbidden for maintain apply)')
    .option('--dry-run', 'Simulate maintain apply without making actual changes')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--router <router>', 'Target router ID')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--json', 'Output result in JSON format')
    .action(
      async (opts: {
        only?: string;
        planHash?: string;
        agents?: string;
        yes?: boolean;
        dryRun?: boolean;
        config?: string;
        router?: string;
        stateDir?: string;
        json?: boolean;
      }) => {
        await runMaintainApplyCommand({
          only: opts.only,
          planHash: opts.planHash,
          agents: opts.agents,
          yes: opts.yes,
          dryRun: opts.dryRun,
          configPath: opts.config,
          router: opts.router,
          stateDir: opts.stateDir,
          json: opts.json,
        });
      }
    );

  maintainCmd
    .command('authorize')
    .description('Authorize limited-time write grant for test combos and agents')
    .option('--only <combos>', 'Target test combo names to authorize (comma-separated, strictly matching ^test-\\d+$)')
    .option('--hours <hours>', 'Duration in hours (1-8)', '1')
    .option('--agents <agents>', 'Allowed agents (comma-separated: hermes, dsh)')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .action(async (opts: { only?: string; hours?: string; agents?: string; stateDir?: string }) => {
      await runMaintainAuthorizeCommand({
        only: opts.only,
        hours: opts.hours,
        agents: opts.agents,
        stateDir: opts.stateDir,
      });
    });

  maintainCmd
    .command('grant-status')
    .description('Display active write grant status')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--json', 'Output grant status in JSON format')
    .action(async (opts: { stateDir?: string; json?: boolean }) => {
      await runMaintainGrantStatusCommand({
        stateDir: opts.stateDir,
        json: opts.json,
      });
    });

  maintainCmd
    .command('revoke-grant')
    .description('Revoke active write grant immediately')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (opts: { stateDir?: string }) => {
      await runMaintainRevokeGrantCommand({
        stateDir: opts.stateDir,
      });
    });

  // C3u U3a: kiểm bí mật trên TTY thật (không mở router, không ghi DB).
  maintainCmd
    .command('secret-selftest')
    .description('Self-test grant secret resolution and validation (tmp state-dir only)')
    .option('--state-dir <dir>', 'Custom state directory')
    .action(async (opts: { stateDir?: string }) => {
      await runMaintainSecretSelftestCommand({
        stateDir: opts.stateDir,
      });
    });

  maintainCmd
    .command('create [name]')
    .description('Create new test combo on router')
    .option('--name <name>', 'Name of test combo to create (strictly matching ^test-\\d+$)')
    .option('--models <models>', 'Comma-separated list of models (at least 2)')
    .option('--free', 'Enforce all models must be verified free')
    .option('--router <router>', 'Target router ID')
    .option('--strategy <strategy>', 'Routing strategy')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--state-dir <dir>', 'Custom state directory')
    .option('--json', 'Output result in JSON format')
    .action(
      async (
        nameArg: string | undefined,
        opts: {
          name?: string;
          models?: string;
          free?: boolean;
          router?: string;
          strategy?: string;
          config?: string;
          stateDir?: string;
          json?: boolean;
        }
      ) => {
        await runMaintainCreateCommand({
          name: opts.name || nameArg,
          models: opts.models,
          free: opts.free,
          router: opts.router,
          strategy: opts.strategy,
          configPath: opts.config,
          stateDir: opts.stateDir,
          json: opts.json,
        });
      }
    );

  // sync command group (ROUND 56: provider scan + combo step pruning)
  program
    .command('sync')
    .description('Read each provider model list (zero tokens) and prune dead combo steps (plan by default)')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--router <router>', 'Target router: 9router | omniroute | all', 'all')
    .option('--apply', 'Write the plan after a second "chay" confirmation (backup + read-back first)')
    .option('--scan-gap-ms <ms>', 'Gap between the two scans in ms (minimum 60000)', '60000')
    .option('--timeout-ms <ms>', 'Per-request GET timeout in ms', '15000')
    .option('--json', 'Output result in JSON format')
    .action(
      async (opts: {
        config?: string;
        router?: string;
        apply?: boolean;
        scanGapMs?: string;
        timeoutMs?: string;
        json?: boolean;
      }) => {
        await runSyncCommand({
          configPath: opts.config,
          router: opts.router,
          apply: opts.apply,
          scanGapMs: Math.max(Number(opts.scanGapMs ?? 60000) || 0, 60000),
          timeoutMs: Number(opts.timeoutMs ?? 15000) || 15000,
          json: opts.json,
        });
      }
    );

  program
    .command('undo')
    .description('Restore combo step lists from the newest sync backup (plan by default)')
    .option('--router <router>', 'Target router: 9router | omniroute', '9router')
    .option('--backup <path>', 'Explicit backup file to restore from')
    .option('--apply', 'Perform the restore (requires "chay")')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { router?: string; backup?: string; apply?: boolean; json?: boolean }) => {
      await runUndoCommand(opts);
    });

  program
    .command('sync-status')
    .description('Show combo step counts, newest sync backup, and last sync record')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--json', 'Output result in JSON format')
    .action(async (opts: { config?: string; json?: boolean }) => {
      await runSyncStatusCommand({ configPath: opts.config, json: opts.json });
    });

  // rank command (Policy §8.4 Lexicographic + Dynamic Tiers + D1 Interleaving)
  program
    .command('rank')
    .description('Evaluate, score, and rank combo models (Policy §8.4 + Dynamic Tiers + D1)')
    .option('--router <router>', 'Target router: 9router | omniroute | all', 'all')
    .option('-c, --config <path>', 'Custom path to ranking.yaml configuration')
    .option('--dry-run', 'Preview changes without modifying router databases (default)', true)
    .option('--apply', 'Apply ranked step ordering to routers (requires confirmation)')
    .option('--scan-gap-ms <ms>', 'Wait gap between scans in milliseconds (default: 60000)')
    .option('--scan', 'Optional scan trigger')
    .option('--json', 'Output result in JSON format')
    .option('--write-outputs', 'Write CLASSIFY.txt, UNRATED.txt, and RANK-PREVIEW.txt to disk')
    .option('--output-dir <dir>', 'Directory to write output files')
    .action(
      async (opts: {
        router?: string;
        config?: string;
        dryRun?: boolean;
        apply?: boolean;
        scanGapMs?: string;
        scan?: boolean;
        json?: boolean;
        writeOutputs?: boolean;
        outputDir?: string;
      }) => {
        await runRankCommand({
          ...opts,
          scanGapMs: opts.scanGapMs ? Number(opts.scanGapMs) : undefined,
        });
      }
    );

  // health command (Round 61: read-only router health)
  program
    .command('health')
    .description('Read-only router health report (zero model calls, zero tokens)')
    .option('--router <router>', 'Target router: 9router | omniroute | all', 'all')
    .option('--days <days>', 'Lookback window in days (default: 7)', '7')
    .option('--json', 'Output result in JSON format')
    .option('--out <file>', 'Write report text to file (UTF-8)')
    .option('--prefix-map', 'Print prefix -> provider connection mapping only')
    .option('--summary', 'Print concise HEAlTH summary ≤150 lines (F2)')
    .option('--full', 'Print full health (outside package)')
    .action(async (opts: { router?: string; days?: string; json?: boolean; out?: string; prefixMap?: boolean; summary?: boolean; full?: boolean }) => {
      const healthOpts: { router?: string; days?: number; json?: boolean; out?: string; prefixMap?: boolean; summary?: boolean } = {};
      if (opts.router !== undefined) healthOpts.router = opts.router;
      if (opts.days !== undefined) healthOpts.days = Number(opts.days);
      if (opts.json !== undefined) healthOpts.json = opts.json;
      if (opts.out !== undefined) healthOpts.out = opts.out;
      if (opts.prefixMap !== undefined) healthOpts.prefixMap = opts.prefixMap;
      if (opts.summary !== undefined) healthOpts.summary = opts.summary;
      await runHealthCommand(healthOpts);
    });

  // sim command (A6: 7-day simulation on redacted copies, undo to raw)
  program
    .command('sim')
    .description('7-day simulation on redacted DB copies with final undo (zero live writes)')
    .option('--days <days>', 'Simulation length in days (default: 7)', '7')
    .option('--out <file>', 'Write report text to file (UTF-8)')
    .action(async (opts: { days?: string; out?: string }) => {
      const simOpts: { days?: number; out?: string } = {};
      if (opts.days !== undefined) simOpts.days = Number(opts.days);
      if (opts.out !== undefined) simOpts.out = opts.out;
      await runSimCommand(simOpts);
    });

  // storage command (B1: read-only storage inspection on a copy)
  const storageCmd = program
    .command('storage')
    .description('Read-only storage inspection (copy-based, allow-listed columns)');

  storageCmd
    .command('inspect')
    .description('Inspect OmniRoute storage tables: key_value, discovery_results, provider_specific_data, model_combo_mappings, model_capabilities')
    .option('--router <router>', 'Target router: omniroute', 'omniroute')
    .option('--out <file>', 'Write report text to file (UTF-8)')
    .action(async (opts: { router?: string; out?: string }) => {
      const stOpts: { router?: string; out?: string } = {};
      if (opts.router !== undefined) stOpts.router = opts.router;
      if (opts.out !== undefined) stOpts.out = opts.out;
      await runStorageInspectCommand(stOpts);
    });

  // discover command (Round 61: read-only model discovery)
  program
    .command('discover')
    .description('Read-only model discovery vs snapshot baseline (zero model calls)')
    .option('--json', 'Output result in JSON format')
    .option('--out <file>', 'Write report text to file (UTF-8)')
    .option('--full', 'Print full report (not truncated)')
    .action(async (opts: { json?: boolean; out?: string; full?: boolean }) => {
      const discoverOpts: { json?: boolean; out?: string; full?: boolean } = {};
      if (opts.json !== undefined) discoverOpts.json = opts.json;
      if (opts.out !== undefined) discoverOpts.out = opts.out;
      if (opts.full !== undefined) discoverOpts.full = opts.full;
      await runDiscoverCommand(discoverOpts);
    });

  // autopilot command group (Round 61: propose-only auto-maintenance plan)
  const autopilotCmd = program
    .command('autopilot')
    .description('Propose-only auto-maintenance plan (no writes at R61)');

  autopilotCmd
    .command('plan')
    .description('Generate unified auto-maintenance plan per router (propose only)')
    .option('--json', 'Output result in JSON format')
    .option('--out <file>', 'Write JSON plan to an additional file path')
    .option('--keep-head <n>', 'Keep first N combo steps unmoved (default 0)')
    .action(async (opts: { json?: boolean; out?: string; keepHead?: string }) => {
      const autoOpts: { json?: boolean; out?: string; keepHead?: number } = {};
      if (opts.json !== undefined) autoOpts.json = opts.json;
      if (opts.out !== undefined) autoOpts.out = opts.out;
      if (opts.keepHead !== undefined) autoOpts.keepHead = Number(opts.keepHead);
      await runAutopilotPlanCommand(autoOpts);
    });

  // profile command group (Round 59: User Profile, P1-P3 General, C1-C5 Combo Rules)
  const profileCmd = program
    .command('profile')
    .description('Manage user profile, workload preferences (P1-P3) and combo constraints (C1-C5)');

  profileCmd
    .command('init')
    .description('Initialize or reconfigure user profile')
    .option('-p, --path <path>', 'Custom profile file path')
    .option('-y, --yes', 'Non-interactive mode with default or specified options')
    .option('--workload <role>', 'Workload role: coding | reasoning | general-chat | agent')
    .option('--cost <pref>', 'Cost preference: free-only | budget | performance-first')
    .option('--strategy <strat>', 'Routing strategy: fallback | round-robin | priority-matrix')
    .action(
      async (opts: {
        path?: string;
        yes?: boolean;
        workload?: string;
        cost?: string;
        strategy?: string;
      }) => {
        await runProfileCommand({ subcommand: 'init', ...opts });
      }
    );

  profileCmd
    .command('show')
    .description('Display current user profile summary')
    .option('-p, --path <path>', 'Custom profile file path')
    .option('--json', 'Output in JSON format')
    .action(async (opts: { path?: string; json?: boolean }) => {
      await runProfileCommand({ subcommand: 'show', ...opts });
    });

  profileCmd
    .command('export')
    .description('Export profile in JSON format')
    .option('-p, --path <path>', 'Custom profile file path')
    .option('--json', 'Output in JSON format')
    .action(async (opts: { path?: string; json?: boolean }) => {
      await runProfileCommand({ subcommand: 'export', ...opts });
    });

  profileCmd
    .command('interview')
    .description('Show W2 profile interview questions (12, Vietnamese)')
    .option('-p, --path <path>', 'Custom profile file path')
    .action(async (opts: { path?: string }) => {
      await runProfileCommand({ subcommand: 'interview', ...opts });
    });

  profileCmd.action(async () => {
    await runProfileCommand({ subcommand: 'show' });
  });

  const exportCmd = program
    .command('export')
    .description('Export combos to external proxy configurations');

  exportCmd
    .command('litellm [combo]')
    .description('Export combo to LiteLLM Proxy YAML configuration')
    .option('--combo <name>', 'Name of combo to export (e.g. test-3)')
    .option('--router <router>', 'Router ID')
    .option('-c, --config <path>', 'Path to routersync configuration file')
    .option('--out <path>', 'Output file path')
    .option('--alias <alias>', 'Alias name for the exported proxy model')
    .option('--retries <count>', 'Number of retries in router_settings', '2')
    .option('--strategy <strategy>', 'Routing strategy in router_settings', 'simple-shuffle')
    .action(
      async (
        comboArg: string | undefined,
        opts: {
          combo?: string;
          router?: string;
          config?: string;
          out?: string;
          alias?: string;
          retries?: string;
          strategy?: string;
        }
      ) => {
        await runExportLiteLLMCommand({
          combo: comboArg || opts.combo,
          router: opts.router,
          config: opts.config,
          out: opts.out,
          alias: opts.alias,
          retries: opts.retries,
          strategy: opts.strategy,
        });
      }
    );

  // apps command group — read-only agent app inspection (no write flag)
  const appsCmd = program
    .command('apps')
    .description('Inspect agent app configuration (read-only)');

  appsCmd
    .command('inspect')
    .description('Read provider/model configuration of supported agent apps')
    .option('--app <app>', 'Target app (hermes, dsh, opencode)')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'Explicit config file (single app only)')
    .option('--json', 'Output results in JSON format')
    .action(async (opts: { app?: string; home?: string; config?: string; json?: boolean }) => {
      await runAppsInspectCommand({
        app: opts.app,
        home: opts.home,
        config: opts.config,
        json: opts.json,
      });
    });

  appsCmd
    .command('drift')
    .description('Đối chiếu model app agent với trạng thái router (chỉ đọc)')
    .option('--app <app>', 'Target app (hermes, dsh, opencode)')
    .option('--router <router>', 'Router để đối chiếu (9router, omniroute)')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'routersync.yaml hoặc config app (single app only)')
    .option('--redact', 'Che tên provider không public (mặc định bật khi ghi tệp)')
    .option('--no-redact', 'Tắt che tên provider')
    .option('--json', 'Output results in JSON format')
    .action(async (opts: { app?: string; router?: string; home?: string; config?: string; redact?: boolean; json?: boolean }) => {
      await runAppsDriftCommand({
        app: opts.app,
        router: opts.router,
        home: opts.home,
        config: opts.config,
        redact: opts.redact,
        json: opts.json,
      });
    });

  // agents command group (Agent Configuration Management / Condition AGENT-WRITE-01)
  const agentsCmd = program
    .command('agents')
    .description('Manage agent harness model definitions (Hermes Agent, DeepSeek Harness)');

  agentsCmd
    .command('discover')
    .description('Discover configuration files for supported agent harnesses')
    .option('--agent <agent>', 'Target agent (hermes, dsh, or all)', 'all')
    .option('--home <dir>', 'Custom user home directory')
    .option('--json', 'Output results in JSON format')
    .action(async (opts: { agent?: string; home?: string; json?: boolean }) => {
      await runAgentsDiscoverCommand({
        agent: opts.agent,
        home: opts.home,
        json: opts.json,
      });
    });

  agentsCmd
    .command('dry-run')
    .description('Preview model list additions/modifications for target agents')
    .option('--agent <agent>', 'Target agent (hermes, dsh, or all)', 'all')
    .option('--models <models>', 'Comma-separated model IDs (defaults to test-3)', 'test-3')
    .option('--provider <provider>', 'Provider identifier in agent config')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'Custom agent config file path')
    .option('--json', 'Output results in JSON format')
    .action(
      async (opts: {
        agent?: string;
        models?: string;
        provider?: string;
        home?: string;
        config?: string;
        json?: boolean;
      }) => {
        await runAgentsDryRunCommand({
          agent: opts.agent,
          models: opts.models,
          provider: opts.provider,
          home: opts.home,
          configPath: opts.config,
          json: opts.json,
        });
      }
    );

  agentsCmd
    .command('apply')
    .description('Apply model definitions to target agent configuration files')
    .option('--agent <agent>', 'Target agent (hermes, dsh, or all)', 'all')
    .option('--models <models>', 'Comma-separated model IDs (defaults to test-3)', 'test-3')
    .option('--provider <provider>', 'Provider identifier in agent config')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'Custom agent config file path')
    .option('--state-dir <dir>', 'Custom state directory for grant validation')
    .option('--grant <id>', 'Grant authorization token')
    .action(
      async (opts: {
        agent?: string;
        models?: string;
        provider?: string;
        home?: string;
        config?: string;
        stateDir?: string;
        grant?: string;
      }) => {
        await runAgentsApplyCommand({
          agent: opts.agent,
          models: opts.models,
          provider: opts.provider,
          home: opts.home,
          configPath: opts.config,
          stateDir: opts.stateDir,
          grant: opts.grant,
        });
      }
    );

  agentsCmd
    .command('rollback')
    .description('Restore original agent configuration from backup')
    .option('--agent <agent>', 'Target agent (hermes, dsh, or all)', 'all')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'Custom agent config file path')
    .option('--backup <path>', 'Explicit backup file path to restore from')
    .action(
      async (opts: {
        agent?: string;
        home?: string;
        config?: string;
        backup?: string;
      }) => {
        await runAgentsRollbackCommand({
          agent: opts.agent,
          home: opts.home,
          configPath: opts.config,
          backup: opts.backup,
        });
      }
    );

  agentsCmd
    .command('update')
    .description('Unified agent model update workflow (dry-run, apply, rollback, roundtrip)')
    .option('--agent <agent>', 'Target agent (hermes, dsh, or all)', 'all')
    .option('--models <models>', 'Comma-separated model IDs (defaults to test-3)', 'test-3')
    .option('--provider <provider>', 'Provider identifier in agent config')
    .option('--home <dir>', 'Custom user home directory')
    .option('-c, --config <path>', 'Custom agent config file path')
    .option('--state-dir <dir>', 'Custom state directory for grant validation')
    .option('--grant <id>', 'Grant authorization token')
    .option('--dry-run', 'Preview changes without modifying files')
    .option('--apply', 'Apply changes to configuration files')
    .option('--rollback', 'Rollback changes from backup')
    .option('--roundtrip', 'Apply changes, verify readback, and immediately rollback')
    .option('--json', 'Output results in JSON format')
    .action(
      async (opts: {
        agent?: string;
        models?: string;
        provider?: string;
        home?: string;
        config?: string;
        stateDir?: string;
        grant?: string;
        dryRun?: boolean;
        apply?: boolean;
        rollback?: boolean;
        roundtrip?: boolean;
        json?: boolean;
      }) => {
        await runAgentsUpdateCommand({
          agent: opts.agent,
          models: opts.models,
          provider: opts.provider,
          home: opts.home,
          configPath: opts.config,
          stateDir: opts.stateDir,
          grant: opts.grant,
          dryRun: opts.dryRun,
          apply: opts.apply,
          rollback: opts.rollback,
          roundtrip: opts.roundtrip,
          json: opts.json,
        });
      }
    );

  return program;
}

// Execute when invoked directly from CLI
function isDirectExecution(): boolean {
  const rawArgv = process.argv[1];
  if (!rawArgv) return false;
  const argvPath = rawArgv.replace(/\\/g, '/');
  if (
    argvPath.endsWith('dist/index.js') ||
    argvPath.endsWith('src/index.ts') ||
    argvPath.endsWith('/routersync') ||
    argvPath === 'routersync'
  ) {
    return true;
  }
  try {
    const real = realpathSync(rawArgv).replace(/\\/g, '/');
    return (
      real.endsWith('dist/index.js') ||
      real.endsWith('src/index.ts') ||
      real.endsWith('/routersync')
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  createCliProgram().parseAsync(process.argv).catch((err: unknown) => {
    console.error(`[routersync] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
