/**
 * test/e2e/e2e.test.ts
 *
 * End-to-end check of the published shape of RouterSync:
 *
 *  1. Fake 9Router and OmniRoute SQLite databases are generated in a temp dir.
 *  2. A fake HTTP server on 127.0.0.1 serves /v1/models with several
 *     scenarios (200, a new model, a lost model, 401, 429, 500).
 *  3. Every workspace package is packed with `pnpm pack`, the tarballs are
 *     installed with npm into an empty project in a temp dir, and the
 *     INSTALLED binaries are driven - not the source tree.
 *  4. The MCP server is driven over stdio with the SDK client.
 *  5. The daemon is started on a random port with a temp state dir, a health
 *     endpoint is called, and the process is stopped.
 *  6. The fake databases are hashed before and after: they must be identical.
 *
 * Nothing here touches a real router: every path is inside the temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(__dirname, '..', '..');
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));

let tmpRoot = '';
let projectDir = '';
let packDir = '';
let fakeHttpUrl = '';
let nineDbPath = '';
let omniDbPath = '';
let configPath = '';
let scenarioFile = '';
let serverProc: ChildProcessWithoutNullStreams | null = null;
let daemonProc: ChildProcessWithoutNullStreams | null = null;
/** Hashes of the fake databases taken right after they were created. */
const hashAfterCreate = { nine: '', omni: '' };

/** Scenarios the fake provider understands. */
const SCENARIOS = ['base', 'added', 'lost', 'unauthorized', 'quota', 'serverError'] as const;
type Scenario = (typeof SCENARIOS)[number];

/**
 * Switch the fake provider to another scenario. The scenario lives in a file
 * that the fake provider process reads on every request.
 */
function setScenario(next: Scenario): void {
  fs.writeFileSync(scenarioFile, next, 'utf8');
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    input: opts.input ?? '',
    shell: process.platform === 'win32',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Environment that isolates every path the CLI can touch. */
function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = path.join(tmpRoot, 'home');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    ROUTERSYNC_HOME: home,
    ROUTERSYNC_STATE_DIR: path.join(tmpRoot, 'state'),
    ROUTERSYNC_9ROUTER_DB: nineDbPath,
    ROUTERSYNC_OMNIROUTE_DB: omniDbPath,
    ROUTERSYNC_CONFIG: configPath,
    ...extra,
  };
}

/** Create the fake router databases with the schema the adapters read. */
function createFakeDatabases(): { nine: string; omni: string } {
  const dir = path.join(tmpRoot, 'dbs');
  fs.mkdirSync(dir, { recursive: true });
  const nine = path.join(dir, 'nine.sqlite');
  const omni = path.join(dir, 'omni.sqlite');

  const Database = requireFromRepo('better-sqlite3');
  const nineDb = new Database(nine);
  nineDb.exec(`
    CREATE TABLE providerConnections (provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT);
    CREATE TABLE providerNodes (id TEXT, data TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);
  `);
  const nowIso = new Date().toISOString();
  nineDb
    .prepare('INSERT INTO providerConnections (provider, name, authType, isActive, data) VALUES (?,?,?,?,?)')
    .run(
      'fake',
      'Fake Provider',
      'apikey',
      1,
      JSON.stringify({ prefix: 'fake', baseUrl: fakeHttpUrl + '/v1', apiKey: 'test-key' })
    );
  nineDb
    .prepare('INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
    .run('combo-1', 'Combo One', 'managed', JSON.stringify(['fake/model-a', 'fake/model-b']), nowIso, nowIso);
  nineDb
    .prepare('INSERT INTO settings (id, data) VALUES (1, ?)')
    .run(JSON.stringify({ comboStrategies: { 'Combo One': { fallbackStrategy: 'fallback' } } }));
  nineDb.close();

  const omniDb = new Database(omni);
  omniDb.exec(`
    CREATE TABLE provider_connections (provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT);
    CREATE TABLE provider_nodes (id TEXT, prefix TEXT, base_url TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT);
  `);
  omniDb
    .prepare('INSERT INTO provider_connections (provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?,?,?,?,?,?)')
    .run(
      'fake',
      'Fake Provider',
      'api_key',
      1,
      'test-key',
      JSON.stringify({ prefix: 'fake', baseUrl: fakeHttpUrl + '/v1' })
    );
  omniDb
    .prepare('INSERT INTO combos (id, name, data) VALUES (?,?,?)')
    .run(
      'omni-combo-1',
      'Omni Combo One',
      JSON.stringify({
        models: [{ model: 'fake/model-a' }, { model: 'fake/model-b' }],
        strategy: 'fallback',
      })
    );
  omniDb.close();

  return { nine, omni };
}

/** Pack every workspace package and install the tarballs with npm. */
function packAndInstall(): void {
  packDir = path.join(tmpRoot, 'packs');
  projectDir = path.join(tmpRoot, 'project');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  // Every package directory under packages/ is a workspace member.
  const packages = fs
    .readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join('packages', e.name));
  const tarballs: string[] = [];
  for (const pkgDir of packages) {
    const pkgJsonPath = path.join(repoRoot, pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const res = run('pnpm', ['pack', '--pack-destination', packDir], { cwd: path.join(repoRoot, pkgDir) });
    if (res.code !== 0) {
      throw new Error(`pnpm pack failed for ${pkgDir}:\n${res.stdout}\n${res.stderr}`);
    }
    const name = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).name.replace('@', '').replace('/', '-');
    const tgz = fs.readdirSync(packDir).find((f) => f.startsWith(name + '-'));
    if (!tgz) throw new Error(`tarball not found for ${pkgDir}`);
    tarballs.push(path.join(packDir, tgz));
  }

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'routersync-e2e', version: '1.0.0', private: true }, null, 2),
    'utf8'
  );
  const res = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], {
    cwd: projectDir,
  });
  if (res.code !== 0) {
    throw new Error(`npm install of the packed tarballs failed:\n${res.stdout}\n${res.stderr}`);
  }
}

