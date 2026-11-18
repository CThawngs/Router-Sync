#!/usr/bin/env node
// C15 Q2.2: npm pack all packages, install into a clean dir, measure footprint.
// Fails if the install log shows a node-gyp rebuild (prebuilt better-sqlite3 required).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const work = path.resolve('.agent/work-c15/footprint');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const packs = path.join(work, 'packs');
const install = path.join(work, 'install');
fs.mkdirSync(packs, { recursive: true });
fs.mkdirSync(install, { recursive: true });

const pkgDirs = fs.readdirSync('packages', { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join('packages', e.name, 'package.json')))
  .map((e) => path.join(root, 'packages', e.name));

const tarballs = [];
for (const dir of pkgDirs) {
  const r = spawnSync('npm', ['pack', '--pack-destination', packs], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`npm pack failed in ${dir}: ${r.stderr}`); process.exit(1); }
  const t = (r.stdout || '').trim().split('\n').pop();
  if (!t) continue;
  // Workspace protocol deps are not installable from a tarball. Strip them so the
  // packed artifact can be measured in a clean directory.
  const stageDir = path.join(work, 'stage', path.basename(dir));
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', path.join(packs, t), '-C', stageDir], { encoding: 'utf8' });
  if (untar.status !== 0) { console.error(`untar failed: ${untar.stderr}`); process.exit(1); }
  const pjPath = path.join(stageDir, 'package', 'package.json');
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pj[key]) continue;
    for (const [dep, spec] of Object.entries(pj[key])) {
      if (String(spec).startsWith('workspace:')) delete pj[key][dep];
    }
  }
  fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
  const rp = spawnSync('npm', ['pack', '--pack-destination', packs], { cwd: path.join(stageDir, 'package'), encoding: 'utf8', shell: process.platform === 'win32' });
  if (rp.status !== 0) { console.error(`repack failed: ${rp.stderr}`); process.exit(1); }
  tarballs.push(path.join(packs, (rp.stdout || '').trim().split('\n').pop()));
}

fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'footprint-probe', private: true, version: '1.0.0' }, null, 2));
const t0 = Date.now();
const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
  cwd: install, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32',
});
const installMs = Date.now() - t0;
const log = (r.stdout || '') + (r.stderr || '');
if (/node-gyp|gyp ERR|building native/i.test(log)) {
  console.error('FOOTPRINT FAIL: native compilation (node-gyp) detected');
  process.exit(1);
}
if (r.status !== 0) { console.error(`npm install failed: ${log.slice(-2000)}`); process.exit(1); }

function size(dir) {
  let bytes = 0, files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = size(p); bytes += s.bytes; files += s.files; }
    else { bytes += fs.statSync(p).size; files += 1; }
  }
  return { bytes, files };
}
const s = size(install);
const result = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  packages: tarballs.length,
  installedBytes: s.bytes,
  installedFiles: s.files,
  installMs,
  nodeGyp: false,
};
fs.writeFileSync('footprint.json', JSON.stringify(result, null, 2) + '\n');
console.log(`FOOTPRINT OK: ${result.packages} packages, ${s.files} files, ${(s.bytes / 1024 / 1024).toFixed(1)} MB, ${installMs} ms, no node-gyp`);
