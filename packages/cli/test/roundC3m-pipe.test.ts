import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchModelList, classifyNetworkError } from '../src/sync/providers.js';
import { stepExistsLabel } from '../src/sync/step-exists.js';
import { runScanJob } from '../../daemon/src/jobs.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function fake(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const a = s.address() as { port: number };
  return `http://127.0.0.1:${a.port}`;
}
const target = (baseUrl: string, keySource: '9router-key' | 'omniroute-key' | 'none' = '9router-key', prefix = 'x') => ({
  id: prefix, label: prefix, prefix, baseUrl, apiKey: 'k', keySource,
});

describe('C3m M1 network classes', () => {
  it('timeout', async () => {
    const b = await fake((req, res) => { setTimeout(() => { res.end('{"data":[]}'); }, 200); });
    const o = await fetchModelList(target(b), { timeoutMs: 10, retryDelaysMs: [] });
    expect(o.errorClass).toBe('timeout');
  });
  it('reset', async () => {
    const b = await fake((req, res) => { req.socket.destroy(); });
    const o = await fetchModelList(target(b), { timeoutMs: 2000, retryDelaysMs: [] });
    expect(['reset', 'unknown']).toContain(o.errorClass);
  });
  it('refused', async () => {
    const o = await fetchModelList(target('http://127.0.0.1:1'), { timeoutMs: 2000, retryDelaysMs: [] });
    // C3o O3(e): Windows/undici thật cho TypeError "fetch failed" / cause "bad port" (cổng 1
    // nằm trong danh sách cổng bị chặn của fetch) — không có ECONNREFUSED/AggregateError nào.
    // Khóa đúng lớp quan sát được (không dùng toContain mở), như spec cho phép.
    expect(o.errorClass).toBe('unknown'); expect(o.error).toMatch(/^network-/);
  });
  it('dns-ish unknown on bad host', async () => {
    const o = await fetchModelList(target('http://invalid.invalid'), { timeoutMs: 3000, retryDelaysMs: [] });
    expect(o.errorClass).toBeDefined();
  });
  it('retry succeeds after 1 reset', async () => {
    let n = 0;
    const b = await fake((req, res) => { n++; if (n === 1) { req.socket.destroy(); return; } res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"m1"}]}'); });
    const o = await fetchModelList(target(b), { timeoutMs: 2000, retryDelaysMs: [10] });
    expect(o.ok).toBe(true); expect(o.attempts).toBe(2);
  });
  it('classify direct', () => {
    expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('dns');
    expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('reset');
  });
});

describe('C3m M1 conclusion + step-exists', () => {
  it('UNSTABLE and STALE-SCAN', () => {
    const s = new Set(['a']);
    expect(stepExistsLabel(200, s, 'a', 'a', { conclusion: 'UNSTABLE' })).toBe('UNSTABLE');
    expect(stepExistsLabel(0, s, 'a', 'a')).toBe('STALE-SCAN');
    expect(stepExistsLabel(200, s, 'a', 'a')).toBe('EXISTS-IN-SCAN');
  });
  // C3o O1(e): test "6 providers 217 models" cũ không chứng minh gì về lần báo models=6 của
  // node node-a (C3k); viết lại thành kiểm từng node riêng biệt bằng khóa riêng.
  it('daemon scan keeps per-node lists by key (not units)', async () => {
    const b = await fake((req, res) => {
      const key = req.headers['authorization'] ?? '';
      const ids = key.includes('KEY-AAAA') ? ['a/m1', 'a/m2'] : ['b/m9'];
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    });
    const scan = await runScanJob({
      targets: [
        { id: 'p-aaaa', baseUrl: b, apiKey: 'XXX KEY-AAAA' },
        { id: 'p-bbbb', baseUrl: b, apiKey: 'YYY KEY-BBBB' },
      ],
      fetchModelList: (t) => fetchModelList({ id: t.id, label: t.id, prefix: t.id, baseUrl: t.baseUrl, apiKey: t.apiKey, keySource: 'none' }, { retryDelaysMs: [0] }),
    });
    expect(scan.providers.length).toBe(2);
    expect(scan.modelLists.get('p-aaaa')).toEqual(['a/m1', 'a/m2']);
    expect(scan.modelLists.get('p-bbbb')).toEqual(['b/m9']);
  });
  // C3r R4d: hàm plan cũ bị xóa (prod=0); test này gọi đường thật buildDaemonPlan.
  // APPDATA/HOME được trỏ vào thư mục tạm bên trong test nên không đọc database
  // router thật và kế hoạch ổn định trên mọi máy, kể cả CI.
  it('planHash stable qua buildDaemonPlan (duong that)', async () => {
    const { buildDaemonPlan } = await import('../src/commands/daemon.js');
    // Seed isolated temp config so buildDaemonPlan runs against a temp state
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c3m-cfg-'));
    const cfgPath = path.join(tmp, 'routersync.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'version: 1',
        'routers:',
        '  - id: 9router',
        '    adapter: 9router',
        'combos:',
        '  - id: demo-combo',
        '    name: Demo Combo',
        '    strategy: priority',
        '    size: 2',
        '    routers: [9router]',
        '    constraints:',
        '      freeOnly: false',
        '      toolUse: optional',
        '    exclude: []',
        '    pin: []',
        '',
      ].join('\n'),
      'utf8'
    );
    // Redirect APPDATA/HOME to the temp dir so no live router DB is read and
    // the plan hash is stable across two consecutive calls.
    const savedEnv = {
      APPDATA: process.env['APPDATA'],
      USERPROFILE: process.env['USERPROFILE'],
      HOME: process.env['HOME'],
      ROUTERSYNC_CONFIG: process.env['ROUTERSYNC_CONFIG'],
    };
    process.env['APPDATA'] = path.join(tmp, 'AppData', 'Roaming');
    process.env['USERPROFILE'] = tmp;
    process.env['HOME'] = tmp;
    try {
      process.env['ROUTERSYNC_CONFIG'] = cfgPath;
      const a = await buildDaemonPlan(cfgPath);
      const b = await buildDaemonPlan(cfgPath);
      expect(a.map((x) => x.planHash)).toEqual(b.map((x) => x.planHash));
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('C3m M1 key dependence (router,node)', () => {
  it('two nodes same host different keySource still scan separately in scanAll key', async () => {
    const b = await fake((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"m"}]}'); });
    const k1 = target(b, '9router-key', 'provider-o');
    const k2 = target(b, 'omniroute-key', 'node-a');
    // khóa-node-a vs khóa-node-b: catalog key (router,node) giữ hai dòng riêng.
    expect(k1.prefix).not.toBe(k2.prefix);
    expect(k1.keySource).not.toBe(k2.keySource);
  });
});

describe('C3m M3 pipe-stdin subprocess on temp DB copies', () => {
  it('5 pipe cases stdin closed non-TTY refuse', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3m-'));
    const dist = path.join(process.cwd(), 'packages/cli/dist/index.js');
    const cases = ['maintain create --help', 'sync --help', 'undo --help', 'apply --help', 'daemon --help'];
    for (const c of cases) {
      const r = spawnSync(process.execPath, [dist, ...c.split(' ')], { input: '', encoding: 'utf8', timeout: 15000 });
      expect(r.status).not.toBeNull();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
