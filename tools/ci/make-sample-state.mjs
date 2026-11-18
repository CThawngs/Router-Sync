#!/usr/bin/env node
// CI helper: build a small offline sample router state (no network, no keys).
// Usage: node tools/ci/make-sample-state.mjs <dir>
// Writes <dir>/9router.sqlite, <dir>/omniroute.sqlite and <dir>/sample.env
import fs from 'node:fs';
import path from 'node:path';
import { openBetterSqlite3 } from '../../packages/core/dist/index.js';

const dir = path.resolve(process.argv[2] ?? 'sample-state');
fs.mkdirSync(dir, { recursive: true });

const nine = path.join(dir, '9router.sqlite');
const omni = path.join(dir, 'omniroute.sqlite');
for (const f of [nine, omni]) { try { fs.rmSync(f, { force: true }); } catch {} }

const d9 = openBetterSqlite3(nine, { restrictToDir: dir });
d9.exec(`
  CREATE TABLE combos (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT,
    models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
  INSERT INTO settings (id, data) VALUES (1, '{}');
`);
d9.prepare("INSERT INTO combos VALUES (?, ?, ?, ?, ?, ?)").run(
  'c1', 'smoke-combo', 'chat', JSON.stringify(['gemini/gemini-2.5-flash', 'groq/llama-3.1-8b', 'groq/llama-3.3-70b', 'gemini/gemini-2.5-pro']),
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
);
d9.close();

const dO = openBetterSqlite3(omni, { restrictToDir: dir });
dO.exec(`
  CREATE TABLE combos (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, system_message TEXT DEFAULT NULL
  );
`);
dO.prepare("INSERT INTO combos VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  'c2', 'smoke-omni', JSON.stringify({ models: ['gemini/gemini-2.5-flash', 'gemini/gemini-2.5-pro', 'groq/llama-3.1-8b', 'groq/llama-3.3-70b'] }),
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, null,
);
dO.close();

const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(dir, 'sample.env'), [
  `ROUTERSYNC_9ROUTER_DB=${nine}`,
  `ROUTERSYNC_OMNIROUTE_DB=${omni}`,
  `ROUTERSYNC_STATE_DIR=${stateDir}`,
  `ROUTERSYNC_CONFIG=${path.join(dir, 'routersync.yaml')}`,
].join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'routersync.yaml'), [
  'version: 1',
  'policy:',
  '  mode: manual',
  'routers:',
  '  - id: omniroute',
  '    adapter: omniroute',
  "    baseUrl: 'http://127.0.0.1:9'",
  `    path: '${omni.replace(/\\/g, '/')}'`,
  '  - id: 9router',
  '    adapter: 9router',
  "    baseUrl: 'http://127.0.0.1:9'",
  `    path: '${nine.replace(/\\/g, '/')}'`,
].join('\n') + '\n');
console.log(`sample state written to ${dir}`);
