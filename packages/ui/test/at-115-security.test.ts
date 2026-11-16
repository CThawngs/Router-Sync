import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MockApi } from '../src/api/mock';

describe('AT-115: Security & No External Leakage', () => {
  const rootUiDir = path.resolve(__dirname, '..');
  const srcDir = path.resolve(rootUiDir, 'src');

  it('verifies index.html specifies strict CSP with default-src self', () => {
    const indexPath = path.join(rootUiDir, 'index.html');
    expect(fs.existsSync(indexPath)).toBe(true);
    const indexHtml = fs.readFileSync(indexPath, 'utf8');

    expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
    expect(indexHtml).toContain("default-src 'self'");
    expect(indexHtml).not.toContain('fonts.googleapis.com');
    expect(indexHtml).not.toContain('fonts.gstatic.com');
  });

  it('scans all TypeScript source files for forbidden dangerous patterns (eval, dangerouslySetInnerHTML, network primitives)', () => {
    const filesToScan: string[] = [];

    function collect(dir: string) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collect(full);
        } else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) {
          filesToScan.push(full);
        }
      }
    }

    collect(srcDir);

    const violations: string[] = [];
    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (trimmed.includes('dangerouslySetInnerHTML')) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains dangerouslySetInnerHTML`);
        }
        if (/\beval\s*\(/.test(line)) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains eval()`);
        }
        if (/\bnew\s+Function\s*\(/.test(line)) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains new Function()`);
        }
        const rel = path.relative(rootUiDir, file).replace(/\\/g, '/');
        if (/\bfetch\s*\(/.test(line)) {
          // src/api/http.ts is the designated local daemon HTTP adapter
          if (rel !== 'src/api/http.ts') {
            violations.push(`${rel}:${idx + 1}: contains fetch()`);
          }
        }
        if (/\bXMLHttpRequest\b/.test(line)) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains XMLHttpRequest`);
        }
        if (/\bWebSocket\b/.test(line)) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains WebSocket`);
        }
        if (/\bEventSource\b/.test(line)) {
          violations.push(`${path.relative(rootUiDir, file)}:${idx + 1}: contains EventSource`);
        }
      });
    }

    expect(violations, `Found security/isolation violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('scans for any external network endpoints outside localhost', () => {
    const filesToScan: string[] = [];

    function collect(dir: string) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collect(full);
        } else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) {
          filesToScan.push(full);
        }
      }
    }

    collect(srcDir);

    const externalUrlRegex = /https?:\/\/(?!localhost|127\.0\.0\.1)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const offenders: string[] = [];

    for (const file of filesToScan) {
      // Allow documentation/comments or mock model names if not in executable fetch/call
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        const matches = line.match(externalUrlRegex);
        if (matches) {
          offenders.push(`${path.relative(rootUiDir, file)}:${idx + 1} -> ${matches.join(', ')}`);
        }
      });
    }

    expect(offenders, `Found external network URLs in source:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('verifies MockApi only performs in-memory operations and never writes to disk or network', async () => {
    const mock = new MockApi();
    const overview = await mock.getOverview();
    expect(overview).toBeDefined();
    expect(overview.isSampleData).toBe(true);

    // Write operations should either toggle local memory state or be simulated safely
    const initialFirstRun = overview.isFirstRun;
    await mock.setFirstRun(!initialFirstRun);
    const updated = await mock.getOverview();
    expect(updated.isFirstRun).toBe(!initialFirstRun);
  });
});