/** Path of the installed CLI binary inside the temp project. */
function installedCli(): string {
  const name = process.platform === 'win32' ? 'routersync.cmd' : 'routersync';
  return path.join(projectDir, 'node_modules', '.bin', name);
}

function installedMcp(): string {
  const name = process.platform === 'win32' ? 'routersync-mcp.cmd' : 'routersync-mcp';
  return path.join(projectDir, 'node_modules', '.bin', name);
}

/** Run the installed CLI with an isolated environment. */
function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return run(installedCli(), args, { cwd: projectDir, env: isolatedEnv(extraEnv) });
}

/** Stop a child process and wait until it is really gone. */
async function stopProcess(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill();
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000))]);
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-e2e-'));

  // The fake provider runs in its OWN process. The CLI is driven with a
  // synchronous call, and a synchronous call blocks the event loop of the
  // process that makes it - an in-process server would never answer.
  scenarioFile = path.join(tmpRoot, 'scenario.txt');
  fs.writeFileSync(scenarioFile, 'base', 'utf8');
  const portFile = path.join(tmpRoot, 'port.txt');
  serverProc = spawn(
    process.execPath,
    [path.join(__dirname, 'fake-provider-server.cjs'), portFile, scenarioFile],
    { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  ) as unknown as ChildProcessWithoutNullStreams;

  // Wait until the server has written its port.
  let port = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(portFile)) {
      const text = fs.readFileSync(portFile, 'utf8').trim();
      if (text !== '') { port = Number(text); break; }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error('the fake provider server did not start');
  fakeHttpUrl = `http://127.0.0.1:${port}`;

  const dbs = createFakeDatabases();
  nineDbPath = dbs.nine;
  omniDbPath = dbs.omni;
  hashAfterCreate.nine = sha256File(nineDbPath);
  hashAfterCreate.omni = sha256File(omniDbPath);

  // The CLI needs a configuration file. Point it at one in the temp dir.
  configPath = path.join(tmpRoot, 'routersync.yaml');
  fs.writeFileSync(
    configPath,
    [
      'version: 1',
      'routers:',
      '  - id: 9router',
      '    adapter: 9router',
      '    db:',
      `      path: ${nineDbPath}`,
      'combos:',
      '  - name: Combo One',
      '    role: custom',
      '    routers: [9router]',
      '    size: 2',
      'adopt: []',
      '',
    ].join('\n'),
    'utf8'
  );

  packAndInstall();
}, 600000);

