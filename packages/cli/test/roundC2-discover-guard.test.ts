import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChatModel, groupDiscoverCandidates } from '../src/commands/discover.js';
import { grantLiveWriteToken, consumeLiveWriteToken, revokeLiveWriteToken } from '../src/sync/write.js';

// E7a explain call_logs 5529→5520: UNVERIFIED — no source available in this session (.agent/send-final/C1d missing), no explanation fabricated.
describe('C2 E6 isChatModel', () => {
  it('loại non-chat theo keyword', () => {
    expect(isChatModel('gpt-oss-120b')).toBe(true);
    expect(isChatModel('bge-embedding-3')).toBe(false);
    expect(isChatModel('whisper-asr')).toBe(false);
    expect(isChatModel('flux-image-1')).toBe(false);
    expect(isChatModel('content-safety-v2')).toBe(false);
    expect(isChatModel('speak-speech-tts')).toBe(false);
  });
});

describe('C2 E6 groupDiscoverCandidates', () => {
  it('gom theo canonical key, tối đa 5/nhóm, lọc non-chat', () => {
    const input = [
      { providerId: 'hf', modelId: 'beam-free', tag: 'a' },
      { providerId: 'hf', modelId: 'beam-free', tag: 'b' },
      { providerId: 'hf', modelId: 'beam-free', tag: 'c' },
      { providerId: 'hf', modelId: 'beam-free', tag: 'd' },
      { providerId: 'hf', modelId: 'beam-free', tag: 'e' },
      { providerId: 'hf', modelId: 'beam-free', tag: 'f' }, // vượt 5 -> loại
      { providerId: 'groq', modelId: 'llama-3.3-70b-versatile', tag: 'g' },
      { providerId: 'groq', modelId: 'whisper-large-asr', tag: 'h' }, // non-chat -> loại
    ];
    const groups = groupDiscoverCandidates(input);
    expect(groups.size).toBe(2);
    expect(groups.get('huggingface/beam')).toHaveLength(5);
    expect(groups.get('groq/llama-3-3-70b-versatile')).toHaveLength(1);
  });
  it('maxPerGroup tuỳ biến', () => {
    const input = [{ providerId: 'groq', modelId: 'a' }, { providerId: 'groq', modelId: 'a' }];
    expect(groupDiscoverCandidates(input, 1).get('groq/a')).toHaveLength(1);
  });
});

describe('C2 E7 consumeLiveWriteToken single-use', () => {
  it('dùng 1 lần, lần 2 ném lỗi', () => {
    grantLiveWriteToken('tok-once');
    expect(consumeLiveWriteToken('tok-once')).toBe('tok-once');
    expect(() => consumeLiveWriteToken('tok-once')).toThrow(/WRITE-GUARD/);
  });
  it('token sai hoặc đã revoke -> ném lỗi', () => {
    grantLiveWriteToken('tok-a');
    expect(() => consumeLiveWriteToken('tok-wrong')).toThrow(/WRITE-GUARD/);
    revokeLiveWriteToken();
    expect(() => consumeLiveWriteToken('tok-a')).toThrow(/WRITE-GUARD/);
  });
});

describe('C2 E7 static guard: ghi router chỉ ở adapter-*/daemon (allowlist)', () => {
  it('không có ghi router ngoài allowlist', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages');
    const scanDirs = ['cli/src', 'core/src', 'sources/src'].map((d) => path.join(root, '..', d));
    const allow = (p: string) =>
      p.includes(`${path.sep}adapter-`) ||
      p.includes(`${path.sep}daemon${path.sep}`) ||
      p.endsWith(`${path.sep}sqlite${path.sep}better-sqlite3.ts`) ||
      p.endsWith(`${path.sep}readonly.ts`) ||
      p.endsWith(`${path.sep}sync${path.sep}write.ts`);
    const bad: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && full.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          const dbWrite = /new Database\(/.test(text) && !/readonly:\s*true/.test(text) && !allow(full);
          const fsRouterWrite = /fs\.writeFileSync\(/.test(text) && /(storage\.sqlite|\.omniroute|9router[\\/][^"']*\.sqlite|omniroute[\\/][^"']*\.sqlite)/i.test(text) && !allow(full);
          if (dbWrite || fsRouterWrite) bad.push(full);
        }
      }
    };
    for (const d of scanDirs) walk(d);
    expect(bad).toEqual([]);
  });
});
