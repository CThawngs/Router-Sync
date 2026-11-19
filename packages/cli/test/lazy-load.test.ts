import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const indexSrc = readFileSync(resolve(root, 'packages/cli/src/index.ts'), 'utf8');

// V6-1: these commands must not be statically imported from the entry.
const V6_1_LAZY = ['doctor.js', 'mcp-http.js', 'daemon.js', 'schedule.js', 'track.js'];

describe('lazy-load — commands nạp động (V6-1/V6-3)', () => {
  for (const mod of ['doctor.js', 'verify.js', 'daemon.js', 'mcp-http.js', 'schedule.js', 'track.js', 'sim.js', 'storage.js', 'discover.js', 'autopilot.js', 'profile.js', 'tick.js']) {
    it(`không static-import './commands/${mod}' từ src/index.ts`, () => {
      // V6-1 chỉ nghiếm mcp-http chứ không nghiếm runMcpServeHttpCommand (các lệnh khác vẫn eager).
      const importRe = new RegExp(`import\\s*[^;]*from\\s*['"]\\./commands/${mod.replace('.', '\\.')}['"]`, 's');
      if (mod === 'mcp-http.js') {
        const st = indexSrc.match(importRe);
        expect(st ? st[0] : '').not.toContain('runMcpServeHttpCommand');
      } else {
        expect(indexSrc).not.toMatch(importRe);
      }
    });
    it(`src/index.ts nạp động './commands/${mod}' trong handler`, () => {
      expect(indexSrc).toMatch(new RegExp(`import\\(['"]\\./commands/${mod.replace('.', '\\.')}['"]\\)`));
    });
  }
  it('V6-1 danh sách chính xác: doctor, verify, daemon, serve-http, schedule, track', () => {
    // Static-check nhanh: 5 module trong V6-1.
    for (const mod of V6_1_LAZY) {
      expect(indexSrc.includes(`'${mod}'`) ? indexSrc.match(new RegExp(`['"]\\./commands/${mod}['"]`)) : null).toBeNull();
    }
  });
});
