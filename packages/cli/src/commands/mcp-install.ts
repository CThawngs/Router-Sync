/**
 * packages/cli/src/commands/mcp-install.ts
 *
 * Implements `routersync mcp install --client <harness>` wired dynamically to
 * `harness-matrix.json` across all 9 WP1 harnesses (Phục vụ: S2, Condition C2 & AT-94).
 *
 * Enforces:
 *  - Default `--dry-run` (shows diff, zero file modifications)
 *  - Lossless non-destructive merge preserving comments & unrelated keys
 *  - `.bak` Backup -> Atomic Write -> Read-back -> Auto-Rollback on mismatch
 *  - Zero secret leakage & strict canonical realpath/symlink/junction `os.homedir()` write guard
 *  - OpenMausBot `bots.json` / `routines.json` safety guard
 *  - `--write` requires interactive TTY confirmation (unless `allowNonTtyForTest` on temp sandbox)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isMap, parseDocument } from 'yaml';
import {
  expandHarnessPathPattern,
  getHarnessCapability,
  listHarnessCapabilities,
  type HarnessCapability,
  type HarnessId,
} from '@routersync/core';
import {
  parseJsoncObject,
  upsertJsoncNestedEntry,
  upsertTomlMcpServerTable,
  upsertYamlMcpServer,
  verifyTomlMcpServerTable,
} from '../apps/lossless-edit.js';
import {
  assertHarnessWriteSandboxAllowed,
  assertOpenMausBotSafeFile,
} from '../apps/write-adapter.js';

const currentDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : path.dirname(fileURLToPath(import.meta.url));

export type McpClientType = HarnessId;

export interface McpInstallOptions {
  client: string;
  write?: boolean | undefined;
  dryRun?: boolean | undefined;
  print?: boolean | undefined;
  targetFile?: string | undefined;
  json?: boolean | undefined;
  allowNonTtyForTest?: boolean | undefined;
  injectReadBackFault?: boolean | undefined;
}

export interface McpInstallReport {
  client: McpClientType;
  mode: 'dry-run' | 'live-write';
  configFile: string;
  backupFile?: string | undefined;
  diff: string;
  success: boolean;
  rolledBack?: boolean | undefined;
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
  return path.resolve(currentDir, '..', '..', '..', 'mcp-server', 'dist', 'index.js');
}

function assertSafeMcpWriteTarget(targetFile: string): void {
  assertHarnessWriteSandboxAllowed(targetFile);
  assertHarnessWriteSandboxAllowed(`${targetFile}.bak`);
}

function resolveDefaultMcpTargetPath(cap: HarnessCapability): string {
  const platformKey: 'win32' | 'darwin' | 'linux' =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';

  if (cap.mcp.envOverride && process.env[cap.mcp.envOverride]) {
    const envRoot = process.env[cap.mcp.envOverride]!;
    if (cap.id === 'opencode') {
      return path.resolve(envRoot);
    }
    const baseName =
      cap.id === 'hermes'
        ? 'config.yaml'
        : cap.id === 'codex'
          ? 'config.toml'
          : cap.id === 'openmausbot'
            ? 'config.json'
            : cap.id === 'dsh'
              ? path.join('profiles', 'desktop', 'cordis.patch.yml')
              : 'mcp.json';
    return path.join(envRoot, baseName);
  }

  const patterns = cap.mcp.paths[platformKey] ?? [];
  const expanded = patterns.map((p) => expandHarnessPathPattern(p, { platform: process.platform }));
  for (const candidate of expanded) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return expanded[0] ?? '';
}

function buildPrintSnippet(cap: HarnessCapability, normalizedEntrypoint: string): string {
  switch (cap.id) {
    case 'claude-code':
      return (
        `claude mcp add --scope user routersync -- node "${normalizedEntrypoint}"\n` +
        JSON.stringify(
          { mcpServers: { routersync: { command: 'node', args: [normalizedEntrypoint] } } },
          null,
          2
        )
      );
    case 'cursor':
      return JSON.stringify(
        { mcpServers: { routersync: { command: 'node', args: [normalizedEntrypoint] } } },
        null,
        2
      );
    case 'antigravity':
      return (
        JSON.stringify(
          { mcpServers: { routersync: { command: 'node', args: [normalizedEntrypoint] } } },
          null,
          2
        ) + `\n# target: ${cap.mcp.paths.linux[0]} (stdio entry without "type")`
      );
    case 'openmausbot':
      return JSON.stringify(
        {
          mcpServers: {
            routersync: { command: 'node', args: [normalizedEntrypoint], enabled: true },
          },
        },
        null,
        2
      );
    case 'opencode':
      return JSON.stringify(
        {
          mcp: {
            routersync: {
              type: 'local',
              command: ['node', normalizedEntrypoint],
              enabled: true,
            },
          },
        },
        null,
        2
      );
    case 'codex':
      return `[mcp_servers.routersync]\ncommand = "node"\nargs = ["${normalizedEntrypoint}"]`;
    case 'hermes':
      return (
        `mcp_servers:\n  routersync:\n    command: node\n    args:\n      - "${normalizedEntrypoint}"\n` +
        `# CLI: hermes mcp add routersync -- node "${normalizedEntrypoint}"`
      );
    case 'dsh':
      return (
        `# RouterSync MCP Server Patch\n` +
        `- insert: mcpServers.routersync\n` +
        `  command: node\n` +
        `  args:\n` +
        `    - "${normalizedEntrypoint}"`
      );
    case 'grok-bot':
      return (
        `# [grok-bot] Hướng dẫn kết nối MCP từ harness-matrix.json:\n` +
        `# 1) Grok Bot (Cloud): chỉ nhận Remote HTTPS MCP công khai (grok.com/manage-connectors), từ chối stdio/localhost.\n` +
        `# 2) Grok Build CLI đi kèm (~/.grok/config.toml): grok mcp add routersync -- node "${normalizedEntrypoint}"\n` +
        `[mcp_servers.routersync]\ncommand = "node"\nargs = ["${normalizedEntrypoint}"]`
      );
  }
}

function atomicWriteWithBackupAndReadBack(
  filePath: string,
  newContent: string,
  verifyFn: (writtenContent: string) => boolean,
  injectFault: boolean
): { verified: boolean; backupFile: string | undefined; rolledBack: boolean } {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const existedBefore = fs.existsSync(filePath);
  const backupFile = existedBefore ? `${filePath}.bak` : undefined;
  const originalBytes = existedBefore ? fs.readFileSync(filePath) : undefined;

  if (backupFile && originalBytes) {
    const bakTmp = `${backupFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(bakTmp, originalBytes);
    fs.renameSync(bakTmp, backupFile);
  }

  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, newContent, 'utf8');
  fs.renameSync(tmpFile, filePath);

  let verified = false;
  try {
    if (injectFault) {
      throw new Error('Injected MCP read-back fault');
    }
    const readBackText = fs.readFileSync(filePath, 'utf8');
    verified = verifyFn(readBackText);
  } catch {
    verified = false;
  }

  if (!verified) {
    if (existedBefore && originalBytes) {
      const restoreTmp = `${filePath}.restore-${process.pid}-${Date.now()}`;
      fs.writeFileSync(restoreTmp, originalBytes);
      fs.renameSync(restoreTmp, filePath);
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { verified: false, backupFile, rolledBack: true };
  }

  return { verified: true, backupFile, rolledBack: false };
}

export async function runMcpInstallCommand(options: McpInstallOptions): Promise<McpInstallReport> {
  if (process.argv.includes('--yes')) {
    console.error('Lỗi: Cờ --yes bị từ chối.');
    process.exit(1);
  }

  const allCapabilities = listHarnessCapabilities();
  const validClients = allCapabilities.map((h) => h.id);
  const cap = getHarnessCapability(options.client);
  if (!cap) {
    console.error(
      `Lỗi: Client không được hỗ trợ '${options.client}'. Các client hỗ trợ: ${validClients.join(', ')}`
    );
    process.exit(1);
  }

  if (cap.id === 'openmausbot' && options.targetFile) {
    assertOpenMausBotSafeFile(options.targetFile);
  }

  const isWrite = Boolean(options.write) && !options.dryRun;
  if (isWrite && !options.allowNonTtyForTest && !process.stdin.isTTY) {
    console.error('Lỗi: Thao tác ghi yêu cầu terminal tương tác (TTY).');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const mcpEntrypoint = resolveMcpServerEntrypoint();
  const normalizedEntrypoint = mcpEntrypoint.replace(/\\/g, '/');

  if (options.print) {
    if (isWrite) {
      throw new Error('Cannot combine --print and --write.');
    }
    const printTarget = options.targetFile ?? resolveDefaultMcpTargetPath(cap);
    if (cap.id === 'openmausbot' && printTarget) {
      assertOpenMausBotSafeFile(printTarget);
    }
    const snippet = buildPrintSnippet(cap, normalizedEntrypoint);
    console.log(snippet);
    return {
      client: cap.id,
      mode: 'dry-run',
      configFile: printTarget,
      diff: snippet,
      success: true,
      message: 'Printed MCP configuration.',
      timestamp,
    };
  }

  if (cap.id === 'grok-bot' && !options.targetFile) {
    if (isWrite) {
      throw new Error(
        '[grok-bot] Grok Bot (Cloud) chỉ hỗ trợ Remote HTTPS MCP công khai và không có tệp stdio cục bộ. Để ghi tệp cấu hình companion CLI cục bộ, vui lòng truyền tường minh targetFile / --file <path>.'
      );
    }
    const guidance = buildPrintSnippet(cap, normalizedEntrypoint);
    if (options.json) {
      const report: McpInstallReport = {
        client: 'grok-bot',
        mode: 'dry-run',
        configFile: '',
        diff: guidance,
        success: true,
        message: cap.mcp.notes,
        timestamp,
      };
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    console.log(guidance);
    return {
      client: 'grok-bot',
      mode: 'dry-run',
      configFile: '',
      diff: guidance,
      success: true,
      message: cap.mcp.notes,
      timestamp,
    };
  }

  let filePath = options.targetFile ?? resolveDefaultMcpTargetPath(cap);
  if (cap.id === 'hermes' && !options.targetFile && !fs.existsSync(filePath)) {
    const home = process.env['HOME'] || os.homedir();
    const legacyJson = path.join(home, '.hermes', 'mcp_config.json');
    if (fs.existsSync(legacyJson)) {
      filePath = legacyJson;
    }
  }

  if (cap.id === 'openmausbot') {
    assertOpenMausBotSafeFile(filePath);
  }
  if (isWrite) {
    assertSafeMcpWriteTarget(filePath);
  }

  const originalContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const ext = path.extname(filePath).toLowerCase();

  let newContent = '';
  let diffSummary = '';
  let verifyFn: (written: string) => boolean;

  if (cap.id === 'dsh') {
    const patchEntry =
      `\n# RouterSync MCP Server Patch\n` +
      `- insert: mcpServers.routersync\n` +
      `  command: node\n` +
      `  args:\n` +
      `    - "${normalizedEntrypoint}"\n`;
    newContent = originalContent.includes('mcpServers.routersync')
      ? originalContent
      : originalContent + patchEntry;
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ insert: mcpServers.routersync -> command: node, args: ["${normalizedEntrypoint}"]`;
    verifyFn = (written) => written.includes('mcpServers.routersync');
  } else if (cap.id === 'hermes' && ext === '.json') {
    let existingJson: Record<string, unknown> = { mcpServers: {} };
    if (originalContent.trim()) {
      try {
        existingJson = JSON.parse(originalContent) as Record<string, unknown>;
      } catch {
        existingJson = { mcpServers: {} };
      }
    }
    const mcpServers = (existingJson['mcpServers'] as Record<string, unknown>) ?? {};
    const updatedJson = {
      ...existingJson,
      mcpServers: {
        ...mcpServers,
        routersync: {
          command: 'node',
          args: [mcpEntrypoint],
          disabled: false,
          autoApprove: [],
        },
      },
    };
    newContent = JSON.stringify(updatedJson, null, 2);
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ "routersync": { command: "node", args: ["${normalizedEntrypoint}"] }`;
    verifyFn = (written) => {
      const parsed = JSON.parse(written) as Record<string, unknown>;
      const servers = parsed['mcpServers'] as Record<string, unknown> | undefined;
      return Boolean(servers && servers['routersync']);
    };
  } else if (cap.id === 'hermes' || ext === '.yaml' || ext === '.yml') {
    const topKey = cap.mcp.topLevelKey ?? 'mcp_servers';
    newContent = upsertYamlMcpServer(originalContent, topKey, 'routersync', 'node', [
      normalizedEntrypoint,
    ]);
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ ${topKey}.routersync: { command: node, args: ["${normalizedEntrypoint}"] }`;
    verifyFn = (written) => {
      const doc = parseDocument(written, { logLevel: 'silent' });
      if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
      const js = doc.toJS() as Record<string, unknown>;
      const servers = js[topKey] as Record<string, unknown> | undefined;
      return Boolean(servers && servers['routersync']);
    };
  } else if (cap.id === 'codex' || ext === '.toml') {
    const topKey = cap.mcp.topLevelKey ?? cap.companionCli?.topLevelKey ?? 'mcp_servers';
    newContent = upsertTomlMcpServerTable(originalContent, topKey, 'routersync', 'node', [
      normalizedEntrypoint,
    ]);
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ [${topKey}.routersync] command = "node" args = ["${normalizedEntrypoint}"]`;
    verifyFn = (written) => verifyTomlMcpServerTable(written, topKey, 'routersync');
  } else if (cap.id === 'opencode') {
    const entry = {
      type: 'local',
      command: ['node', normalizedEntrypoint],
      enabled: true,
    };
    newContent = upsertJsoncNestedEntry(originalContent, 'mcp', 'routersync', entry);
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ mcp.routersync: ${JSON.stringify(entry)}`;
    verifyFn = (written) => {
      const { value } = parseJsoncObject(written);
      const mcp = value['mcp'] as Record<string, unknown> | undefined;
      const rs = mcp?.['routersync'] as Record<string, unknown> | undefined;
      return Boolean(rs && rs['type'] === 'local' && Array.isArray(rs['command']));
    };
  } else {
    const entry: Record<string, unknown> =
      cap.id === 'openmausbot'
        ? { command: 'node', args: [normalizedEntrypoint], enabled: true }
        : { command: 'node', args: [normalizedEntrypoint] };
    const topKey = cap.mcp.topLevelKey ?? 'mcpServers';
    newContent = upsertJsoncNestedEntry(originalContent, topKey, 'routersync', entry);
    diffSummary = `--- ${filePath} (before)\n+++ ${filePath} (after)\n+ ${topKey}.routersync: ${JSON.stringify(entry)}`;
    verifyFn = (written) => {
      const { value } = parseJsoncObject(written);
      const servers = value[topKey] as Record<string, unknown> | undefined;
      const rs = servers?.['routersync'] as Record<string, unknown> | undefined;
      if (!rs || rs['command'] !== 'node') return false;
      if (cap.id === 'antigravity' && 'type' in rs) return false;
      return true;
    };
  }

  if (!isWrite) {
    const report: McpInstallReport = {
      client: cap.id,
      mode: 'dry-run',
      configFile: filePath,
      diff: diffSummary,
      success: true,
      message: 'Dry-run successful. Zero files modified. Run with --write to apply.',
      timestamp,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[routersync] [DRY-RUN] Previewing ${cap.displayName} MCP configuration:`);
      console.log(`Target: ${filePath}`);
      console.log(diffSummary);
    }
    return report;
  }

  assertSafeMcpWriteTarget(filePath);

  if (!options.allowNonTtyForTest) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Write Execution Blocked: Running with --write requires an interactive TTY terminal (Condition C2).'
      );
    }
    console.log(`\nProposed change to: ${filePath}`);
    console.log(diffSummary);
    const confirmed = await askConfirmation(
      `Are you sure you want to write to ${cap.displayName} MCP config? [yes/N]: `
    );
    if (!confirmed) {
      return {
        client: cap.id,
        mode: 'live-write',
        configFile: filePath,
        diff: diffSummary,
        success: false,
        message: 'Operation cancelled by user.',
        timestamp,
      };
    }
  }

  const writeOutcome = atomicWriteWithBackupAndReadBack(
    filePath,
    newContent,
    verifyFn,
    Boolean(options.injectReadBackFault)
  );

  if (!writeOutcome.verified) {
    throw new Error(
      `Read-back verification failed for ${cap.displayName}; automatic rollback restored ${filePath} from backup.`
    );
  }

  return {
    client: cap.id,
    mode: 'live-write',
    configFile: filePath,
    backupFile: writeOutcome.backupFile,
    diff: diffSummary,
    success: true,
    rolledBack: false,
    message: `Successfully configured ${cap.displayName} MCP server.`,
    timestamp,
  };
}
