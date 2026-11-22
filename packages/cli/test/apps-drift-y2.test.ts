import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultOpenMausPath,
  maskInstanceId,
  maskUrl,
  readOpenMausConfig,
  triedPaths,
} from '../src/apps/openmausbot.js';
import { openmausbotAdapter } from '../src/apps/inspect.js';
import { firstGoodAndHangs } from '../src/commands/apps-drift.js';

const fixture = fileURLToPath(new URL('./fixtures/agent-apps/openmausbot.json', import.meta.url));

describe('C41 Y2: bộ đọc OpenMausBot', () => {
  it('che UUID và cổng riêng', () => {
    expect(maskInstanceId('openai-compat-5c7bdb86-5261-4ca7-b5e1-9413a85e6b92', 0)).toBe('openai-compat-<uuid>');
    expect(maskUrl('http://localhost:20128/v1').url).toBe('http://localhost:20128/v1');
    expect(maskUrl('http://secret-host:9999/v1').url).toBe('http://<host>:<port>/v1');
  });

  it('đọc cấu hình mẫu, không trả key hay id thật', () => {
    const read = readOpenMausConfig(fixture);
    expect(read.instances).toHaveLength(2);
    expect(read.instances[0]?.model).toBe('9Router-Agent-1');
    expect(read.instances[0]?.keyPresent).toBe(true);
    expect(JSON.stringify(read)).not.toContain('5c7bdb86');
    expect(JSON.stringify(read)).not.toContain('<KEY>');
    expect(JSON.stringify(read)).not.toContain('9999');
  });

  it('adapter có routerRef 9router từ cổng 20128', async () => {
    const inspection = await openmausbotAdapter.inspect({ configPath: fixture });
    expect(inspection.routerRef).toBe('9router');
    expect(inspection.activeModel).toBe('9Router-Agent-1');
    expect(inspection.models).toHaveLength(2);
    expect(inspection.readOnly).toBe(true);
    expect(JSON.stringify(inspection)).not.toContain('<KEY>');
  });

  it('thiếu tệp thì báo đã thử đường dẫn dạng <HOME>', () => {
    const read = readOpenMausConfig(defaultOpenMausPath('/tmp/no-such-home'));
    expect(read.instances).toHaveLength(0);
    expect(triedPaths('/tmp/no-such-home').every((p) => p.startsWith('<HOME>/'))).toBe(true);
  });

  it('đếm bước HANG trước bước chạy được đầu tiên', () => {
    const rel = new Map([
      ['a/hang', { label: 'HANG' as const, p90Ms: null, ok: 0, attempts: 6 }],
      ['b/good', { label: 'RELIABLE' as const, p90Ms: 300, ok: 6, attempts: 6 }],
    ]);
    expect(firstGoodAndHangs(['a/hang', 'b/good'], rel)).toEqual({ index: 1, hangBefore: 1 });
    expect(firstGoodAndHangs(['a/hang'], rel)).toEqual({ index: null, hangBefore: null });
  });

  it('mutation: bỏ kiểm tra cổng thì test đỏ', () => {
    const source = readFileSync(new URL('../src/apps/inspect.ts', import.meta.url), 'utf8');
    expect(source).toContain('routerInstance?.port === ROUTER_PORT');
  });
});
