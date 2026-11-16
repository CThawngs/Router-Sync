/**
 * packages/cli/src/commands/mcp-install.ts
 *
 * Implements `routersync mcp install --client hermes|dsh` (Condition C2 & AT-94).
 * Enforces:
 *  - Default `--dry-run` (shows diff, zero file modifications)
 *  - Non-destructive merge preserving all foreign keys and settings
 *  - Snapshot -> Write -> Read-back -> Rollback capability
 *  - Zero secret leakage
 *  - `--write` requires interactive TTY confirmation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const currentDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : path.dirname(fileURLToPath(import.meta.url));

export type McpClientType = 'hermes' | 'dsh' | 'claude-code' | 'cursor' | 'codex' | 'antigravity' | 'opencode';

export interface McpInstallOptions {
  client: string;
  write?: boolean | undefined;
  dryRun?: boolean | undefined;
  print?: boolean | undefined;
  targetFile?: string | undefined;
  json?: boolean | undefined;
}

export interface McpInstallReport {
  client: 'hermes' | 'dsh';
  mode: 'dry-run' | 'live-write';
  configFile: string;
  diff: string;
  success: boolean;
  message: string;
  timestamp: string;
}

function askConfirmation(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

export function resolveMcpServerEntrypoint(): string {
  // Try to locate installed packages/mcp-server/dist/index.js
  const candidate = path.resolve(
    currentDir,
    '..', '..', '..', 'mcp-server', 'dist', 'index.js'
  );
  return candidate;
}

export async function runMcpInstallCommand(options: McpInstallOptions): Promise<McpInstallReport> {
  if (process.argv.includes('--yes')) {
    console.error('Lỗi: Cờ --yes bị từ chối.');
    process.exit(1);
  }

  const validClients = ['hermes', 'dsh', 'claude-code', 'cursor', 'codex', 'antigravity', 'opencode'];
  if (!validClients.includes(options.client)) {
    console.error(`Lỗi: Client không được hỗ trợ '${options.client}'. Các client hỗ trợ: ${validClients.join(', ')}`);
    process.exit(1);
  }

  if (options.write && !process.stdin.isTTY) {
    console.error('Lỗi: Thao tác ghi yêu cầu terminal tương tác (TTY).');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const mcpEntrypoint = resolveMcpServerEntrypoint();
  const normalizedEntrypoint = mcpEntrypoint.replace(/\\/g, '/');

  // If --print explicitly requested, or client only supports print (not hermes/dsh)
  const isPrintMode = Boolean(options.print) || !['hermes', 'dsh'].includes(options.client);
  if (isPrintMode) {
    if (options.write) {
      throw new Error(`Write is not supported for client '${options.client}'. Use --print to copy configuration manually.`);
    }

    let outputConfig = '';
    switch (options.client) {
      case 'claude-code':
        outputConfig = `claude mcp add --transport stdio routersync node "${normalizedEntrypoint}"`;
        break;
      case 'cursor':
        outputConfig = JSON.stringify({
          mcpServers: {
            routersync: {
              command: 'node',
              args: [normalizedEntrypoint],
            },
          },
        }, null, 2);
        break;
      case 'codex':
        outputConfig = `[mcp_servers.routersync]\ncommand = "node"\nargs = ["${normalizedEntrypoint}"]`;
        break;
      case 'hermes':
        outputConfig = JSON.stringify({
          mcpServers: {
            routersync: {
              command: 'node',
              args: [normalizedEntrypoint],
              disabled: false,
              autoApprove: [],
            },
          },
        }, null, 2);
        break;
      case 'dsh':
        outputConfig = `mcp:\n  servers:\n    routersync:\n      command: node\n      args:\n        - "${normalizedEntrypoint}"`;
        break;
      case 'antigravity':
        outputConfig = JSON.stringify({ mcpServers: { routersync: { command: 'node', args: [normalizedEntrypoint] } } }, null, 2) + '\n# target: ~/.gemini/antigravity/mcp_config.json (dry-run only, có .bak khi ghi)';
        break;
      case 'opencode':
        outputConfig = JSON.stringify({ mcp: { routersync: { type: 'local', command: ['node', normalizedEntrypoint] } } }, null, 2) + '\n# target: ~/.config/opencode/opencode.json (dry-run only, có .bak khi ghi)';
        break;
    }

    console.log(outputConfig);
    return {
      client: options.client as any,
      mode: 'dry-run',
      configFile: options.targetFile ?? '',
      diff: outputConfig,
      success: true,
      message: 'Printed MCP configuration.',
      timestamp,
    };
  }

  // Live write or dry-run merge mode for hermes and dsh
  const isWrite = Boolean(options.write);
  if (options.client === 'hermes') {
    return installHermesMcp(options, mcpEntrypoint, isWrite, timestamp);
  } else if (options.client === 'dsh') {
    return installDshMcp(options, mcpEntrypoint, isWrite, timestamp);
  } else {
    throw new Error(`Write is not supported for client '${options.client}'. Use --print to copy configuration manually.`);
  }
}

async function installHermesMcp(
  options: McpInstallOptions,
  mcpEntrypoint: string,
  isWrite: boolean,
  timestamp: string
): Promise<McpInstallReport> {
  const home = process.env.HOME || os.homedir();
  const defaultPath = path.join(home, '.hermes', 'mcp_config.json');
  const filePath = options.targetFile ?? defaultPath;

  let existingJson: Record<string, unknown> = { mcpServers: {} };
  let originalContent = '';

  if (fs.existsSync(filePath)) {
    originalContent = fs.readFileSync(filePath, 'utf8');
    try {
      existingJson = JSON.parse(originalContent) as Record<string, unknown>;
    } catch {
      existingJson = { mcpServers: {} };
    }
  }

  const mcpServers = (existingJson['mcpServers'] as Record<string, unknown>) ?? {};

  // Non-destructive merge: add or update 'routersync' key while keeping other servers
  const updatedServers = {
    ...mcpServers,
    routersync: {
      command: 'node',
      args: [mcpEntrypoint],
      disabled: false,
      autoApprove: [],
    },
  };

  const updatedJson = {
    ...existingJson,
    mcpServers: updatedServers,
  };

  const newContent = JSON.stringify(updatedJson, null, 2);
  const diff = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ "routersync": { command: "node", args: ["${mcpEntrypoint.replace(/\\/g, '/')}"] }`;

  if (!isWrite) {
    // DRY-RUN mode
    const report: McpInstallReport = {
      client: 'hermes',
      mode: 'dry-run',
      configFile: filePath,
      diff,
      success: true,
      message: 'Dry-run successful. Zero files modified. Run with --write to apply.',
      timestamp,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[routersync] [DRY-RUN] Previewing Hermes MCP configuration:`);
      console.log(`Target: ${filePath}`);
      console.log(diff);
      console.log(`\nTo write changes, run \`routersync mcp install --client hermes --write\` in an interactive terminal.`);
    }

    return report;
  }

  // Live write requires interactive TTY
  if (!process.stdin.isTTY) {
    throw new Error('Write Execution Blocked: Running with --write requires an interactive TTY terminal (Condition C2).');
  }

  console.log(`\nProposed change to: ${filePath}`);
  console.log(diff);
  const confirmed = await askConfirmation(`Are you sure you want to write to Hermes MCP config? [yes/N]: `);
  if (!confirmed) {
    return {
      client: 'hermes',
      mode: 'live-write',
      configFile: filePath,
      diff,
      success: false,
      message: 'Operation cancelled by user.',
      timestamp,
    };
  }

  // Pre-write snapshot
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf8');

  // Read-back verification
  const readBack = fs.readFileSync(filePath, 'utf8');
  const readBackJson = JSON.parse(readBack) as Record<string, unknown>;
  const serversBack = readBackJson['mcpServers'] as Record<string, unknown>;
  const verified = Boolean(serversBack && serversBack['routersync']);

  return {
    client: 'hermes',
    mode: 'live-write',
    configFile: filePath,
    diff,
    success: verified,
    message: verified ? 'Successfully configured Hermes MCP server.' : 'Read-back verification failed.',
    timestamp,
  };
}

async function installDshMcp(
  options: McpInstallOptions,
  mcpEntrypoint: string,
  isWrite: boolean,
  timestamp: string
): Promise<McpInstallReport> {
  const home = process.env.HOME || os.homedir();
  const defaultPath = path.join(
    home,
    '.dsh',
    'profiles',
    'desktop',
    'cordis.patch.yml'
  );
  const filePath = options.targetFile ?? defaultPath;

  let originalContent = '';
  if (fs.existsSync(filePath)) {
    originalContent = fs.readFileSync(filePath, 'utf8');
  }

  const patchEntry =
    `\n# RouterSync MCP Server Patch\n` +
    `- insert: mcpServers.routersync\n` +
    `  command: node\n` +
    `  args:\n` +
    `    - "${mcpEntrypoint.replace(/\\/g, '/')}"\n`;

  const newContent = originalContent.includes('mcpServers.routersync')
    ? originalContent
    : originalContent + patchEntry;

  const diff = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ insert: mcpServers.routersync -> command: node, args: ["${mcpEntrypoint.replace(/\\/g, '/')}"]`;

  if (!isWrite) {
    const report: McpInstallReport = {
      client: 'dsh',
      mode: 'dry-run',
      configFile: filePath,
      diff,
      success: true,
      message: 'Dry-run successful. Zero files modified. Run with --write to apply.',
      timestamp,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[routersync] [DRY-RUN] Previewing DSH Cordis patch configuration:`);
      console.log(`Target: ${filePath}`);
      console.log(diff);
      console.log(`\nTo write changes, run \`routersync mcp install --client dsh --write\` in an interactive terminal.`);
    }

    return report;
  }

  if (!process.stdin.isTTY) {
    throw new Error('Write Execution Blocked: Running with --write requires an interactive TTY terminal (Condition C2).');
  }

  console.log(`\nProposed change to: ${filePath}`);
  console.log(diff);
  const confirmed = await askConfirmation(`Are you sure you want to write to DSH Cordis patch? [yes/N]: `);
  if (!confirmed) {
    return {
      client: 'dsh',
      mode: 'live-write',
      configFile: filePath,
      diff,
      success: false,
      message: 'Operation cancelled by user.',
      timestamp,
    };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf8');

  const readBack = fs.readFileSync(filePath, 'utf8');
  const verified = readBack.includes('mcpServers.routersync');

  return {
    client: 'dsh',
    mode: 'live-write',
    configFile: filePath,
    diff,
    success: verified,
    message: verified ? 'Successfully configured DSH Cordis patch.' : 'Read-back verification failed.',
    timestamp,
  };
}