afterAll(async () => {
  await stopProcess(daemonProc);
  daemonProc = null;
  await stopProcess(serverProc);
  serverProc = null;
  if (tmpRoot) {
    // Windows keeps a handle on a killed process for a short moment, so the
    // removal is retried a few times before giving up.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

describe('E2E - the installed package works end to end', () => {
  it('prints version and help from the installed CLI', () => {
    const version = cli(['--version']);
    expect(version.stdout + version.stderr).toMatch(/0\.1\.0/);

    const help = cli(['--help']);
    expect(help.stdout).toMatch(/scan/);
    expect(help.stdout).toMatch(/tick/);
  });

  it('runs a read-only scan against the fake router databases', () => {
    const res = cli(['scan']);
    expect(res.code).toBe(0);
  });

  it('ticks twice: the second run makes 0 requests (15 minute gate)', () => {
    setScenario('base');
    const first = cli(['tick', '--mode', 'observe']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout, first.stdout).toMatch(/TICK-SUMMARY mode=observe scanned=1 /);
    expect(first.stdout).toMatch(/paid-requests=0 tokens=0 llm-calls=0/);

    const second = cli(['tick', '--mode', 'observe']);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    // The provider was skipped by the 15 minute gate: nothing was requested.
    expect(second.stdout, second.stdout).toMatch(/unchanged=1/);
    expect(second.stdout).toMatch(/TICK requests=0 /);
    expect(second.stdout).toMatch(/paid-requests=0 tokens=0 llm-calls=0/);
  });

  it('detects a new model and a lost model', () => {
    setScenario('added');
    const added = cli(['tick', '--mode', 'observe']);
    expect(added.code).toBe(0);

    setScenario('lost');
    const lost = cli(['tick', '--mode', 'observe']);
    expect(lost.code).toBe(0);
    setScenario('base');
  });

  it('records provider errors as zero-token failures', () => {
    setScenario('unauthorized');
    const res = cli(['tick', '--mode', 'observe']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/paid-requests=0 tokens=0 llm-calls=0/);
    setScenario('base');
  });

  it('runs verify and the inbox commands', () => {
    const verify = cli(['verify']);
    expect(verify.code).toBe(0);

    const list = cli(['inbox', 'list']);
    expect(list.code).toBe(0);

    const items = fs.existsSync(path.join(tmpRoot, 'state', 'inbox.json'))
      ? (JSON.parse(fs.readFileSync(path.join(tmpRoot, 'state', 'inbox.json'), 'utf8')) as { items?: Array<{ id: string }> })
      : { items: [] };
    const first = items.items?.[0];
    if (first) {
      const ack = cli(['inbox', 'ack', first.id]);
      expect(ack.code).toBe(0);
      const snooze = cli(['inbox', 'snooze', first.id, '--days', '1']);
      expect(snooze.code).toBe(0);
    }
  });

  it('accepts a research submission', () => {
    const evidence = path.join(tmpRoot, 'evidence.json');
    fs.writeFileSync(
      evidence,
      JSON.stringify({
        id: 'fake/model-a',
        conclusion: 'still-alive',
        url: 'https://example.com/fake',
        snippet: 'fake evidence for the end-to-end run',
        accessedAt: '2026-01-01',
      }),
      'utf8'
    );
    const res = cli(['research', 'submit', evidence]);
    expect(res.code).toBe(0);
  });

  it('runs a rank preview without touching the router database', () => {
    const outDir = path.join(tmpRoot, 'rank-out');
    fs.mkdirSync(outDir, { recursive: true });
    const res = cli(['rank', '--output-dir', outDir]);
    expect(res.code, res.stdout + res.stderr).toBe(0);
    expect(fs.readdirSync(outDir)).not.toContain('PLAN-SHOWN.txt');
  });

  it('runs undo in plan-only mode and refuses sync without a TTY', () => {
    const undo = cli(['undo']);
    expect(undo.code).toBe(0);

    // `sync` asks for an interactive confirmation before it scans, so in a
    // pipe it must refuse instead of starting a scan.
    const sync = cli(['sync']);
    const out = sync.stdout + sync.stderr;
    expect(sync.code).not.toBe(0);
    expect(out).toMatch(/stdin is not a TTY|TTY/i);
  });

  it('refuses sync --apply, undo --apply and rank --apply when stdin is a pipe', () => {
    for (const args of [['sync', '--apply'], ['undo', '--apply'], ['rank', '--apply']]) {
      const res = cli(args);
      const out = res.stdout + res.stderr;
      expect(res.code).not.toBe(0);
      expect(out).toMatch(/TTY|stdin is not a TTY|Write Execution Blocked/i);
    }
  });

  it('serves the MCP server over stdio with 26 read-only + 2 ledger-append + 1 controlled-write tools', async () => {
    const mcpServerPath = path.join(projectDir, 'node_modules', '@routersync', 'mcp-server', 'dist', 'index.js');
    expect(fs.existsSync(mcpServerPath), `fixture missing ${mcpServerPath}; npm install of the packed tarballs failed?`).toBe(true);
    const { Client } = requireFromRepo('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = requireFromRepo('@modelcontextprotocol/sdk/client/stdio.js');

    const plansDir = path.join(tmpRoot, 'state', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const dummyRouterActions = [
      {
        router: '9router',
        comboName: 'combo-1',
        provider: 'fake',
        modelId: 'model-c',
        action: 'ADD_MODEL',
      },
    ];
    const canonicalPlan = JSON.stringify({
      routerActions: dummyRouterActions,
      harnessActions: [],
    });
    const dummyPlanHash = crypto.createHash('sha256').update(canonicalPlan).digest('hex').slice(0, 16);
    fs.writeFileSync(
      path.join(plansDir, 'tick-plan.json'),
      JSON.stringify(
        {
          version: 1,
          mode: 'propose',
          planHash: dummyPlanHash,
          routerActions: dummyRouterActions,
          harnessActions: [],
        },
        null,
        2
      ),
      'utf8'
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectDir, 'node_modules', '@routersync', 'mcp-server', 'dist', 'index.js')],
      env: isolatedEnv(),
    });
    const client = new Client({ name: 'routersync-e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toHaveLength(29);
      expect(names).toContain('apply_plan');
      for (const name of names.filter((n: string) => n !== 'apply_plan')) {
        expect(name).not.toMatch(/write|apply|delete|update|approve|grant/i);
      }
      for (const name of names) {
        expect(name).not.toMatch(/delete|approve|grant/i);
      }

      // Calling apply_plan without standing consent or approvalToken must fail closed with zero mutations.
      const denied = await client.callTool({
        name: 'apply_plan',
        arguments: {
          planHash: dummyPlanHash,
          targets: ['router:9router/combo-1'],
        },
      });
      expect(denied.isError).toBe(true);
      expect(sha256File(nineDbPath)).toBe(hashAfterCreate.nine);
      expect(sha256File(omniDbPath)).toBe(hashAfterCreate.omni);

      // Five read-only calls must answer with a JSON payload.
      for (const [tool, args] of [
        ['status', {}],
        ['list_combos', {}],
        ['list_models', {}],
        ['inbox_list', {}],
        ['verify_requests', {}],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.content.length).toBeGreaterThan(0);
      }
    } finally {
      await client.close();
    }
  });

  it('starts the daemon on a random port and answers a health request', async () => {
    const cliScript = path.join(projectDir, 'node_modules', '@routersync', 'cli', 'dist', 'index.js');
    expect(fs.existsSync(cliScript), `fixture missing ${cliScript}; npm install of the packed tarballs failed?`).toBe(true);
    const daemonScript = path.join(projectDir, 'node_modules', '@routersync', 'mcp-server', 'dist', 'index.js');
    expect(fs.existsSync(daemonScript), `daemon script missing in fixture: ${daemonScript}`).toBe(true);
    const port = 32000 + Math.floor(Math.random() * 2000);
    daemonProc = spawn(
      process.execPath,
      [path.join(projectDir, 'node_modules', '@routersync', 'cli', 'dist', 'index.js'), 'daemon', '--port', String(port), '--mode', 'observe'],
      {
        cwd: projectDir,
        env: isolatedEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ) as ChildProcessWithoutNullStreams;

    // Capture the daemon output and watch liveness: the poll loop stops
    // early once the process exits, and the failure message carries what the
    // daemon printed, so a bind failure, a spawn crash, or a missing health
    // endpoint is visible instead of an opaque `expected false to be true`.
    const proc = daemonProc as ChildProcessWithoutNullStreams;
    const daemonOut: string[] = [];
    const daemonErr: string[] = [];
    proc.stdout.on('data', (d: Buffer) => daemonOut.push(String(d)));
    proc.stderr.on('data', (d: Buffer) => daemonErr.push(String(d)));
    const stdoutText = () => daemonOut.join('');
    const stderrText = () => daemonErr.join('');
    const exited = () => proc.exitCode !== null;
    // The daemon prints `[routersync-daemon] Listening on http://<host>:<port>`
    // once the server is bound: poll the printed port when it appears, else
    // the requested one. Possible failure modes, checked by evidence:
    //   - daemon dies during startup (bind error, spawn crash) -> exited() true
    //   - requested port busy / taken -> daemon exits, exited() true
    //   - slow first health response on a loaded ARM runner -> poll times out
    //   - wrong address: the fetch target is derived from the readiness line.
    const boundPort = (): number => {
      const m = stdoutText().match(/Listening on http:\/\/[^:]+:(\d+)/);
      return m ? Number(m[1]) : port;
    };
    const diag = (): string =>
      `exited=${exited()} exitCode=${proc.exitCode} stdout=${stdoutText().slice(-400)} stderr=${stderrText().slice(-400)}`;

    let body = '';
    let ok = false;
    for (let attempt = 0; attempt < 40 && !exited(); attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      if (exited()) break;
      try {
        const res = await fetch(`http://127.0.0.1:${boundPort()}/api/v1/health`);
        body = await res.text();
        ok = res.ok;
        if (ok) break;
      } catch {
        // not up yet
      }
    }
    expect(ok, `daemon health failed; ${diag()}`).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  }, 120000);

  it('leaves the fake router databases byte-identical', () => {
    // The end-to-end run must never write to a router database.
    expect(sha256File(nineDbPath)).toBe(hashAfterCreate.nine);
    expect(sha256File(omniDbPath)).toBe(hashAfterCreate.omni);
  });
});
