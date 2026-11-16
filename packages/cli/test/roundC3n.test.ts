/**
 * packages/cli/test/roundC3n.test.ts
 * C3n N1(d): five write-gate commands via subprocess, stdin=pipe, on a temp DB
 * copy — must be refused by the gate message and leave the DB hash unchanged.
 * Plus N2(b) parity fake-server and N3(b) alias unit test.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { scanAll, hashIdSet } from '../src/commands/sync/sync-scan.js';
import type { ProviderTarget } from '../src/sync/providers.js';
import type { RouterView } from '../src/commands/sync/sync-plan.js';
import { runScanJob } from '@routersync/daemon';
import { matchedExternalRecord, EXTERNAL_ALIAS } from '../src/commands/dead-models.js';

const distIndex = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const env = {
  ...process.env,
  VITEST: 'true',
  ROUTERSYNC_TEST_FAST: '1',
  ROUTERSYNC_TEST_CONFIRM: 'chay',
};

function hashFile(f: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function runGate(args: string[]): { out: string; dbHash: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3n-gate-'));
  const db = path.join(tmp, 'test.db');
  fs.writeFileSync(db, 'seed-bytes-c3n', 'utf8');
  // Fake snapshot so rollback reaches its TTY gate instead of "No snapshots".
  const snapDir = path.join(tmp, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'fake1.json'), JSON.stringify({
    id: 'fake1', target: '9router', timestamp: '2026-11-07T00:00:00.000Z',
    combos: [{ id: 'c1', name: 'Combo', models: ['a/b'], managed: true }],
  }), 'utf8');
  // Seed temp config so subprocess commands pass under empty-env CI
  const cfgPath = path.join(tmp, 'routersync.yaml');
  fs.writeFileSync(
    cfgPath,
    [
      'version: 1',
      'routers:',
      '  - id: 9router',
      '    adapter: 9router',
      'combos: []',
      'adopt: []',
      '',
    ].join('\n'),
    'utf8'
  );
  const before = hashFile(db);
  const r = spawnSync(process.execPath, [distIndex, ...args], {
    input: '', // pipe stdin, not a TTY
    env: { ...env, ROUTERSYNC_STATE_DIR: tmp, ROUTERSYNC_DB: db, ROUTERSYNC_CONFIG: cfgPath },
    timeout: 30_000,
  });
  const out = r.stdout.toString() + r.stderr.toString();
  const after = hashFile(db);
  // C3o O3(d): một dòng cho từng lệnh trong đầu ra vitest.
  const refused = out.match(/stdin is not a TTY|SYNC-REFUSED|Write Execution Blocked|MAINTAIN-REFUSED/)?.[0] ?? 'none';
  // C3p P4b: định dạng GATE cố định để REPORT trích được mọi trường.
  console.log(`GATE | ${args.join(' ')} | exit=${r.status} | refused=${refused} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'}`);
  return { out, dbHash: after, tmp };
}

const gates: Array<{ name: string; args: string[]; needle: RegExp }> = [
  { name: 'sync --apply refuses on pipe stdin', args: ['sync', '--apply'], needle: /stdin is not a TTY|SYNC-REFUSED/ },
  { name: 'undo --apply refuses on pipe stdin', args: ['undo', '--apply'], needle: /stdin is not a TTY|SYNC-REFUSED/ },
  { name: 'apply --write refuses on pipe stdin', args: ['apply', '--write'], needle: /Write Execution Blocked/ },
  { name: 'maintain apply refuses on pipe stdin', args: ['maintain', 'apply'], needle: /MAINTAIN-REFUSED/ },
  { name: 'rollback --write refuses on pipe stdin', args: ['rollback', 'fake1', '--write'], needle: /Write Execution Blocked/ },
];

describe('C3n N1(d) write gates via subprocess (pipe stdin)', () => {
  for (const g of gates) {
    it(g.name, () => {
      const { out, dbHash, tmp } = runGate(g.args);
      // ponytail: DB hash check via the seed file written above.
      const seed = path.join(tmp, 'test.db');
      expect(hashFile(seed)).toBe(dbHash);
      expect(fs.readFileSync(seed, 'utf8')).toBe('seed-bytes-c3n');
      expect(out).toMatch(g.needle);
    });
  }
});

describe('C3n N2(b) parity: two nodes, same host, different keys -> different lists', () => {
  it('scanAll keeps per-key results; runScanJob agrees', async () => {
    const server = http.createServer((req, res) => {
      const key = req.headers['authorization'] ?? '';
      const body = key.includes('KEY-AAAA')
        ? JSON.stringify({ data: [{ id: 'a/model-1' }, { id: 'a/model-2' }] })
        : JSON.stringify({ data: [{ id: 'b/model-9' }] });
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}/v1`;
      const mk = (prefix: string, key: string): ProviderTarget => ({
        id: prefix, label: prefix, prefix, baseUrl: base, apiKey: key, keySource: '9router-key',
      });
      const views: RouterView[] = [{
        name: '9router', adapter: '9router', targets: [mk('node-aaaa', 'XXX KEY-AAAA'), mk('node-bbbb', 'YYY KEY-BBBB')] as never,
      } as unknown as RouterView];
      const round = await scanAll(views, 1, 5_000, true);
      const l1 = round.get('9router:node-aaaa') ?? [];
      const l2 = round.get('9router:node-bbbb') ?? [];
      expect(l1).toEqual(['a/model-1', 'a/model-2']);
      expect(l2).toEqual(['b/model-9']);
      expect(hashIdSet(l1)).not.toBe(hashIdSet(l2));
      const daemon = await runScanJob({
        targets: [
          { id: '9router:node-aaaa', label: 'x', baseUrl: base, apiKey: 'XXX KEY-AAAA' },
          { id: '9router:node-bbbb', label: 'x', baseUrl: base, apiKey: 'YYY KEY-BBBB' },
        ],
        fetchModelList: async (t) => ({
          ok: true, status: 200, models: t.id.endsWith('node-aaaa') ? [...l1] : [...l2], latencyMs: 0,
        }),
      });
      expect(daemon.modelLists.get('9router:node-aaaa')).toEqual(l1);
      expect(daemon.modelLists.get('9router:node-bbbb')).toEqual(l2);
    } finally {
      server.close();
    }
  });
});

describe('C3n N3(b) external alias', () => {
  it('hf -> huggingface, gemini -> google', () => {
    expect(EXTERNAL_ALIAS.hf).toBe('huggingface');
    expect(EXTERNAL_ALIAS.gemini).toBe('google');
    const md = new Map<string, ReadonlySet<string>>([['huggingface', new Set(['Qwen3-235B-A22B'])]]);
    expect(matchedExternalRecord('hf', 'Qwen3-235B-A22B', 'hf/Qwen3-235B-A22B', md, new Set())).toBe('models-dev:huggingface/Qwen3-235B-A22B');
    expect(matchedExternalRecord('gemini', 'gemini-x', 'gemini/gemini-x', new Map([['google', new Set(['gemini-x'])]]), new Set())).toBe('models-dev:google/gemini-x');
    expect(matchedExternalRecord('hf', 'nope', 'hf/nope', md, new Set())).toBeNull();
  });
});
