#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const reportPath = path.resolve(root, 'packages/ui/test-report.json');

if (fs.existsSync(reportPath)) {
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    const data = JSON.parse(raw);
    if (data.testResults && Array.isArray(data.testResults)) {
      for (const res of data.testResults) {
        if (res.name) {
          const norm = res.name.replace(/\\/g, '/');
          const rootNorm = root.replace(/\\/g, '/');
          if (norm.startsWith(rootNorm + '/')) {
            res.name = norm.slice(rootNorm.length + 1);
          } else {
            res.name = path.relative(root, res.name).replace(/\\/g, '/');
          }
        }
      }
      fs.writeFileSync(reportPath, JSON.stringify(data), 'utf8');
    }
  } catch (e) {
    console.error('Failed to relativize test-report.json:', e);
  }
}
