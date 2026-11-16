/**
 * packages/cli/src/commands/mcp-http.ts
 *
 * Loopback HTTP MCP Server and single-use pairing token management.
 * Enforces:
 * - Loopback binding on 127.0.0.1 (strictly no external access)
 * - Host header validation (127.0.0.1, localhost)
 * - Origin header validation for DNS rebinding and CSRF protection
 * - 5-minute single-use pairing codes (A-Z2-9 charset)
 * - SHA-256 storage only in mcp-pairing.json and mcp-tokens.json
 * - timingSafeEqual for constant-time hash comparisons
 * - Max body payload limit of 1MB (413 Payload Too Large)
 * - 5 consecutive failed pairing attempts trigger 429 lockout
 * - Instant token revocation without server restart
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : path.dirname(fileURLToPath(import.meta.url));

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface McpPairingState {
  codeHash: string;
  expiresAt: string;
  used: boolean;
  locked: boolean;
  wrongAttempts: number;
  client?: string | undefined;
}

export interface McpTokenRecord {
  id: string;
  hash: string;
  client: string;
  createdAt: string;
  lastSeenAt: string;
  revoked: boolean;
}

export interface McpTokensFile {
  tokens: McpTokenRecord[];
}

function getStateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
}

function getPairingFilePath(): string {
  return path.join(getStateDir(), 'mcp-pairing.json');
}

function getTokensFilePath(): string {
  return path.join(getStateDir(), 'mcp-tokens.json');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    fs.unlinkSync(tmpPath);
  }
}

function loadPairingData(): McpPairingState | null {
  const filePath = getPairingFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function savePairingData(data: McpPairingState): void {
  atomicWriteJson(getPairingFilePath(), data);
}

function loadTokensFile(): McpTokensFile {
  const filePath = getTokensFilePath();
  if (!fs.existsSync(filePath)) return { tokens: [] };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.tokens)) return parsed;
    return { tokens: [] };
  } catch {
    return { tokens: [] };
  }
}

function saveTokensFile(data: McpTokensFile): void {
  atomicWriteJson(getTokensFilePath(), data);
}

export function generatePairCode(): string {
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += CHARSET[crypto.randomInt(0, CHARSET.length)];
    part2 += CHARSET[crypto.randomInt(0, CHARSET.length)];
  }
  return `${part1}-${part2}`;
}

export function runMcpPairCommand(options: { client?: string | undefined }): void {
  const code = generatePairCode();
  const isFast = process.env['ROUTERSYNC_TEST_FAST'] === '1';
  const ttlMs = (isFast && process.env['ROUTERSYNC_PAIR_TTL_MS'])
    ? Number(process.env['ROUTERSYNC_PAIR_TTL_MS'])
    : 300000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  const pairingData: McpPairingState = {
    codeHash,
    expiresAt,
    used: false,
    locked: false,
    wrongAttempts: 0,
    client: options.client || 'default',
  };

  savePairingData(pairingData);

  process.stdout.write(`PAIR-CODE ${code}\n`);
  process.stdout.write(`PAIR-EXPIRES ${expiresAt}\n`);
}

export function runMcpListCommand(): void {
  const data = loadTokensFile();
  for (const t of data.tokens) {
    const revokedStr = t.revoked ? 'yes' : 'no';
    process.stdout.write(`MCP-TOKEN id=${t.id} client=${t.client} created=${t.createdAt} lastSeen=${t.lastSeenAt} revoked=${revokedStr}\n`);
  }
}

export function runMcpRevokeCommand(tokenId: string): void {
  const data = loadTokensFile();
  const target = data.tokens.find((t) => t.id === tokenId);
  if (!target) {
    process.stderr.write(`Lỗi: Không tìm thấy token id=${tokenId}\n`);
    process.exit(1);
  }
  target.revoked = true;
  saveTokensFile(data);
  process.stdout.write(`MCP-REVOKED id=${tokenId}\n`);
}

async function getMcpServer() {
  const serverPath = path.resolve(
    currentDir,
    '..', '..', '..', 'mcp-server', 'dist', 'index.js'
  );
  const mod = await import(pathToFileURL(serverPath).href);
  return mod;
}

export async function runMcpServeHttpCommand(options: { port?: string | number | undefined }): Promise<void> {
  const port = options.port !== undefined ? Number(options.port) : 3128;
  const mcpMod = await getMcpServer();

  async function createTransport() {
    const transport = new mcpMod.StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const s = mcpMod.createRouterSyncMcpServer();
    await s.connect(transport);
    return transport;
  }

  const server = http.createServer((req, res) => {
    // 1. Host header validation
    const rawHost = req.headers['host'];
    const hostOnly = (rawHost || '').split(':')[0]?.toLowerCase();
    if (!hostOnly || (hostOnly !== '127.0.0.1' && hostOnly !== 'localhost')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid Host header' }));
      return;
    }

    // 2. Origin header validation
    const originHeader = req.headers['origin'];
    if (originHeader) {
      try {
        const u = new URL(originHeader);
        const originHost = u.hostname.toLowerCase();
        if (originHost !== '127.0.0.1' && originHost !== 'localhost') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: invalid Origin header' }));
          return;
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: malformed Origin header' }));
        return;
      }
    }

    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // Route: /pair
    if (pathname === '/pair') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let bytes = 0;
      let overflow = false;
      req.on('error', () => {});
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          if (!overflow) {
            overflow = true;
            res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            req.destroy();
          }
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        if (overflow) return;
        let payload: any = {};
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request: invalid JSON' }));
          return;
        }

        const pairingData = loadPairingData();
        if (!pairingData) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: no pairing code active' }));
          return;
        }

        if (pairingData.locked || (pairingData.wrongAttempts && pairingData.wrongAttempts >= 5)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too Many Requests: locked out' }));
          return;
        }

        const codeInput = String(payload?.code || '').trim().toUpperCase();
        const inputHash = crypto.createHash('sha256').update(codeInput).digest();
        const storedHash = Buffer.from(pairingData.codeHash, 'hex');

        const isMatch = inputHash.length === storedHash.length && crypto.timingSafeEqual(inputHash, storedHash);

        if (!isMatch) {
          pairingData.wrongAttempts = (pairingData.wrongAttempts || 0) + 1;
          if (pairingData.wrongAttempts >= 5) {
            pairingData.locked = true;
            savePairingData(pairingData);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Too Many Requests: locked out after 5 failed attempts' }));
            return;
          }
          savePairingData(pairingData);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid pairing code' }));
          return;
        }

        if (pairingData.used) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: pairing code already used' }));
          return;
        }

        if (new Date() > new Date(pairingData.expiresAt)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: pairing code expired' }));
          return;
        }

        pairingData.used = true;
        pairingData.wrongAttempts = 0;
        savePairingData(pairingData);

        const token = 'rs_' + crypto.randomBytes(32).toString('hex');
        const tokenId = 'tok_' + crypto.randomBytes(8).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const now = new Date().toISOString();

        const tokensFile = loadTokensFile();
        tokensFile.tokens.push({
          id: tokenId,
          hash: tokenHash,
          client: String(payload?.clientName || pairingData.client || 'gate-client').slice(0, 64),
          createdAt: now,
          lastSeenAt: now,
          revoked: false,
        });
        saveTokensFile(tokensFile);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token,
          tokenId,
          scope: 'routersync.read',
        }));
      });
      return;
    }

    // Route: /mcp
    if (pathname === '/mcp') {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
        return;
      }

      const rawToken = authHeader.slice(7).trim();
      const inTokenHash = crypto.createHash('sha256').update(rawToken).digest();

      const tokensFile = loadTokensFile();
      let matchedToken: McpTokenRecord | null = null;
      for (const rec of tokensFile.tokens) {
        const recHash = Buffer.from(rec.hash, 'hex');
        if (inTokenHash.length === recHash.length && crypto.timingSafeEqual(inTokenHash, recHash)) {
          matchedToken = rec;
          break;
        }
      }

      if (!matchedToken || matchedToken.revoked) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or revoked token' }));
        return;
      }

      matchedToken.lastSeenAt = new Date().toISOString();
      saveTokensFile(tokensFile);

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let bytes = 0;
      let overflow = false;
      req.on('error', () => {});
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          if (!overflow) {
            overflow = true;
            res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            req.destroy();
          }
          return;
        }
        body += chunk;
      });

      req.on('end', async () => {
        if (overflow) return;
        let rpcReq: any = null;
        try {
          rpcReq = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request: invalid JSON-RPC payload' }));
          return;
        }

        if (rpcReq?.method === 'initialize' && rpcReq.params?.clientInfo?.name && typeof mcpMod.recordConnectedClient === 'function') {
          mcpMod.recordConnectedClient(rpcReq.params.clientInfo.name, rpcReq.params.clientInfo.version ?? 'unknown');
        }

        try {
          const transport = await createTransport();
          await transport.handleRequest(req, res, rpcReq);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        }
      });
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as any;
    const actualPort = addr?.port || port;
    process.stdout.write(`MCP-HTTP-LISTEN http://127.0.0.1:${actualPort}/mcp\n`);
  });

  // Keep process alive until termination signal
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      server.close(() => resolve());
    });
    process.on('SIGTERM', () => {
      server.close(() => resolve());
    });
  });
}
