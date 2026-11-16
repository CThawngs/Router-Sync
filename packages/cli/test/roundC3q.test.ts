/**
 * packages/cli/test/roundC3q.test.ts
 * C3q Q1(e) shrinkVerdict, Q4a/b classifyNetworkError + đóng cổng thật,
 * Q4(b) GATE-FORGE: grant giả (thiếu chữ ký / sai chữ ký) vào maintain apply
 * qua stdin pipe phải bị từ chối và băm DB không đổi.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { shrinkVerdict } from '../src/commands/scan.js';
import { classifyNetworkError } from '../src/sync/providers.js';

describe('C3q SHRUNK-SUSPECT', () => {
  it('217 -> 6 là SHRUNK-SUSPECT', () => {
    expect(shrinkVerdict(217, 6)).toBe('SHRUNK-SUSPECT');
  });
  it('94 -> 69 là SHRUNK-SUSPECT', () => {
    expect(shrinkVerdict(94, 69)).toBe('SHRUNK-SUSPECT');
  });
  it('217 -> 217 không phải SHRUNK-SUSPECT', () => {
    expect(shrinkVerdict(217, 217)).toBe('SAME');
  });
  it('217 -> 226 là GROWN, vẫn ANOMALY-LOG', () => {
    expect(shrinkVerdict(217, 226)).toBe('GROWN');
  });
});

describe('C3q Q4a classify extra', () => {
  it('{cause:{message:"bad port"}} -> unknown', () => {
    expect(classifyNetworkError({ cause: { message: 'bad port' } })).toBe('unknown');
  });
  it('{cause:{errors:[{code:ECONNREFUSED}]}} -> refused', () => {
    expect(classifyNetworkError({ cause: { errors: [{ code: 'ECONNREFUSED' }] } })).toBe('refused');
  });
  it('cổng thật đã đóng -> refused và in ERR-SHAPE', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    let err: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${port}/models`, { signal: AbortSignal.timeout(5000) });
    } catch (e) { err = e; }
    const e = err as { name?: string; code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> }; errors?: Array<{ code?: string }> };
    const c0 = e?.errors?.[0]?.code ?? e?.cause?.errors?.[0]?.code ?? '-';
    console.log(`ERR-SHAPE closed-port name=${e?.name ?? '-'} code=${e?.code ?? '-'} cause.code=${e?.cause?.code ?? '-'} errors0=${c0}`);
    expect(classifyNetworkError(err)).toBe('refused');
  });
});

const distIndex = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

function hashFile(f: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

type GateVariant = 'missing-signature' | 'wrong-signature' | 'expired' | 'wrong-scope' | 'wrong-planHash';

function gateForge(variant: GateVariant) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3q-gateforge-'));
  const db = path.join(tmp, 'test.db');
  fs.writeFileSync(db, 'seed-bytes-c3q', 'utf8');
  const now = new Date();
  const expires = new Date(now.getTime() + 3600_000);
  const grant: Record<string, unknown> = {
    version: 1, id: 'abcdef1234567890', combos: ['test-01'], agents: ['hermes'],
    createdAt: now.toISOString(), expiresAt: expires.toISOString(),
  };
  if (variant === 'missing-signature') {
    // C3r R4a: grant thiếu trường (không có combos/id đầy đủ) -> grant-invalid.
    delete grant['combos'];
  }
  if (variant === 'wrong-signature') grant['signature'] = 'sha256-deadbeef';
  if (variant === 'expired') {
    const past = new Date(now.getTime() - 3600_000);
    grant['createdAt'] = new Date(now.getTime() - 7200_000).toISOString();
    grant['expiresAt'] = past.toISOString();
  }
  if (variant === 'wrong-scope') grant['combos'] = ['test-99'];
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(grant), 'utf8');
  const before = hashFile(db);
  const env = { ...process.env, ROUTERSYNC_STATE_DIR: tmp, ROUTERSYNC_DB: db };
  delete env['VITEST'];
  delete env['ROUTERSYNC_TEST_CONFIRM'];
  delete env['ROUTERSYNC_TEST_FAST'];
  // C3r R4a: --plan-hash hợp lệ VỀ HÌNH THỨC (16 hex) nhưng sai giá trị so với
  // kế hoạch thật của bản sao DB -> dừng ở cổng plan-hash sau tầng grant.
  const r = spawnSync(process.execPath, [distIndex, 'maintain', 'apply', '--only', 'test-01', '--state-dir', tmp, '--plan-hash', '0000000000000000'], {
    input: '', // pipe stdin, not a TTY
    env,
    timeout: 30_000,
  });
  const out = r.stdout.toString() + r.stderr.toString();
  const after = hashFile(db);
  const reason = out.match(/MAINTAIN-REFUSED reason=(\S+)/)?.[1]
    ?? (out.includes('Plan hash mismatch') ? 'plan-hash-mismatch' : 'unknown');
  console.log(`GATE-FORGE | maintain apply | exit=${r.status} | reason=${reason} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'} | ${variant}`);
  return { status: r.status, before, after, reason };
}

describe('C3q Q4b GATE-FORGE', () => {
  it('grant thiếu chữ ký bị từ chối, DB không đổi', () => {
    const r = gateForge('missing-signature');
    expect(r.status).toBe(1);
    expect(r.before).toBe(r.after);
    expect(r.reason).toBe('grant-invalid');
  });
  it('grant sai chữ ký bị từ chối, DB không đổi', () => {
    const r = gateForge('wrong-signature');
    expect(r.status).toBe(1);
    expect(r.before).toBe(r.after);
  });
  it('grant hết hạn bị từ chối, DB không đổi', () => {
    const r = gateForge('expired');
    expect(r.status).toBe(1);
    expect(r.before).toBe(r.after);
    expect(r.reason).toBe('grant-expired');
  });
  it('grant sai phạm vi combo bị từ chối, DB không đổi', () => {
    const r = gateForge('wrong-scope');
    expect(r.status).toBe(1);
    expect(r.before).toBe(r.after);
    // C3s S0: secret gate runs before scope, so a script-written grant
    // without the secret is refused with grant-secret-missing.
    expect(r.reason).toBe('grant-secret-missing');
  });
  it('sai planHash bị từ chối, DB không đổi', () => {
    const r = gateForge('wrong-planHash');
    expect(r.status).toBe(1);
    expect(r.before).toBe(r.after);
    // C3s S0: secret gate runs before the plan-hash gate.
    expect(r.reason).toBe('grant-secret-missing');
  });
});
