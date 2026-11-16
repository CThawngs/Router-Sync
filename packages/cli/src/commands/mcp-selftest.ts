/**
 * packages/cli/src/commands/mcp-selftest.ts
 * G6 (C3g): mcp selftest --raw: JSON-RPC thô vào/ra của một phiên stdio thật.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function runMcpSelftestRaw(): Promise<void> {
  const server = path.join(process.cwd(), 'packages', 'mcp-server', 'dist', 'index.js');
  const proc = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
  let stdout = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  const send = (msg: unknown) => {
    proc.stdin.write(JSON.stringify(msg) + '\n');
  };
  const deadline = Date.now() + 15000;
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'routersync-selftest', version: '0.1' } } });
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.some((l) => l.includes('"id":1'))) break;
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (stdout.includes('"id":2')) break;
  }
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } });
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (stdout.includes('"id":3')) break;
  }
  proc.kill();
  const frames = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.stringify(JSON.parse(l)); } catch { return l; } });
  console.log('MCP-SELFTEST-RAW (stdio thật, không kịch bản tạm)');
  for (const f of frames) console.log(f);
  const toolNames = frames.filter((f) => f.includes('health')).length;
  console.log(`selftest co tool health: ${toolNames > 0 ? 'đúng' : 'sai'}`);
}
