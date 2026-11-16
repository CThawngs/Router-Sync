import { describe, it, expect } from 'vitest';
import { isGatedError, classifyModelLock, classifyLock } from '../src/commands/health.js';
import { confirmStatusLabel, combineServedSources, trustCompleteFor, loadCatalogTrust } from '../src/sync/confirm.js';
import { pickDeterministicControlId } from '../src/sync/providers.js';
import { dedupeAliasIds, canonicalAliasKey } from '../src/commands/discover.js';
import { reorderNeedsOwner } from '../src/commands/autopilot.js';
describe('C1c A5 REORDER needs-owner khi tier=? >20%', () => {
  it('tierUnknown >20% => needs-owner bat ke % doi', () => {
    expect(reorderNeedsOwner(0.1, 0.21)).toBe(true);
    expect(reorderNeedsOwner(0.1, 0.2)).toBe(false);
    expect(reorderNeedsOwner(0.26, 0)).toBe(true);
    expect(reorderNeedsOwner(0.1, 0.1)).toBe(false);
  });
});

describe('C1c A2 control xac dinh theo host', () => {
  it('cung host + cung danh sach => cung control_id (bo tien to provider, sort)', () => {
    const ids = ['groq/llama-3.3-70b-versatile', 'groq/llama-3.1-8b-instant', 'groq/openai/gpt-oss-120b'];
    expect(pickDeterministicControlId(ids, 'groq')).toBe('llama-3.1-8b-instant');
    expect(pickDeterministicControlId([...ids].reverse(), 'groq')).toBe('llama-3.1-8b-instant');
    expect(pickDeterministicControlId([], 'groq')).toBeNull();
  });
  it('hai dong cung host roi thi ket luan giong (control!=200 ca hai)', () => {
    const c1 = pickDeterministicControlId(['groq/b', 'groq/a'], 'groq');
    const c2 = pickDeterministicControlId(['groq/a', 'groq/b'], 'groq');
    expect(c1).toBe(c2);
    expect(confirmStatusLabel(0, false)).toBe('NOT-SENT (control!=200)');
  });
});
describe('C1c A1 nhan GATED', () => {
  it('401/403 + noi dung quyen/dang ky/ngoi sao => GATED', () => {
    expect(isGatedError({ errorCode: 401, lastError: 'need permission, register on Github star' })).toBe(true);
    expect(isGatedError({ errorCode: 403, lastError: 'forbidden: cần đăng ký quyền truy cập' })).toBe(true);
    expect(isGatedError({ errorCode: 401 })).toBe(false);
    expect(isGatedError({ errorCode: 404, lastError: 'permission denied' })).toBe(false);
  });
  it('classify tra GATED truoc DEAD-CANDIDATE, sau QUOTA', () => {
    expect(classifyLock({ errorCode: 401, lastError: 'unauthorized: need access permission' })).toBe('GATED');
    const now = Date.parse('2026-11-04T08:00:00Z');
    expect(classifyModelLock({ modelLock_m: new Date(now + 60000).toISOString(), errorCode: 401, lastError: 'register to unlock' }, 'm', { now }).label).toBe('QUOTA');
  });
});
describe('C1c A3 NOT-SENT + 2 nguon + catalogTrust', () => {
  it('confirmStatusLabel: control!=200 => NOT-SENT, khong phai 0', () => {
    expect(confirmStatusLabel(0, false)).toBe('NOT-SENT (control!=200)');
    expect(confirmStatusLabel(200, true)).toBe('200');
    expect(confirmStatusLabel(404, true)).toBe('404');
  });
  it('combineServedSources: chi 2 nguon cung vang moi NOT-SERVED-2-SOURCES', () => {
    expect(combineServedSources('STILL-EXISTS', 'CONFIRMED-ABSENT')).toBe('STILL-SERVED');
    expect(combineServedSources('CONFIRMED-ABSENT', 'CONFIRMED-ABSENT')).toBe('NOT-SERVED-2-SOURCES');
    expect(combineServedSources('UNSUPPORTED', 'CONFIRMED-ABSENT')).toBe('UNKNOWN');
    expect(combineServedSources(null, null)).toBe('UNKNOWN');
  });
  it('catalogTrust: doc registry, mac dinh false khi chua co dong nguon', () => {
    const entries = loadCatalogTrust();
    expect(entries.length).toBeGreaterThan(0);
    expect(trustCompleteFor('groq', entries)).toBe(false);
    expect(trustCompleteFor('khong-ton-tai', entries)).toBe(false);
    expect(entries.find((e) => e.provider === 'groq')?.doc).toContain('http');
  });
});
describe('C1c B1 dedupe alias', () => {
  it('gop bzl/beam-free vs bzl/reflection/beam-free:free', () => {
    expect(canonicalAliasKey('bzl/beam-free')).toBe('beam');
    expect(canonicalAliasKey('bzl/reflection/beam-free:free')).toBe('beam');
    expect(dedupeAliasIds(['bzl/beam-free', 'bzl/reflection/beam-free:free', 'bzl/other-free'])).toEqual(['bzl/beam-free', 'bzl/other-free']);
  });
  it('gop nemotron-3.5-lightning-free vs bzl/nvidia/nemotron-3.5-lightning-free:free', () => {
    expect(dedupeAliasIds(['bzl/nemotron-3.5-lightning-free', 'bzl/nvidia/nemotron-3.5-lightning-free:free'])).toHaveLength(1);
  });
  it('xoa trung chinh xac tencent/hy4', () => {
    expect(dedupeAliasIds(['tencent/hy4', 'tencent/hy4'])).toEqual(['tencent/hy4']);
  });
});
