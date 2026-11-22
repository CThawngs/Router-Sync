/**
 * packages/cli/src/apps/openmausbot.ts
 *
 * C41 Y2: read-only view of OpenMausBot's OpenAI-compatible instances.
 * Never writes a file. Never returns a key, token or raw private host/port.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const OPENMAUS_CONFIG_REL = '.openmausbot/config.json';
export const ROUTER_PORT = 20128;

export interface OpenMausInstance {
  /** Masked instance id. The raw UUID never leaves this module. */
  id: string;
  model: string;
  url: string;
  port: number | null;
  keyPresent: boolean;
}

export interface OpenMausRead {
  configPath: string;
  instances: OpenMausInstance[];
  notes: string[];
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Rec;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Che UUID và các id instance tự sinh — không bao giờ in id thật. */
export function maskInstanceId(raw: string, index: number): string {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  if (uuid.test(raw)) return raw.replace(uuid, '<uuid>');
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return `instance-${index + 1}`;
  return raw;
}

/** Cổng 20128 được giữ; cổng khác và host riêng bị che. */
export function maskUrl(raw: string): { url: string; port: number | null } {
  const match = raw.match(/^([a-z]+:\/\/)([^:/]+):(\d+)(.*)$/i);
  if (!match) {
    return { url: /[\d]{4,5}/.test(raw) ? '<url-masked>' : raw, port: null };
  }
  const port = Number(match[3]);
  if (port === ROUTER_PORT) return { url: `http://localhost:${ROUTER_PORT}${match[4] || '/v1'}`, port };
  return { url: `${match[1]}<host>:<port>${match[4]}`, port: null };
}

function hasKeyMaterial(config: Rec): boolean {
  return Object.entries(config).some(([key, value]) => /key|token|secret|credential/i.test(key) && typeof value === 'string' && value.length > 0);
}

/** Đọc cấu hình; trả notes khi không tìm thấy thay vì đoán. */
export function readOpenMausConfig(configPath: string): OpenMausRead {
  const notes: string[] = [];
  if (!fs.existsSync(configPath)) {
    return { configPath, instances: [], notes: ['không tìm thấy tệp cấu hình'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { configPath, instances: [], notes: ['JSON không hợp lệ'] };
  }
  const doc = asRecord(parsed);
  const instancesRaw = asRecord(doc?.['instances']) ?? {};
  const instances: OpenMausInstance[] = [];
  let index = 0;
  for (const [rawId, value] of Object.entries(instancesRaw)) {
    const config = asRecord(asRecord(value)?.['config']) ?? {};
    const model = str(config['model']);
    const rawUrl = str(config['url']);
    if (!model || !rawUrl) {
      notes.push(`instance ${index + 1}: thiếu model hoặc url`);
      index += 1;
      continue;
    }
    const masked = maskUrl(rawUrl);
    instances.push({
      id: maskInstanceId(rawId, index),
      model,
      url: masked.url,
      port: masked.port,
      keyPresent: hasKeyMaterial(config),
    });
    index += 1;
  }
  if (instances.length === 0) notes.push('không có instance nào có model + url');
  return { configPath, instances, notes };
}

export function defaultOpenMausPath(homeDir: string): string {
  return path.join(homeDir, OPENMAUS_CONFIG_REL);
}

/** Các đường dẫn đã thử, viết dạng <HOME>/... để không lộ tên người dùng. */
export function triedPaths(homeDir: string): string[] {
  return [
    `<HOME>/${OPENMAUS_CONFIG_REL.replace(/\\/g, '/')}`,
    '<HOME>/.config/openmausbot/config.json',
  ];
}
