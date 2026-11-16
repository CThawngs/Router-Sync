/**
 * test/e2e/fake-provider-server.cjs
 *
 * Fake provider host for the end-to-end run. It runs in its OWN process so a
 * synchronous CLI call cannot block the HTTP server (a parent process that
 * blocks its event loop cannot answer requests).
 *
 * usage: node fake-provider-server.cjs <portFile> <scenarioFile>
 *   portFile     : the chosen port is written here as plain text
 *   scenarioFile : the current scenario name is read on every request
 *                 (base | added | lost | unauthorized | quota | serverError)
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');

const portFile = process.argv[2];
const scenarioFile = process.argv[3];

const LISTS = {
  base: ['model-a', 'model-b'],
  added: ['model-a', 'model-b', 'model-new'],
  lost: ['model-a'],
};
const STATUS = {
  unauthorized: 401,
  quota: 429,
  serverError: 500,
};

const server = http.createServer((req, res) => {
  let scenario = 'base';
  try {
    scenario = fs.readFileSync(scenarioFile, 'utf8').trim();
  } catch {
    scenario = 'base';
  }

  if (!req.url || !req.url.includes('/models')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }

  const status = STATUS[scenario];
  if (status) {
    res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":"fake"}');
    return;
  }

  const ids = LISTS[scenario] ?? LISTS.base;
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(portFile, String(address.port), 'utf8');
  process.stdout.write('FAKE-PROVIDER-PORT ' + address.port + '\n');
});
